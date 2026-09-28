// dsh-x-memory —— 浏览器端插件包：在 dsh 的设置页里加一块「记忆」。
//
// 记忆本体是磁盘上的 markdown 文件（<DSH_HOME>/memories/<工作区>/），这块面板只是它们的
// 浏览器：按工作区列出条目、看正文、编辑、删除、看索引。所有数据走主机侧那组
// /api/x-memory/*（仅限环回）。
//
// 客户端插件的入口形态是 window.__ModuleLoader__.load({ id, factory })，
// 里面用 require('react')（不是 ESM import）。
window.__ModuleLoader__.load({
	id: "dsh-x-memory",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** 需要的 ctx 服务：插槽（注册设置页条目）与词典。 */
		const inject = ["slots", "locale"];

		const NS = "x-memory";
		const TYPES = ["user", "feedback", "project", "reference"];
		const STYLES = `
.dsh-xmem { display: flex; flex-direction: column; gap: 14px; }
.dsh-xmem-group { border: 1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius: 12px; overflow: hidden; }
.dsh-xmem-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; }
.dsh-xmem-row + .dsh-xmem-row { border-top: 1px solid var(--dsh-border, rgba(128,128,128,.18)); }
.dsh-xmem-row.stacked { display: block; }
.dsh-xmem-text { min-width: 0; }
.dsh-xmem-name { display: block; font-size: 13px; font-weight: 600; }
.dsh-xmem-desc { display: block; margin-top: 3px; font-size: 12px; line-height: 1.6; opacity: .72; }
.dsh-xmem-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.dsh-xmem input[type=text], .dsh-xmem select, .dsh-xmem textarea {
	background: var(--dsh-input-bg, transparent); color: inherit; border: 1px solid var(--dsh-border, rgba(128,128,128,.35));
	border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12px; min-width: 0;
}
.dsh-xmem textarea { width: 100%; min-height: 160px; line-height: 1.6; resize: vertical; font-family: var(--dsh-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.dsh-xmem input[type=checkbox] { width: 16px; height: 16px; }
.dsh-xmem-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dsh-xmem-btn { border: 1px solid var(--dsh-border, rgba(128,128,128,.35)); background: transparent; color: inherit;
	border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 12px; cursor: pointer; }
.dsh-xmem-btn:hover:not(:disabled) { border-color: var(--dsh-accent, #3b6fe0); }
.dsh-xmem-btn:disabled { opacity: .5; cursor: default; }
.dsh-xmem-btn.primary { border-color: var(--dsh-accent, #3b6fe0); color: var(--dsh-accent, #3b6fe0); }
.dsh-xmem-btn.danger:hover:not(:disabled) { border-color: var(--dsh-danger, #d9534f); color: var(--dsh-danger, #d9534f); }
.dsh-xmem-hint { margin: 0; font-size: 12px; line-height: 1.6; opacity: .78; white-space: pre-wrap; }
.dsh-xmem-hint.error { color: var(--dsh-danger, #d9534f); opacity: 1; }
.dsh-xmem-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 14px; }
.dsh-xmem-item + .dsh-xmem-item { border-top: 1px solid var(--dsh-border, rgba(128,128,128,.18)); }
.dsh-xmem-badge { flex: 0 0 auto; margin-right: 8px; padding: 1px 7px; border-radius: 999px; font-size: 11px;
	border: 1px solid var(--dsh-border, rgba(128,128,128,.4)); opacity: .85; }
.dsh-xmem-pre { margin: 0; padding: 12px 14px; font-size: 12px; line-height: 1.7; white-space: pre-wrap;
	font-family: var(--dsh-mono, ui-monospace, SFMono-Regular, Menlo, monospace); opacity: .9; }
.dsh-xmem-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px 14px; }
.dsh-xmem-fields .full { grid-column: 1 / -1; }
.dsh-xmem-label { display: block; font-size: 12px; opacity: .72; margin-bottom: 4px; }
`;

		/** 界面文案。 */
		const zh = {
			title: "记忆",
			subtitle: "跨会话的长期记忆：一条事实一个 Markdown 文件 + MEMORY.md 索引，按工作区分开存放。模型用 memory_* 工具读写；这里可以直接看、改、删。",
			workspace: "工作区",
			workspaceDesc: "记忆按会话的工作区分开存放；切到某个工作区看它的记忆。",
			noWorkspaces: "还没有任何记忆目录——等模型第一次写记忆，或点「新建」创建一条。",
			stat: (count, type) => `${count} 条 · ${type}`,
			newMemory: "新建记忆",
			refresh: "刷新",
			showIndex: "查看索引",
			hideIndex: "收起索引",
			reindex: "重建索引",
			empty: "这个工作区还没有记忆。",
			edit: "编辑",
			remove: "删除",
			confirmRemove: (name) => `删除「${name}」？文件会被真的删掉。`,
			fieldName: "文件名（slug，留空自动生成）",
			fieldTitle: "标题（给人看）",
			fieldType: "类型",
			fieldDescription: "一句话说明（召回时用它判断相关性）",
			fieldContent: "正文（一条事实，几行写完；相关记忆用 [[name]] 互链）",
			save: "保存",
			cancel: "取消",
			created: (name) => `已新建 ${name}.md`,
			updated: (name) => `已更新 ${name}.md`,
			deleted: (name) => `已删除 ${name}.md`,
			reindexed: (count) => `索引已重建（${count} 条）`,
			autoInject: "自动注入记忆索引",
			autoInjectDesc: "会话开始时把 MEMORY.md 索引注入上下文；关掉后模型只能自己用 memory_search 查。",
			freeze: "索引每会话冻结",
			freezeDesc: "索引在会话里只渲染一次——中途写记忆不会改变已经注入的内容（推荐）。",
			perWorkspace: "按工作区分开",
			perWorkspaceDesc: "每个工作区一份记忆；关掉则所有工作区共用一份（放 memories/shared）。",
			savedConfig: "设置已保存",
			root: "存储位置",
			typeUser: "用户",
			typeFeedback: "反馈",
			typeProject: "项目",
			typeReference: "参考",
		};
		const en = {
			title: "Memory",
			subtitle: "Cross-session long-term memory: one fact per Markdown file plus a MEMORY.md index, kept per workspace. The model reads and writes it with the memory_* tools; here you can inspect, edit and delete.",
			workspace: "Workspace",
			workspaceDesc: "Memories are kept per session workspace; switch to inspect another one.",
			noWorkspaces: "No memory directory yet — wait for the model to save one, or create a memory yourself.",
			stat: (count, type) => `${count} entries · ${type}`,
			newMemory: "New memory",
			refresh: "Refresh",
			showIndex: "Show index",
			hideIndex: "Hide index",
			reindex: "Rebuild index",
			empty: "No memories in this workspace yet.",
			edit: "Edit",
			remove: "Delete",
			confirmRemove: (name) => `Delete "${name}"? The file is removed for real.`,
			fieldName: "File name (slug; leave empty to derive)",
			fieldTitle: "Title",
			fieldType: "Type",
			fieldDescription: "One-line summary (decides relevance during recall)",
			fieldContent: "Body (one fact, a few lines; link related memories with [[name]])",
			save: "Save",
			cancel: "Cancel",
			created: (name) => `Created ${name}.md`,
			updated: (name) => `Updated ${name}.md`,
			deleted: (name) => `Deleted ${name}.md`,
			reindexed: (count) => `Index rebuilt (${count} entries)`,
			autoInject: "Inject the memory index",
			autoInjectDesc: "Inject MEMORY.md into the context at session start; when off the model must call memory_search itself.",
			freeze: "Freeze the index per session",
			freezeDesc: "Render the index once per session — saving a memory mid-session leaves what was injected unchanged (recommended).",
			perWorkspace: "Separate per workspace",
			perWorkspaceDesc: "One memory store per workspace; off means every workspace shares memories/shared.",
			savedConfig: "Settings saved",
			root: "Storage",
			typeUser: "user",
			typeFeedback: "feedback",
			typeProject: "project",
			typeReference: "reference",
		};

		/** 类型 → 词典键。 */
		const typeKey = (type) => `type${type.slice(0, 1).toUpperCase()}${type.slice(1)}`;

		async function api(path, options) {
			const response = await fetch(path, {
				headers: { "content-type": "application/json" },
				...options,
			});
			const value = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
			return value;
		}

		function MemoryPanel(props) {
			// 翻译函数由设置页宿主通过 props 传进来；带参数的文案（统计、确认框）在本地词典里是函数。
			const t = (key, ...args) => {
				let value;
				try { value = props?.t?.(key); } catch { value = undefined; }
				if (typeof value !== "string") value = zh[key];
				if (typeof value === "function") return value(...args);
				return value ?? key;
			};
			const [state, setState] = React.useState(null);
			const [workspace, setWorkspace] = React.useState("");
			const [entries, setEntries] = React.useState([]);
			const [stats, setStats] = React.useState(null);
			const [indexText, setIndexText] = React.useState(null);
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [hint, setHint] = React.useState("");

			const load = React.useCallback(async (key) => {
				setBusy(true);
				setError("");
				try {
					const next = await api("/api/x-memory/state");
					setState(next);
					let current = key;
					if (!current || !(next.workspaces ?? []).some((row) => row.key === current)) {
						current = next.workspaces?.[0]?.key ?? "";
					}
					setWorkspace(current);
					if (current) {
						const listed = await api(`/api/x-memory/list?workspace=${encodeURIComponent(current)}`);
						setEntries(listed.entries ?? []);
						setStats(listed.stats ?? null);
					} else {
						setEntries([]);
						setStats(null);
					}
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			}, []);

			React.useEffect(() => { load(""); }, [load]);

			const pickWorkspace = async (key) => {
				setWorkspace(key);
				setIndexText(null);
				setDraft(null);
				setBusy(true);
				setError("");
				try {
					const listed = await api(`/api/x-memory/list?workspace=${encodeURIComponent(key)}`);
					setEntries(listed.entries ?? []);
					setStats(listed.stats ?? null);
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			};

			const patchConfig = async (patch) => {
				setBusy(true);
				setError("");
				try {
					const saved = await api("/api/x-memory/config", { method: "POST", body: JSON.stringify(patch) });
					setState((prev) => (prev ? { ...prev, config: saved.config } : prev));
					setHint(t("savedConfig"));
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			};

			const openEditor = async (entry) => {
				if (entry) {
					setBusy(true);
					setError("");
					try {
						const full = await api(`/api/x-memory/read?workspace=${encodeURIComponent(workspace)}&name=${encodeURIComponent(entry.name)}`);
						setDraft({ mode: "edit", name: full.entry.name, title: full.entry.title, type: full.entry.type, description: full.entry.description ?? "", content: full.entry.body ?? "" });
					} catch (err) {
						setError(err.message);
					} finally {
						setBusy(false);
					}
					return;
				}
				setDraft({ mode: "new", name: "", title: "", type: "project", description: "", content: "" });
			};

			const submitDraft = async () => {
				if (!draft) return;
				setBusy(true);
				setError("");
				try {
					if (draft.mode === "new") {
						const saved = await api("/api/x-memory/save", {
							method: "POST",
							body: JSON.stringify({ workspace, name: draft.name || undefined, title: draft.title, type: draft.type, description: draft.description, content: draft.content }),
						});
						setHint(t("created", saved.name));
					} else {
						await api("/api/x-memory/update", {
							method: "POST",
							body: JSON.stringify({ workspace, name: draft.name, title: draft.title, type: draft.type, description: draft.description, content: draft.content }),
						});
						setHint(t("updated", draft.name));
					}
					setDraft(null);
					await load(workspace);
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			};

			const removeEntry = async (entry) => {
				if (!window.confirm(t("confirmRemove", entry.title || entry.name))) return;
				setBusy(true);
				setError("");
				try {
					await api("/api/x-memory/delete", { method: "POST", body: JSON.stringify({ workspace, name: entry.name }) });
					setHint(t("deleted", entry.name));
					await load(workspace);
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			};

			const toggleIndex = async () => {
				if (indexText !== null) {
					setIndexText(null);
					return;
				}
				setBusy(true);
				setError("");
				try {
					const rebuilt = await api(`/api/x-memory/index?workspace=${encodeURIComponent(workspace)}`);
					setIndexText(rebuilt.text ?? "");
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			};

			const config = state?.config ?? {};
			const typeSummary = TYPES.map((type) => `${t(typeKey(type))} ${stats?.byType?.[type] ?? 0}`).join(" / ");

			return h("div", { className: "dsh-xmem" },
				h("p", { className: "dsh-xmem-hint" }, t("subtitle")),

				h("div", { className: "dsh-xmem-group" },
					h("div", { className: "dsh-xmem-row" },
						h("div", { className: "dsh-xmem-text" },
							h("span", { className: "dsh-xmem-name" }, t("workspace")),
							h("span", { className: "dsh-xmem-desc" }, t("workspaceDesc"))),
						h("div", { className: "dsh-xmem-control" },
							(state?.workspaces?.length ?? 0) > 1
								? h("select", { value: workspace, onChange: (event) => pickWorkspace(event.target.value) },
									(state?.workspaces ?? []).map((row) => h("option", { key: row.key, value: row.key }, `${row.key}（${row.count}）`)))
								: null,
							h("button", { className: "dsh-xmem-btn", disabled: busy, onClick: () => load(workspace) }, t("refresh")))),
					stats
						? h("div", { className: "dsh-xmem-row" },
							h("div", { className: "dsh-xmem-text" },
								h("span", { className: "dsh-xmem-name" }, t("root")),
								h("span", { className: "dsh-xmem-desc" }, `${stats.rootDir}\n${typeSummary}`)))
						: null,
					h("div", { className: "dsh-xmem-row" },
						h("div", { className: "dsh-xmem-control" },
							h("button", { className: "dsh-xmem-btn", disabled: busy || !workspace, onClick: () => openEditor(null) }, t("newMemory")),
							h("button", { className: "dsh-xmem-btn", disabled: busy || !workspace, onClick: toggleIndex }, indexText !== null ? t("hideIndex") : t("showIndex")),
							h("button", { className: "dsh-xmem-btn", disabled: busy || !workspace, onClick: async () => { await api(`/api/x-memory/index?workspace=${encodeURIComponent(workspace)}`); setHint(t("reindexed", entries.length)); } }, t("reindex"))))),

				indexText !== null ? h("div", { className: "dsh-xmem-group" }, h("pre", { className: "dsh-xmem-pre" }, indexText || "(空)")) : null,

				draft
					? h("div", { className: "dsh-xmem-group" },
						h("div", { className: "dsh-xmem-fields" },
							h("label", null,
								h("span", { className: "dsh-xmem-label" }, t("fieldTitle")),
								h("input", { type: "text", value: draft.title, disabled: draft.mode === "edit", onChange: (event) => setDraft({ ...draft, title: event.target.value }) })),
							h("label", null,
								h("span", { className: "dsh-xmem-label" }, t("fieldType")),
								h("select", { value: draft.type, onChange: (event) => setDraft({ ...draft, type: event.target.value }) },
									TYPES.map((type) => h("option", { key: type, value: type }, t(typeKey(type)))))),
							h("label", { className: "full" },
								h("span", { className: "dsh-xmem-label" }, t("fieldName")),
								h("input", { type: "text", value: draft.name, disabled: draft.mode === "edit", placeholder: "memory-slug", onChange: (event) => setDraft({ ...draft, name: event.target.value }) })),
							h("label", { className: "full" },
								h("span", { className: "dsh-xmem-label" }, t("fieldDescription")),
								h("input", { type: "text", value: draft.description, onChange: (event) => setDraft({ ...draft, description: event.target.value }) })),
							h("label", { className: "full" },
								h("span", { className: "dsh-xmem-label" }, t("fieldContent")),
								h("textarea", { value: draft.content, onChange: (event) => setDraft({ ...draft, content: event.target.value }) }))),
						h("div", { className: "dsh-xmem-row" },
							h("div", { className: "dsh-xmem-control" },
								h("button", { className: "dsh-xmem-btn primary", disabled: busy || !draft.title.trim() || !draft.content.trim(), onClick: submitDraft }, t("save")),
								h("button", { className: "dsh-xmem-btn", disabled: busy, onClick: () => setDraft(null) }, t("cancel")))))
					: null,

				h("div", { className: "dsh-xmem-group" },
					entries.length === 0
						? h("div", { className: "dsh-xmem-row" }, h("p", { className: "dsh-xmem-hint" }, workspace ? t("empty") : t("noWorkspaces")))
						: entries.map((entry) => h("div", { className: "dsh-xmem-item", key: entry.name },
							h("div", { className: "dsh-xmem-text" },
								h("span", { className: "dsh-xmem-name" },
									h("span", { className: "dsh-xmem-badge" }, t(typeKey(entry.type))),
									entry.title || entry.name,
									entry.title && entry.title !== entry.name ? h("span", { className: "dsh-xmem-desc" }, ` (${entry.name}.md)`) : null),
								h("span", { className: "dsh-xmem-desc" }, entry.description || "")),
							h("div", { className: "dsh-xmem-control" },
								h("button", { className: "dsh-xmem-btn", disabled: busy, onClick: () => openEditor(entry) }, t("edit")),
								h("button", { className: "dsh-xmem-btn danger", disabled: busy, onClick: () => removeEntry(entry) }, t("remove")))))),

				h("div", { className: "dsh-xmem-group" },
					h("div", { className: "dsh-xmem-row" },
						h("div", { className: "dsh-xmem-text" },
							h("span", { className: "dsh-xmem-name" }, t("autoInject")),
							h("span", { className: "dsh-xmem-desc" }, t("autoInjectDesc"))),
						h("input", { type: "checkbox", checked: config.autoInject !== false, disabled: busy, onChange: (event) => patchConfig({ autoInject: event.target.checked }) })),
					h("div", { className: "dsh-xmem-row" },
						h("div", { className: "dsh-xmem-text" },
							h("span", { className: "dsh-xmem-name" }, t("freeze")),
							h("span", { className: "dsh-xmem-desc" }, t("freezeDesc"))),
						h("input", { type: "checkbox", checked: config.freezeIndexPerSession !== false, disabled: busy, onChange: (event) => patchConfig({ freezeIndexPerSession: event.target.checked }) })),
					h("div", { className: "dsh-xmem-row" },
						h("div", { className: "dsh-xmem-text" },
							h("span", { className: "dsh-xmem-name" }, t("perWorkspace")),
							h("span", { className: "dsh-xmem-desc" }, t("perWorkspaceDesc"))),
						h("input", { type: "checkbox", checked: config.perWorkspace !== false, disabled: busy, onChange: (event) => patchConfig({ perWorkspace: event.target.checked }) }))),

				error ? h("p", { className: "dsh-xmem-hint error" }, error) : null,
				hint ? h("p", { className: "dsh-xmem-hint" }, hint) : null,
			);
		}

		/** 注册词典、样式与设置页那块面板。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-x-memory: dictionaries");
			ctx.effect(() => {
				if (document.getElementById("dsh-xmem-style")) return () => {};
				const style = document.createElement("style");
				style.id = "dsh-xmem-style";
				style.textContent = STYLES;
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, "dsh-x-memory: styles");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "x-memory", order: 34, label: () => ctx.locale.t?.(NS, "title") ?? "记忆", locale: NS },
				MemoryPanel,
			));
		}

		return { apply, inject };
	},
});
