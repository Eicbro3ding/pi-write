/**
 * 添加 / 编辑自定义模型弹窗(供应商详情里的「＋ 添加模型」与模型行的编辑入口共用)。
 *
 * 2026-09 拆开职责:这个弹窗**只管模型**(模型 ID / 显示名 / 上下文窗口 / 最大输出 /
 * 输入类型)。Base URL 与 API Key 是供应商级字段,由详情带入、不在这里显示——
 * 之前它们摆在这个表单里,既让「加模型」看着像在改供应商,又能在不改供应商的情况下
 * 改掉它所有模型的地址(写 models.json 的 provider 级 baseUrl 会覆盖该供应商全部模型)。
 * 添加供应商见 AddProviderDialog。
 *
 * 提交走 POST /api/models/custom(openai-completions 协议;输入类型 vendor 只支持
 * text/image,视频/PDF 无对应语义故不提供选项;聊天模型一律文本输出)。
 */
import { useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { Select } from "./Select.tsx";
import { THINKING_FORMATS, thinkingFormatLabel } from "../provider-list-logic.ts";
import { IconX } from "./Icons.tsx";

/** 模型 id 校验(与后端 /api/models/custom 同款正则)。 */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9-_.]{0,127}$/;

export type AddModelMode = "model" | "edit";

/** 编辑模式预填的现有自定义模型。 */
export interface EditableModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	/** 是否声明支持思考深度(reasoning);缺省按不支持。 */
	reasoning?: boolean;
	/** 显式声明的思考参数协议(compat.thinkingFormat);缺省 = 交给 vendor 自动探测。 */
	thinkingFormat?: string;
}

