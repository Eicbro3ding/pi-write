import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { ModelDto, ProviderDetailDto, ProviderInfo } from "../types.ts";
import { AddModelDialog, type AddModelMode } from "./AddModelDialog.tsx";
import { IconPlus, IconTrash } from "./Icons.tsx";

/**
 * 模型供应商配置(双栏卡片:左列表 + 右详情),设置页「模型」分类与首次启动
 * 向导第 2 步共用(props 签名与旧版一致,调用方零改动)。
 *
 * - 左栏:供应商列表(已配置分组置顶 + 搜索过滤 + 状态点),底部「自定义供应商」;
 * - 右栏:详情(已配置徽章、Base URL、API 格式、API Key 掩码/更换、模型列表、
 *   「+ 添加模型」);「已启用/禁用」不存在于后端(可用性唯一由认证状态决定),
 *   故以「已配置/未配置」徽章表达。
 * - 认证变化(添加/更新/移除 key)后回调 onAuthChanged,由外层刷新模型列表。
 */
export function ProviderList({ client, onAuthChanged }: { client: ApiClient; onAuthChanged: () => void | Promise<void> }) {
	/** null = 加载中;[] = 已加载但为空(或加载失败)。 */
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	/** 当前选中供应商 id(null = 未选中)。 */
	const [selectedId, setSelectedId] = useState<string | null>(null);
	/** 详情状态:null = 未加载;404 未知等错误置空并提示。 */
	const [detail, setDetail] = useState<ProviderDetailDto | null>(null);
	const [detailErr, setDetailErr] = useState<string | null>(null);
	/** API key 编辑状态(掩码 + 更换)。 */
	const [editingKey, setEditingKey] = useState(false);
	const [keyValue, setKeyValue] = useState("");
	const [keyBusy, setKeyBusy] = useState(false);
	const [keyErr, setKeyErr] = useState<string | null>(null);
	/** 保存成功提示(短暂显示)。 */
	const [keySaved, setKeySaved] = useState(false);
	/** 移除凭据确认态。 */
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [removeBusy, setRemoveBusy] = useState(false);
	/** 添加模型/自定义供应商弹窗(null = 关闭)。 */
	const [addDialog, setAddDialog] = useState<AddModelMode | null>(null);

	const load = useCallback(async () => {
		setProviders(await client.getProviders());
	}, [client]);

	useEffect(() => {
		let cancelled = false;
		setLoadErr(null);
		void load().catch((e) => {
			if (cancelled) return;
			setProviders([]);
			setLoadErr(`供应商加载失败: ${friendlyError(e)}`);
		});
		return () => {
			cancelled = true;
		};
	}, [load]);

	/** 选中供应商变化/供应商列表刷新后:拉取详情(未选中时自动选第一个已配置)。 */
	useEffect(() => {
		if (providers === null) return;
		const current = selectedId && providers.some((p) => p.id === selectedId) ? selectedId : providers.find((p) => p.configured)?.id ?? providers[0]?.id ?? null;
		if (current !== selectedId) setSelectedId(current);
	}, [providers, selectedId]);

	useEffect(() => {
		if (!selectedId) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		setDetailErr(null);
		void client
			.getProviderDetail(selectedId)
			.then((d) => {
				if (!cancelled) setDetail(d);
			})
			.catch((e) => {
				if (cancelled) return;
				setDetail(null);
				setDetailErr(`详情加载失败: ${friendlyError(e)}`);
			});
		return () => {
			cancelled = true;
		};
	}, [client, selectedId]);

	const filtered = useMemo(() => {
		const list = providers ?? [];
		if (query.trim().length === 0) return list;
		const q = query.trim().toLowerCase();
		return list.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
	}, [providers, query]);

	/** 清理 key 编辑状态(关闭/成功共用)。 */
	function resetKeyEdit() {
		setEditingKey(false);
		setKeyValue("");
		setKeyErr(null);
	}

	/** 重新拉当前选中供应商详情(认证状态/徽章变化后调用)。 */
	const reloadDetail = useCallback(async () => {
		if (!selectedId) return;
		try {
			setDetail(await client.getProviderDetail(selectedId));
		} catch {
			/* 详情刷新失败:保留旧值(下次选中会再拉) */
		}
	}, [client, selectedId]);

	/** 保存 key:保存 → 刷新详情(configured 变化)+ 通知外层刷新模型。 */
	async function saveKey() {
		if (!selectedId || keyBusy) return;
		setKeyBusy(true);
		setKeyErr(null);
		try {
			await client.setProviderApiKey(selectedId, keyValue);
		} catch (e) {
			setKeyErr(`保存失败: ${friendlyError(e)}`);
			setKeyBusy(false);
			return;
		}
		setKeyValue("");
		setEditingKey(false);
		setKeySaved(true);
		setTimeout(() => setKeySaved(false), 3000);
		try {
			await load();
			await reloadDetail();
		} catch {
			setKeyErr("供应商列表刷新失败");
		}
		try {
			await onAuthChanged();
		} catch (e) {
			setKeyErr(`认证状态刷新失败: ${friendlyError(e)}`);
		}
		setKeyBusy(false);
	}

	/** 移除凭据:确认后删除 + 刷新 + 通知外层;若删除的是当前选中供应商则清空详情。 */
	async function removeKey() {
		if (!selectedId || removeBusy) return;
		setRemoveBusy(true);
		try {
			await client.deleteProvider(selectedId);
		} catch (e) {
			setKeyErr(`移除失败: ${friendlyError(e)}`);
			setRemoveBusy(false);
			return;
		}
		setConfirmRemove(false);
		try {
			await load();
			await reloadDetail();
		} catch {
			setKeyErr("供应商列表刷新失败");
		}
		try {
			await onAuthChanged();
		} catch (e) {
			setKeyErr(`认证状态刷新失败: ${friendlyError(e)}`);
		}
		setRemoveBusy(false);
	}

	// —— 渲染 ——
	const detailProvider = detail?.provider;
	const isConfigured = detailProvider?.configured ?? false;

	/** 供应商列表分组:已配置置顶(load 已排序,这里再按 configured 切分)。 */
	const configuredList = filtered.filter((p) => p.configured);
	const otherList = filtered.filter((p) => !p.configured);

	function renderProviderItem(p: ProviderInfo, selected: boolean) {
		return (
			<button type="button" key={p.id} className={`pvc-item${selected ? " sel" : ""}`} onClick={() => setSelectedId(p.id)}>
				<span className="pvc-item-name">{p.name}</span>
				<span className={`pvc-dot${p.configured ? "" : " off"}`} />
			</button>
		);
	}

	return (
		<>
			{loadErr && <div className="notice err">{loadErr}</div>}
			<div className="pvc-card">
				{/* 左栏:供应商列表 */}
				<div className="pvc-side">
					<input
						className="s-search pvc-search"
						type="search"
						placeholder="搜索供应商…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<div className="pvc-list">
						{filtered.length === 0 ? (
							<div className="s-empty-row">
								<span className="s-val muted">未找到匹配的供应商</span>
							</div>
						) : (
							<>
								{configuredList.length > 0 && (
									<>
										<div className="pvc-group">已配置</div>
										{configuredList.map((p) => renderProviderItem(p, selectedId === p.id))}
									</>
								)}
								{otherList.length > 0 && (
									<>
										<div className="pvc-group">其他供应商</div>
										{otherList.map((p) => renderProviderItem(p, selectedId === p.id))}
									</>
								)}
							</>
						)}
					</div>
					<button type="button" className="pvc-add-provider" onClick={() => setAddDialog("provider")}>
						<IconPlus size={14} />
						自定义供应商
					</button>
				</div>

				{/* 右栏:详情 */}
				<div className="pvc-detail">
					{!selectedId ? (
						<div className="pvc-empty">
							<span className="s-val muted">从左侧选择一个供应商查看配置,或添加自定义供应商。</span>
						</div>
					) : !detail && !detailErr ? (
						<div className="pvc-empty">
							<span className="s-val muted">加载中…</span>
						</div>
					) : detailErr ? (
						<div className="pvc-empty">
							<span className="s-val muted">{detailErr}</span>
						</div>
					) : (
						<>
							<header className="pvc-d-head">
								<span className="pvc-d-title">{detailProvider?.id}</span>
								{isConfigured ? (
									<span className="pvc-badge-on">已配置</span>
								) : (
									<span className="pvc-badge-off">未配置</span>
								)}
								<span className="pvc-d-spacer" />
								{confirmRemove ? (
									<span className="pvc-remove-confirm">
										<span>移除凭据后该供应商将不可用,确认?</span>
										<button type="button" className="btn-ghost danger" disabled={removeBusy} onClick={() => void removeKey()}>
											{removeBusy ? "移除中…" : "确认移除"}
										</button>
										<button type="button" className="btn-ghost" disabled={removeBusy} onClick={() => setConfirmRemove(false)}>
											取消
										</button>
									</span>
								) : (
									<button type="button" className="icon-btn" title="移除凭据" disabled={removeBusy} onClick={() => setConfirmRemove(true)}>
										<IconTrash size={15} />
									</button>
								)}
							</header>

							<div className="pvc-field">
								<label className="pvc-label">Base URL</label>
								<div className="pvc-value mono">{detailProvider?.baseUrl ?? "—"}</div>
							</div>

							<div className="pvc-field">
								<label className="pvc-label">API 格式</label>
								<div className="pvc-value mono">{apiFormatLabel(detail?.models?.[0]?.api)}</div>
							</div>

							<div className="pvc-field">
								<label className="pvc-label">API Key</label>
								{editingKey ? (
									<div className="pvc-key-row">
										<input
											type="password"
											className="s-input mono pvc-key-input"
											placeholder="粘贴 API key"
											value={keyValue}
											autoFocus
											disabled={keyBusy}
											onChange={(e) => setKeyValue(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && keyValue.trim().length > 0) void saveKey();
												if (e.key === "Escape") resetKeyEdit();
											}}
										/>
										<button type="button" className="btn-ghost" disabled={keyBusy || keyValue.trim().length === 0} onClick={() => void saveKey()}>
											{keyBusy ? "保存中…" : "保存"}
										</button>
										<button type="button" className="btn-ghost" disabled={keyBusy} onClick={resetKeyEdit}>
											取消
										</button>
									</div>
								) : (
									<div className="pvc-key-row">
										<div className="pvc-value mono pvc-key-mask">{isConfigured ? "••••••••••••••••" : "未配置"}</div>
										<button type="button" className="btn-ghost" disabled={keyBusy} onClick={() => { setEditingKey(true); setKeyValue(""); setKeyErr(null); }}>
											更换
										</button>
									</div>
								)}
								{keyErr && <div className="pvc-err">{keyErr}</div>}
								{keySaved && !keyErr && <div className="pvc-saved">已保存</div>}
							</div>

							<div className="pvc-field">
								<label className="pvc-label">模型列表</label>
								{detail?.models && detail.models.length > 0 ? (
									<div className="pvc-m-list">
										{detail.models.map((m) => (
											<div className="pvc-m-item" key={m.id}>
												<span className="pvc-m-name mono">{m.id}</span>
												{modelBadges(m)}
											</div>
										))}
									</div>
								) : (
									<div className="pvc-value faint">该供应商暂无模型(配置 key 后自动出现)</div>
								)}
							</div>

							<button type="button" className="pvc-add-model" onClick={() => setAddDialog("model")}>
								<IconPlus size={14} />
								添加模型
							</button>
						</>
					)}
				</div>
			</div>
			{/* 弹窗:添加模型(供应商上下文) / 自定义供应商 */}
			{addDialog && (
				<AddModelDialog
					client={client}
					mode={addDialog}
					providerId={addDialog === "model" ? selectedId ?? "" : ""}
					baseUrl={addDialog === "model" ? detail?.provider?.baseUrl ?? "" : undefined}
					onSaved={async () => {
						// 刷新列表(自定义供应商新条目出现)+ 详情(模型/徽章变化)
						await load();
						if (selectedId) {
							try {
								setDetail(await client.getProviderDetail(selectedId));
							} catch {
								/* 详情刷新失败不阻塞(下次选中会再拉) */
							}
						}
					}}
					onClose={() => setAddDialog(null)}
				/>
			)}
		</>
	);
}

