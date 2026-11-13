// dsh-x-context-menu —— 浏览器端插件：给 dsh 网页界面补右键菜单。
//
// dsh 0.2.2 起自带右键菜单（`contextMenus` 服务，会话行/工作区行都挂好了触发器），
// 所以行上的菜单**不再自绘**：本插件只往官方菜单里加官方没做的动作（复制标题/工作目录、
// 在资源管理器中打开、工作区的新建会话/复制名称/路径）。两套菜单同时画出来就是 #110。
// 官方没有这个服务的老 dsh 上，行菜单退回自绘，功能一个不少。
//
// 剩下的几个面官方没有对应触发器，仍然自绘：正文里的选中文字、正文里的链接、输入框。
// 自绘菜单用 dsh 自己的 --dsw-alias-* 设计令牌，跟界面同色——不用系统原生菜单：原生菜单
// 不能跟主题一起变，而且 Windows 上会闪一下系统样式。
//
// 动作分两类：
// - 官方公开能力：uiWorkspace.archiveSession / pinSession / unpinSession / forkSession /
//   startSession / openSession，以及 sessions 上的重命名。直接调服务，不去点官方菜单里的
//   文字——官方改文案就失效的路子不跟。
// - 系统动作：在资源管理器中打开、用浏览器打开链接，走本插件主机侧那两个环回路由。
//
// 客户端插件的入口形态是 window.__ModuleLoader__.load({ id, factory })，
// 里面用 require('react')（不是 ESM import）。
window.__ModuleLoader__.load({
	id: "dsh-x-context-menu",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** 需要 slots（挂覆盖层）与词典；uiWorkspace / sessions 按需取，缺了也不影响加载。 */
		const inject = ["slots", "locale"];

		const NS = "x-context-menu";
		const TOAST_MS = 1800;

		/** 会话行/工作区行都带 data-row-key="session:<id>" / "workspace:<key>"。 */
		const ROW_SELECTOR = "[data-row-key]";
		const EDITABLE_SELECTOR = 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]),textarea,[contenteditable="true"]';
		const LINK_SELECTOR = "a[href]";

		const STYLES = `
.dsh-xcm-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
.dsh-xcm-menu, .dsh-xcm-card, .dsh-xcm-scrim { pointer-events: auto; }
.dsh-xcm-menu {
	position: fixed; min-width: 196px; max-width: 340px; padding: 5px;
	border-radius: 10px;
	background: var(--dsw-alias-bg-layer-2, var(--dsh-menu-bg, rgba(38, 38, 40, .98)));
	border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .3));
	box-shadow: 0 12px 32px rgba(0, 0, 0, .28), 0 2px 6px rgba(0, 0, 0, .16);
	color: var(--dsw-alias-label-primary, inherit);
	font-size: 13px; line-height: 18px;
	outline: none;
}
.dsh-xcm-title {
	padding: 4px 10px 6px; font-size: 11px;
	color: var(--dsw-alias-label-tertiary, rgba(140, 140, 140, .95));
	max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-xcm-item {
	display: flex; align-items: center; justify-content: space-between; gap: 18px;
	padding: 6px 10px; border-radius: 7px; white-space: nowrap;
	cursor: default; user-select: none;
}
.dsh-xcm-item.active { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .18)); }
.dsh-xcm-item.danger { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsh-xcm-item.disabled { opacity: .45; }
.dsh-xcm-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(140, 140, 140, .95)); }
.dsh-xcm-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l2, rgba(128, 128, 128, .25)); }
.dsh-xcm-scrim {
	position: fixed; inset: 0; background: rgba(0, 0, 0, .28);
	display: flex; align-items: center; justify-content: center;
}
.dsh-xcm-card {
	width: min(380px, 86vw); padding: 16px; border-radius: 12px;
	display: flex; flex-direction: column; gap: 10px;
	background: var(--dsw-alias-bg-layer-1, var(--dsh-panel-bg, #232326));
	border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .3));
	box-shadow: 0 18px 44px rgba(0, 0, 0, .34);
	color: var(--dsw-alias-label-primary, inherit);
}
.dsh-xcm-card-title { margin: 0; font-size: 14px; font-weight: 600; }
.dsh-xcm-card-label { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(180, 180, 180, .95)); }
.dsh-xcm-card input {
	width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
	background: var(--dsw-alias-bg-base, transparent); color: inherit;
	border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .35));
	font: inherit; font-size: 13px;
}
.dsh-xcm-card input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-xcm-card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.dsh-xcm-btn {
	border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .35));
	background: transparent; color: inherit; border-radius: 999px;
	padding: 6px 16px; font: inherit; font-size: 12px; cursor: pointer;
}
.dsh-xcm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-xcm-btn.primary { border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-xcm-btn:disabled { opacity: .5; cursor: default; }
.dsh-xcm-toast {
	position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%);
	padding: 7px 14px; border-radius: 999px; font-size: 12px; pointer-events: none;
	max-width: 70vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	background: var(--dsw-alias-bg-module-platform, rgba(30, 30, 32, .94));
	color: var(--dsw-alias-label-primary, #fff);
	border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .3));
	box-shadow: 0 6px 18px rgba(0, 0, 0, .24);
}
`;

		/** 界面文案：中文为主，英文兜底（界面语言跟着 dsh 的 locale 走）。 */
		const zh = {
			rename: "重命名…",
			renameTitle: "重命名会话",
			renameLabel: "会话名称",
			pin: "置顶会话",
			unpin: "取消置顶",
			fork: "分叉会话",
			archive: "归档会话",
			unarchive: "取消归档",
			copyTitle: "复制会话标题",
			copySessionId: "复制会话 ID",
			copyCwd: "复制工作目录",
			reveal: "在文件夹显示",
			newSession: "新建会话",
			copyName: "复制工作区名称",
			copyPath: "复制工作区路径",
			copy: "复制",
			cut: "剪切",
			paste: "粘贴",
			selectAll: "全选",
			copyLink: "复制链接地址",
			openLink: "在浏览器中打开",
			revealed: "已在资源管理器中打开",
			opened: "已在浏览器中打开",
			copied: "已复制",
			copiedTitle: "已复制标题",
			copiedSessionId: "已复制会话 ID",
			copiedCwd: "已复制工作目录",
			copiedName: "已复制名称",
			copiedPath: "已复制路径",
			copiedLink: "已复制链接",
			renamed: "已重命名",
			archived: "已归档",
			unarchived: "已取消归档",
			pinned: "已置顶",
			unpinned: "已取消置顶",
			forked: "已分叉",
			revealFailed: "无法在文件夹中显示",
			save: "保存",
			cancel: "取消",
			clipboardUnavailable: "剪贴板不可用",
			emptyTitle: "名称不能为空",
			sessionUnavailable: "拿不到会话服务",
			actionFailed: (reason) => `操作失败：${reason}`,
		};
		const en = {
			rename: "Rename…",
			renameTitle: "Rename session",
			renameLabel: "Session name",
			pin: "Pin session",
			unpin: "Unpin session",
			fork: "Fork session",
			archive: "Archive session",
			unarchive: "Unarchive",
			copyTitle: "Copy session title",
			copySessionId: "Copy session ID",
			copyCwd: "Copy working directory",
			reveal: "Show in folder",
			newSession: "New session",
			copyName: "Copy workspace name",
			copyPath: "Copy workspace path",
			copy: "Copy",
			cut: "Cut",
			paste: "Paste",
			selectAll: "Select all",
			copyLink: "Copy link address",
			openLink: "Open in browser",
			revealed: "Opened in file manager",
			opened: "Opened in browser",
			copied: "Copied",
			copiedTitle: "Title copied",
			copiedSessionId: "Session ID copied",
			copiedCwd: "Working directory copied",
			copiedName: "Name copied",
			copiedPath: "Path copied",
			copiedLink: "Link copied",
			renamed: "Renamed",
			archived: "Archived",
			unarchived: "Unarchived",
			pinned: "Pinned",
			unpinned: "Unpinned",
			forked: "Forked",
			revealFailed: "Could not show the folder",
			save: "Save",
			cancel: "Cancel",
			clipboardUnavailable: "Clipboard unavailable",
			emptyTitle: "Name cannot be empty",
			sessionUnavailable: "Session service unavailable",
			actionFailed: (reason) => `Action failed: ${reason}`,
		};

		/** 一个可订阅的极简 store：菜单、弹窗、toast 都用它驱动。 */
		function createStore() {
			let current = null;
			const listeners = new Set();
			return {
				get: () => current,
				set(next) {
					current = next;
					for (const listener of listeners) listener(current);
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
			};
		}

		/** toast：一次只显示一条，新的顶掉旧的。 */
		function createToasts() {
			let current = null;
			let seq = 0;
			const listeners = new Set();
			const publish = (value) => {
				current = value;
				for (const listener of listeners) listener(current);
			};
			return {
				show(text) {
					if (!text) return;
					const id = ++seq;
					publish({ id, text });
					setTimeout(() => { if (current?.id === id) publish(null); }, TOAST_MS);
				},
				get: () => current,
				subscribe(listener) {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
			};
		}

		/** 抄官方那套写剪贴板：先 Clipboard API，禁用时退回 execCommand。 */
		async function writeClipboard(text) {
			try {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				// 无权限/非安全上下文：走下面的兜底。
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand("copy");
				area.remove();
				return ok;
			} catch {
				return false;
			}
		}

		/** 右键的目标面。 */
		function targetOf(event) {
			const element = event.target instanceof Element ? event.target : null;
			if (!element) return null;

			const editable = element.closest(EDITABLE_SELECTOR);
			if (editable) {
				return { surface: "editable", editable, selection: selectionOf(editable) };
			}

			const row = element.closest(ROW_SELECTOR);
			if (row) {
				const key = row.getAttribute("data-row-key") || "";
				if (key.startsWith("session:")) {
					return { surface: "session", row, sessionId: key.slice("session:".length) };
				}
				if (key.startsWith("workspace:")) {
					return { surface: "workspace", row, groupKey: key.slice("workspace:".length) };
				}
			}

			const link = element.closest(LINK_SELECTOR);
			if (link) return { surface: "link", link, href: link.getAttribute("href") || "" };

			const selection = String(globalThis.getSelection?.() ?? "");
			if (selection.trim() !== "") return { surface: "selection", selection };
			return null;
		}

		/** 输入框里的选区文本；普通元素取全局选区。 */
		function selectionOf(editable) {
			if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
				const start = editable.selectionStart ?? 0;
				const end = editable.selectionEnd ?? 0;
				return end > start ? editable.value.slice(start, end) : "";
			}
			return String(globalThis.getSelection?.() ?? "");
		}

		/** 行里那串可见文字（标题/工作区名）；取不到时为空串。 */
		function rowText(row) {
			const raw = String(row.textContent || "").replace(/\s+/g, " ").trim();
			return raw;
		}

		function apply(ctx) {
			const store = createStore();
			const toasts = createToasts();

			const t = (key, ...args) => {
				let value;
				try {
					value = ctx.locale.t?.(NS, key);
				} catch {
					value = undefined;
				}
				if (value === undefined || value === null || value === key) value = zh[key];
				if (typeof value === "function") return value(...args);
				return value ?? key;
			};

			/** 关掉菜单/弹窗。 */
			const close = () => store.set(null);

			/** 失败一律落到 toast，不让异常冒到界面。 */
			const report = (error) => {
				toasts.show(t("actionFailed", error instanceof Error ? error.message : String(error)));
			};

			const copy = async (text, message) => {
				if (!(await writeClipboard(text))) throw new Error(t("clipboardUnavailable"));
				toasts.show(message);
			};

			// ---- 官方服务（缺了就是没有这个能力，菜单项不显示）----
			const service = (name) => {
				try {
					return ctx.get?.(name) ?? ctx[name] ?? null;
				} catch {
					return null;
				}
			};

			/**
			 * dsh 自带的右键菜单服务。0.2.2 起才有；老版本返回 null，行菜单退回自绘。
			 * 只认有 register 的那种：别的同名字段（若有）不能当扩展点用。
			 */
			const nativeMenus = () => {
				const menus = service("contextMenus");
				return menus && typeof menus.register === "function" ? menus : null;
			};

			/** 反馈统一走官方 toast（跟官方动作同一处出现）；没有这个服务时用自家 toast。 */
			const notify = (text, success = false) => {
				const menus = nativeMenus();
				if (menus && typeof menus.notify === "function") {
					try {
						menus.notify(text, success);
						return;
					} catch {
						// 服务已卸载/版本不同：退回自家 toast。
					}
				}
				toasts.show(text);
			};

			/** 官方菜单里的复制动作：剪贴板失败直接抛，交给官方菜单的 failureLabel 提示。 */
			const copyInto = (text, message) => async () => {
				if (!(await writeClipboard(text))) throw new Error(t("clipboardUnavailable"));
				notify(message, true);
			};

			const sessionSummary = (id) => {
				try {
					return service("sessions")?.list?.getSnapshot()?.byId?.[id] ?? null;
				} catch {
					return null;
				}
			};

			/** 工作区集合：uiWorkspace 上的纯控制器（不是公开字段，但没有别的公开入口）。 */
			const workspaceState = () => {
				try {
					const state = service("uiWorkspace")?.workspaces?.list?.getSnapshot?.();
					return {
						items: state?.items ?? [],
						pinnedSessionIds: state?.pinnedSessionIds ?? [],
						archivedSessionIds: state?.archivedSessionIds ?? [],
					};
				} catch {
					return { items: [], pinnedSessionIds: [], archivedSessionIds: [] };
				}
			};

			/** 归档过的会话在列表里还在，但动作要换成「取消归档」。 */
			const isArchived = (id) => workspaceState().archivedSessionIds.includes(id);

			const workspaceOfSession = (id) => {
				const { items } = workspaceState();
				return items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(id)) ?? null;
			};

			const workspaceByGroupKey = (key) => {
				const { items } = workspaceState();
				return items.find((item) => item.workspaceId === key) ?? null;
			};

			const isPinned = (id) => workspaceState().pinnedSessionIds.includes(id);

			async function renameSession(id, title) {
				const sessions = service("sessions");
				if (!sessions) throw new Error(t("sessionUnavailable"));
				const trimmed = title.trim();
				if (trimmed === "") throw new Error(t("emptyTitle"));
				// 优先用 manager（不必先 retain 会话），拿不到再退回已 retain 的绑定。
				if (typeof sessions.manager?.rename === "function") {
					const result = await sessions.manager.rename(id, trimmed);
					if (result && result.ok === false) throw new Error(result.error?.message || "rename failed");
					return;
				}
				const result = await sessions.binding?.(id)?.session?.rename?.(trimmed);
				if (result && result.ok === false) throw new Error(result.error?.message || "rename failed");
				if (!sessions.binding?.(id)?.session?.rename) throw new Error(t("sessionUnavailable"));
			}

			const uiWorkspace = () => service("uiWorkspace");

			async function archiveSession(id) {
				const workspace = uiWorkspace();
				if (typeof workspace?.archiveSession !== "function") throw new Error(t("sessionUnavailable"));
				await workspace.archiveSession(id);
			}

			async function unarchiveSession(id) {
				const workspace = uiWorkspace();
				if (typeof workspace?.unarchiveSession !== "function") throw new Error(t("sessionUnavailable"));
				await workspace.unarchiveSession(id);
			}

			async function forkSession(id) {
				const workspace = uiWorkspace();
				if (typeof workspace?.forkSession !== "function") throw new Error(t("sessionUnavailable"));
				await workspace.forkSession(id);
			}

			async function togglePin(id) {
				const workspace = uiWorkspace();
				const pinned = isPinned(id);
				const method = pinned ? "unpinSession" : "pinSession";
				if (typeof workspace?.[method] !== "function") throw new Error(t("sessionUnavailable"));
				await workspace[method](id);
				toasts.show(pinned ? t("unpinned") : t("pinned"));
			}

			async function startSessionIn(workspaceId) {
				const workspace = uiWorkspace();
				if (typeof workspace?.startSession !== "function") throw new Error(t("sessionUnavailable"));
				workspace.startSession(workspaceId);
			}

			// ---- 系统动作（主机侧环回路由）----
			async function postJson(path, body) {
				const response = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				const value = await response.json().catch(() => ({}));
				if (!response.ok || value?.ok === false) throw new Error(value?.error || `HTTP ${response.status}`);
				return value;
			}

			const reveal = async (path) => {
				await postJson("/api/x-context-menu/reveal", { path });
				notify(t("revealed"), true);
			};
			const openUrl = async (url) => {
				await postJson("/api/x-context-menu/open-url", { url });
				notify(t("opened"), true);
			};

			/** 打开外链：只放行 http/https，其余当普通文本。 */
			async function openExternal(raw) {
				let url;
				try {
					url = new URL(raw);
				} catch {
					throw new Error(raw);
				}
				if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(raw);
				await openUrl(url.toString());
			}

			// ---- 官方菜单里的动作（会话行 / 工作区行）----
			//
			// 只加官方没做的：官方的会话菜单已经有置顶、重命名、分叉、复制 Session ID、
			// 在应用中打开、归档，工作区菜单已经有重命名、在资源管理器中打开、删除。
			// 复制到这里就是第二个同名菜单项，所以一行都不重复。
			//
			// 服务晚到也能生效：ctx.inject 等 `contextMenus` 就位再注册；老 dsh 上没有这个
			// 服务时回调根本不跑，行菜单继续由下面的自绘实现负责。
			ctx.inject(["contextMenus"], (menusCtx) => {
				const menus = menusCtx.contextMenus ?? menusCtx.get?.("contextMenus");
				if (!menus || typeof menus.register !== "function") return;

				// 官方菜单一打开就把自家菜单收掉，反之亦然（见 onContextMenu）：
				// 两个 popup 叠在一起就是 #110 里那张截图。
				menusCtx.effect(() => {
					const active = menus.active;
					if (typeof active?.subscribe !== "function") return () => {};
					return active.subscribe((target) => {
						if (target !== null) close();
					});
				}, "dsh-x-context-menu: follow official menu");

				menusCtx.effect(() => menus.register({
					id: "x-context-menu.session",
					target: "session",
					// 官方：置顶 100、重命名 200、分叉 300、复制 Session ID 450、在应用中打开 500、
					// 归档 600。460 让复制类动作贴着「复制 Session ID」，归档仍在最后。
					order: 460,
					observe: () => {
						const list = service("sessions")?.list;
						return typeof list?.subscribe === "function" ? [list] : [];
					},
					resolve: ({ sessionId, displayTitle }) => {
						const summary = sessionSummary(sessionId);
						const cwd = summary?.cwd || workspaceOfSession(sessionId)?.path || "";
						const title = displayTitle || summary?.title || "";
						const actions = [];
						if (title !== "") {
							actions.push({
								id: "copy-title", label: t("copyTitle"),
								run: copyInto(title, t("copiedTitle")), failureLabel: t("clipboardUnavailable"),
							});
						}
						if (cwd !== "") {
							actions.push({
								id: "copy-cwd", label: t("copyCwd"),
								run: copyInto(cwd, t("copiedCwd")), failureLabel: t("clipboardUnavailable"),
							});
							actions.push({
								id: "reveal", label: t("reveal"), separatorBefore: true,
								run: () => reveal(cwd), failureLabel: t("revealFailed"),
							});
						}
						return actions;
					},
				}), "dsh-x-context-menu: session actions");

				// 官方工作区菜单：重命名 100、在资源管理器中打开 200、删除 300。
				// 新建会话是主操作，排最前面；复制名称/路径贴着官方那两项的后面。
				menusCtx.effect(() => menus.register({
					id: "x-context-menu.workspace-start",
					target: "workspace",
					order: 50,
					resolve: ({ workspaceId }) => (
						workspaceId && typeof uiWorkspace()?.startSession === "function"
							? [{
								id: "new-session", label: t("newSession"),
								run: () => startSessionIn(workspaceId), failureLabel: t("sessionUnavailable"),
							}]
							: []
					),
				}), "dsh-x-context-menu: workspace new session");

				menusCtx.effect(() => menus.register({
					id: "x-context-menu.workspace-copy",
					target: "workspace",
					order: 250,
					resolve: ({ path, displayTitle }) => {
						const actions = [];
						if (displayTitle) {
							actions.push({
								id: "copy-name", label: t("copyName"),
								run: copyInto(displayTitle, t("copiedName")), failureLabel: t("clipboardUnavailable"),
							});
						}
						if (path) {
							actions.push({
								id: "copy-path", label: t("copyPath"),
								run: copyInto(path, t("copiedPath")), failureLabel: t("clipboardUnavailable"),
							});
						}
						return actions;
					},
				}), "dsh-x-context-menu: workspace copy actions");
			});

			// ---- 菜单装配 ----
			let itemSeq = 0;
			const item = (label, run, options = {}) => ({ id: `item:${itemSeq++}`, label, run, ...options });
			const separator = () => ({ separator: true });

			function promptRename(sessionId, currentTitle) {
				store.set({
					kind: "prompt",
					title: t("renameTitle"),
					label: t("renameLabel"),
					value: currentTitle,
					onSubmit: async (value) => {
						await renameSession(sessionId, value);
						toasts.show(t("renamed"));
					},
				});
			}

			function buildSessionItems(target) {
				const id = target.sessionId;
				const summary = sessionSummary(id);
				const workspace = workspaceOfSession(id);
				const cwd = summary?.cwd || workspace?.path || "";
				const title = rowText(target.row);
				const workspaceApi = uiWorkspace();
				const archived = isArchived(id);
				const items = [];

				// 官方对空白会话不发标题（行里永远显示「新会话」），所以空白行不给重命名。
				if (summary?.blank !== true) items.push(item(t("rename"), () => promptRename(id, title)));
				if (typeof workspaceApi?.pinSession === "function") {
					items.push(item(isPinned(id) ? t("unpin") : t("pin"), () => togglePin(id)));
				}
				if (typeof workspaceApi?.forkSession === "function") {
					items.push(item(t("fork"), async () => {
						await forkSession(id);
						toasts.show(t("forked"));
					}));
				}
				if (archived) {
					items.push(item(t("unarchive"), async () => {
						await unarchiveSession(id);
						toasts.show(t("unarchived"));
					}));
				} else if (typeof workspaceApi?.archiveSession === "function") {
					items.push(item(t("archive"), async () => {
						await archiveSession(id);
						toasts.show(t("archived"));
					}));
				}

				items.push(separator());
				if (title !== "") items.push(item(t("copyTitle"), () => copy(title, t("copiedTitle"))));
				items.push(item(t("copySessionId"), () => copy(id, t("copiedSessionId"))));
				if (cwd !== "") {
					items.push(item(t("copyCwd"), () => copy(cwd, t("copiedCwd"))));
					items.push(item(t("reveal"), () => reveal(cwd)));
				}
				return { title, items };
			}

			function buildWorkspaceItems(target) {
				const groupKey = target.groupKey;
				const workspace = workspaceByGroupKey(groupKey);
				const path = workspace?.path ?? "";
				const name = workspace?.title || rowText(target.row);
				const items = [];

				// 「未分组」不是真工作区（没有 workspaceId），没地方新建会话。
				if (workspace?.workspaceId && typeof uiWorkspace()?.startSession === "function") {
					items.push(item(t("newSession"), () => startSessionIn(workspace.workspaceId)));
					items.push(separator());
				}
				if (name !== "") items.push(item(t("copyName"), () => copy(name, t("copiedName"))));
				if (path !== "") {
					items.push(item(t("copyPath"), () => copy(path, t("copiedPath"))));
					items.push(item(t("reveal"), () => reveal(path)));
				}
				return { title: name, items };
			}

			function buildLinkItems(target) {
				const href = target.href;
				const items = [];
				if (href !== "") items.push(item(t("copyLink"), () => copy(href, t("copiedLink"))));
				const absolute = (() => {
					try {
						return new URL(href, location.href);
					} catch {
						return null;
					}
				})();
				if (absolute && (absolute.protocol === "http:" || absolute.protocol === "https:")) {
					items.push(item(t("openLink"), () => openExternal(absolute.toString())));
				}
				return { title: "", items };
			}

			function buildSelectionItems(target) {
				return { title: "", items: [item(t("copy"), () => copy(target.selection, t("copied")))] };
			}

			function buildEditableItems(target) {
				const { editable, selection } = target;
				const items = [];
				const focus = () => {
					try {
						editable.focus();
					} catch {
						// 元素已卸载就别管了。
					}
				};
				const selectAll = async () => {
					focus();
					if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select();
					else document.execCommand("selectAll");
				};
				if (selection !== "") {
					items.push(item(t("cut"), async () => {
						focus();
						if (!document.execCommand("cut")) throw new Error(t("clipboardUnavailable"));
					}));
					items.push(item(t("copy"), async () => {
						focus();
						if (!document.execCommand("copy")) throw new Error(t("clipboardUnavailable"));
					}));
				}
				items.push(item(t("paste"), async () => {
					focus();
					const text = await navigator.clipboard?.readText?.();
					if (typeof text !== "string") throw new Error(t("clipboardUnavailable"));
					if (!document.execCommand("insertText", false, text)) throw new Error(t("clipboardUnavailable"));
				}));
				items.push(item(t("selectAll"), selectAll));
				return { title: "", items };
			}

			/** 右键 → 菜单；没有可做的面就返回 null，让浏览器/外壳保持默认行为。 */
			function buildMenu(target, event) {
				if (!target) return null;
				let built;
				if (target.surface === "session") built = buildSessionItems(target);
				else if (target.surface === "workspace") built = buildWorkspaceItems(target);
				else if (target.surface === "link") built = buildLinkItems(target);
				else if (target.surface === "selection") built = buildSelectionItems(target);
				else if (target.surface === "editable") built = buildEditableItems(target);
				else return null;
				if (!built || built.items.filter((entry) => !entry.separator).length === 0) return null;
				return { kind: "menu", x: event.clientX, y: event.clientY, title: built.title, items: built.items };
			}

			/**
			 * 这一面是不是官方菜单负责的。
			 *
			 * 会话行/工作区行官方都挂了触发器，必须让给官方：再自绘一套就是 #110 里两个
			 * 菜单同时出现。但官方的触发器是按数据条件挂的——空白会话（`blank`，行标题
			 * 固定显示占位文案）传 undefined，没有路径的「未分组」工作区也没有——这些行
			 * 官方菜单根本不会打开，继续由本插件负责，否则右键就只剩浏览器自带菜单了。
			 */
			const nativeOwnsRow = (target) => {
				if (nativeMenus() === null) return false;
				if (target.surface === "session") {
					return sessionSummary(target.sessionId)?.blank !== true;
				}
				if (target.surface === "workspace") {
					const workspace = workspaceByGroupKey(target.groupKey);
					return Boolean(workspace?.workspaceId && workspace?.path);
				}
				return false;
			};

			// ---- 事件 ----
			const onContextMenu = (event) => {
				if (event.defaultPrevented) return;
				const target = targetOf(event);
				if (!target) return;
				if (nativeOwnsRow(target)) {
					// 不拦默认行为，官方菜单照常打开；自家覆盖层不能留在旁边。
					close();
					return;
				}
				const menu = buildMenu(target, event);
				if (!menu) return;
				event.preventDefault();
				event.stopPropagation();
				// 官方菜单可能已经开着（Shift+F10、行尾按钮先点开过）。官方自己的关闭逻辑只认
				// 没被 preventDefault 的 contextmenu，这里不主动关就会叠成两层。
				const menus = nativeMenus();
				if (menus) {
					try {
						menus.close();
					} catch {
						// 服务卸载中：没有菜单要关。
					}
				}
				store.set(menu);
			};

			const onPointerDown = (event) => {
				if (store.get()) {
					// 点在菜单/弹窗自己身上由组件处理；这一层只兜外面的点击。
					const element = event.target instanceof Element ? event.target : null;
					if (!element || !element.closest(".dsh-xcm-menu, .dsh-xcm-card")) close();
				}
			};

			const onKeyDown = (event) => {
				if (event.key === "Escape" && store.get()) {
					event.preventDefault();
					close();
				}
			};

			const onBlur = () => close();

			// 只认用户自己滚动：标题跑马灯、聊天流式输出、列表补位都会触发 scroll，
			// 按 scroll 关菜单会让「鼠标一动菜单就没了」。
			const onWheel = (event) => {
				if (!store.get()) return;
				const element = event.target instanceof Element ? event.target : null;
				if (element && element.closest(".dsh-xcm-menu, .dsh-xcm-card")) return;
				close();
			};

			document.addEventListener("contextmenu", onContextMenu, true);
			document.addEventListener("pointerdown", onPointerDown, true);
			document.addEventListener("keydown", onKeyDown, true);
			document.addEventListener("wheel", onWheel, { capture: true, passive: true });
			document.addEventListener("touchmove", onWheel, { capture: true, passive: true });
			window.addEventListener("blur", onBlur);
			window.addEventListener("resize", close);

			ctx.effect(() => () => {
				document.removeEventListener("contextmenu", onContextMenu, true);
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("keydown", onKeyDown, true);
				document.removeEventListener("wheel", onWheel, true);
				document.removeEventListener("touchmove", onWheel, true);
				window.removeEventListener("blur", onBlur);
				window.removeEventListener("resize", close);
			}, "dsh-x-context-menu: listeners");

			// ---- 覆盖层组件 ----
			function MenuItem({ entry, active, onHover, onRun }) {
				return h("div", {
					className: "dsh-xcm-item" + (active ? " active" : "") + (entry.danger ? " danger" : "") + (entry.disabled ? " disabled" : ""),
					role: "menuitem",
					"aria-disabled": entry.disabled ? "true" : undefined,
					onMouseEnter: onHover,
					onClick: () => { if (!entry.disabled) onRun(); },
				},
					h("span", null, entry.label),
					entry.hint ? h("span", { className: "dsh-xcm-hint" }, entry.hint) : null,
				);
			}

			function MenuView({ snapshot }) {
				const menuRef = React.useRef(null);
				const [active, setActive] = React.useState(0);
				const entries = React.useMemo(() => snapshot.items.filter((entry) => !entry.separator), [snapshot]);
				const indexOf = (entry) => entries.indexOf(entry);

				React.useLayoutEffect(() => {
					const element = menuRef.current;
					if (!element) return;
					const rect = element.getBoundingClientRect();
					const pad = 8;
					let left = snapshot.x;
					let top = snapshot.y;
					if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
					if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
					element.style.left = `${Math.round(left)}px`;
					element.style.top = `${Math.round(top)}px`;
					element.focus?.();
				}, [snapshot]);

				const run = (entry) => {
					if (!entry || entry.disabled) return;
					close();
					Promise.resolve()
						.then(() => entry.run())
						.catch(report);
				};

				const onKeyDown = (event) => {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setActive((index) => (index + 1) % entries.length);
					} else if (event.key === "ArrowUp") {
						event.preventDefault();
						setActive((index) => (index - 1 + entries.length) % entries.length);
					} else if (event.key === "Enter") {
						event.preventDefault();
						run(entries[active]);
					} else if (event.key === "Home") {
						event.preventDefault();
						setActive(0);
					} else if (event.key === "End") {
						event.preventDefault();
						setActive(entries.length - 1);
					}
				};

				return h("div", {
					className: "dsh-xcm-menu",
					ref: menuRef,
					role: "menu",
					tabIndex: -1,
					style: { left: snapshot.x, top: snapshot.y },
					onKeyDown,
					onContextMenu: (event) => event.preventDefault(),
				},
					snapshot.title ? h("div", { className: "dsh-xcm-title" }, snapshot.title) : null,
					snapshot.items.map((entry, index) => entry.separator
						? h("div", { key: `sep:${index}`, className: "dsh-xcm-sep", role: "separator" })
						: h(MenuItem, {
							key: entry.id,
							entry,
							active: indexOf(entry) === active,
							onHover: () => setActive(indexOf(entry)),
							onRun: () => run(entry),
						})),
				);
			}

			function PromptView({ snapshot }) {
				const [value, setValue] = React.useState(snapshot.value ?? "");
				const [busy, setBusy] = React.useState(false);
				const inputRef = React.useRef(null);

				React.useLayoutEffect(() => {
					const element = inputRef.current;
					if (!element) return;
					element.focus();
					element.select?.();
				}, []);

				const submit = async () => {
					if (busy) return;
					if (value.trim() === "") {
						toasts.show(t("emptyTitle"));
						return;
					}
					setBusy(true);
					try {
						await snapshot.onSubmit(value);
						close();
					} catch (error) {
						report(error);
						setBusy(false);
					}
				};

				return h("div", {
					className: "dsh-xcm-scrim",
					onMouseDown: (event) => { if (event.target === event.currentTarget) close(); },
				},
					h("div", { className: "dsh-xcm-card", role: "dialog", "aria-modal": "true" },
						h("h2", { className: "dsh-xcm-card-title" }, snapshot.title),
						snapshot.label ? h("label", { className: "dsh-xcm-card-label" }, snapshot.label) : null,
						h("input", {
							ref: inputRef,
							value,
							disabled: busy,
							onChange: (event) => setValue(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void submit();
								}
							},
						}),
						h("div", { className: "dsh-xcm-card-actions" },
							h("button", { type: "button", className: "dsh-xcm-btn", disabled: busy, onClick: close }, t("cancel")),
							h("button", { type: "button", className: "dsh-xcm-btn primary", disabled: busy, onClick: () => void submit() }, t("save")),
						),
					),
				);
			}

			/** 覆盖层：菜单 / 弹窗 / toast 都挂在这一个组件里。 */
			function MenuLayer() {
				const [snapshot, setSnapshot] = React.useState(() => store.get());
				const [toast, setToast] = React.useState(() => toasts.get());
				React.useEffect(() => store.subscribe(setSnapshot), []);
				React.useEffect(() => toasts.subscribe(setToast), []);

				const overlay = snapshot === null
					? null
					: snapshot.kind === "prompt"
						? h(PromptView, { snapshot })
						: h(MenuView, { snapshot });

				if (overlay === null && toast === null) return null;
				return h("div", { className: "dsh-xcm-layer" },
					overlay,
					toast !== null ? h("div", { className: "dsh-xcm-toast", role: "status" }, toast.text) : null,
				);
			}

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-x-context-menu: dictionaries");

			ctx.effect(() => {
				if (document.getElementById("dsh-xcm-style")) return () => {};
				const style = document.createElement("style");
				style.id = "dsh-xcm-style";
				style.textContent = STYLES;
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, "dsh-x-context-menu: styles");

			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "x-context-menu", order: 900 },
				MenuLayer,
			));
		}

		return { apply, inject };
	},
});
