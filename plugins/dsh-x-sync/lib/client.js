// dsh-x-sync —— 浏览器端插件包：在 dsh 的设置页里加一块「同步」。
//
// 与 DSH-X 启动器上的那块面板同源：存储类型（S3 / WebDAV / 本地目录 / ZIP）、
// 同步范围、冲突策略、上传/下载/停止、进度与结果明细。配置由主机侧写进当前
// profile 目录下的 dsh-x-sync.json，浏览器只跟 /api/x-sync/* 打交道。
//
// 客户端插件的入口形态是 window.__ModuleLoader__.load({ id, factory })，
// 里面用 require('react')（不是 ESM import）。
window.__ModuleLoader__.load({
	id: "dsh-x-sync",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** 需要的 ctx 服务：插槽（注册设置页条目）与词典。 */
		const inject = ["slots", "locale"];

		const NS = "x-sync";
		const STYLES = `
.dsh-xsync { display: flex; flex-direction: column; gap: 14px; }
.dsh-xsync-group { border: 1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius: 12px; overflow: hidden; }
.dsh-xsync-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; }
.dsh-xsync-row + .dsh-xsync-row { border-top: 1px solid var(--dsh-border, rgba(128,128,128,.18)); }
.dsh-xsync-row.stacked { display: block; }
.dsh-xsync-text { min-width: 0; }
.dsh-xsync-name { display: block; font-size: 13px; font-weight: 600; }
.dsh-xsync-desc { display: block; margin-top: 3px; font-size: 12px; line-height: 1.6; opacity: .72; }
.dsh-xsync-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.dsh-xsync-row.stacked .dsh-xsync-control { margin-top: 8px; }
.dsh-xsync input[type=text], .dsh-xsync input[type=password], .dsh-xsync select {
	background: var(--dsh-input-bg, transparent); color: inherit; border: 1px solid var(--dsh-border, rgba(128,128,128,.35));
	border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12px; min-width: 0;
}
.dsh-xsync-row.stacked .dsh-xsync-control input[type=text],
.dsh-xsync-row.stacked .dsh-xsync-control input[type=password] { flex: 1 1 auto; width: 100%; }
.dsh-xsync input[type=checkbox] { width: 16px; height: 16px; }
.dsh-xsync-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dsh-xsync-btn { border: 1px solid var(--dsh-border, rgba(128,128,128,.35)); background: transparent; color: inherit;
	border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 12px; cursor: pointer; }
.dsh-xsync-btn:hover:not(:disabled) { border-color: var(--dsh-accent, #3b6fe0); }
.dsh-xsync-btn:disabled { opacity: .5; cursor: default; }
.dsh-xsync-btn.primary { border-color: var(--dsh-accent, #3b6fe0); color: var(--dsh-accent, #3b6fe0); }
.dsh-xsync-hint { margin: 0; font-size: 12px; line-height: 1.6; opacity: .78; white-space: pre-wrap; }
.dsh-xsync-hint.error { color: var(--dsh-danger, #d9534f); opacity: 1; }
.dsh-xsync-bar { height: 4px; border-radius: 999px; background: var(--dsh-border, rgba(128,128,128,.25)); overflow: hidden; }
.dsh-xsync-bar > div { height: 100%; background: var(--dsh-accent, #3b6fe0); transition: width .2s ease; }
.dsh-xsync-scope { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; cursor: pointer; }
.dsh-xsync-scope + .dsh-xsync-scope { border-top: 1px solid var(--dsh-border, rgba(128,128,128,.18)); }
`;
		const STYLE_ID = "dsh-xsync-style";

		/** 界面文案（主机侧与工具返回的中文是同源的，这里只管面板自己的）。 */
		const zh = {
			title: "同步",
			subtitle: "会话、附件、插件配置、技能与记忆 —— 传到远端，或从一个本地目录 / ZIP 导入导出。与 DSH-X 启动器共用同一只桶。",
			remote: "远端存储",
			storeType: "存储类型",
			storeDesc: "S3 兼容存储、WebDAV、本地目录或单个 ZIP 文件。几套配置各存一份，来回切换不用重填。",
			s3: "S3 兼容存储",
			webdav: "WebDAV",
			folder: "本地目录（导出 / 导入）",
			zip: "ZIP 文件（导出 / 导入）",
			endpoint: "存储端点",
			endpointDesc: "S3 兼容服务的地址。也可以直接贴 s3://桶名/前缀（按下面的区域补成 AWS 端点）。",
			region: "区域",
			regionDesc: "AWS 看桶所在区域；R2 填 auto；自建存储填什么都行。",
			style: "寻址风格",
			styleAuto: "自动",
			stylePath: "路径风格（MinIO 等）",
			styleVirtual: "虚拟主机",
			bucket: "桶名",
			prefix: "桶内前缀",
			prefixDesc: "留空就放在桶根目录下；多台机器共用同一只桶时填机器名。",
			accessKey: "AccessKey",
			secretKey: "SecretKey",
			secretDesc: "密钥只存在本机这个 profile 的配置文件里（明文），不会进会话日志。",
			sessionToken: "会话令牌（可选）",
			davUrl: "WebDAV 地址",
			davUrlDesc: "要写到具体目录。坚果云：账户信息 → 安全选项 → 添加应用密码；Nextcloud：/remote.php/dav/files/用户名。",
			davUser: "用户名",
			davSecret: "密码",
			davSecretDesc: "只做 Basic 认证，务必走 https；同样明文存在本机配置文件里。",
			davPrefix: "目录前缀",
			folderPath: "导出目录",
			folderPathDesc: "导出的内容放在这个文件夹里（布局和远端一样）。别选 dsh 用户目录里面的目录——会自己套自己。",
			zipPath: "ZIP 文件",
			zipPathDesc: "一个文件装下所有内容：导出写这个 .zip，导入从这个 .zip 合并回来。别人用压缩工具打好的包也能导入。",
			insecure: "跳过证书校验",
			insecureDesc: "自建存储用了自签名证书时才打开。",
			scopes: "同步什么",
			scopeSessions: "会话记录",
			scopeSessionsDesc: "每个项目的聊天记录",
			scopeAttachments: "附件",
			scopeAttachmentsDesc: "对话里贴的图片和文件",
			scopePlugins: "插件与配置",
			scopePluginsDesc: "当前 profile 的插件清单与补丁层（拉下来会自动重装依赖）",
			scopeSkills: "技能",
			scopeSkillsDesc: "dsh 与 agents 两个用户级技能目录",
			scopeMemory: "记忆",
			scopeMemoryDesc: "dsh 的长期记忆目录",
			policy: "两边不一样时",
			policyDesc: "下载时碰上「本机也有、内容却不同」的文件怎么办。",
			policySkip: "保留本机",
			policyOverwrite: "用远端的覆盖本机",
			policyDuplicate: "两份都留",
			check: "检测连接",
			checkFolder: "检查目录",
			checkZip: "检查文件",
			up: "上传",
			down: "下载",
			export: "导出",
			import: "导入",
			stop: "停止",
			browse: "浏览…",
			choose: "选择…",
			busy: "正在准备…",
			scanning: "正在扫描 {label}…",
			working: "{verb} {label} {done}/{total}",
			runningInstall: "插件清单变了，正在重装依赖…",
			ready: "已保存。",
			checking: "正在检查…",
			stopped: "正在停下来，做完手上这个就收口…",
			notConfigured: "还没填完：{missing}",
			willSyncTo: "将同步到 {url}",
			connected: "连上了：{host} · {ns} {state}",
			hasContent: "已有内容",
			emptyRemote: "还没有内容",
			doneUp: "{verb}完成：{n} 个文件{extra}",
			extraSkipped: "，跳过 {n} 个",
			extraMerged: "，插件清单已合并",
			extraInstalled: "，依赖已重装",
			failed: "同步失败：{error}",
		};
		const en = {
			title: "Sync",
			subtitle: "Sessions, attachments, plugin config, skills and memory — pushed to a remote, or exported/imported as a local folder / single ZIP. Shares the same bucket as the DSH-X launcher.",
			remote: "Remote storage",
			storeType: "Storage type",
			storeDesc: "S3-compatible storage, WebDAV, a local folder, or a single ZIP file. Each keeps its own settings, so switching back and forth loses nothing.",
			s3: "S3-compatible",
			webdav: "WebDAV",
			folder: "Local folder (export / import)",
			zip: "ZIP file (export / import)",
			endpoint: "Endpoint",
			endpointDesc: "Address of the S3-compatible service; s3://bucket/prefix also works.",
			region: "Region",
			regionDesc: "Bucket region for AWS; auto for R2; anything for self-hosted.",
			style: "Addressing style",
			styleAuto: "Automatic",
			stylePath: "Path style (MinIO…)",
			styleVirtual: "Virtual-host style",
			bucket: "Bucket",
			prefix: "Key prefix",
			prefixDesc: "Empty = bucket root; use the machine name when several machines share one bucket.",
			accessKey: "AccessKey",
			secretKey: "SecretKey",
			secretDesc: "Kept in this profile's config file on this machine (plain text); never written to session logs.",
			sessionToken: "Session token (optional)",
			davUrl: "WebDAV address",
			davUrlDesc: "Point it at the folder to use. Jianguo Cloud: account info → security options → add an app password. Nextcloud: /remote.php/dav/files/<user>.",
			davUser: "Username",
			davSecret: "Password",
			davSecretDesc: "Basic auth only — keep it on https. Stored in plain text in the local config file.",
			davPrefix: "Folder prefix",
			folderPath: "Export folder",
			folderPathDesc: "Everything is exported into this folder (same layout as the remote). Do not pick a folder inside the dsh home — the export would include itself.",
			zipPath: "ZIP file",
			zipPathDesc: "One file holds everything: export writes this .zip, import merges from it. Zips made by other tools work too.",
			insecure: "Skip certificate check",
			insecureDesc: "Only for self-hosted storage with a self-signed certificate.",
			scopes: "What to sync",
			scopeSessions: "Chat sessions",
			scopeSessionsDesc: "Conversation history per project",
			scopeAttachments: "Attachments",
			scopeAttachmentsDesc: "Images and files pasted into conversations",
			scopePlugins: "Plugins and config",
			scopePluginsDesc: "This profile's plugin manifest and patch layer (dependencies are reinstalled after a pull)",
			scopeSkills: "Skills",
			scopeSkillsDesc: "Both user-level skill folders: dsh and agents",
			scopeMemory: "Memory",
			scopeMemoryDesc: "dsh's long-term memory folder",
			policy: "When both sides differ",
			policyDesc: "What to do when a download finds a file that also exists locally with different content.",
			policySkip: "Keep local",
			policyOverwrite: "Overwrite with the remote copy",
			policyDuplicate: "Keep both",
			check: "Test connection",
			checkFolder: "Check folder",
			checkZip: "Check file",
			up: "Upload",
			down: "Download",
			export: "Export",
			import: "Import",
			stop: "Stop",
			browse: "Browse…",
			choose: "Choose…",
			busy: "Getting ready…",
			scanning: "Scanning {label}…",
			working: "{verb} {label} {done}/{total}",
			runningInstall: "The plugin manifest changed; reinstalling dependencies…",
			ready: "Saved.",
			checking: "Checking…",
			stopped: "Stopping after the current file…",
			notConfigured: "Not filled in yet: {missing}",
			willSyncTo: "Syncing to {url}",
			connected: "Connected: {host} · {ns} {state}",
			hasContent: "has content",
			emptyRemote: "is empty",
			doneUp: "{verb} finished: {n} file(s){extra}",
			extraSkipped: ", skipped {n}",
			extraMerged: ", manifest merged",
			extraInstalled: ", dependencies reinstalled",
			failed: "Sync failed: {error}",
		};

		const SCOPE_ROWS = [
			["sessions", "scopeSessions", "scopeSessionsDesc"],
			["attachments", "scopeAttachments", "scopeAttachmentsDesc"],
			["plugins", "scopePlugins", "scopePluginsDesc"],
			["skills", "scopeSkills", "scopeSkillsDesc"],
			["memory", "scopeMemory", "scopeMemoryDesc"],
		];

		/** 面板：读写 /api/x-sync/*，其余交给主机侧。 */
		function SyncPanel(props) {
			const t = props.t;
			const [config, setConfig] = React.useState(null);
			const [state, setState] = React.useState(null);
			const [note, setNote] = React.useState("");
			const [error, setError] = React.useState("");
			const [hint, setHint] = React.useState("");
			const busyRef = React.useRef(false);

			const call = React.useCallback(async (path, body) => {
				const response = await fetch(path, {
					method: body === undefined ? "GET" : "POST",
					headers: { "content-type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				});
				const data = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
				return data;
			}, []);

			const load = React.useCallback(async () => {
				try {
					const data = await call("/api/x-sync/config");
					setConfig(data.config);
					setState(data.state);
				} catch (err) {
					setError(err.message);
				}
			}, [call]);

			React.useEffect(() => { load(); }, [load]);

			// 跑同步时轮询进度（面板不需要 SSE，1 秒一次足够）
			React.useEffect(() => {
				const phase = state?.phase;
				if (!phase || phase === "done" || phase === "error" || phase === "idle") return undefined;
				const timer = setInterval(async () => {
					try {
						const data = await call("/api/x-sync/state");
						setState(data.state);
					} catch { /* 下一轮再说 */ }
				}, 1000);
				return () => clearInterval(timer);
			}, [state, call]);

			const patch = async (part) => {
				try {
					const data = await call("/api/x-sync/config", part);
					setConfig(data.config);
					setNote(t("ready"));
					setError("");
				} catch (err) {
					setError(err.message);
				}
			};
			const setStore = (store) => patch({ store });
			const setScope = (scope, on) => {
				const current = new Set(config?.scopes ?? []);
				if (on) current.add(scope); else current.delete(scope);
				patch({ scopes: [...current] });
			};

			if (!config) {
				return h("div", { className: "dsh-xsync" }, h("p", { className: "dsh-xsync-hint" }, error || t("busy")));
			}

			const store = config.store;
			const isFolder = store === "folder";
			const isZip = store === "zip";
			const local = isFolder || isZip;
			const setField = (group, key, value) => patch({ [group]: { ...config[group], [key]: value } });
			const field = (group, key, labelKey, descKey, options = {}) => {
				const value = config[group]?.[key] ?? "";
				const input = h("input", {
					type: options.password ? "password" : "text",
					value,
					placeholder: options.placeholder || "",
					onChange: (event) => setField(group, key, event.target.value),
				});
				const browse = options.browse
					? h("button", {
						type: "button",
						className: "dsh-xsync-btn",
						onClick: async () => {
							try {
								const data = await call("/api/x-sync/pick", { mode: options.browse });
								if (data.path) setField(group, key, data.path);
							} catch (err) { setError(err.message); }
						},
					}, t(options.browse === "dir" ? "browse" : "choose"))
					: null;
				return h("div", { className: "dsh-xsync-row stacked", key: `${group}.${key}` },
					h("div", { className: "dsh-xsync-text" },
						h("span", { className: "dsh-xsync-name" }, t(labelKey)),
						descKey ? h("span", { className: "dsh-xsync-desc" }, t(descKey)) : null),
					h("div", { className: "dsh-xsync-control" }, input, browse),
				);
			};
			const toggleRow = (group, key, labelKey, descKey) => h("label", { className: "dsh-xsync-row", key: `${group}.${key}` },
				h("div", { className: "dsh-xsync-text" },
					h("span", { className: "dsh-xsync-name" }, t(labelKey)),
					descKey ? h("span", { className: "dsh-xsync-desc" }, t(descKey)) : null),
				h("input", {
					type: "checkbox",
					checked: config[group]?.[key] === true,
					onChange: (event) => setField(group, key, event.target.checked),
				}));

			const remoteFields = [];
			if (store === "s3") {
				remoteFields.push(field("s3", "endpoint", "endpoint", "endpointDesc", { placeholder: "https://s3.us-east-1.amazonaws.com" }));
				remoteFields.push(field("s3", "region", "region", "regionDesc", { placeholder: "us-east-1" }));
				remoteFields.push(h("div", { className: "dsh-xsync-row", key: "style" },
					h("div", { className: "dsh-xsync-text" }, h("span", { className: "dsh-xsync-name" }, t("style"))),
					h("select", { value: config.s3?.style || "auto", onChange: (event) => setField("s3", "style", event.target.value) },
						h("option", { value: "auto" }, t("styleAuto")),
						h("option", { value: "path" }, t("stylePath")),
						h("option", { value: "virtual" }, t("styleVirtual")))));
				remoteFields.push(field("s3", "bucket", "bucket", null, { placeholder: "my-bucket" }));
				remoteFields.push(field("s3", "prefix", "prefix", "prefixDesc", { placeholder: "laptop" }));
				remoteFields.push(field("s3", "accessKeyId", "accessKey", null, { placeholder: "AKIA…" }));
				remoteFields.push(field("s3", "secretAccessKey", "secretKey", "secretDesc", { password: true }));
				remoteFields.push(field("s3", "sessionToken", "sessionToken", null, { password: true }));
				remoteFields.push(toggleRow("s3", "insecure", "insecure", "insecureDesc"));
			} else if (store === "webdav") {
				remoteFields.push(field("webdav", "url", "davUrl", "davUrlDesc", { placeholder: "https://dav.jianguoyun.com/dav/我的目录" }));
				remoteFields.push(field("webdav", "username", "davUser", null, { placeholder: "you@example.com" }));
				remoteFields.push(field("webdav", "password", "davSecret", "davSecretDesc", { password: true }));
				remoteFields.push(field("webdav", "prefix", "davPrefix", "prefixDesc", { placeholder: "laptop" }));
				remoteFields.push(toggleRow("webdav", "insecure", "insecure", "insecureDesc"));
			} else if (isFolder) {
				remoteFields.push(field("folder", "path", "folderPath", "folderPathDesc", { placeholder: "D:\\dsh-backup", browse: "dir" }));
			} else if (isZip) {
				remoteFields.push(field("zip", "path", "zipPath", "zipPathDesc", { placeholder: "D:\\dsh-backup.zip", browse: "save" }));
			}

			const run = async (mode) => {
				if (busyRef.current) return;
				busyRef.current = true;
				setError("");
				setNote("");
				try {
					const data = await call("/api/x-sync/run", { mode });
					setState(data);
					setNote(data.text || "");
				} catch (err) {
					setError(err.message);
				} finally {
					busyRef.current = false;
				}
			};
			const phase = state?.phase;
			const running = Boolean(phase) && !["done", "error", "idle"].includes(phase);
			const verbOf = (up) => t(local ? (up ? "export" : "import") : (up ? "up" : "down"));
			let status = note;
			if (running) {
				if (phase === "scan" || phase === "start") status = t("busy");
				else if (phase === "install") status = t("runningInstall");
				else status = t("working", { verb: verbOf(state.mode === "up"), label: state.scope || "", done: state.done || 0, total: state.total || 0 });
			} else if (state?.phase === "error" && !error) status = t("failed", { error: state.error || "" });
			else if (state?.phase === "done" && state.summary && !note) {
				const summary = state.summary;
				const moved = summary.mode === "up" ? summary.uploaded : summary.downloaded;
				let extra = "";
				if (summary.skipped) extra += t("extraSkipped", { n: summary.skipped });
				if (summary.merged) extra += t("extraMerged");
				if (summary.installed) extra += t("extraInstalled");
				status = t("doneUp", { verb: verbOf(summary.mode === "up"), n: moved, extra });
			}
			const percent = running && state?.total ? Math.max(2, Math.min(100, Math.round((state.done / state.total) * 100))) : null;

			return h("div", { className: "dsh-xsync" },
				h("p", { className: "dsh-xsync-hint" }, t("subtitle")),
				h("div", { className: "dsh-xsync-actions" },
					h("button", { type: "button", className: "dsh-xsync-btn", disabled: running, onClick: async () => {
						setHint(t("checking"));
						setError("");
						try {
							const info = await call("/api/x-sync/test", {});
							setHint(t("connected", { host: info.host || "", ns: info.namespace || "", state: info.empty ? t("emptyRemote") : t("hasContent") }));
						} catch (err) { setError(err.message); setHint(""); }
					} }, t(isZip ? "checkZip" : isFolder ? "checkFolder" : "check")),
					h("button", { type: "button", className: "dsh-xsync-btn primary", disabled: running, onClick: () => run("up") }, verbOf(true)),
					h("button", { type: "button", className: "dsh-xsync-btn", disabled: running, onClick: () => run("down") }, verbOf(false)),
					running ? h("button", { type: "button", className: "dsh-xsync-btn", onClick: async () => {
						try {
							await call("/api/x-sync/stop", {});
							setNote(t("stopped"));
						} catch (err) { setError(err.message); }
					} }, t("stop")) : null,
				),
				percent !== null ? h("div", { className: "dsh-xsync-bar" }, h("div", { style: { width: `${percent}%` } })) : null,
				status ? h("p", { className: "dsh-xsync-hint" }, status) : null,
				error ? h("p", { className: "dsh-xsync-hint error" }, error) : null,
				hint ? h("p", { className: "dsh-xsync-hint" }, hint) : null,
				h("div", { className: "dsh-xsync-group" },
					h("div", { className: "dsh-xsync-row" },
						h("div", { className: "dsh-xsync-text" },
							h("span", { className: "dsh-xsync-name" }, t("storeType")),
							h("span", { className: "dsh-xsync-desc" }, t("storeDesc"))),
						h("select", { value: store, onChange: (event) => setStore(event.target.value) },
							h("option", { value: "s3" }, t("s3")),
							h("option", { value: "webdav" }, t("webdav")),
							h("option", { value: "folder" }, t("folder")),
							h("option", { value: "zip" }, t("zip")))),
					...remoteFields),
				h("div", { className: "dsh-xsync-group" },
					...SCOPE_ROWS.map(([id, labelKey, descKey]) => h("label", { className: "dsh-xsync-scope", key: id },
						h("div", { className: "dsh-xsync-text" },
							h("span", { className: "dsh-xsync-name" }, t(labelKey)),
							h("span", { className: "dsh-xsync-desc" }, t(descKey))),
						h("input", {
							type: "checkbox",
							checked: (config.scopes ?? []).includes(id),
							onChange: (event) => setScope(id, event.target.checked),
						})))),
				h("div", { className: "dsh-xsync-group" },
					h("div", { className: "dsh-xsync-row" },
						h("div", { className: "dsh-xsync-text" },
							h("span", { className: "dsh-xsync-name" }, t("policy")),
							h("span", { className: "dsh-xsync-desc" }, t("policyDesc"))),
						h("select", { value: config.policy, onChange: (event) => patch({ policy: event.target.value }) },
							h("option", { value: "skip" }, t("policySkip")),
							h("option", { value: "overwrite" }, t("policyOverwrite")),
							h("option", { value: "duplicate" }, t("policyDuplicate"))))),
			);
		}

		/** 注册词典、样式与设置页那块面板。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-x-sync: dictionaries");
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) return () => {};
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = STYLES;
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, "dsh-x-sync: styles");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "x-sync", order: 32, label: () => ctx.locale.t?.(NS, "title") ?? "同步", locale: NS },
				SyncPanel,
			));
		}

		return { apply, inject };
	},
});