/** API 格式映射表(唯一真相源;api 为 vendor 模型原始值)。 */
export function apiFormatLabel(api: string | undefined): string {
	const map: Record<string, string> = {
		"openai-completions": "Chat Completions (/chat/completions)",
		"openai-responses": "OpenAI Responses",
		"azure-openai-responses": "Azure OpenAI Responses",
		"openai-codex-responses": "OpenAI Codex Responses",
		"anthropic-messages": "Anthropic Messages",
		"google-generative-language": "Google Generative Language",
		"bedrock-converse-stream": "AWS Bedrock Converse",
		"cloudflare-workers-ai": "Cloudflare Workers AI",
	};
	return (api && map[api]) || api || "—";
}

/** 模型徽章:上下文大小(≥1M 显示 1M 倍率,否则 K 单位)+ 视觉 + 思考。 */
function modelBadges(m: ModelDto) {
	return (
		<span className="pvc-m-tags">
			{m.input.includes("image") && <span className="pvc-tag vis">视觉</span>}
			{m.reasoning && <span className="pvc-tag">思考</span>}
			<span className="pvc-tag">{contextWindowLabel(m.contextWindow)}</span>
		</span>
	);
}

/** 上下文窗口标签:< 1000 原样,≥1000 按 K,M 缩写(向下取整,如 262144 → 256K)。 */
export function contextWindowLabel(ctx: number): string {
	if (ctx >= 1_000_000) return `${Math.floor(ctx / 1_000_000)}M`;
	if (ctx >= 1000) return `${Math.floor(ctx / 1000)}K`;
	return String(ctx);
}
