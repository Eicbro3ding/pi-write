/**
 * 添加自定义供应商弹窗(供应商列表的「＋ 添加供应商 › 自定义」)。
 *
 * 只管**供应商**:id / 显示名 / 接口地址 / API Key。这里不出现任何模型字段——
 * 「加供应商」与「加模型」是两件事,模型在供应商详情里逐个添加(2026-09 拆开)。
 *
 * 提交走 POST /api/providers/custom:写 models.json 的 provider 条目(models 为空数组),
 * 服务端热重载后供应商出现在列表里,再点进去填 key / 加模型。
 */
import { useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { IconX } from "./Icons.tsx";

/** 供应商 id 校验(与后端同款正则)。 */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function AddProviderDialog({
	client,
	onSaved,
	onClose,
}: {
	client: ApiClient;
	/** 保存成功(已关弹窗由本组件负责;onSaved 由父组件刷新列表)。 */
	onSaved: (providerId: string) => void | Promise<void>;
	onClose: () => void;
}) {
	const [formId, setFormId] = useState("");
	const [formName, setFormName] = useState("");
	const [formBaseUrl, setFormBaseUrl] = useState("");
	const [formApiKey, setFormApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function submit() {
		if (busy) return;
		const id = formId.trim();
		if (!PROVIDER_ID_RE.test(id)) {
			setErr("供应商 id 只允许小写字母/数字/连字符(如 mock)");
			return;
		}
		const url = formBaseUrl.trim();
		if (!/^https?:\/\//.test(url)) {
			setErr("Base URL 必须是 http(s) 地址(如 http://127.0.0.1:8787/v1)");
			return;
		}
		setBusy(true);
		setErr(null);
		try {
			await client.addCustomProvider({
				provider: id,
				name: formName.trim().length > 0 ? formName.trim() : undefined,
				baseUrl: url,
				apiKey: formApiKey.trim().length > 0 ? formApiKey.trim() : undefined,
			});
			await onSaved(id);
			onClose();
		} catch (e) {
			setErr(`保存失败: ${friendlyError(e)}`);
			setBusy(false);
		}
	}

	return (
		<div className="dlg-overlay amd-overlay" role="dialog" aria-modal="true" aria-label="添加供应商">
			<div className="dlg-panel amd-panel">
				<header className="amd-head">
					<span className="amd-head-text">
						<span className="amd-title">添加供应商</span>
						<span className="amd-sub">保存后到它的详情里添加模型</span>
					</span>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
						<IconX size={16} />
					</button>
				</header>
				<div className="amd-body">
					<div className="s-field-grid">
						<div className="s-field">
							<label className="s-field-label">供应商 ID</label>
							<input
								className="s-input mono"
								placeholder="如 mock"
								value={formId}
								disabled={busy}
								autoFocus
								onChange={(e) => setFormId(e.target.value)}
							/>
						</div>
						<div className="s-field">
							<label className="s-field-label">名称(可选)</label>
							<input
								className="s-input"
								placeholder="如 本地 Mock"
								value={formName}
								disabled={busy}
								onChange={(e) => setFormName(e.target.value)}
							/>
						</div>
					</div>
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
					<div className="s-field">
						<label className="s-field-label">
							API Key
							<span className="amd-label-hint">可留空</span>
						</label>
						<input
							className="s-input mono"
							placeholder="本地服务可留空"
							value={formApiKey}
							disabled={busy}
							onChange={(e) => setFormApiKey(e.target.value)}
						/>
					</div>
					<div className="amd-note">
						自定义供应商使用 Chat Completions 协议。只买/只用内置清单里的服务(OpenAI、Anthropic 等)时,不必新建,直接在列表里选它们。
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
