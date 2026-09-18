/**
 * qq-groupmate 的浏览器半：在「设置 → 插件」里渲染一张配置卡片。
 *
 * 这份文件是手写的客户端产物，格式与 dsh 客户端模块系统一致：
 *   window.__ModuleLoader__.load({ id, factory })
 * 工厂里只能 require 平台基线模块（react / react/jsx-runtime /
 * @deepseek-ai/dsh-client-ui-primitives 等），不能引用其它插件的组件。
 *
 * 与 Host 半的配对键是设置命名空间 "qq-groupmate"；运行状态读
 * "qq-groupmate-status"（由 Host 半写入，这里只读）。
 *
 * 视觉：卡片样式注入一次 <style>，只用 --dsw-alias-* 设计令牌（跟随主题明暗），
 * 控件尺寸照内置设置页（34px 高、13px 字号、0.5px 描边），状态点用原生 StateDot。
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-qq-groupmate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const Button = primitives.Button;
		const Switch = primitives.Switch;
		const StateDot = primitives.StateDot;
		const Tag = primitives.Tag;
		const IconChevronDownOutline14 = primitives.IconChevronDownOutline14;

		const h = React.createElement;

		/** 设置命名空间（必须与 Host 半一致）。 */
		const NS = "qq-groupmate";
		/** 运行状态命名空间。 */
		const STATUS_NS = "qq-groupmate-status";

		// ── 卡片样式：只用 --dsw-alias-* 令牌，类名统一 qgm- 前缀 ─────────────
		const CARD_CSS = [
			".qgm-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px}",
			".qgm-header{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;width:100%;margin:-6px -8px;padding:6px 8px;background:none;border:none;border-radius:10px;cursor:pointer;color:inherit;font:inherit;text-align:left}",
			".qgm-header:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}",
			".qgm-head-text{display:flex;flex-direction:column;gap:3px;min-width:0}",
			".qgm-title{font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".qgm-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
			".qgm-status{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:1.5;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
			".qgm-status-detail{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis}",
			".qgm-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform 150ms ease}",
			".qgm-body{display:flex;flex-direction:column;gap:16px}",
			".qgm-section{display:flex;flex-direction:column;gap:10px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}",
			".qgm-section>.qgm-hint,.qgm-section>.qgm-fallback{margin-left:128px}",
			".qgm-section-title{margin:0;font-size:12px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".qgm-field{display:grid;grid-template-columns:116px minmax(0,1fr);gap:12px;align-items:start}",
			".qgm-label{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:34px;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-secondary)}",
			".qgm-reset{padding:0;background:none;border:none;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;color:var(--dsw-alias-label-tertiary)}",
			".qgm-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);text-decoration:underline}",
			".qgm-reset:disabled{cursor:default}",
			".qgm-control{display:flex;flex-direction:column;gap:5px;min-width:0}",
			".qgm-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".qgm-input,.qgm-select,.qgm-textarea{width:100%;box-sizing:border-box;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:8px;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}",
			".qgm-input::placeholder,.qgm-textarea::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}",
			".qgm-input:focus-visible,.qgm-select:focus-visible,.qgm-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".qgm-input:disabled,.qgm-select:disabled,.qgm-textarea:disabled{color:var(--dsw-alias-label-tertiary);opacity:.7;cursor:default}",
			".qgm-textarea{height:auto;min-height:88px;padding:8px 12px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6}",
			".qgm-selectwrap{position:relative;display:flex;min-width:0}",
			".qgm-select{appearance:none;-webkit-appearance:none;padding-right:30px;cursor:pointer}",
			".qgm-selectwrap::after{content:\"\";position:absolute;right:12px;top:50%;width:6px;height:6px;border-right:1.3px solid var(--dsw-alias-label-tertiary);border-bottom:1.3px solid var(--dsw-alias-label-tertiary);transform:translateY(-70%) rotate(45deg);pointer-events:none}",
			".qgm-list{display:flex;flex-direction:column;gap:8px}",
			".qgm-item{display:flex;flex-direction:column;gap:8px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px}",
			".qgm-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}",
			".qgm-item-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-width:0}",
			".qgm-item-fields{display:flex;align-items:flex-start;flex-wrap:wrap;gap:12px}",
			".qgm-id{font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
			".qgm-meta{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".qgm-spacer{flex:1 1 auto}",
			".qgm-mini{display:flex;flex-direction:column;gap:4px;min-width:132px}",
			".qgm-mini-label{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}",
			".qgm-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}",
			".qgm-inline{display:flex;align-items:center;gap:8px;min-width:0}",
			".qgm-grow{flex:1 1 auto;min-width:0}",
			".qgm-w110{width:110px}", ".qgm-w130{width:130px}", ".qgm-w150{width:150px}",
			".qgm-w170{width:170px}", ".qgm-w180{width:180px}", ".qgm-w200{width:200px}",
			".qgm-footer{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".qgm-error{margin:0;color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".qgm-fallback{display:flex;align-items:baseline;gap:6px;min-width:0}",
			".qgm-fallback-text{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
			// 折叠组：展开后不再是一条 25 个区块的长龙（原生 details，内容仍在 DOM 里，能被页内查找命中）。
			".qgm-fold{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));padding-top:14px}",
			".qgm-fold>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".qgm-fold>summary::-webkit-details-marker{display:none}",
			".qgm-fold>summary::before{content:\"▸\";flex:none;width:10px;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform 150ms ease}",
			".qgm-fold[open]>summary::before{transform:rotate(90deg)}",
			".qgm-fold>summary:hover{color:var(--dsw-alias-brand-primary)}",
			".qgm-fold-count{font-size:12px;font-weight:400;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".qgm-fold-body{display:flex;flex-direction:column;gap:16px;padding-top:12px}",
			// 组内的区块不再各自画一条分隔线（组本身已经有一条）。
			".qgm-fold-body>.qgm-section{border-top:none;padding-top:0}",
			".qgm-presets{display:flex;flex-direction:column;gap:8px}",
			".qgm-preset{display:flex;flex-direction:column;gap:6px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px}",
			".qgm-preset-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}",
			".qgm-preset-name{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".qgm-preset .qgm-textarea{min-height:56px}",
		].join("");

		/** 注入一次卡片样式；冒烟测试的桩环境没有 document，跳过。 */
		const CSS_TAG_ID = "dsh-plugin-qq-groupmate/card.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-qq-groupmate";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CARD_CSS;
			document.head.appendChild(tag);
		}

		// ── 路径读写小工具 ────────────────────────────────────────────────────
		function readPath(object, path) {
			let cursor = object;
			for (const key of path) {
				if (cursor === null || typeof cursor !== "object") return undefined;
				cursor = cursor[key];
			}
			return cursor;
		}

		function hasPath(object, path) {
			let cursor = object;
			for (const key of path) {
				if (cursor === null || typeof cursor !== "object") return false;
				if (!Object.prototype.hasOwnProperty.call(cursor, key)) return false;
				cursor = cursor[key];
			}
			return true;
		}

		function writePath(scope, path, value) {
			return scope.mutate([{ op: "set", path: path, value: value }]);
		}

		function clearPath(scope, path) {
			return scope.mutate([{ op: "unset", path: path }]);
		}

		/** 一行字段：左侧标签（可带覆盖标记），右侧控件与说明。 */
		function Row(props) {
			return h("div", { className: "qgm-field" },
				h("div", { className: "qgm-label" },
					h("span", { className: "qgm-grow" }, props.label),
					props.overridden ? h(Tag, { tone: "quiet" }, "已修改") : null,
					props.overridden
						? h("button", {
							type: "button", className: "qgm-reset", title: "恢复为部署配置里的值",
							disabled: props.disabled, onClick: props.onReset,
						}, "重置")
						: null,
				),
				h("div", { className: "qgm-control" },
					props.children,
					props.hint ? h("p", { className: "qgm-hint" }, props.hint) : null,
				),
			);
		}

		/** 文本输入：失焦或回车时提交变化。带 `list` 时挂到同名 datalist 做候选。 */
		function TextField(props) {
			const [draft, setDraft] = React.useState(props.value === undefined ? "" : String(props.value));
			React.useEffect(() => {
				setDraft(props.value === undefined ? "" : String(props.value));
			}, [props.value]);
			const commit = () => {
				if (draft === (props.value === undefined ? "" : String(props.value))) return;
				props.onCommit(draft);
			};
			return h("input", {
				className: "qgm-input",
				type: props.secret ? "password" : "text",
				value: draft,
				list: props.list,
				placeholder: props.placeholder,
				disabled: props.disabled,
				onChange: (event) => { setDraft(event.target.value); },
				onBlur: commit,
				onKeyDown: (event) => { if (event.key === "Enter") event.currentTarget.blur(); },
			});
		}

		/** 多行文本：提示词这类内容长、要换行的字段用它。 */
		function TextAreaField(props) {
			const [draft, setDraft] = React.useState(props.value === undefined ? "" : String(props.value));
			React.useEffect(() => {
				setDraft(props.value === undefined ? "" : String(props.value));
			}, [props.value]);
			const commit = () => {
				if (draft === (props.value === undefined ? "" : String(props.value))) return;
				props.onCommit(draft);
			};
			return h("textarea", {
				className: "qgm-textarea",
				value: draft,
				placeholder: props.placeholder,
				disabled: props.disabled,
				onChange: (event) => { setDraft(event.target.value); },
				onBlur: commit,
			});
		}

		/** 模型候选：从服务商拉回来的模型 id 做成原生 datalist，点输入框即可挑。 */
		function ModelDatalist(props) {
			const models = props.models || [];
			if (props.id === undefined || models.length === 0) return null;
			return h("datalist", { id: props.id },
				models.map(id => h("option", { key: id, value: id })),
			);
		}

		/** 数字输入：失焦时提交，非法输入不写。 */
		function NumberField(props) {
			const [draft, setDraft] = React.useState(props.value === undefined ? "" : String(props.value));
			React.useEffect(() => {
				setDraft(props.value === undefined ? "" : String(props.value));
			}, [props.value]);
			const commit = () => {
				if (draft.trim() === "") return;
				const parsed = Number(draft);
				if (!Number.isFinite(parsed)) return;
				if (parsed === props.value) return;
				props.onCommit(parsed);
			};
			return h("input", {
				className: "qgm-input",
				type: "number",
				value: draft,
				disabled: props.disabled,
				onChange: (event) => { setDraft(event.target.value); },
				onBlur: commit,
				onKeyDown: (event) => { if (event.key === "Enter") event.currentTarget.blur(); },
			});
		}

		/** 开关：点一下立即写入。 */
		function SwitchField(props) {
			return h("div", { className: "qgm-inline" },
				h(Switch, {
					checked: props.value === true,
					label: props.label,
					disabled: props.disabled,
					onChange: (next) => { props.onCommit(next); },
				}),
			);
		}

		/** 下拉选择。 */
		function SelectField(props) {
			return h("div", { className: "qgm-selectwrap" },
				h("select", {
					className: "qgm-select",
					value: props.value === undefined ? "" : props.value,
					disabled: props.disabled,
					onChange: (event) => {
						const raw = event.target.value;
						props.onCommit(raw === "" ? undefined : raw);
					},
				}, props.options.map(option => h("option", { key: option.value, value: option.value }, option.label))),
			);
		}

		/** 字符串数组：逗号分隔编辑。 */
		function ListField(props) {
			const text = (props.value || []).join("、");
			const [draft, setDraft] = React.useState(text);
			React.useEffect(() => { setDraft(text); }, [text]);
			const commit = () => {
				if (draft === text) return;
				const items = draft.split(/[,，、\s]+/u).map(item => item.trim()).filter(item => item !== "");
				props.onCommit(items);
			};
			return h("input", {
				className: "qgm-input",
				type: "text",
				value: draft,
				placeholder: props.placeholder,
				disabled: props.disabled,
				onChange: (event) => { setDraft(event.target.value); },
				onBlur: commit,
				onKeyDown: (event) => { if (event.key === "Enter") event.currentTarget.blur(); },
			});
		}

		/** 按群覆盖：JSON 文本域。 */
		function GroupsField(props) {
			const text = props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
			const [draft, setDraft] = React.useState(text);
			const [error, setError] = React.useState("");
			React.useEffect(() => { setDraft(text); setError(""); }, [text]);
			const commit = () => {
				if (draft.trim() === "") { props.onCommit(undefined); return; }
				let parsed;
				try {
					parsed = JSON.parse(draft);
				}
				catch (cause) {
					setError("JSON 格式不对：" + String(cause && cause.message ? cause.message : cause));
					return;
				}
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					setError("需要一个对象，键是群号");
					return;
				}
				setError("");
				props.onCommit(parsed);
			};
			return h("div", { className: "qgm-control" },
				h("textarea", {
					className: "qgm-textarea",
					value: draft,
					disabled: props.disabled,
					placeholder: props.placeholder,
					onChange: (event) => { setDraft(event.target.value); },
					onBlur: commit,
				}),
				error === "" ? null : h("p", { className: "qgm-error" }, error),
			);
		}

		/**
		 * 独立 API 服务商：一条一行（id / 协议 / 地址 / Key / 额外头 / 删除）。
		 * 额外头写成 `k=v;k2=v2`，避免在设置页里编辑 JSON。
		 */
		function ApiProvidersField(props) {
			const list = Array.isArray(props.value) ? props.value : [];
			const patch = (index, key, next) => {
				props.onCommit(list.map((item, i) => i === index ? Object.assign({}, item, { [key]: next }) : item));
			};
			const headersText = (headers) => Object.entries(headers && typeof headers === "object" ? headers : {})
				.map(([key, value]) => key + "=" + String(value)).join(";");
			const parseHeaders = (text) => {
				const result = {};
				String(text || "").split(/[;；\n]+/u).forEach(part => {
					const item = part.trim();
					if (item === "") return;
					const at = item.indexOf("=");
					if (at <= 0) return;
					result[item.slice(0, at).trim()] = item.slice(at + 1).trim();
				});
				return result;
			};
			const rows = list.map((item, index) => h("div", { key: "api" + index, className: "qgm-item" },
				h("div", { className: "qgm-item-head" },
					h("div", { className: "qgm-mini qgm-w110" }, h("span", { className: "qgm-mini-label" }, "id"), h(TextField, {
						value: item.id, disabled: props.disabled, placeholder: "id",
						onCommit: (next) => { patch(index, "id", next.trim()); },
					})),
					h("div", { className: "qgm-mini qgm-w130" }, h("span", { className: "qgm-mini-label" }, "协议"), h(SelectField, {
						value: item.protocol === "anthropic" ? "anthropic" : "openai", disabled: props.disabled,
						options: [{ value: "openai", label: "OpenAI 兼容" }, { value: "anthropic", label: "Anthropic" }],
						onCommit: (next) => { patch(index, "protocol", next === "anthropic" ? "anthropic" : "openai"); },
					})),
					h("div", { className: "qgm-spacer" }),
					h(Button, {
						variant: "ghost", size: "sm", disabled: props.disabled,
						onClick: () => { props.onCommit(list.filter((_, i) => i !== index)); },
					}, "删除"),
				),
				h("div", { className: "qgm-item-fields" },
					h("div", { className: "qgm-mini qgm-grow qgm-w200" }, h("span", { className: "qgm-mini-label" }, "地址"), h(TextField, {
						value: item.baseUrl, disabled: props.disabled, placeholder: "https://api.openai.com/v1",
						onCommit: (next) => { patch(index, "baseUrl", next.trim()); },
					})),
					h("div", { className: "qgm-mini qgm-w170" }, h("span", { className: "qgm-mini-label" }, "API Key"), h(TextField, {
						value: item.apiKey, disabled: props.disabled, secret: true, placeholder: "API Key",
						onCommit: (next) => { patch(index, "apiKey", next.trim()); },
					})),
					h("div", { className: "qgm-mini qgm-w150" }, h("span", { className: "qgm-mini-label" }, "额外头"), h(TextField, {
						value: headersText(item.headers), disabled: props.disabled, placeholder: "k=v;k2=v2",
						onCommit: (next) => { patch(index, "headers", parseHeaders(next)); },
					})),
				),
			));
			return h("div", { className: "qgm-control" },
				h("div", { className: "qgm-list" },
					rows.length === 0
						? h("p", { className: "qgm-hint" }, "还没有配置自定义服务商")
						: rows,
				),
				h("div", { className: "qgm-actions" },
					h(Button, {
						variant: "outline", size: "sm", disabled: props.disabled,
						onClick: () => { props.onCommit(list.concat([{ id: "", protocol: "openai", baseUrl: "", apiKey: "" }])); },
					}, "添加服务商"),
				),
			);
		}

		/** 加一个 id 的小输入框（群号 / QQ 号）。 */
		function AddIdRow(props) {
			const [draft, setDraft] = React.useState("");
			const submit = () => {
				const value = draft.trim();
				if (value === "") return;
				props.onAdd(value);
				setDraft("");
			};
			return h("div", { className: "qgm-inline" },
				h("div", { className: "qgm-grow qgm-w200" }, h("input", {
					className: "qgm-input",
					type: "text",
					value: draft,
					placeholder: props.placeholder,
					disabled: props.disabled,
					onChange: (event) => { setDraft(event.target.value); },
					onKeyDown: (event) => { if (event.key === "Enter") event.currentTarget.blur(); },
					onBlur: submit,
				})),
				h(Button, { variant: "outline", size: "sm", disabled: props.disabled, onClick: submit }, "添加"),
			);
		}

		/** 状态行：读 Host 写进 qq-groupmate-status 的值。 */
		function StatusLine(props) {
			const status = props.status || {};
			const state = status.state || "idle";
			const dotState = state === "connected" ? "done" : state === "disconnected" ? "warning" : "idle";
			const label = state === "connected" ? "已连接" : state === "disconnected" ? "未连接" : "未启动";
			return h("div", { className: "qgm-status" },
				h(StateDot, { state: dotState }),
				h("span", null, label),
				status.detail ? h("span", { className: "qgm-status-detail" }, status.detail) : null,
			);
		}

		/** 协议端进程状态 + 启停按钮：读 Host 写进 qq-groupmate-status 的 protocolSide。 */
		function ProtocolSideStatus(props) {
			const live = props.live || {};
			const mode = props.mode || live.mode || "local";
			const state = live.state || "stopped";
			const dotState = state === "running" ? "done"
				: state === "starting" || state === "stopping" ? "ongoing"
					: state === "error" ? "error" : "idle";
			const label = state === "running" ? (live.owned ? "运行中（插件托管）" : "运行中（外部进程）")
				: state === "starting" ? "启动中"
					: state === "stopping" ? "停止中"
						: state === "error" ? "异常" : "未运行";
			const local = mode === "local";
			const act = (action) => () => { props.onAction(action); };
			return h("div", { className: "qgm-control" },
				h("div", { className: "qgm-status" },
					h(StateDot, { state: dotState }),
					h("span", null, label),
					live.pid ? h("span", { className: "qgm-meta" }, "PID " + String(live.pid)) : null,
					live.detail ? h("span", { className: "qgm-status-detail" }, live.detail) : null,
				),
				h("div", { className: "qgm-actions" },
					h(Button, { variant: "outline", size: "sm", disabled: props.busy || !local, onClick: act("start") }, "启动"),
					h(Button, { variant: "outline", size: "sm", disabled: props.busy || !local, onClick: act("stop") }, "停止"),
					h(Button, { variant: "ghost", size: "sm", disabled: props.busy || !local, onClick: act("restart") }, "重启"),
					h(Button, {
						variant: "ghost", size: "sm",
						onClick: () => {
							const url = live.webuiUrl || "http://127.0.0.1:5099";
							if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
						},
					}, "打开管理台"),
				),
				local ? null : h("p", { className: "qgm-hint" }, "外部手动模式：协议端由你自己启动，插件只连接不管进程。"),
			);
		}

		/**
		 * 模型选择：优先从「模型配置」清单里选，也可以切到手写 `服务商/模型名`（兼容老写法）。
		 * 参考 RP-Hub 的模型选择器：平时只选名字，不用记 provider/model 串。
		 */
		function ModelSelectField(props) {
			const value = props.value === undefined ? "" : String(props.value);
			const names = props.names || [];
			const manual = value !== "" && names.indexOf(value) < 0;
			// 用 1/0 而不是布尔：设置页卡片的冒烟测试用桩 React，会把布尔初值一律当 true。
			const [manualMode, setManualMode] = React.useState(manual ? 1 : 0);
			if (manualMode === 1 || manual) {
				return h("div", { className: "qgm-inline" },
					h("div", { className: "qgm-grow" }, h(TextField, {
						value: value, disabled: props.disabled,
						placeholder: props.placeholder || "服务商/模型名",
						onCommit: (next) => { props.onCommit(next.trim()); },
					})),
					h(Button, {
						variant: "ghost", size: "sm", disabled: props.disabled,
						onClick: () => { setManualMode(0); props.onCommit(""); },
					}, "改用配置"),
				);
			}
			return h(SelectField, {
				value: value, disabled: props.disabled,
				options: [{ value: "", label: props.emptyLabel || "跟随默认" }]
					.concat(names.map(name => ({ value: name, label: name })))
					.concat([{ value: "__manual__", label: "手写服务商/模型…" }]),
				onCommit: (next) => {
					if (next === "__manual__") { setManualMode(1); return; }
					setManualMode(0);
					props.onCommit(next === undefined ? "" : next);
				},
			});
		}

		/** 一行模型配置：名称 / 服务商 / 模型名 / 删除。 */
		function ModelPresetsField(props) {
			const list = Array.isArray(props.value) ? props.value : [];
			const providers = props.providers || [];
			const defaultProvider = props.defaultProvider || "";
			const patch = (index, key, next) => {
				props.onCommit(list.map((item, i) => i === index ? Object.assign({}, item, { [key]: next }) : item));
			};
			const rows = list.map((item, index) => {
				// 该行实际询问的服务商：没写就跟随默认服务商。
				const providerId = item.provider === undefined || item.provider === "" ? defaultProvider : item.provider;
				const catalog = props.catalogOf(providerId);
				const datalistId = "qgm-models-" + String(index);
				return h("div", { key: "model" + index, className: "qgm-item" },
					h("div", { className: "qgm-item-head" },
						h(ModelFetchButton, {
							provider: providerId, disabled: props.disabled, onFetch: props.onFetch,
						}),
						h("div", { className: "qgm-spacer" }),
						h(Button, {
							variant: "ghost", size: "sm", disabled: props.disabled,
							onClick: () => { props.onCommit(list.filter((entry, i) => i !== index)); },
						}, "删除"),
					),
					h("div", { className: "qgm-item-fields" },
						h("div", { className: "qgm-mini qgm-w110" }, h("span", { className: "qgm-mini-label" }, "名称"), h(TextField, {
							value: item.name, disabled: props.disabled, placeholder: "名称",
							onCommit: (next) => { patch(index, "name", next.trim()); },
						})),
						h("div", { className: "qgm-mini qgm-w150" }, h("span", { className: "qgm-mini-label" }, "服务商"), h(SelectField, {
							value: item.provider === undefined ? "" : item.provider, disabled: props.disabled,
							options: [{ value: "", label: "默认服务商" }].concat(providers),
							onCommit: (next) => { patch(index, "provider", next === undefined ? "" : next); },
						})),
						h("div", { className: "qgm-mini qgm-grow qgm-w200" },
							h("span", { className: "qgm-mini-label" }, "模型"),
							h(TextField, {
								value: item.model, disabled: props.disabled, placeholder: "模型名，如 deepseek-v4-flash",
								list: datalistId,
								onCommit: (next) => { patch(index, "model", next.trim()); },
							}),
							h(ModelDatalist, { id: datalistId, models: catalog === undefined ? [] : catalog.models }),
							h(ModelCatalogNote, { catalog: catalog }),
						),
					),
				);
			});
			return h("div", { className: "qgm-control" },
				h("div", { className: "qgm-list" },
					rows.length === 0
						? h("p", { className: "qgm-hint" }, "还没有模型配置。加一条（例如 名称 flash、服务商 deepseek、模型 deepseek-v4-flash），下面的模型分配就能直接按名字选。")
						: rows,
				),
				h(AddModelPresetRow, {
					key: "add",
					disabled: props.disabled,
					providers: providers,
					onAdd: (item) => { props.onCommit(list.concat([item])); },
				}),
			);
		}

		/** 「拉取」按钮：让 Host 去问服务商要模型列表（结果随后写进运行状态）。 */
		function ModelFetchButton(props) {
			const provider = props.provider === undefined ? "" : String(props.provider);
			return h(Button, {
				variant: "outline", size: "sm",
				disabled: props.disabled || provider === "",
				title: provider === "" ? "先选服务商" : "向服务商拉取模型列表",
				onClick: () => { props.onFetch(provider); },
			}, "拉取模型");
		}

		/** 拉取结果的说明行：拉取中 / 失败原因 / 已拉取多少个。 */
		function ModelCatalogNote(props) {
			const catalog = props.catalog;
			if (catalog === undefined) return null;
			if (catalog.pending === true) return h("p", { className: "qgm-hint" }, "正在向服务商拉取模型列表…");
			if (catalog.error !== undefined && catalog.error !== "") {
				return h("p", { className: "qgm-error" }, "拉取失败：" + catalog.error);
			}
			const count = Array.isArray(catalog.models) ? catalog.models.length : 0;
			const time = catalog.at ? new Date(catalog.at).toLocaleTimeString("zh-CN", { hour12: false }) : "";
			return h("p", { className: "qgm-hint" },
				"已拉取 " + String(count) + " 个模型" + (time === "" ? "" : "（" + time + "）") + "，在模型框里点一下就能选。");
		}

		/** 新增一条模型配置。 */
		function AddModelPresetRow(props) {
			const [name, setName] = React.useState("");
			const [provider, setProvider] = React.useState("");
			const [model, setModel] = React.useState("");
			const providers = props.providers || [];
			const submit = () => {
				if (name.trim() === "" || model.trim() === "") return;
				props.onAdd({ name: name.trim(), provider: provider, model: model.trim() });
				setName(""); setModel(""); setProvider("");
			};
			return h("div", { className: "qgm-item" },
				h("div", { className: "qgm-item-fields" },
					h("div", { className: "qgm-mini qgm-w110" }, h(InputLike, {
						value: name, placeholder: "名称", disabled: props.disabled, onEdit: setName,
					})),
					h("div", { className: "qgm-mini qgm-w150" }, h("div", { className: "qgm-selectwrap" },
						h("select", {
							className: "qgm-select", value: provider, disabled: props.disabled,
							onChange: (event) => { setProvider(event.target.value); },
						}, [{ value: "", label: "默认服务商" }].concat(providers)
							.map(option => h("option", { key: option.value, value: option.value }, option.label))),
					)),
					h("div", { className: "qgm-mini qgm-grow qgm-w200" }, h(InputLike, {
						value: model, placeholder: "模型名", disabled: props.disabled, onEdit: setModel,
						onSubmit: submit,
					})),
					h("div", { className: "qgm-spacer" }),
					h(Button, { variant: "outline", size: "sm", disabled: props.disabled, onClick: submit }, "添加"),
				),
			);
		}

		/** 受控输入（不需要「失焦提交」语义的地方用）。 */
		function InputLike(props) {
			return h("input", {
				className: "qgm-input",
				type: "text",
				value: props.value,
				placeholder: props.placeholder,
				disabled: props.disabled,
				onChange: (event) => { props.onEdit(event.target.value); },
				onKeyDown: (event) => { if (event.key === "Enter" && props.onSubmit) props.onSubmit(); },
			});
		}

		/**
		 * 把 V4.5 与 V5 两份画风清单并成一张表：同名（两套表共用的画师预设，例如 8 位那批）只出现一次，
		 * 标签里标出它在哪几套表里——设置页填的画师串按名字生效，两套表共用同一条。
		 */
		function mergePresetEntries(v45, v5) {
			const rows = [];
			const byName = new Map();
			for (const [table, entries] of [["V4.5", v45], ["V5", v5]]) {
				for (const entry of Array.isArray(entries) ? entries : []) {
					if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || entry.name === "") continue;
					let row = byName.get(entry.name);
					if (row === undefined) {
						row = {
							name: entry.name, desc: entry.desc || "", builtin: entry.builtin === true,
							overridden: entry.overridden === true, filled: entry.filled === true,
							preview: entry.preview || "", tables: [],
						};
						byName.set(entry.name, row);
						rows.push(row);
					}
					if (row.tables.indexOf(table) < 0) row.tables.push(table);
					if (entry.overridden === true) row.overridden = true;
					if (entry.filled === true) row.filled = true;
					if (row.preview === "" && entry.preview) row.preview = entry.preview;
				}
			}
			return rows;
		}

		/**
		 * 画风预设编辑器：一个画风一行，把画师串贴进输入框（留空 = 用内置/自定义那一条）。
		 * 清单与状态由 Host 写在运行状态里（`presets`），这里只负责编辑设置文档里的覆盖表。
		 */
		function PresetArtistsField(props) {
			const rows = mergePresetEntries(props.v45, props.v5);
			const overrides = props.value !== null && typeof props.value === "object" ? props.value : {};
			if (rows.length === 0) {
				return h("p", { className: "qgm-hint" }, "画风清单还没准备好：插件重启后（或打开生图后）这里会列出全部画风。");
			}
			return h("div", { className: "qgm-presets" }, rows.map(row => h("div", { key: row.name, className: "qgm-preset" },
				h("div", { className: "qgm-preset-head" },
					h("span", { className: "qgm-preset-name" }, row.name),
					row.tables.map(table => h(Tag, { key: table, tone: "neutral" }, table)),
					h(Tag, { tone: "quiet" }, row.builtin ? "内置" : "自定义"),
					row.filled ? h(Tag, { tone: "info" }, "有画师串") : h(Tag, { tone: "warning" }, "待填"),
					row.overridden ? h(Tag, { tone: "success" }, "设置页填的") : null,
				),
				row.desc === "" ? null : h("p", { className: "qgm-hint" }, row.desc),
				h(TextAreaField, {
					value: typeof overrides[row.name] === "string" ? overrides[row.name] : "",
					disabled: props.disabled,
					placeholder: row.preview === ""
						? (row.builtin ? "这个画风还没有画师串——把画师串贴在这里" : "留空 = 用这条自定义画风自己的画师串")
						: "留空 = 用现有的（" + row.preview + "…）",
					onCommit: (next) => { props.onCommit(row.name, next); },
				}),
			)));
		}

		/** 卡片主体。 */
		function QqGroupmateCard(props) {
			const scope = props.scope;
			const statusScope = props.statusScope;
			const subscribeScope = React.useCallback((listener) => scope.subscribe(listener), [scope]);
			const readScope = React.useCallback(() => scope.getSnapshot(), [scope]);
			const snapshot = React.useSyncExternalStore(subscribeScope, readScope, readScope);
			const subscribeStatus = React.useCallback((listener) => statusScope.subscribe(listener), [statusScope]);
			const readStatus = React.useCallback(() => statusScope.getSnapshot(), [statusScope]);
			const statusSnapshot = React.useSyncExternalStore(subscribeStatus, readStatus, readStatus);

			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState("");
			const [open, setOpen] = React.useState(false);
			/** 折叠组的开合状态：只开第一组，其余收起（键是组名）。 */
			const [folds, setFolds] = React.useState({});

			const value = snapshot.value || {};
			const user = snapshot.user && typeof snapshot.user === "object" ? snapshot.user : {};
			const writable = snapshot.writable === true && snapshot.status === "ready";
			const trigger = value.trigger || {};
			const context = value.context || {};
			const memory = value.memory || {};
			const learner = value.learner || {};
			const live = statusSnapshot.value || {};
			const liveGroups = Array.isArray(live.groups) ? live.groups : [];
			const livePrivates = Array.isArray(live.privateChats) ? live.privateChats : [];
			const characters = Array.isArray(live.characters) ? live.characters : [];
			/** 最近一次「拉取模型」的结果（Host 写进运行状态）。 */
			const modelCatalog = live.modelCatalog && typeof live.modelCatalog === "object" ? live.modelCatalog : {};
			/** 画风清单（Host 写进运行状态）：「画风预设」编辑器用。 */
			const presetStatus = live.presets && typeof live.presets === "object" ? live.presets : {};
			const allowGroups = Array.isArray(value.allowGroups) ? value.allowGroups : [];
			const allowUsers = Array.isArray(value.allowUsers) ? value.allowUsers : [];
			const groupOverrides = value.groups && typeof value.groups === "object" ? value.groups : {};

			const overridden = (path) => hasPath(user, path);
			const set = (path) => (next) => {
				setBusy(true);
				writePath(scope, path, next).then(
					() => { setBusy(false); setNotice(""); },
					(error) => { setBusy(false); setNotice("保存失败：" + String(error && error.message ? error.message : error)); },
				);
			};
			const reset = (path) => () => {
				setBusy(true);
				clearPath(scope, path).then(
					() => { setBusy(false); setNotice(""); },
					(error) => { setBusy(false); setNotice("保存失败：" + String(error && error.message ? error.message : error)); },
				);
			};

			/** 协议端启停：动作 + 令牌一次写入，Host 侧令牌变化才执行一次。 */
			const runLauncherAction = (action) => {
				setBusy(true);
				scope.mutate([
					{ op: "set", path: ["protocolSideAction"], value: action },
					{ op: "set", path: ["protocolSideToken"], value: Date.now() },
				]).then(
					() => { setBusy(false); setNotice(""); },
					(error) => { setBusy(false); setNotice("操作失败：" + String(error && error.message ? error.message : error)); },
				);
			};

			const disabled = !writable || busy;
			const field = (label, path, control, hint) => h(Row, {
				key: path.join("."), label: label, hint: hint, disabled: disabled,
				overridden: overridden(path), onReset: reset(path),
			}, control);
			const section = (title, rows) => h("section", { className: "qgm-section" },
				h("h3", { className: "qgm-section-title" }, title),
				rows,
			);
			const note = (key, text) => h("p", { key: key, className: "qgm-hint" }, text);
			/** 折叠组：不点开就只看到一行标题（原生 details，收起时内容仍在 DOM 里）。 */
			const fold = (key, title, rows, options) => {
				const settings = options === undefined ? {} : options;
				const isOpen = Object.prototype.hasOwnProperty.call(folds, key)
					? folds[key] === true
					: settings.open === true;
				return h("details", {
					key: "fold-" + key,
					className: "qgm-fold",
					open: isOpen,
					onToggle: (event) => {
						const next = Object.assign({}, folds);
						next[key] = event.currentTarget.open === true;
						setFolds(next);
					},
				},
					h("summary", null,
						h("span", null, title),
						settings.hint ? h("span", { className: "qgm-fold-count" }, settings.hint) : null,
					),
					h("div", { className: "qgm-fold-body" }, rows),
				);
			};
			/** 写/清「画风预设」里某个画风的画师串；留空 = 清掉覆盖，回到内置/自定义那一条。 */
			const setPresetArtist = (name, text) => {
				setBusy(true);
				const task = text.trim() === ""
					? clearPath(scope, ["imageGen", "presetArtists", name])
					: writePath(scope, ["imageGen", "presetArtists", name], text);
				task.then(
					() => { setBusy(false); setNotice(""); },
					(error) => { setBusy(false); setNotice("保存失败：" + String(error && error.message ? error.message : error)); },
				);
			};

			/** 模型配置名清单（下拉用）。 */
			const modelNames = (Array.isArray(value.models) ? value.models : [])
				.map(item => (item && typeof item.name === "string" ? item.name.trim() : ""))
				.filter(name => name !== "");
			/** 默认服务商：模型配置和默认模型都跟随它去拉模型列表。 */
			const defaultProviderId = value.provider === undefined || value.provider === "" ? "deepseek-official" : value.provider;
			/** 拉取到的模型清单（按服务商）；没拉过或不是这个服务商就返回 undefined。 */
			const catalogOf = (providerId) => {
				const id = providerId === undefined || providerId === null ? "" : String(providerId);
				if (id === "" || modelCatalog.provider !== id) return undefined;
				return modelCatalog;
			};
			/** 让 Host 去问服务商要模型列表：动作 + 令牌一次写入（Host 侧令牌变化才执行）。 */
			const fetchModels = (providerId) => {
				setBusy(true);
				scope.mutate([
					{ op: "set", path: ["modelFetchProvider"], value: providerId },
					{ op: "set", path: ["modelFetchToken"], value: Date.now() },
				]).then(
					() => { setBusy(false); setNotice(""); },
					(error) => { setBusy(false); setNotice("拉取请求发送失败：" + String(error && error.message ? error.message : error)); },
				);
			};
			/** 可选服务商：dsh 里的 provider + 自定义 API 服务商。 */
			const providerOptions = Array.from(new Set(
				([]).concat(
					Array.isArray(live.providers) ? live.providers : [],
					(Array.isArray(value.apiProviders) ? value.apiProviders : [])
						.map(item => (item && typeof item.id === "string" ? item.id.trim() : "")),
				).filter(id => typeof id === "string" && id !== ""),
			)).map(id => ({ value: id, label: id }));

			/** 一个用途的模型分配：主模型 + 备用模型两个下拉。 */
			const slotRow = (label, kind, hint) => {
				const slot = (value.modelSlots || {})[kind] || {};
				const commit = (field, next) => {
					if (next === "") reset(["modelSlots", kind, field])();
					else set(["modelSlots", kind, field])(next);
				};
				return field(label, ["modelSlots", kind, "model"], h("div", { className: "qgm-inline" },
					h("div", { className: "qgm-grow" }, h(ModelSelectField, {
						value: slot.model, disabled: disabled, names: modelNames, emptyLabel: "跟随默认",
						onCommit: (next) => { commit("model", next); },
					})),
					h("span", { className: "qgm-mini-label" }, "备用"),
					h("div", { className: "qgm-grow" }, h(ModelSelectField, {
						value: slot.backup, disabled: disabled, names: modelNames, emptyLabel: "不启用",
						onCommit: (next) => { commit("backup", next); },
					})),
				), hint);
			};

			// 白名单：列表为空表示不限制；一旦改动就先物化成「当前全部」，再增删。
			// 全部关掉时写入哨兵值（永远匹配不到真实群号/QQ 号），表达「谁都不允许」，
			// 避免空数组被当成「不限制」而语义反转。
			const NONE = "__none__";
			const materialize = (list, known) => (list.length > 0 ? list.slice() : known.slice());
			const normalize = (list) => (list.length === 0 ? [NONE] : list);
			const toggleAllowGroup = (id, next) => {
				const base = materialize(allowGroups, liveGroups.map(item => item.id)).filter(item => item !== NONE);
				const updated = next ? Array.from(new Set(base.concat([id]))) : base.filter(item => item !== id);
				set(["allowGroups"])(normalize(updated));
			};
			const toggleAllowUser = (id, next) => {
				const base = materialize(allowUsers, livePrivates.map(item => item.id)).filter(item => item !== NONE);
				const updated = next ? Array.from(new Set(base.concat([id]))) : base.filter(item => item !== id);
				set(["allowUsers"])(normalize(updated));
			};

			const groupRow = (group) => {
				const allowed = allowGroups.length === 0 || allowGroups.indexOf(group.id) >= 0;
				const override = groupOverrides[group.id] || {};
				return h("div", { key: group.id, className: "qgm-item" },
					h("div", { className: "qgm-item-head" },
						h("span", { className: "qgm-id" }, group.id),
						h("span", { className: "qgm-meta" },
							String(group.messages) + " 条记录" + (group.summaries ? " · " + group.summaries + " 条总结" : "")),
						h("div", { className: "qgm-spacer" }),
						h(Switch, {
							checked: allowed, label: "允许在群 " + group.id + " 发言", disabled: disabled,
							onChange: (next) => { toggleAllowGroup(group.id, next); },
						}),
						h(Button, {
							variant: "ghost", size: "sm", disabled: disabled,
							onClick: () => { set(["groups", group.id, "resetToken"])(Date.now()); },
						}, "清空记忆"),
					),
					h("div", { className: "qgm-item-fields" },
						h("div", { className: "qgm-mini qgm-w130" }, h("span", { className: "qgm-mini-label" }, "角色"),
							h(SelectField, {
								value: override.character === undefined ? "" : override.character,
								disabled: disabled,
								options: [{ value: "", label: "跟随默认" }].concat(characters.map(id => ({ value: id, label: id }))),
								onCommit: (next) => {
									if (next === undefined) reset(["groups", group.id, "character"])();
									else set(["groups", group.id, "character"])(next);
								},
							})),
						h("div", { className: "qgm-mini qgm-grow qgm-w180" }, h("span", { className: "qgm-mini-label" }, "模型"),
							h(ModelSelectField, {
								value: override.model, disabled: disabled, names: modelNames, emptyLabel: "跟随默认",
								onCommit: (next) => {
									if (next === "") reset(["groups", group.id, "model"])();
									else set(["groups", group.id, "model"])(next);
								},
							})),
						h("div", { className: "qgm-mini qgm-grow qgm-w180" }, h("span", { className: "qgm-mini-label" }, "备用"),
							h(ModelSelectField, {
								value: override.backup, disabled: disabled, names: modelNames, emptyLabel: "不启用",
								onCommit: (next) => {
									if (next === "") reset(["groups", group.id, "backup"])();
									else set(["groups", group.id, "backup"])(next);
								},
							})),
					),
				);
			};

			const privateRow = (item) => {
				const allowed = allowUsers.length === 0 || allowUsers.indexOf(item.id) >= 0;
				return h("div", { key: item.id, className: "qgm-item" },
					h("div", { className: "qgm-item-head" },
						h("span", { className: "qgm-id" }, item.id),
						h("span", { className: "qgm-meta" },
							String(item.messages) + " 条记录" + (item.summaries ? " · " + item.summaries + " 条总结" : "")),
						h("div", { className: "qgm-spacer" }),
						h(Switch, {
							checked: allowed, label: "允许回应 " + item.id, disabled: disabled,
							onChange: (next) => { toggleAllowUser(item.id, next); },
						}),
						h(Button, {
							variant: "ghost", size: "sm", disabled: disabled,
							onClick: () => {
								const base = materialize(allowUsers, livePrivates.map(x => x.id)).filter(x => x !== item.id && x !== NONE);
								set(["allowUsers"])(base.length === 0 ? [NONE] : base);
							},
						}, "移除"),
					),
				);
			};

			return h("div", { className: "qgm-card" },
				// 标题行：点一下展开/收起，折叠时也能看到连接状态。
				h("button", {
					type: "button",
					"aria-expanded": open,
					"aria-label": (open ? "收起" : "展开") + "：QQ 群友",
					className: "qgm-header",
					onClick: () => { setOpen(!open); },
				},
					h("span", { className: "qgm-head-text" },
						h("span", { className: "qgm-title" }, "QQ 群友"),
						h("span", { className: "qgm-desc" },
							"让 AI 以群友身份待在 QQ 群里：被 @ 或点名才接话，按角色卡说话，每个群可以单独换角色和模型。"),
					),
					h(StatusLine, { status: statusSnapshot.value }),
					h(IconChevronDownOutline14, {
						className: "qgm-chevron",
						style: { transform: open ? "rotate(180deg)" : "none" },
					}),
				),

				open ? h("div", { className: "qgm-body" },
				// 分组折叠：不点开就是六行标题（25 个区块全铺开太长了）。
				fold("basic", "基本设置", [
				section("发言范围（白名单）", [
					h("div", { key: "grouplist", className: "qgm-list" },
						liveGroups.length === 0
							? h("p", { className: "qgm-hint" }, "还没有记录到群。机器人在群里收到消息后会自动出现在这里。")
							: liveGroups.map(groupRow),
					),
					h(AddIdRow, {
						key: "addgroup",
						placeholder: "手动添加群号",
						disabled: disabled,
						onAdd: (id) => { toggleAllowGroup(id, true); },
					}),
					note("grouphint",
						"开关打开 = 机器人在这个群会发言。没有开关时（列表为空）所有群都会响应；"
						+ "关掉任意一个群就会进入白名单模式，只保留还开着的群。"),
					h("h3", { key: "privatetitle", className: "qgm-section-title" }, "私聊"),
					h("div", { key: "privatelist", className: "qgm-list" },
						livePrivates.length === 0
							? h("p", { className: "qgm-hint" }, "还没有私聊记录。")
							: livePrivates.map(privateRow),
					),
					h(AddIdRow, {
						key: "adduser",
						placeholder: "手动添加 QQ 号",
						disabled: disabled,
						onAdd: (id) => { toggleAllowUser(id, true); },
					}),
				]),

				section("连接方式", [
					field("模式", ["mode"], h(SelectField, {
						value: value.mode, disabled: disabled,
						options: [
							{ value: "", label: "自动（按下面的地址推断）" },
							{ value: "forward", label: "正向 WS：插件连协议端" },
							{ value: "reverse", label: "反向 WS：协议端连插件" },
						],
						onCommit: set(["mode"]),
					}), "正向适合协议端自己开着 WS 服务端（SnowLuma / NapCat 服务端模式）；反向适合协议端支持「WebSocket 客户端」。"),

					field("正向地址", ["wsUrl"], h(TextField, {
						value: value.wsUrl, disabled: disabled, placeholder: "ws://127.0.0.1:3001",
						onCommit: set(["wsUrl"]),
					}), "例如 ws://127.0.0.1:3001"),

					field("反向监听", ["listenPort"], h(NumberField, {
						value: value.listenPort, disabled: disabled,
						onCommit: set(["listenPort"]),
					}), "反向模式下插件监听的端口，默认 3001"),

					field("访问令牌", ["accessToken"], h(TextField, {
						value: value.accessToken, disabled: disabled, secret: true,
						placeholder: "留空表示不校验",
						onCommit: set(["accessToken"]),
					}), "与 QQ 协议端的 token 保持一致"),

					field("重新连接", ["reloadToken"], h("div", { className: "qgm-inline" },
						h(Button, {
							variant: "outline", size: "sm", disabled: busy,
							onClick: () => { set(["reloadToken"])((value.reloadToken || 0) + 1); },
						}, "重连"),
					), "改完连接配置后点一下，立即用新配置重连"),
				]),

				], { open: true }),

				fold("model", "模型与连接（协议端 / 模型 / 角色）", [
				section("QQ 协议端（SnowLuma）", [
					field("模式", ["protocolSide", "mode"], h(SelectField, {
						value: (value.protocolSide || {}).mode, disabled: disabled,
						options: [
							{ value: "local", label: "本地托管：dsh 启动时自动打开协议端" },
							{ value: "external", label: "外部手动：协议端由我自己启动" },
						],
						onCommit: set(["protocolSide", "mode"]),
					}), "托管模式下插件负责拉起 / 停止本地协议端；手动模式下插件只连接，不碰进程（可用仓库里的「本地启动 QQ 群友.bat」一键启动）。"),

					field("进程状态", ["protocolSide", "status"], h(ProtocolSideStatus, {
						live: live.protocolSide || {}, mode: (value.protocolSide || {}).mode,
						busy: busy, onAction: runLauncherAction,
					}), "启动 / 停止 / 重启只对托管模式生效；管理台是协议端自己的 Web 界面"),

					field("启动命令", ["protocolSide", "command"], h(TextField, {
						value: (value.protocolSide || {}).command, disabled: disabled,
						placeholder: "留空自动探测",
						onCommit: (next) => {
							if (next.trim() === "") reset(["protocolSide", "command"])();
							else set(["protocolSide", "command"])(next.trim());
						},
					}), "完整命令行，路径带空格时用引号，例如 \"C:\\qq-protocol\\node.exe\" \"C:\\qq-protocol\\index.mjs\""),

					field("工作目录", ["protocolSide", "workDir"], h(TextField, {
						value: (value.protocolSide || {}).workDir, disabled: disabled,
						placeholder: "默认用命令所在目录",
						onCommit: (next) => {
							if (next.trim() === "") reset(["protocolSide", "workDir"])();
							else set(["protocolSide", "workDir"])(next.trim());
						},
					}), "协议端的启动目录"),

					field("自动启动", ["protocolSide", "autoStart"], h(SwitchField, {
						value: (value.protocolSide || {}).autoStart !== false, disabled: disabled,
						label: "dsh 启动时自动打开协议端",
						onCommit: set(["protocolSide", "autoStart"]),
					}), "只对托管模式生效；关掉后可以自己按「启动」"),

					field("退出时关闭", ["protocolSide", "autoStop"], h(SwitchField, {
						value: (value.protocolSide || {}).autoStop === true, disabled: disabled,
						label: "dsh 退出时关闭协议端",
						onCommit: set(["protocolSide", "autoStop"]),
					}), "默认关：dsh 退出后协议端继续跑，QQ 不掉线"),

					field("显示窗口", ["protocolSide", "showConsole"], h(SwitchField, {
						value: (value.protocolSide || {}).showConsole !== false, disabled: disabled,
						label: "显示协议端控制台窗口",
						onCommit: set(["protocolSide", "showConsole"]),
					}), "关掉则后台运行，输出写到下面的日志文件"),

					field("就绪端口", ["protocolSide", "readyPort"], h(NumberField, {
						value: (value.protocolSide || {}).readyPort, disabled: disabled,
						onCommit: set(["protocolSide", "readyPort"]),
					}), "0 = 跟随连接配置（正向取 wsUrl 端口，反向取监听端口）"),

					field("管理台", ["protocolSide", "webuiUrl"], h(TextField, {
						value: (value.protocolSide || {}).webuiUrl, disabled: disabled,
						placeholder: "http://127.0.0.1:5099",
						onCommit: (next) => {
							if (next.trim() === "") reset(["protocolSide", "webuiUrl"])();
							else set(["protocolSide", "webuiUrl"])(next.trim());
						},
					}), "协议端自带的 Web 管理台地址，仅用于展示和跳转"),

					field("协议端日志", ["protocolSide", "logFile"], h(TextField, {
						value: (value.protocolSide || {}).logFile, disabled: disabled,
						placeholder: "默认 <数据目录>/protocol-side.log",
						onCommit: (next) => {
							if (next.trim() === "") reset(["protocolSide", "logFile"])();
							else set(["protocolSide", "logFile"])(next.trim());
						},
					}), "不显示控制台窗口时，协议端的输出写到这里"),
				]),

				section("模型配置", [
					field("模型清单", ["models"], h(ModelPresetsField, {
						value: value.models, disabled: disabled, providers: providerOptions,
						defaultProvider: defaultProviderId, catalogOf: catalogOf, onFetch: fetchModels,
					}), "给常用的「服务商 + 模型」起个名字（服务商就是上面 API 服务商里的 id，或 dsh 自带的 provider）；"
						+ "点「拉取模型」向服务商要一份模型列表，模型框里就能直接挑，不用手打。"),

					field("默认服务商", ["provider"], h(SelectField, {
						value: value.provider, disabled: disabled,
						options: [{ value: "", label: "deepseek-official" }].concat(providerOptions),
						onCommit: (next) => {
							if (next === undefined || next === "") reset(["provider"])();
							else set(["provider"])(next);
						},
					}), "模型配置没写服务商时用它；dsh 自带的 provider 或自定义服务商 id"),

					field("默认模型", ["model"], h("div", { className: "qgm-control" },
						h(TextField, {
							value: value.model, disabled: disabled, placeholder: "deepseek-v4-flash",
							list: "qgm-models-default",
							onCommit: set(["model"]),
						}),
						h(ModelDatalist, {
							id: "qgm-models-default",
							models: catalogOf(defaultProviderId) === undefined ? [] : catalogOf(defaultProviderId).models,
						}),
						h(ModelCatalogNote, { catalog: catalogOf(defaultProviderId) }),
						h("div", { className: "qgm-actions" },
							h(ModelFetchButton, { provider: defaultProviderId, disabled: disabled, onFetch: fetchModels }),
						),
					), "模型分配里没选时用它；一般保持默认即可"),
				]),

				section("模型分配", [
					slotRow("群聊", "chat", "群聊用的模型；备用模型在它请求失败（401、超时、网络错误…）时自动顶上"),
					slotRow("持续学习", "learner", "留空跟随群聊模型；建议用便宜的快模型"),
					slotRow("识图", "vision", "留空跟随群聊模型；要选能读图的模型"),
					live.modelFallback
						? h("div", { key: "fallbacknote", className: "qgm-fallback" },
							h(Tag, { tone: "warning" }, "降级"),
							h("span", { className: "qgm-fallback-text" }, "最近一次自动降级：" + live.modelFallback))
						: null,
				]),

				section("角色与默认参数", [
					field("默认角色", ["defaultCharacter"], h(SelectField, {
						value: value.defaultCharacter, disabled: disabled,
						options: characters.map(id => ({ value: id, label: id })),
						onCommit: (next) => { if (next !== undefined) set(["defaultCharacter"])(next); },
					}), "没有单独设置的群都用这个角色"),

					field("温度", ["temperature"], h(NumberField, {
						value: value.temperature, disabled: disabled,
						onCommit: set(["temperature"]),
					}), "0~2，越大越随性"),

					field("最大 token", ["maxTokens"], h(NumberField, {
						value: value.maxTokens, disabled: disabled,
						onCommit: set(["maxTokens"]),
					}), "单次回复的长度上限"),
				]),

				section("独立 API 服务商", [
					field("服务商", ["apiProviders"], h(ApiProvidersField, {
						value: value.apiProviders, disabled: disabled,
						onCommit: set(["apiProviders"]),
					}), "插件自带 OpenAI / Anthropic 协议客户端，不经过 dsh；用 服务商id/模型名 调用"),
				]),

				]),

				fold("fun", "群友玩法（过滤 / 联网 / 提醒 / 天气 / 语音 / 老婆 / 塔罗 / 表情）", [
				section("发送过滤（违禁词）", [
					field("启用", ["outboundFilter", "enabled"], h(SwitchField, {
						value: (value.outboundFilter || {}).enabled !== false, disabled: disabled,
						label: "发送前检查违禁词",
						onCommit: set(["outboundFilter", "enabled"]),
					}), "机器人往 QQ 发文字前先检查一遍；词表默认用「持续学习 → 禁用词」那份"),

					field("拦截方式", ["outboundFilter", "mode"], h(SelectField, {
						value: (value.outboundFilter || {}).mode, disabled: disabled,
						options: [
							{ value: "block", label: "整条不发（推荐）" },
							{ value: "redact", label: "把违禁词替换成 *" },
						],
						onCommit: (next) => {
							if (next === undefined) reset(["outboundFilter", "mode"])();
							else set(["outboundFilter", "mode"])(next);
						},
					}), "拦下的消息会写进插件日志"),

					field("单独词表", ["outboundFilter", "bannedWords"], h(ListField, {
						value: (value.outboundFilter || {}).bannedWords || [], disabled: disabled,
						placeholder: "留空用「持续学习 → 禁用词」",
						onCommit: set(["outboundFilter", "bannedWords"]),
					}), "逗号/顿号分隔；不区分大小写，长的词优先匹配"),
				]),

				section("天气", [
					field("启用", ["weather", "enabled"], h(SwitchField, {
						value: (value.weather || {}).enabled !== false, disabled: disabled, label: "注入当前天气",
						onCommit: set(["weather", "enabled"]),
					}), "被问到天气时按 Open-Meteo 实时数据如实回答；按公网 IP 粗略定位城市（不保存 IP），10 分钟缓存"),

					field("位置名", ["weather", "locationName"], h(TextField, {
						value: (value.weather || {}).locationName, disabled: disabled, placeholder: "留空自动定位",
						onCommit: (next) => {
							if (next.trim() === "") reset(["weather", "locationName"])();
							else set(["weather", "locationName"])(next.trim());
						},
					}), "提示词里显示的位置名；留空用 IP 定位到的城市"),

					field("自动定位", ["weather", "autoDetectFromIp"], h(SwitchField, {
						value: (value.weather || {}).autoDetectFromIp !== false, disabled: disabled, label: "按公网 IP 定位城市",
						onCommit: set(["weather", "autoDetectFromIp"]),
					}), "关掉就按下面的经纬度查天气"),

					field("纬度", ["weather", "latitude"], h(NumberField, {
						value: (value.weather || {}).latitude, disabled: disabled,
						onCommit: set(["weather", "latitude"]),
					}), "关闭自动定位时必填"),

					field("经度", ["weather", "longitude"], h(NumberField, {
						value: (value.weather || {}).longitude, disabled: disabled,
						onCommit: set(["weather", "longitude"]),
					}), "关闭自动定位时必填"),
				]),

				section("联网与查资料", [
					field("启用", ["web", "enabled"], h(SwitchField, {
						value: (value.web || {}).enabled !== false, disabled: disabled, label: "允许联网查资料",
						onCommit: set(["web", "enabled"]),
					}), "开了之后会用 [搜索:] [网页:] [查梗:] 查东西；关掉这些标记全都不认"),

					field("搜索页", ["web", "searchUrl"], h(TextField, {
						value: (value.web || {}).searchUrl, disabled: disabled, placeholder: "https://cn.bing.com/search",
						onCommit: (next) => {
							if (next.trim() === "") reset(["web", "searchUrl"])();
							else set(["web", "searchUrl"])(next.trim());
						},
					}), "默认抓 Bing 结果页，不需要任何 Key；有自建搜索页也可以换"),

					field("结果条数", ["web", "maxResults"], h(NumberField, {
						value: (value.web || {}).maxResults, disabled: disabled,
						onCommit: set(["web", "maxResults"]),
					}), "一次返回几条搜索结果（1~10，默认 6）"),

					field("超时（毫秒）", ["web", "timeoutMs"], h(NumberField, {
						value: (value.web || {}).timeoutMs, disabled: disabled,
						onCommit: set(["web", "timeoutMs"]),
					}), "搜索请求超时，默认 15000"),

					field("自定义搜索接口", ["web", "customBaseUrl"], h(TextField, {
						value: (value.web || {}).customBaseUrl, disabled: disabled, placeholder: "留空用内置 Bing 抓取",
						onCommit: (next) => {
							if (next.trim() === "") reset(["web", "customBaseUrl"])();
							else set(["web", "customBaseUrl"])(next.trim());
						},
					}), "填了就用它（POST {query}，返回 JSON）；比抓 Bing 稳，但要有这个服务"),

					field("自定义接口密钥", ["web", "customApiKey"], h(TextField, {
						value: (value.web || {}).customApiKey, disabled: disabled, placeholder: "可选",
						onCommit: (next) => {
							if (next.trim() === "") reset(["web", "customApiKey"])();
							else set(["web", "customApiKey"])(next.trim());
						},
					}), "以 Bearer 头发出；用内置 Bing 时留空"),

					note("web-note", "抓网页正文走 SSRF 防护：内网 / 本机地址一律拒绝，重定向每一跳都重新校验。"),
				]),

				section("AI 信件", [
					field("启用", ["notes", "enabled"], h(SwitchField, {
						value: (value.notes || {}).enabled !== false, disabled: disabled, label: "隔一阵子留一张小字条",
						onCommit: set(["notes", "enabled"]),
					}), "聊到考试、约定、难过的事、道谢之后，过一会儿主动发一条；冷却与周限防刷屏"),

					field("写信模型", ["notes", "model"], h(TextField, {
						value: (value.notes || {}).model, disabled: disabled, placeholder: "留空跟随默认群聊模型",
						onCommit: (next) => {
							if (next.trim() === "") reset(["notes", "model"])();
							else set(["notes", "model"])(next.trim());
						},
					}), "模型配置名，或 服务商id/模型名"),

					field("备用模型", ["notes", "backup"], h(TextField, {
						value: (value.notes || {}).backup, disabled: disabled, placeholder: "留空跟随群聊备用",
						onCommit: (next) => {
							if (next.trim() === "") reset(["notes", "backup"])();
							else set(["notes", "backup"])(next.trim());
						},
					}), "写信失败时自动切换"),

					field("最早投递（分钟）", ["notes", "delayMinMinutes"], h(NumberField, {
						value: (value.notes || {}).delayMinMinutes, disabled: disabled,
						onCommit: set(["notes", "delayMinMinutes"]),
					}), "触发后随机等 30~120 分钟，这里调下限"),

					field("最晚投递（分钟）", ["notes", "delayMaxMinutes"], h(NumberField, {
						value: (value.notes || {}).delayMaxMinutes, disabled: disabled,
						onCommit: set(["notes", "delayMaxMinutes"]),
					}), "投递延迟的上限"),

					field("投递冷却（小时）", ["notes", "cooldownHours"], h(NumberField, {
						value: (value.notes || {}).cooldownHours, disabled: disabled,
						onCommit: set(["notes", "cooldownHours"]),
					}), "两次投递最少隔几小时（默认 24）"),

					field("每周上限", ["notes", "weeklyLimit"], h(NumberField, {
						value: (value.notes || {}).weeklyLimit, disabled: disabled,
						onCommit: set(["notes", "weeklyLimit"]),
					}), "七天窗口里最多发几封（默认 3）"),

					field("群安静时间（分钟）", ["notes", "requiredQuietMinutes"], h(NumberField, {
						value: (value.notes || {}).requiredQuietMinutes, disabled: disabled,
						onCommit: set(["notes", "requiredQuietMinutes"]),
					}), "投递前群里需要安静多少分钟（默认 10 分钟）"),
				]),

				section("语音（GPT-SoVITS）", [
					field("启用", ["voice", "enabled"], h(SwitchField, {
						value: (value.voice || {}).enabled !== false, disabled: disabled, label: "回复带 QQ 语音",
						onCommit: set(["voice", "enabled"]),
					}), "用本地 GPT-SoVITS 合成语音后发一条 QQ 语音；合成失败只影响语音，文字照常"),

					field("TTS 端点", ["voice", "endpoint"], h(TextField, {
						value: (value.voice || {}).endpoint, disabled: disabled, placeholder: "http://127.0.0.1:9880/tts",
						onCommit: (next) => {
							if (next.trim() === "") reset(["voice", "endpoint"])();
							else set(["voice", "endpoint"])(next.trim());
						},
					}), "api_v2 格式的本地 TTS 接口"),

					field("日文 TTS 端点", ["voice", "japaneseEndpoint"], h(TextField, {
						value: (value.voice || {}).japaneseEndpoint, disabled: disabled, placeholder: "http://127.0.0.1:9881/tts",
						onCommit: (next) => {
							if (next.trim() === "") reset(["voice", "japaneseEndpoint"])();
							else set(["voice", "japaneseEndpoint"])(next.trim());
						},
					}), "日文音色单独一套服务（与 mod 的 JapaneseVoiceEndpoint 一致，默认 9881）"),

					field("语音语言", ["voice", "language"], h(SelectField, {
						value: (value.voice || {}).language === undefined ? "auto" : (value.voice || {}).language,
						disabled: disabled,
						options: [
							{ value: "auto", label: "自动（按回复语言）" },
							{ value: "zh", label: "中文音色" },
							{ value: "ja", label: "日文音色" },
						],
						onCommit: (next) => {
							if (next === undefined || next === "auto") reset(["voice", "language"])();
							else set(["voice", "language"])(next);
						},
					}), "自动：回复里出现假名就走日文音色。两套音色的端点、参考音与 api_v2 配置各自独立，互不影响"),

					field("语音宿主路径", ["voice", "hostPath"], h(TextField, {
						value: (value.voice || {}).hostPath, disabled: disabled, placeholder: "留空自动探测",
						onCommit: (next) => {
							if (next.trim() === "") reset(["voice", "hostPath"])();
							else set(["voice", "hostPath"])(next.trim());
						},
					}), "语音宿主可执行文件的完整路径"),

					field("自动拉起服务", ["voice", "autoStart"], h(SwitchField, {
						value: (value.voice || {}).autoStart !== false, disabled: disabled, label: "服务没起时自动拉起",
						onCommit: set(["voice", "autoStart"]),
					}), "只对本机回环地址生效；dsh 启动时就会预热，冷启动约 20~30 秒（装载模型）。" +
						"先试随包宿主，宿主起不来会自动改用 venv 直接跑 api_v2"),

					field("参考音目录", ["voice", "refsDir"], h(TextField, {
						value: (value.voice || {}).refsDir, disabled: disabled, placeholder: "默认 <数据目录>/voice/refs",
						onCommit: (next) => {
							if (next.trim() === "") reset(["voice", "refsDir"])();
							else set(["voice", "refsDir"])(next.trim());
						},
					}), "中文音色：放 calm/excited/wronged/sleepy-reference.wav（情绪参考音）；留空会自动探测语音运行时隔壁的 voice 目录"),

					field("日文参考音目录", ["voice", "japaneseRefsDir"], h(TextField, {
						value: (value.voice || {}).japaneseRefsDir, disabled: disabled, placeholder: "留空自动探测（voice/jp）",
						onCommit: (next) => {
							if (next.trim() === "") reset(["voice", "japaneseRefsDir"])();
							else set(["voice", "japaneseRefsDir"])(next.trim());
						},
					}), "日文音色：calm / excited / wronged / sleepy-reference.wav，另有 calm-aux-reference.wav（与 mod 一致）"),

					field("语音概率", ["voice", "probability"], h(NumberField, {
						value: (value.voice || {}).probability, disabled: disabled,
						onCommit: set(["voice", "probability"]),
					}), "0~1：一条回复转语音的概率，1 = 每条都说（嫌吵可以调低）"),

					field("最长字数", ["voice", "maxChars"], h(NumberField, {
						value: (value.voice || {}).maxChars, disabled: disabled,
						onCommit: set(["voice", "maxChars"]),
					}), "超过这个字数的回复不合成（默认 200）"),
				]),

				section("今日老婆", [
					field("启用", ["wife", "enabled"], h(SwitchField, {
						value: (value.wife || {}).enabled !== false, disabled: disabled, label: "全员可玩",
						onCommit: set(["wife", "enabled"]),
					}), "从最近发言过的群友里抽一位今日老婆；移植自 AstrBot 插件 wifepicker"),

					field("每天抽取上限", ["wife", "dailyLimit"], h(NumberField, {
						value: (value.wife || {}).dailyLimit, disabled: disabled,
						onCommit: set(["wife", "dailyLimit"]),
					}), "每人每天最多抽几次（默认 1）"),

					field("活跃天数", ["wife", "activeDays"], h(NumberField, {
						value: (value.wife || {}).activeDays, disabled: disabled,
						onCommit: set(["wife", "activeDays"]),
					}), "发言过多少天内算活跃、会被抽到（上限 30，默认 30）"),

					field("@ 抽中的老婆", ["wife", "atWife"], h(SwitchField, {
						value: (value.wife || {}).atWife !== false, disabled: disabled, label: "结果里 @ 对方",
						onCommit: set(["wife", "atWife"]),
					}), "关掉就不点名，只带头像"),

					field("关键词直发", ["wife", "keywordTrigger"], h(SwitchField, {
						value: (value.wife || {}).keywordTrigger !== false, disabled: disabled, label: "不带前缀也能触发",
						onCommit: set(["wife", "keywordTrigger"]),
					}), "开了之后群里直接发「今日老婆」「抽老婆」整句就触发；关掉要带 . 前缀"),

					field("排除名单", ["wife", "excludedUsers"], h(ListField, {
						value: (value.wife || {}).excludedUsers || [], disabled: disabled,
						placeholder: "QQ 号列表，逗号分隔",
						onCommit: set(["wife", "excludedUsers"]),
					}), "这些 QQ 不参与抽取与强娶"),

					field("强娶冷却（天）", ["wife", "forceCooldownDays"], h(NumberField, {
						value: (value.wife || {}).forceCooldownDays, disabled: disabled,
						onCommit: set(["wife", "forceCooldownDays"]),
					}), "强娶一次之后要等几天（默认 3，0 = 不限）"),

					field("分手冷却（小时）", ["wife", "breakupCooldownHours"], h(NumberField, {
						value: (value.wife || {}).breakupCooldownHours, disabled: disabled,
						onCommit: set(["wife", "breakupCooldownHours"]),
					}), "分手后要等几小时（默认 72，0 = 不限）"),
				]),

				section("星羽塔罗", [
					field("启用", ["tarot", "enabled"], h(SwitchField, {
						value: (value.tarot || {}).enabled !== false, disabled: disabled, label: "全员可玩",
						onCommit: set(["tarot", "enabled"]),
					}), ".占卜 问题 / .单抽 起卦；78 张韦特塔罗，移植自 AstrBot 插件 star_feather"),

					field("AI 解读", ["tarot", "aiEnabled"], h(SwitchField, {
						value: (value.tarot || {}).aiEnabled !== false, disabled: disabled, label: "解读用模型生成",
						onCommit: set(["tarot", "aiEnabled"]),
					}), "关了只发牌面图与内置牌义，不调模型"),

					field("解读模型", ["tarot", "model"], h(TextField, {
						value: (value.tarot || {}).model, disabled: disabled, placeholder: "留空跟随默认群聊模型",
						onCommit: (next) => {
							if (next.trim() === "") reset(["tarot", "model"])();
							else set(["tarot", "model"])(next.trim());
						},
					}), "模型配置名，或 服务商id/模型名"),

					field("解读超时（秒）", ["tarot", "aiTimeoutSeconds"], h(NumberField, {
						value: (value.tarot || {}).aiTimeoutSeconds, disabled: disabled,
						onCommit: set(["tarot", "aiTimeoutSeconds"]),
					}), "超时自动回退内置牌义（默认 30）"),

					field("占卜冷却（秒）", ["tarot", "cooldownSeconds"], h(NumberField, {
						value: (value.tarot || {}).cooldownSeconds, disabled: disabled,
						onCommit: set(["tarot", "cooldownSeconds"]),
					}), "同一人两次占卜的最小间隔（默认 10，0 = 不限）"),

					field("每日次数上限", ["tarot", "dailyCountLimit"], h(NumberField, {
						value: (value.tarot || {}).dailyCountLimit, disabled: disabled,
						onCommit: set(["tarot", "dailyCountLimit"]),
					}), "每人每天最多占卜几次（默认 0 = 不限）"),

					field("牌灵人设", ["tarot", "persona"], h(TextField, {
						value: (value.tarot || {}).persona, disabled: disabled, placeholder: "off / tsundere / gentle / mystic / random",
						onCommit: (next) => {
							if (next.trim() === "") reset(["tarot", "persona"])();
							else set(["tarot", "persona"])(next.trim().toLowerCase());
						},
					}), "只改解读口吻；random = 每次随机（默认）"),

					field("洗牌提示", ["tarot", "shuffleLines"], h(SwitchField, {
						value: (value.tarot || {}).shuffleLines !== false, disabled: disabled, label: "多张牌阵先发「洗牌中」",
						onCommit: set(["tarot", "shuffleLines"]),
					}), "单张牌阵（单抽/今日牌运）没有这个仪式感"),

					field("今日固定牌运", ["tarot", "dailyFixed"], h(SwitchField, {
						value: (value.tarot || {}).dailyFixed !== false, disabled: disabled, label: "运势类问题同一天同一张牌",
						onCommit: set(["tarot", "dailyFixed"]),
					}), "md5 确定性抽牌，问一百遍也是它；关掉就每次都重新随机"),
				]),


				section("定时提醒", [
					field("启用", ["reminders", "enabled"], h(SwitchField, {
						value: (value.reminders || {}).enabled !== false, disabled: disabled, label: "到点主动开口",
						onCommit: set(["reminders", "enabled"]),
					}), "群友说「明天九点提醒我…」就会定下，到点在原会话里发出来"),

					field("最少提前（秒）", ["reminders", "minDelaySec"], h(NumberField, {
						value: (value.reminders || {}).minDelaySec, disabled: disabled,
						onCommit: set(["reminders", "minDelaySec"]),
					}), "防「立刻提醒我」这种（默认 30 秒）"),

					field("迟到补发窗口（分钟）", ["reminders", "catchUpMinutes"], h(NumberField, {
						value: (value.reminders || {}).catchUpMinutes, disabled: disabled,
						onCommit: set(["reminders", "catchUpMinutes"]),
					}), "dsh 关着时到点的提醒，启动后在这个窗口内补发（默认 720 = 12 小时）"),

					field("全局上限", ["reminders", "maxPending"], h(NumberField, {
						value: (value.reminders || {}).maxPending, disabled: disabled,
						onCommit: set(["reminders", "maxPending"]),
					}), "最多挂着多少条提醒（默认 200）"),

					field("单会话上限", ["reminders", "maxPendingPerChat"], h(NumberField, {
						value: (value.reminders || {}).maxPendingPerChat, disabled: disabled,
						onCommit: set(["reminders", "maxPendingPerChat"]),
					}), "一个会话最多挂几条（默认 20）"),

					field("每人每日上限", ["reminders", "maxPerDay"], h(NumberField, {
						value: (value.reminders || {}).maxPerDay, disabled: disabled,
						onCommit: set(["reminders", "maxPerDay"]),
					}), "同一个人一天最多定几条（默认 20）"),

					field("到点 @ 提醒对象", ["reminders", "mentionTarget"], h(SwitchField, {
						value: (value.reminders || {}).mentionTarget !== false, disabled: disabled, label: "@ 一下定提醒的人",
						onCommit: set(["reminders", "mentionTarget"]),
					}), "关掉就只发一句话，不 @ 人"),

					field("到点带语音", ["reminders", "voice"], h(SwitchField, {
						value: (value.reminders || {}).voice !== false, disabled: disabled, label: "提醒也发一条语音",
						onCommit: set(["reminders", "voice"]),
					}), "语音开关也要开着才有效"),
				]),

				section("桌面工具（管理员私聊）", [
					field("高级电脑操作", ["desktop", "enabled"], h(SwitchField, {
						value: (value.desktop || {}).enabled === true, disabled: disabled, label: "允许指挥这台电脑",
						onCommit: set(["desktop", "enabled"]),
					}), "默认关。开了之后：管理员私聊发「截图」「内存状态」「打开下载文件夹」「复制「文本」」「5分钟后提醒我」等命令会本机执行；删档/关机/密码类命令永远拒绝，群友触发不了"),
				]),

				section("生命周期桥接（Codex / deepseek harness）", [
					field("启用", ["bridge", "enabled"], h(SwitchField, {
						value: (value.bridge || {}).enabled !== false, disabled: disabled, label: "Agent 开跑/等确认/跑完时播报",
						onCommit: set(["bridge", "enabled"]),
					}), "监听钩子事件目录，角色用自己的口吻播报（可带语音）"),

					field("事件目录", ["bridge", "eventsDir"], h(TextField, {
						value: (value.bridge || {}).eventsDir, disabled: disabled,
						placeholder: "留空用默认事件目录",
						onCommit: (next) => {
							if (next.trim() === "") reset(["bridge", "eventsDir"])();
							else set(["bridge", "eventsDir"])(next.trim());
						},
					}), "钩子把事件 JSON 写进这个目录；tools/bridge-notify.mjs 就是干这个的"),

					field("播报的私聊", ["bridge", "notifyUsers"], h(ListField, {
						value: (value.bridge || {}).notifyUsers || [], disabled: disabled,
						placeholder: "留空默认播报给第一个管理员",
						onCommit: set(["bridge", "notifyUsers"]),
					}), "QQ 号列表，逗号/顿号分隔"),

					field("播报的群", ["bridge", "notifyGroups"], h(ListField, {
						value: (value.bridge || {}).notifyGroups || [], disabled: disabled,
						placeholder: "默认不在群里播报",
						onCommit: set(["bridge", "notifyGroups"]),
					}), "群号列表；生命周期是电脑上的事，私聊通常就够了"),

					field("播报带语音", ["bridge", "voice"], h(SwitchField, {
						value: (value.bridge || {}).voice !== false, disabled: disabled, label: "播报时发语音",
						onCommit: set(["bridge", "voice"]),
					}), "「做好了。你来看看吧。」也可以是语音"),
				]),

				section("表情包", [
					field("启用", ["stickers", "enabled"], h(SwitchField, {
						value: (value.stickers || {}).enabled === true, disabled: disabled, label: "启用表情包",
						onCommit: set(["stickers", "enabled"]),
					}), "把本地表情文件夹里的图片给模型用，它想发时输出 [表情:名字]"),

					field("表情目录", ["stickers", "dir"], h(TextField, {
						value: (value.stickers || {}).dir, disabled: disabled, placeholder: "默认 <数据目录>/stickers",
						onCommit: (next) => {
							if (next.trim() === "") reset(["stickers", "dir"])();
							else set(["stickers", "dir"])(next.trim());
						},
					}), "放表情图片的文件夹（png/jpg/gif/webp），文件名就是表情名"),

					field("列出个数", ["stickers", "maxListed"], h(NumberField, {
						value: (value.stickers || {}).maxListed, disabled: disabled,
						onCommit: set(["stickers", "maxListed"]),
					}), "提示词里最多告诉模型多少个表情名"),

					field("发表情概率", ["stickers", "probability"], h(NumberField, {
						value: (value.stickers || {}).probability, disabled: disabled,
						onCommit: set(["stickers", "probability"]),
					}), "0~1：模型自己没发时，顺手补一张表情的概率（默认 0.2）"),
				]),

				]),

				fold("image", "生图与识图（画风预设在这里填）", [
				section("生图（Nai2API）", [
					field("启用", ["imageGen", "enabled"], h(SwitchField, {
						value: (value.imageGen || {}).enabled === true, disabled: disabled, label: "启用生图",
						onCommit: set(["imageGen", "enabled"]),
					}), "群友让你画图时真的画一张发出来；画一张要好几分钟，会消耗生图服务里的点数（普通尺寸 1 点）"),

					note("imagegenhint", "模型被 @ 后用 [生图:英文标签] 触发；也能用「.生图 <标签>」直接画。"),

					field("密钥", ["imageGen", "token"], h(TextField, {
						value: (value.imageGen || {}).token, disabled: disabled, placeholder: "生图密钥…",
						onCommit: set(["imageGen", "token"]),
					}), "生图服务的密钥；这个要填上，只开开关画不了"),

					field("服务地址", ["imageGen", "baseUrl"], h(TextField, {
						value: (value.imageGen || {}).baseUrl, disabled: disabled, placeholder: "https://…",
						onCommit: (next) => {
							if (next.trim() === "") reset(["imageGen", "baseUrl"])();
							else set(["imageGen", "baseUrl"])(next.trim());
						},
					}), "生图服务地址（Nai2API 兼容接口）；留空则生图不可用"),

					field("模型", ["imageGen", "model"], h(SelectField, {
						value: (value.imageGen || {}).model, disabled: disabled,
						options: [
							{ value: "nai-diffusion-4-5-full", label: "V4.5 完整版（1 点/张）" },
							{ value: "nai-diffusion-5-full", label: "V5 完整版（5 点/张）" },
						],
						onCommit: set(["imageGen", "model"]),
					}), "V5 画得更好但贵 5 倍"),

					field("尺寸", ["imageGen", "size"], h(SelectField, {
						value: (value.imageGen || {}).size, disabled: disabled,
						options: [
							{ value: "竖图", label: "竖图（1 点）" },
							{ value: "横图", label: "横图（1 点）" },
							{ value: "方图", label: "方图（1 点）" },
							{ value: "2K竖图", label: "2K 竖图（15 点）" },
							{ value: "2K横图", label: "2K 横图（15 点）" },
							{ value: "2K方图", label: "2K 方图（15 点）" },
							{ value: "4K竖图", label: "4K 竖图（25 点）" },
							{ value: "4K横图", label: "4K 横图（25 点）" },
							{ value: "4K方图", label: "4K 方图（25 点）" },
						],
						onCommit: set(["imageGen", "size"]),
					}), "群里看一般用普通尺寸就够；点数按尺寸算，和「每次点数」留空时的估算一致"),

					field("画风", ["imageGen", "artist"], h(TextAreaField, {
						value: (value.imageGen || {}).artist, disabled: disabled,
						placeholder: "留空用服务端默认画风",
						onCommit: (next) => {
							if (next.trim() === "") reset(["imageGen", "artist"])();
							else set(["imageGen", "artist"])(next.trim());
						},
					}), "默认画师串（英文）：谁都没点名画风时用它。群友点名了画风（-p 画风名，或直接说画风名）就用那一条，见下面的「画风预设」"),

					field("负面词", ["imageGen", "negative"], h(TextAreaField, {
						value: (value.imageGen || {}).negative, disabled: disabled,
						placeholder: "留空用一份通用负面词（坏手坏脸、水印文字等）",
						onCommit: (next) => {
							if (next.trim() === "") reset(["imageGen", "negative"])();
							else set(["imageGen", "negative"])(next.trim());
						},
					}), "不想要的东西写这里（英文，逗号分隔）；留空用内置的通用负面词"),

					field("步数", ["imageGen", "steps"], h(NumberField, {
						value: (value.imageGen || {}).steps, disabled: disabled,
						onCommit: set(["imageGen", "steps"]),
					}), "默认 28（服务端上限就是 28）"),

					field("引导强度", ["imageGen", "scale"], h(NumberField, {
						value: (value.imageGen || {}).scale, disabled: disabled,
						onCommit: set(["imageGen", "scale"]),
					}), "提示词引导强度，默认 6"),

					field("每轮张数", ["imageGen", "maxPerReply"], h(NumberField, {
						value: (value.imageGen || {}).maxPerReply, disabled: disabled,
						onCommit: set(["imageGen", "maxPerReply"]),
					}), "一条回复里最多画几张，默认 1（防止一次画掉太多点数）"),

					field("排队上限", ["imageGen", "maxQueue"], h(NumberField, {
						value: (value.imageGen || {}).maxQueue, disabled: disabled,
						onCommit: set(["imageGen", "maxQueue"]),
					}), "每个群/私聊最多积压几张没画完的，默认 3（防止被刷屏）"),

					field("超时", ["imageGen", "timeoutSeconds"], h(NumberField, {
						value: (value.imageGen || {}).timeoutSeconds, disabled: disabled,
						onCommit: set(["imageGen", "timeoutSeconds"]),
					}), "从提交到出画等多少秒，默认 300；排队人多时要等更久，可以加大"),

					field("下载并发", ["imageGen", "downloadConnections"], h(NumberField, {
						value: (value.imageGen || {}).downloadConnections, disabled: disabled,
						onCommit: set(["imageGen", "downloadConnections"]),
					}), "服务端给每条连接限速，多开几条抢跑（谁先下完用谁）能快 2~3 倍；默认 2，设 1 恢复单连接"),

					field("发送方式", ["imageGen", "sendMode"], h(SelectField, {
						value: (value.imageGen || {}).sendMode, disabled: disabled,
						options: [
							{ value: "url", label: "图片地址（推荐）" },
							{ value: "base64", label: "下载后以 base64 发送" },
						],
						onCommit: set(["imageGen", "sendMode"]),
					}), "地址方式省插件一次下载；协议端下载不了图时改用 base64"),

					field("失败提示", ["imageGen", "notifyOnFailure"], h(SwitchField, {
						value: (value.imageGen || {}).notifyOnFailure !== false, disabled: disabled, label: "画失败时说一声",
						onCommit: set(["imageGen", "notifyOnFailure"]),
					}), "画不出来时在群里说一句，免得群友一直等"),

					field("信息标签", ["imageGen", "showImageInfo"], h(SwitchField, {
						value: (value.imageGen || {}).showImageInfo !== false, disabled: disabled, label: "图片下面报一行信息",
						onCommit: set(["imageGen", "showImageInfo"]),
					}), "画完在图下面跟一行「V5 | 绝区零游戏风 | 耗时37秒」，和原插件一致"),
				]),

				section("画风预设（画师串）", [
					note("presethint", "群友发「.画风」看自己当前模型的清单、「.v5画风」直接看 V5；发「.切v5」切模型。" +
						"清单里十几行的长回复会以「合并转发」发出来，不会把群聊刷长。"),
					note("presethint2", "下面逐个填画师串：留空 = 用这一条自己的（内置项或群命令存的自定义项）；填了就覆盖它，改完即时生效。" +
						"同名画师（两套表共用的那些）只填一条就够。V5 那 7 个内置画风原本没有画师串，拿到作者的 v5_presets.json 后贴在这里即可。"),

					h("div", { key: "presetlist", className: "qgm-list" },
						h(PresetArtistsField, {
							v45: presetStatus.v45 || [],
							v5: presetStatus.v5 || [],
							value: (value.imageGen || {}).presetArtists || {},
							disabled: disabled,
							onCommit: setPresetArtist,
						}),
					),

					field("V5 兜底画师串", ["imageGen", "v5FallbackArtist"], h(TextAreaField, {
						value: (value.imageGen || {}).v5FallbackArtist, disabled: disabled,
						placeholder: "留空用一份通用质量词（masterpiece, best quality, …）",
						onCommit: (next) => {
							if (next.trim() === "") reset(["imageGen", "v5FallbackArtist"])();
							else set(["imageGen", "v5FallbackArtist"])(next.trim());
						},
					}), "上面哪个 V5 画风还空着时，统一用它兜底（画得出图，但风格不是原版）"),

					field("V5 每日张数", ["imageGen", "v5DailyLimit"], h(NumberField, {
						value: (value.imageGen || {}).v5DailyLimit, disabled: disabled,
						onCommit: set(["imageGen", "v5DailyLimit"]),
					}), "每个 QQ 滚动 24 小时内最多画几张 V5，默认 4；填 0 表示不限"),

					field("V5 白名单", ["imageGen", "v5UnlimitedUsers"], h(ListField, {
						value: (value.imageGen || {}).v5UnlimitedUsers || [], disabled: disabled, placeholder: "123456789、987654321",
						onCommit: set(["imageGen", "v5UnlimitedUsers"]),
					}), "这些 QQ 用 V5 不限额"),
				]),

				section("识图（视觉模型）", [
					field("启用", ["vision", "enabled"], h(SwitchField, {
						value: (value.vision || {}).enabled === true, disabled: disabled, label: "启用识图",
						onCommit: set(["vision", "enabled"]),
					}), "有人发图时，把图交给视觉模型看一眼（会额外产生调用费用）"),

					note("visionmodelhint", "识图用哪个模型在「模型分配 → 识图」里选，这里只管开关和限额。"),
					field("最多张数", ["vision", "maxImages"], h(NumberField, {
						value: (value.vision || {}).maxImages, disabled: disabled,
						onCommit: set(["vision", "maxImages"]),
					}), "一条消息里最多看几张图"),

					field("单张上限", ["vision", "maxBytes"], h(NumberField, {
						value: (value.vision || {}).maxBytes, disabled: disabled,
						onCommit: set(["vision", "maxBytes"]),
					}), "单张图片字节上限，默认 1572864（1.5MB）"),
				]),

				]),

				fold("talk", "触发与知识库", [
				section("知识库", [
					field("启用", ["knowledge", "enabled"], h(SwitchField, {
						value: (value.knowledge || {}).enabled === true, disabled: disabled, label: "启用知识库",
						onCommit: set(["knowledge", "enabled"]),
					}), "默认关。开着时群友消息命中知识条目就把条目塞进提示词——仓库自带的文档写的是别的项目（RP-Hub / QQ Agent）的报错，机器人会当成群内事实讲，别直接拿去用。"),

					field("知识目录", ["knowledge", "dir"], h(TextField, {
						value: (value.knowledge || {}).dir, disabled: disabled, placeholder: "默认 <数据目录>/knowledge",
						onCommit: (next) => {
							if (next.trim() === "") reset(["knowledge", "dir"])();
							else set(["knowledge", "dir"])(next.trim());
						},
					}), "Markdown 文档：`## 大节` / `### 条目`；条目里可用「关键词：a，b」补充命中词；改完即时生效（会重读目录）"),
				]),

				section("触发规则", [
					field("被 @ 回复", ["trigger", "mention"], h(SwitchField, {
						value: trigger.mention !== false, disabled: disabled, label: "被 @ 回复",
						onCommit: set(["trigger", "mention"]),
					}), "别人 @ 机器人时是否接话"),

					field("唤醒前缀", ["trigger", "prefixes"], h(ListField, {
						value: trigger.prefixes || [], disabled: disabled, placeholder: "/ai、小深",
						onCommit: set(["trigger", "prefixes"]),
					}), "消息以这些词开头就接话，逗号分隔"),

					field("随机接话", ["trigger", "randomChance"], h(NumberField, {
						value: trigger.randomChance, disabled: disabled,
						onCommit: set(["trigger", "randomChance"]),
					}), "0~1，没人点名时自己插话的概率，默认 0（不插话）"),

					field("回复间隔", ["trigger", "cooldownSeconds"], h(NumberField, {
						value: trigger.cooldownSeconds, disabled: disabled,
						onCommit: set(["trigger", "cooldownSeconds"]),
					}), "两次回复至少间隔多少秒，防刷屏"),

					field("响应回复", ["trigger", "replyToSelf"], h(SwitchField, {
						value: trigger.replyToSelf !== false, disabled: disabled, label: "响应回复",
						onCommit: set(["trigger", "replyToSelf"]),
					}), "有人回复机器人的消息时是否接话"),

					field("响应私聊", ["trigger", "privateChat"], h(SwitchField, {
						value: trigger.privateChat !== false, disabled: disabled, label: "响应私聊",
						onCommit: set(["trigger", "privateChat"]),
					}), null),
				]),

				]),

				fold("memory", "记忆（记话 / 记人 / 学腔调）", [
					section("常用", [
						note("memory-intro", "机器人会自动记住群里的事：旧聊天按小时归档、认识每个人、学着像你们一样说话。三个开关全开就是推荐配置。"),

						field("旧事归档", ["memory", "enabled"], h(SwitchField, {
							value: memory.enabled !== false, disabled: disabled, label: "把聊天按小时存档",
							onCommit: set(["memory", "enabled"]),
						}), "存下来的旧聊天**不会每轮塞给模型**（那样又贵又容易让它答非所问）：平时不占额度，等聊到以前的事、模型自己翻（`[回忆:关键词]`）才取出来"),

						field("群友档案", ["people", "enabled"], h(SwitchField, {
							value: (value.people || {}).enabled !== false, disabled: disabled, label: "记住群里的人",
							onCommit: set(["people", "enabled"]),
						}), "按 QQ 号记住每个人的印象和约定，换群也不用重新认识"),

						field("说话习惯", ["learner", "enabled"], h(SwitchField, {
							value: learner.enabled === true, disabled: disabled, label: "学群友的说话腔调",
							onCommit: set(["learner", "enabled"]),
						}), "只学「怎么说」（句子长短、口头禅），不学「说什么」，也不改人设"),

						field("每次带多少条聊天记录", ["context", "maxTurns"], h(NumberField, {
							value: context.maxTurns, disabled: disabled,
							onCommit: set(["context", "maxTurns"]),
						}), "数字越大越记得住，也越费额度；30 条对大多数群够用"),

						note("memorymodelhint", "说话习惯用哪个模型，在「模型分配」里选。"),
					]),

					fold("memory-detail", "细调（不确定就保持默认）", [
						section("旧事归档怎么存", [
							field("保留多久（天）", ["memory", "retainDays"], h(NumberField, {
								value: memory.retainDays, disabled: disabled,
								onCommit: set(["memory", "retainDays"]),
							}), "超过这个天数的归档自动清掉（默认 120）。归档放在数据目录的 memory/chunks 下，按会话、按小时一个文件"),
						]),

						section("说话习惯怎么学", [
							field("多久学一次", ["learner", "batchMessages"], h(NumberField, {
								value: learner.batchMessages, disabled: disabled,
								onCommit: set(["learner", "batchMessages"]),
							}), "攒够这么多条群友消息提炼一次（默认 60）"),

							field("跳过最近几条", ["learner", "keepMessages"], h(NumberField, {
								value: learner.keepMessages, disabled: disabled,
								onCommit: set(["learner", "keepMessages"]),
							}), "最近这么多条不拿去学（默认 40）"),

							field("画像字数上限", ["learner", "maxChars"], h(NumberField, {
								value: learner.maxChars, disabled: disabled,
								onCommit: set(["learner", "maxChars"]),
							}), "学到的风格画像最多保留多少字（默认 400）"),

							field("禁用词", ["learner", "bannedWords"], h(ListField, {
								value: learner.bannedWords || [], disabled: disabled, placeholder: "奶龙、酒馆",
								onCommit: set(["learner", "bannedWords"]),
							}), "画像里出现这些词就整条丢掉，免得把它们带进提示词"),

							field("不学的群", ["learner", "skipGroups"], h(ListField, {
								value: learner.skipGroups || [], disabled: disabled, placeholder: "群号，逗号分隔",
								onCommit: set(["learner", "skipGroups"]),
							}), "这些群完全不参与学习——群里基本都是机器人时用"),

							field("不学的人", ["learner", "skipSpeakers"], h(ListField, {
								value: learner.skipSpeakers || [], disabled: disabled, placeholder: "小爱、群猫娘、管家",
								onCommit: set(["learner", "skipSpeakers"]),
							}), "昵称里带这些词的发言人不参与学习（包含即算），别的群混了 bot 时用"),

							field("思考强度", ["learner", "reasoningEffort"], h(TextField, {
								value: learner.reasoningEffort, disabled: disabled, placeholder: "off / low / high / max，留空用模型默认",
								onCommit: (next) => {
									if (next.trim() === "") reset(["learner", "reasoningEffort"])();
									else set(["learner", "reasoningEffort"])(next.trim());
								},
							}), "同样是改写任务，默认 off；模型不支持时自动退回默认"),

							field("最大 token", ["learner", "maxTokens"], h(NumberField, {
								value: learner.maxTokens, disabled: disabled,
								onCommit: set(["learner", "maxTokens"]),
							}), "思考也占这个额度：思考强度开 high/max 时建议 4000 以上（默认 2000）"),
						]),
						section("群友档案：记什么 / 忘多快", [
							field("跨群共享", ["people", "crossGroupEnabled"], h(SwitchField, {
								value: (value.people || {}).crossGroupEnabled !== false, disabled: disabled, label: "别的群学到的也能用",
								onCommit: set(["people", "crossGroupEnabled"]),
							}), "关掉就退化成「只在同一个会话里记住」"),

							field("私聊→群", ["people", "privateToGroup"], h(SwitchField, {
								value: (value.people || {}).privateToGroup !== false, disabled: disabled, label: "私聊交代的事群里能接上",
								onCommit: set(["people", "privateToGroup"]),
							}), "关掉后私聊里说的不会在群里被提起（更保守）"),

							field("不共享的会话", ["people", "crossGroupExclude"], h(TextAreaField, {
								value: Array.isArray((value.people || {}).crossGroupExclude) ? (value.people || {}).crossGroupExclude.join("\n") : "",
								disabled: disabled, placeholder: "每行一个：群号 或 private:QQ", rows: 2,
								onCommit: (next) => {
									const list = next.split(/[\n,，]/).map(item => item.trim()).filter(item => item !== "");
									if (list.length === 0) reset(["people", "crossGroupExclude"])();
									else set(["people", "crossGroupExclude"])(list);
								},
							}), "这些会话的记忆不参与跨群共享（别把某个群的私事带到别的群）"),

							field("最多带几个人", ["people", "peopleMaxInject"], h(NumberField, {
								value: (value.people || {}).peopleMaxInject, disabled: disabled,
								onCommit: set(["people", "peopleMaxInject"]),
							}), "每次回复最多把几个人的档案写进提示词（默认 6）"),

							field("最多带几条事件", ["people", "eventsMaxInject"], h(NumberField, {
								value: (value.people || {}).eventsMaxInject, disabled: disabled,
								onCommit: set(["people", "eventsMaxInject"]),
							}), "约定 / 梗 / 恩怨这类长期记忆每次最多带几条（默认 6）"),

							field("每人几条印象", ["people", "factsPerPersonInject"], h(NumberField, {
								value: (value.people || {}).factsPerPersonInject, disabled: disabled,
								onCommit: set(["people", "factsPerPersonInject"]),
							}), "档案里每个人最多列几条印象（默认 3）"),

							field("提示词预算（字）", ["people", "maxChars"], h(NumberField, {
								value: (value.people || {}).maxChars, disabled: disabled,
								onCommit: set(["people", "maxChars"]),
							}), "「档案 + 长期记忆」两节合起来最多多少字（默认 1400）"),

							field("遗忘速度（天）", ["people", "decayHalfLifeDays"], h(NumberField, {
								value: (value.people || {}).decayHalfLifeDays, disabled: disabled,
								onCommit: set(["people", "decayHalfLifeDays"]),
							}), "多久忘掉一半（默认 30 天）；越重要的记得越久，重要度 5 大约能记 4 倍时间"),

							field("淘汰阈值", ["people", "decayMinWeight"], h(NumberField, {
								value: (value.people || {}).decayMinWeight, disabled: disabled,
								onCommit: set(["people", "decayMinWeight"]),
							}), "衰减到这个程度就清理（默认 0.08，越小记得越久）"),

							field("至少保留（天）", ["people", "decayMinAgeDays"], h(NumberField, {
								value: (value.people || {}).decayMinAgeDays, disabled: disabled,
								onCommit: set(["people", "decayMinAgeDays"]),
							}), "多久没碰过的记忆才允许被清理（默认 7 天）"),

							field("永不遗忘的重要度", ["people", "keepImportance"], h(NumberField, {
								value: (value.people || {}).keepImportance, disabled: disabled,
								onCommit: set(["people", "keepImportance"]),
							}), "重要度到这个数（1~5）以上就永不遗忘（默认 4）"),

							field("每人印象上限", ["people", "maxFactsPerPerson"], h(NumberField, {
								value: (value.people || {}).maxFactsPerPerson, disabled: disabled,
								onCommit: set(["people", "maxFactsPerPerson"]),
							}), "一个人最多存几条印象，超了先淘汰不重要的（默认 12）"),

							field("跨会话接话", ["people", "surfaceEnabled"], h(SwitchField, {
								value: (value.people || {}).surfaceEnabled !== false, disabled: disabled, label: "记得「刚在别处说过的话」",
								onCommit: set(["people", "surfaceEnabled"]),
							}), "某人刚在别的群 / 私聊说过的话，这里也能自然接上"),

							field("接话有效期（分钟）", ["people", "surfaceTtlMinutes"], h(NumberField, {
								value: (value.people || {}).surfaceTtlMinutes, disabled: disabled,
								onCommit: set(["people", "surfaceTtlMinutes"]),
							}), "默认 10 分钟；调小更不容易「跨会话串台」"),

							field("整理间隔（小时）", ["people", "decayIntervalHours"], h(NumberField, {
								value: (value.people || {}).decayIntervalHours, disabled: disabled,
								onCommit: set(["people", "decayIntervalHours"]),
							}), "多久自动清理一次忘掉的记忆（默认 24，0 = 不自动跑）"),

							note("people-note", "记忆文件在数据目录的 people/ 里；想全部忘掉，删掉这个文件夹再重启即可。"),
						]),

						section("上下文总字数", [
							field("字数上限", ["context", "maxChars"], h(NumberField, {
								value: context.maxChars, disabled: disabled,
								onCommit: set(["context", "maxChars"]),
							}), "聊天记录 + 记忆 + 资料合起来的上限，超了从最早的丢；默认 6000，开满记忆可调到 20000 左右"),
						]),
					]),
				]),

				fold("advanced", "高级（命令 / 路径 / 按群覆盖）", [
				section("管理命令", [
					field("命令前缀", ["commandPrefix"], h(TextField, {
						value: value.commandPrefix, disabled: disabled, placeholder: ".",
						onCommit: set(["commandPrefix"]),
					}), "群内管理命令的前缀，例如 .status"),

					field("管理员", ["admins"], h(ListField, {
						value: value.admins || [], disabled: disabled, placeholder: "123456789、987654321",
						onCommit: set(["admins"]),
					}), "允许执行管理命令的 QQ 号；留空表示所有人都能执行"),
				]),

				section("文件与高级", [
					field("数据目录", ["dataDir"], h(TextField, {
						value: value.dataDir, disabled: disabled, placeholder: "默认 <dsh home>/qq-groupmate",
						onCommit: set(["dataDir"]),
					}), "记忆、状态与日志的存放位置"),

					field("日志文件", ["logFile"], h(TextField, {
						value: value.logFile, disabled: disabled, placeholder: "qq-groupmate.log",
						onCommit: set(["logFile"]),
					}), "相对数据目录，或写绝对路径；留空关闭"),

					field("角色卡目录", ["charactersDir"], h(TextField, {
						value: value.charactersDir, disabled: disabled, placeholder: "默认 <数据目录>/characters",
						onCommit: set(["charactersDir"]),
					}), "放 JSON 角色卡的目录"),

					field("按群覆盖", ["groups"], h(GroupsField, {
						value: value.groups, disabled: disabled,
						placeholder: '{\n  "123456789": { "character": "tsundere", "model": "deepseek-v4-pro" }\n}',
						onCommit: set(["groups"]),
					}), "给指定群单独指定角色/模型，键是群号（上面的群管理区也能改）"),
				]),
				]),

				h("div", { className: "qgm-footer" },
					h("span", null,
						snapshot.status === "ready"
							? (writable ? "改完即时生效，无需重启 dsh" : "当前设置文档只读，改动不会保存")
							: snapshot.status === "loading" ? "正在读取配置…" : "Host 未提供设置文档，配置只能在 cordis.patch.yml 里改"),
					notice === "" ? null : h("span", { className: "qgm-error" }, notice),
				),
				) : null,
			);
		}

		/** 浏览器半入口。 */
		function apply(ctx) {
			const scope = ctx.settingsScope.bind({
				namespace: NS,
				decode: (section) => (section !== null && typeof section === "object" && !Array.isArray(section) ? section : undefined),
			});
			const statusScope = ctx.settingsScope.bind({
				namespace: STATUS_NS,
				decode: (section) => (section !== null && typeof section === "object" && !Array.isArray(section) ? section : undefined),
			});
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
				inject: () => ({ scope: scope, statusScope: statusScope }),
			}, QqGroupmateCard));
		}

		exports.apply = apply;
		exports.inject = ["slots", "settingsScope"];
		return module.exports;
	}
});