export function AddModelDialog({
	client,
	providerId,
	/** 供应商的接口地址(写盘时随模型一起提交;不在表单里显示)。 */
	baseUrl,
	/** 供应商显示名(标题里点明模型加在谁下面)。 */
	providerLabel,
	mode,
	/** 编辑模式:要编辑的现有模型(同时决定打开时的预填值)。 */
	initialModel,
	onSaved,
	onClose,
	closing = false,
}: {
	client: ApiClient;
	mode: AddModelMode;
	/** 供应商 id(添加/编辑都固定使用当前详情里的供应商)。 */
	providerId: string;
	/** 当前供应商的 baseUrl(随提交写回,表单不显示、不可改)。 */
	baseUrl?: string;
	/** 供应商显示名(副标题用「添加到 <名称>」)。 */
	providerLabel?: string;
	/** 编辑模式:现有模型;缺省时编辑模式不可用。 */
	initialModel?: EditableModel;
	/** 保存成功(已关弹窗由本组件负责,onSaved 由父组件刷新列表/详情)。 */
	onSaved: () => void | Promise<void>;
	onClose: () => void;
	/** 退场中(父级 useExitPresence):给根壳加 .is-closing 播反向动画。 */
	closing?: boolean;
}) {
	const editing = mode === "edit";
	const [formModel, setFormModel] = useState(initialModel?.id ?? "");
	const [formModelName, setFormModelName] = useState(initialModel?.name ?? "");
	const [formCtx, setFormCtx] = useState(String(initialModel?.contextWindow ?? 1000000));
	const [formMaxTokens, setFormMaxTokens] = useState(String(initialModel?.maxTokens ?? 128000));
	const [formInput, setFormInput] = useState<("text" | "image")[]>(initialModel?.input ?? ["text"]);
	const [formReasoning, setFormReasoning] = useState(initialModel?.reasoning ?? false);
	/**
	 * 思考参数协议(BUG-002):第三方 OpenAI 兼容服务对 reasoning 参数的写法各不相同,
	 * 空 = 交给 vendor 按 provider 名与 baseUrl 自动探测;只在声明支持思考时才显示。
	 */
	const [formThinkingFormat, setFormThinkingFormat] = useState(initialModel?.thinkingFormat ?? "");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	function toggleInput(flag: "text" | "image") {
		setFormInput((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]));
	}

	/**
	 * 校验上下文窗口/最大输出;非法时 setErr 并返回 null。
	 *
	 * 2026-10 审计 BUG-015:与后端 `optionalPositiveInt` 同语义 —— **正整数或未提供**。
	 * 此前只查 finite + 正数,有限小数(1.5)能提交,后端返回 400,用户看到的是通用
	 * 「保存失败」而不是字段级提示。这里补 `Number.isInteger`(空串/非数字/0/负数/小数
	 * 都当场拒绝),后端仍保留最终校验作为安全边界。
	 */
	function parseLimits(): { ctx: number; maxTokens: number } | null {
		const rawCtx = formCtx.trim();
		const rawMax = formMaxTokens.trim();
		const ctx = Number(rawCtx);
		const maxTokens = Number(rawMax);
		const bad = (raw: string, n: number) => raw.length === 0 || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0;
		if (bad(rawCtx, ctx) || bad(rawMax, maxTokens)) {
			setErr("上下文窗口与最大输出 Token 必须是正整数(不能为 0、负数或小数)");
			return null;
		}
		return { ctx, maxTokens };
	}

	/** 提交:校验 + 调 API + onSaved。失败留在弹窗显示错误。 */
	async function submit() {
		if (busy) return;
		const model = formModel.trim();
		if (!MODEL_ID_RE.test(model)) {
			setErr("模型 id 只允许小写字母/数字/连字符/点/下划线(如 mock-1)");
			return;
		}
		const limits = parseLimits();
		if (!limits) return;
		// 编辑模式:只改模型条目(id 可重命名),不动 provider 级字段
		if (editing) {
			if (!initialModel) {
				setErr("缺少要编辑的模型");
				return;
			}
			setBusy(true);
			setErr(null);
			try {
				await client.editCustomModel({
					provider: providerId,
					model: initialModel.id,
					newModel: model !== initialModel.id ? model : undefined,
					name: formModelName.trim(), // 空串 = 清掉显示名,回退到模型 id
					contextWindow: limits.ctx,
					maxTokens: limits.maxTokens,
					input: formInput,
					reasoning: formReasoning,
				});
				await onSaved();
				onClose();
			} catch (e) {
				setErr(`保存失败: ${friendlyError(e)}`);
				setBusy(false);
			}
			return;
		}
		const url = (baseUrl ?? "").trim();
		if (!/^https?:\/\//.test(url)) {
			setErr(`该供应商没有可用的接口地址,无法添加模型。请先到「设置 › 供应商」里补上它的 Base URL。`);
			return;
		}
		setBusy(true);
		setErr(null);
		try {
			await client.addCustomModel({
				provider: providerId,
				model,
				baseUrl: url,
				contextWindow: limits.ctx,
				maxTokens: limits.maxTokens,
				input: formInput,
				reasoning: formReasoning,
				thinkingFormat: formThinkingFormat,
				name: formModelName.trim().length > 0 ? formModelName.trim() : undefined,
			});
			await onSaved();
			onClose();
		} catch (e) {
			setErr(`保存失败: ${friendlyError(e)}`);
			setBusy(false);
		}
	}

	const title = editing ? "编辑模型" : "添加模型";

	return (
		<div className={`dlg-overlay amd-overlay${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
			<div className="dlg-panel amd-panel">
				<header className="amd-head">
					<span className="amd-head-text">
						<span className="amd-title">{title}</span>
						<span className="amd-sub">{`供应商 ${providerLabel ?? providerId}`}</span>
					</span>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
						<IconX size={16} />
					</button>
				</header>
				<div className="amd-body">
					<div className="s-field">
						<label className="s-field-label">模型 ID</label>
						<input
							className="s-input mono"
							placeholder="如 gpt-4o-mini"
							value={formModel}
							disabled={busy}
							autoFocus
							onChange={(e) => setFormModel(e.target.value)}
						/>
					</div>
					<div className="s-field">
						<label className="s-field-label">显示名(可选)</label>
						<input
							className="s-input"
							placeholder="留空则用模型 ID"
							value={formModelName}
							disabled={busy}
							onChange={(e) => setFormModelName(e.target.value)}
						/>
					</div>
					<div className="s-field-grid">
						<div className="s-field">
							<label className="s-field-label">上下文窗口</label>
							<input className="s-input mono" value={formCtx} disabled={busy} onChange={(e) => setFormCtx(e.target.value)} />
						</div>
						<div className="s-field">
							<label className="s-field-label">最大输出 Token</label>
							<input className="s-input mono" value={formMaxTokens} disabled={busy} onChange={(e) => setFormMaxTokens(e.target.value)} />
						</div>
					</div>
					<div className="s-field">
						<label className="s-field-label">输入类型</label>
						<div className="amd-check-row">
							<button
								type="button"
								className={`amd-check${formInput.includes("text") ? " on" : ""}`}
								disabled={busy}
								onClick={() => toggleInput("text")}
							>
								文本
							</button>
							<button
								type="button"
								className={`amd-check${formInput.includes("image") ? " on" : ""}`}
								disabled={busy}
								onClick={() => toggleInput("image")}
							>
								图片
							</button>
							<span className="amd-hint">输出固定为文本</span>
						</div>
					</div>
					{/* 思考深度:vendor 按 model.reasoning 决定可用档位(非推理模型只有 off),
					    不声明就永远调不深 —— 且表现为「思考等级菜单点了没反应」,所以这里给开关 */}
					<div className="s-field">
						<label className="s-field-label">思考深度</label>
						<div className="amd-check-row">
							<button
								type="button"
								className={`amd-check${formReasoning ? " on" : ""}`}
								disabled={busy}
								aria-pressed={formReasoning}
								onClick={() => setFormReasoning((v) => !v)}
							>
								{formReasoning ? "支持思考" : "不支持思考"}
							</button>
							<span className="amd-hint">仅当供应商接受 reasoning 参数时才打开;不确定就关着</span>
						</div>
					</div>
					{/* 思考参数协议:不能只按 provider 名推断(BUG-002)。空 = 自动探测 */}
					{formReasoning && (
						<div className="s-field">
							<label className="s-field-label">思考参数协议</label>
							<Select
								className="sel-block"
								value={formThinkingFormat}
								options={[
									{ value: "", label: "自动探测(默认)" },
									...THINKING_FORMATS.map((f) => ({ value: f, label: thinkingFormatLabel(f) })),
								]}
								disabled={busy}
								ariaLabel="思考参数协议"
								onChange={(v) => setFormThinkingFormat(v)}
							/>
							<div className="amd-hint">
								该服务按哪种写法接受思考参数。选错可能被忽略或直接报错 —— 不确定先用「自动探测」,再按供应商文档选。
							</div>
						</div>
					)}
					<div className="amd-note">
						接口地址与 API Key 属于供应商配置,在供应商详情里改;这里只定义这个模型。
					</div>
					{err && <div className="notice err">{err}</div>}
				</div>
				<footer className="amd-foot">
					<button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button type="button" className="wz-primary" disabled={busy} onClick={() => void submit()}>
						{busy ? "保存中…" : "保存"}
					</button>
				</footer>
			</div>
		</div>
	);
}
