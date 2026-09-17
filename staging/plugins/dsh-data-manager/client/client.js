// dsh-data-manager browser half.
//
// A "数据管理" page in Settings, beside General / Models / Plugins. It reads the
// host's /dsh-data routes and shows where the application keeps its data, what is
// in it, and the whole migration — copy, verify, switch, restart — as it happens,
// so each step is visibly finished instead of hidden behind a spinner.
//
// Written directly against the client module-loader contract, so the package
// ships without a build step.
window.__ModuleLoader__.load({
	id: "dsh-data-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { useCallback, useEffect, useState } = react;
		const h = react.createElement;

		const STATUS_PATH = "/dsh-data/status";
		const MIGRATE_PATH = "/dsh-data/migrate";
		const RESTART_PATH = "/dsh-data/restart";
		const OPEN_PATH = "/dsh-data/open";
		const POLL_MS = 1200;

		// ---- helpers ----------------------------------------------------

		function formatBytes(bytes) {
			if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "-";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
			return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
		}

		async function callJson(path, options) {
			const response = await fetch(path, options);
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = {};
			}
			if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
			return payload;
		}

		// ---- styles -----------------------------------------------------
		// Inline and neutral: the page inherits the application's font and
		// colours rather than carrying a second theme.

		const page = { display: "flex", flexDirection: "column", gap: "16px", fontSize: "13px", lineHeight: "1.65" };
		const card = {
			border: "1px solid var(--dsw-border-subtle, rgba(128,128,128,0.28))",
			borderRadius: "10px",
			padding: "14px 16px",
		};
		const heading = { fontWeight: 600, marginBottom: "8px" };
		const muted = { opacity: 0.72 };
		const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", wordBreak: "break-all" };
		const row = { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" };
		const input = {
			flex: "1 1 300px",
			minWidth: "220px",
			padding: "7px 9px",
			borderRadius: "6px",
			border: "1px solid var(--dsw-border-subtle, rgba(128,128,128,0.4))",
			background: "transparent",
			color: "inherit",
			font: "inherit",
		};
		const button = {
			padding: "6px 12px",
			borderRadius: "6px",
			border: "1px solid var(--dsw-border-subtle, rgba(128,128,128,0.4))",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			cursor: "pointer",
		};
		const primary = { ...button, fontWeight: 600 };
		const danger = { color: "var(--dsw-status-error, #d33)", whiteSpace: "pre-wrap" };
		const good = { color: "var(--dsw-status-success, #2a8)", whiteSpace: "pre-wrap" };
		const table = { width: "100%", borderCollapse: "collapse", marginTop: "6px" };
		const cell = { padding: "3px 0", textAlign: "left", verticalAlign: "top" };
		const cellRight = { ...cell, textAlign: "right", ...muted, whiteSpace: "nowrap" };

		/** The migration as ordered steps, so progress reads as a process. */
		const STEPS = [
			{ key: "copying", title: "复制文件", detail: "完整复制到新目录；指向安装目录的索引链接会被跳过（下次启动自动重建）。" },
			{ key: "verifying", title: "校验完整性", detail: "核对目标目录的文件数与字节数，不一致就中止，不切换配置。" },
			{ key: "switching", title: "切换配置", detail: "改写程序目录下 config.json 的 dataDirectory。" },
			{ key: "restart-required", title: "重启生效", detail: "重启应用后才会使用新位置。" },
		];

		/** Where one step stands, given the phase the host reports. */
		function stepState(phase, key) {
			const order = STEPS.map(step => step.key);
			if (phase === "restart-required") return key === "restart-required" ? "active" : "done";
			if (phase === "failed") return key === "copying" ? "failed" : "pending";
			if (phase === "removing") return key === "restart-required" ? "pending" : "done";
			const current = order.indexOf(phase);
			if (current === -1) return "pending";
			const mine = order.indexOf(key);
			if (mine < current) return "done";
			return mine === current ? "active" : "pending";
		}

		function StepList({ phase }) {
			const mark = { done: "✓", active: "●", pending: "○", failed: "✕" };
			const colour = {
				done: "var(--dsw-status-success, #2a8)",
				active: "inherit",
				pending: "inherit",
				failed: "var(--dsw-status-error, #d33)",
			};
			return h(
				"div",
				null,
				...STEPS.map(step => {
					const state = stepState(phase, step.key);
					return h(
						"div",
						{ key: step.key, style: { display: "flex", gap: "8px", alignItems: "flex-start", opacity: state === "pending" ? 0.5 : 1 } },
						h("span", { style: { color: colour[state], width: "14px" } }, mark[state]),
						h(
							"div",
							null,
							h("div", { style: { fontWeight: state === "active" ? 600 : 400 } }, step.title),
							h("div", { style: muted }, step.detail),
						),
					);
				}),
			);
		}

		// ---- component --------------------------------------------------

		function DataManagerSection() {
			const [status, setStatus] = useState(null);
			const [failure, setFailure] = useState("");
			const [notice, setNotice] = useState("");
			const [target, setTarget] = useState("");
			const [removeSource, setRemoveSource] = useState(false);
			const [busy, setBusy] = useState(false);

			const refresh = useCallback(async () => {
				try {
					const next = await callJson(STATUS_PATH);
					setStatus(next);
					setFailure("");
					return next;
				} catch (cause) {
					setFailure(String(cause?.message ?? cause));
					return null;
				}
			}, []);

			useEffect(() => { void refresh(); }, [refresh]);

			const migration = (status && status.migration) || {};
			const migrating = migration.active === true;
			const restartRequired = migration.phase === "restart-required";

			useEffect(() => {
				if (!migrating && !restartRequired) return undefined;
				const timer = setInterval(() => { void refresh(); }, POLL_MS);
				return () => clearInterval(timer);
			}, [migrating, restartRequired, refresh]);

			const start = useCallback(async () => {
				if (target.trim() === "") return;
				setBusy(true);
				setNotice("");
				setFailure("");
				try {
					await callJson(MIGRATE_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ target: target.trim(), removeSource }),
					});
					setNotice("已开始迁移。期间请不要使用应用，完成后本页会提示重启。");
					await refresh();
				} catch (cause) {
					setFailure(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [target, removeSource, refresh]);

			const restart = useCallback(async () => {
				setBusy(true);
				try {
					await callJson(RESTART_PATH, { method: "POST" });
					setNotice("正在重启应用，几秒后刷新页面即可。");
				} catch (cause) {
					setFailure(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, []);

			const openFolder = useCallback(async () => {
				try {
					await callJson(OPEN_PATH, { method: "POST" });
				} catch (cause) {
					setFailure(String(cause?.message ?? cause));
				}
			}, []);

			if (status === null) {
				return h("div", { style: page }, h("div", { style: muted }, failure === "" ? "正在读取…" : failure));
			}

			const done = typeof migration.copied === "number" ? migration.copied : 0;
			const total = typeof migration.total === "number" ? migration.total : 0;
			const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

			return h(
				"div",
				{ style: page },

				h(
					"div",
					{ style: card },
					h("div", { style: heading }, "当前数据位置"),
					h("div", { style: mono }, status.path),
					h("div", { style: muted }, `来源：${status.source}`),
					h(
						"div",
						{ style: muted },
						status.exists
							? `占用：${formatBytes(status.bytes)} / ${status.files} 个文件${status.writable ? "" : "（当前不可写）"}`
							: "尚未创建（首次启动时自动建立）",
					),
					Array.isArray(status.children) && status.children.length > 0
						? h(
							"table",
							{ style: table },
							h(
								"tbody",
								null,
								...status.children.map(child =>
									h(
										"tr",
										{ key: child.name },
										h("td", { style: cell }, child.name),
										h("td", { style: cellRight }, `${formatBytes(child.bytes)} / ${child.files} 个文件`),
									),
								),
							),
						)
						: null,
					h(
						"div",
						{ style: { ...row, marginTop: "10px" } },
						h("button", { style: button, onClick: openFolder }, "打开该目录"),
						h("button", { style: button, disabled: busy, onClick: () => { void refresh(); } }, "刷新"),
					),
				),

				h(
					"div",
					{ style: card },
					h("div", { style: heading }, "迁移到其他位置"),
					h(
						"div",
						{ style: muted },
						"上传的图片、附件和会话都在上面这个目录里。系统盘紧张时，可以把整个目录复制到别的盘，程序会自动改用它。",
					),
					h(
						"div",
						{ style: { ...row, marginTop: "10px" } },
						h("input", {
							style: input,
							value: target,
							placeholder: "例如 D:\\dsh-data",
							disabled: migrating || busy,
							onChange: event => setTarget(event.target.value),
						}),
						h("button", { style: primary, disabled: migrating || busy || target.trim() === "", onClick: start }, "开始迁移"),
					),
					h(
						"label",
						{ style: { ...row, marginTop: "10px", ...muted, cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: removeSource,
							disabled: migrating || busy,
							onChange: event => setRemoveSource(event.target.checked),
						}),
						"校验通过后删除原目录（默认不删；建议先确认新位置可用再自己删）",
					),
					h(
						"div",
						{ style: { ...muted, marginTop: "8px" } },
						"目标目录必须是空目录或尚不存在；不能在当前数据目录里，也不能在程序安装目录里。复制期间尽量不要使用应用。",
					),
				),

				migration.phase !== "idle"
					? h(
						"div",
						{ style: card },
						h("div", { style: heading }, "迁移过程"),
						h(StepList, { phase: migration.phase }),
						migrating
							? h(
								"div",
								{ style: { marginTop: "10px" } },
								h(
									"div",
									{ style: muted },
									`${done}/${total} 个文件，${formatBytes(migration.bytes)}${migration.totalBytes ? ` / ${formatBytes(migration.totalBytes)}` : ""}`,
								),
								h(
									"div",
									{ style: { marginTop: "6px", height: "6px", borderRadius: "3px", background: "rgba(128,128,128,0.25)" } },
									h("div", {
										style: { width: `${percent}%`, height: "100%", borderRadius: "3px", background: "currentColor", opacity: 0.6 },
									}),
								),
							)
							: null,
						restartRequired
							? h(
								"div",
								{ style: { ...row, marginTop: "12px" } },
								h("button", { style: primary, disabled: busy, onClick: restart }, "立即重启应用"),
								h("span", { style: muted }, "重启后新位置才会生效"),
							)
							: null,
						migration.phase === "failed" && migration.error
							? h("div", { style: { ...danger, marginTop: "10px" } }, `迁移失败：${migration.error}`)
							: null,
					)
					: null,

				notice !== "" ? h("div", { style: good }, notice) : null,
				failure !== "" ? h("div", { style: danger }, failure) : null,

				h(
					"div",
					{ style: muted },
					status.configPath === null
						? "没有找到程序的 config.json，位置由环境变量或默认值决定。"
						: `位置由 ${status.configPath} 的 dataDirectory 决定；本页改动写的就是它。`,
				),
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-data",
				order: 40,
				label: "数据管理",
			}, DataManagerSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
