/**
 * 添加模型/自定义供应商弹窗(ProviderList 双栏卡片的「+ 添加模型」与「+ 自定义供应商」共用)。
 *
 * 两种入口(由 mode 区分):
 * - model:「添加模型」——供应商上下文已知,provider/baseUrl/apiKey 由详情带入;
 * - provider:「自定义供应商」——需要填供应商 id/名称/Base URL/apiKey,同时定义第一个模型。
 *
 * 提交走 POST /api/models/custom(openai-completions 协议;输入类型 vendor 只支持
 * text/image,视频/PDF 无对应语义故不提供选项;聊天模型一律文本输出)。
 */
import { useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { IconX } from "./Icons.tsx";

/** 模型 id 校验(与后端 /api/models/custom 同款正则)。 */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9-_.]{0,127}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type AddModelMode = "model" | "provider" | "edit";

/** 编辑模式预填的现有自定义模型。 */
export interface EditableModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
}

export function AddModelDialog({
	client,
	mode,
	/** 供应商上下文(添加模型/编辑模型模式必填;自定义供应商模式下作为新供应商的前缀参考)。 */
	providerId,
	baseUrl,
	apiKeyRequired,
	/** 编辑模式:要编辑的现有模型(同时决定打开时的预填值)。 */
	initialModel,
	onSaved,
	onClose,
}: {
	client: ApiClient;
	mode: AddModelMode;
	/** 当前选中的供应商 id(添加模型模式固定使用;自定义供应商模式不预填)。 */
	providerId: string;
	/** 当前供应商的 baseUrl(添加模型模式自动带入,可改;自定义供应商模式也可预填)。 */
	baseUrl?: string;
	/** 供应商是否要求 API key(oauth provider 仍可自定义覆盖,仅提示用)。 */
	apiKeyRequired?: boolean;
	/** 编辑模式:现有模型;缺省时编辑模式不可用。 */
	initialModel?: EditableModel;
	/** 保存成功(已关弹窗由本组件负责,onSaved 由父组件刷新列表/详情)。 */
	onSaved: () => void | Promise<void>;
	onClose: () => void;
}) {
	// 供应商模式独有字段
	const [newProviderId, setNewProviderId] = useState("");
	const [newProviderName, setNewProviderName] = useState("");
	// 通用字段(供应商模式下 baseUrl 必填且为首个模型服务地址)
	const editing = mode === "edit";
	const [formBaseUrl, setFormBaseUrl] = useState(baseUrl ?? "");
	const [formApiKey, setFormApiKey] = useState("");
	const [formModel, setFormModel] = useState(initialModel?.id ?? "");
	const [formModelName, setFormModelName] = useState(initialModel?.name ?? "");
	const [formCtx, setFormCtx] = useState(String(initialModel?.contextWindow ?? 1000000));
	const [formMaxTokens, setFormMaxTokens] = useState(String(initialModel?.maxTokens ?? 128000));
	const [formInput, setFormInput] = useState<("text" | "image")[]>(initialModel?.input ?? ["text"]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	function toggleInput(flag: "text" | "image") {
		setFormInput((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]));
	}

	/** 校验上下文窗口/最大输出;非法时 setErr 并返回 null。 */
	function parseLimits(): { ctx: number; maxTokens: number } | null {
		const ctx = Number(formCtx);
		const maxTokens = Number(formMaxTokens);
		if (!Number.isFinite(ctx) || ctx <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
			setErr("上下文窗口与最大输出 Token 必须是正整数");
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
				});
				await onSaved();
				onClose();
			} catch (e) {
				setErr(`保存失败: ${friendlyError(e)}`);
				setBusy(false);
			}
			return;
		}
		const pid = mode === "provider" ? newProviderId.trim() : providerId;
		const url = formBaseUrl.trim();
		if (!PROVIDER_ID_RE.test(pid)) {
			setErr(mode === "provider" ? "供应商 id 只允许小写字母/数字/连字符(如 mock)" : "供应商 id 无效");
			return;
		}
		if (!/^https?:\/\//.test(url)) {
			setErr("Base URL 必须是 http(s) 地址(如 http://127.0.0.1:8787/v1)");
			return;
		}
		setBusy(true);
		setErr(null);
		try {
			await client.addCustomModel({
				provider: pid,
				model,
				baseUrl: url,
				apiKey: formApiKey.trim().length > 0 ? formApiKey.trim() : undefined,
				contextWindow: limits.ctx,
				maxTokens: limits.maxTokens,
				input: formInput,
				name: mode === "provider" && newProviderName.trim().length > 0 ? newProviderName.trim() : undefined,
			});
			await onSaved();
			onClose();
		} catch (e) {
			setErr(`保存失败: ${friendlyError(e)}`);
			setBusy(false);
		}
	}

	const title = mode === "provider" ? "自定义供应商" : editing ? "编辑模型" : "添加模型";

	return (
		<div className="dlg-overlay" role="dialog" aria-modal="true" aria-label={title}>
			<div className="dlg-panel amd-panel">
				<header className="amd-head">
					<span className="amd-title">{title}</span>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
						<IconX size={16} />
					</button>
				</header>
				<div className="amd-body">
					{mode === "provider" && (
						<div className="s-field-grid">
							<div className="s-field">
								<label className="s-field-label">供应商 ID</label>
								<input
									className="s-input"
									placeholder="如 mock"
									value={newProviderId}
									disabled={busy}
									autoFocus
									onChange={(e) => setNewProviderId(e.target.value)}
								/>
							</div>
							<div className="s-field">
								<label className="s-field-label">名称(可选)</label>
								<input
									className="s-input"
									placeholder="如 本地 Mock"
									value={newProviderName}
									disabled={busy}
									onChange={(e) => setNewProviderName(e.target.value)}
								/>
							</div>
						</div>
					)}
					<div className="s-field">
						<label className="s-field-label">模型 ID</label>
						<input
							className="s-input"
							placeholder="模型 ID"
							value={formModel}
							disabled={busy}
							autoFocus={mode === "model" || editing}
							onChange={(e) => setFormModel(e.target.value)}
						/>
					</div>
					{editing && (
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
					)}
					{/* Base URL / API Key 是 provider 级字段:编辑单个模型时不展示(避免误改) */}
					{!editing && (
						<div className="s-field">
							<label className="s-field-label">Base URL</label>
							<input
								className="s-input mono"
								placeholder="http://127.0.0.1:8787/v1"
								value={formBaseUrl}
								disabled={busy}
								onChange={(e) => setFormBaseUrl(e.target.value)}
							/>
						</div>
					)}
					{!editing && (
						<div className="s-field">
							<label className="s-field-label">
								API Key
								{apiKeyRequired && mode === "provider" && <span className="amd-label-hint">必填</span>}
							</label>
							<input
								className="s-input mono"
								placeholder={apiKeyRequired && mode === "provider" ? "必填(占位 sk-custom 亦可)" : "可选"}
								value={formApiKey}
								disabled={busy}
								onChange={(e) => setFormApiKey(e.target.value)}
							/>
						</div>
					)}
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
