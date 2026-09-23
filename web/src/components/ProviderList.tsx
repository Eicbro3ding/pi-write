import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { currentModelOf, filterProviders, providerCanHoldApiKey, providerCountLabel, providerCounts, providerRowSub, unconfiguredHint } from "../provider-list-logic.ts";
import type { ModelDto, ProviderDetailDto, ProviderInfo } from "../types.ts";
import { AddModelDialog, type AddModelMode } from "./AddModelDialog.tsx";
import { IconPlus } from "./Icons.tsx";
import { Lu } from "./Lu.tsx";

/**
 * 模型供应商配置(双栏卡片:左列表 + 右详情),设置页「模型」分类与首次启动
 * 向导第 2 步共用(props 签名不变,调用方零改动)。
 *
 * 设计稿 v1(14-管理供应商)重做:
 * - 左栏只留「已配置」列表(未配置的靠底部「添加供应商」进入),每行是
 *   名称 + 当前模型小字;底部「＋ 添加供应商」+「共 N 个可选」计数;
 * - 右栏:provider 名 + 已配置胶囊 + 右上「测试连接」「移除凭据」;
 *   Base URL / API 格式是**只读信息行**(没有输入框外观);API Key 一行带眼睛
 *   (显示 / 隐藏,编辑态可直接看明文,不再强制 password 掩码);
 *   模型列表按族聚合(同前缀的版本收成一条,展开显示子版本);
 * - 数据与写操作完全沿用:GET /api/providers、GET /api/providers/:id、
 *   POST /api/providers/:id/apikey、DELETE /api/providers/:id、
 *   POST /api/models/custom(经 AddModelDialog)。
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
	/** 输入框明文显示(眼睛);只影响本次输入,不改服务端。 */
	const [keyVisible, setKeyVisible] = useState(false);
	const [keyBusy, setKeyBusy] = useState(false);
	const [keyErr, setKeyErr] = useState<string | null>(null);
	/** 保存成功提示(短暂显示)。 */
	const [keySaved, setKeySaved] = useState(false);
	/** 移除凭据确认态。 */
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [removeBusy, setRemoveBusy] = useState(false);
	/** 测试连接进行中与结果(只读:刷新模型目录,不写任何配置)。 */
	const [testBusy, setTestBusy] = useState(false);
	const [testMsg, setTestMsg] = useState<string | null>(null);
	/** 结果色调:null = 还没测;true/false = 通过/失败(失败必须看得见)。 */
	const [testOk, setTestOk] = useState<boolean | null>(null);
	/** 模型列表视图:按族聚合 / 全部。 */
	const [grouped, setGrouped] = useState(true);
	/** 展开的族 key 集合(聚合视图下显示子版本)。 */
	const [openFamilies, setOpenFamilies] = useState<Record<string, boolean>>({});
	/** 添加模型/自定义供应商弹窗(null = 关闭)。 */
	const [addDialog, setAddDialog] = useState<AddModelMode | null>(null);
	/** 当前使用的模型引用 "provider/id"(只读,仅用于左栏每行的「当前模型」小字)。 */
	const [currentModel, setCurrentModel] = useState<string | null>(null);

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

	/** 当前使用的模型("provider/id"):左栏行内小字显示用;读不到就不显示(静默)。 */
	useEffect(() => {
		let cancelled = false;
		void client
			.getModels()
			.then((r) => {
				if (!cancelled) setCurrentModel(modelRefOf(r.current));
			})
			.catch(() => {
				/* 读不到当前模型:左栏小字留空 */
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

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

	/** 切换供应商时收拾临时状态(测试结果 / key 编辑 / 展开的族)。 */
	useEffect(() => {
		setTestMsg(null);
		setTestOk(null);
		setOpenFamilies({});
		setConfirmRemove(false);
		resetKeyEdit();
		// resetKeyEdit 只动本地 state,无需进依赖
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedId]);

	const filtered = useMemo(() => filterProviders(providers ?? [], query), [providers, query]);

	/** 清理 key 编辑状态(关闭/成功共用)。 */
	function resetKeyEdit() {
		setEditingKey(false);
		setKeyValue("");
		setKeyVisible(false);
		setKeyErr(null);
	}

	/** 重新拉当前选中供应商详情(认证状态/徽章变化后调用);返回最新详情供调用方直接使用。 */
	const reloadDetail = useCallback(async (): Promise<ProviderDetailDto | null> => {
		if (!selectedId) return null;
		try {
			const d = await client.getProviderDetail(selectedId);
			setDetail(d);
			return d;
		} catch {
			/* 详情刷新失败:保留旧值(下次选中会再拉) */
			return null;
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

	/**
	 * 测试连接:联网刷新一次模型目录(POST /api/models/refresh),**按这次刷新报出的错误判定**。
	 *
	 * 2026-09-23 修。此前只看「模型数 > 0」,而模型列表来自 catalog、只按「该 provider 有没有
	 * 存过凭据」过滤(vendor `model-runtime.ts` 的 `configuredProviders`),与密钥有效性无关 ——
	 * 实测:已删除的密钥也报「连接正常,该供应商有 3 个模型可用」,而同一把密钥真发消息是 401。
	 * 现在读 `refreshModels()` 返回的 `errors`(按 provider id 过滤)。
	 *
	 * 仍要说清的一点:目录刷新只能对**会联网拉模型目录**的供应商验出鉴权失败(本版只有
	 * DeepSeek 那种 provider 会发这次请求),目录来自内置清单的供应商这里验不了 key ——
	 * 所以成功时也只说「目录刷新无误」,不说「凭据有效」。
	 */
	async function testConnection() {
		if (testBusy) return;
		setTestBusy(true);
		setTestMsg(null);
		setTestOk(null);
		try {
			const r = await client.refreshModels();
			const fail = (r.errors ?? []).find((e) => e.provider === selectedId);
			// 用刚拉到的详情判断,避免闭包里的旧 detail
			const fresh = await reloadDetail();
			if (fail) {
				setTestOk(false);
				setTestMsg(`连接失败: ${fail.message}`);
			} else if (!fresh) {
				// 详情接口本身失败。此前这里会走 count=0 的分支,被写成「连接正常,但未返回模型」
				setTestOk(false);
				setTestMsg("详情读取失败(接口异常),无法判断该供应商是否可用");
			} else {
				const count = fresh.models?.length ?? 0;
				setTestOk(count > 0);
				setTestMsg(count > 0 ? `目录刷新无误,该供应商有 ${count} 个模型可用` : "目录刷新无误,但没有可用模型(检查 Base URL 与 API 格式)");
			}
		} catch (e) {
			setTestOk(false);
			setTestMsg(`连接失败: ${friendlyError(e)}`);
		} finally {
			setTestBusy(false);
		}
	}

	// —— 渲染 ——
	const detailProvider = detail?.provider;
	const isConfigured = detailProvider?.configured ?? false;
	const modelFamilies = useMemo(() => groupModelFamilies(detail?.models ?? []), [detail]);
	/** 不能填 key 的供应商(纯 oauth / 本机凭据)该给的那行说明;null = 可以填 key。 */
	const apiKeyHint = detailProvider ? unconfiguredHint(detailProvider) : null;
	/** 未配置时直接摆出输入框 —— 藏在一支铅笔后面等于没有入口(2026-09-23)。 */
	const showKeyInput = apiKeyHint === null && (editingKey || !isConfigured);

	/**
	 * 左栏:列**全部**供应商(已配置的排前面 + 带「已配置」胶囊)。
	 *
	 * 2026-09-23 改:此前只列 `configured`,而页脚写着「共 17 个可选,点上方浏览全部」
	 * —— 那颗「添加供应商」通向的是**自定义供应商表单**,不是服务商目录,于是那 17 个
	 * 在设置页里根本没有入口(向导第 2 步反而有完整列表)。现在直接列全:
	 * 顺序沿用 `/api/providers`(后端已按「已配置优先 → id」排好),本组件不重排。
	 */
	const counts = providerCounts(providers ?? []);
	const searching = query.trim().length > 0;

	function renderProviderItem(p: ProviderInfo, selected: boolean) {
		return (
			<button
				type="button"
				key={p.id}
				className={`pvc-item${selected ? " sel" : ""}${p.configured ? " on" : ""}`}
				onClick={() => setSelectedId(p.id)}
			>
				{/* 圆点:已配置绿、未配置灰(基类是绿的,所以未配置加 .off) */}
				<span className={`pvc-dot${p.configured ? "" : " off"}`} />
				<span className="pvc-item-text">
					<span className="pvc-item-name">{p.name}</span>
					<span className="pvc-item-sub">{providerRowSub(p, currentModel)}</span>
				</span>
				{p.configured && <span className="pvc-item-pill">已配置</span>}
			</button>
		);
	}

	return (
		<>
			{loadErr && <div className="notice err">{loadErr}</div>}
			<div className="pvc-card">
				{/* 左栏:全部供应商(已配置优先)+ 搜索 + 自定义供应商入口 */}
				<div className="pvc-side">
					<div className="pvc-side-title">{providerCountLabel(counts)}</div>
					<input
						className="s-search pvc-search"
						type="search"
						placeholder="搜索供应商…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<div className="pvc-list">
						{providers === null ? (
							<div className="s-empty-row">
								<span className="s-val muted">加载中…</span>
							</div>
						) : filtered.length === 0 ? (
							<div className="s-empty-row">
								<span className="s-val muted">{searching ? `没有匹配「${query.trim()}」的供应商` : "服务端没有返回任何供应商"}</span>
							</div>
						) : (
							// key 用 id:未搜索时列表是后端顺序(已配置优先),搜索时顺序不变
							filtered.map((p) => renderProviderItem(p, selectedId === p.id))
						)}
					</div>
					<button type="button" className="pvc-add-provider" onClick={() => setAddDialog("provider")}>
						<IconPlus size={14} />
						添加自定义供应商
					</button>
					{/* 页脚不再写「点上方浏览全部」:那颗按钮通向自定义表单,不提供"全部"。
					    上面列的就是全部,这里只交代"为什么有的没配"。 */}
					{counts.configured < counts.total && <div className="pvc-side-foot">未配置的也能点开看;填好 key 后即可用。</div>}
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
								{isConfigured ? <span className="pvc-badge-on">已配置</span> : <span className="pvc-badge-off">未配置</span>}
								<span className="pvc-d-spacer" />
								{/* 未配置没有凭据可测 —— 隐藏而不是给一个必然"正常"的结论(2026-09-23)。
								    已配置的走 testConnection,由它读 /api/models/refresh 的 errors 判真假。 */}
								{isConfigured && (
									<button type="button" className="btn-ghost pvc-head-btn" disabled={testBusy} onClick={() => void testConnection()}>
										{testBusy ? "测试中…" : "测试连接"}
									</button>
								)}
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
									<button
										type="button"
										className="btn-ghost danger pvc-head-btn"
										disabled={removeBusy || !isConfigured}
										title={isConfigured ? "移除凭据" : "该供应商还没有凭据"}
										onClick={() => setConfirmRemove(true)}
									>
										移除凭据
									</button>
								)}
							</header>
							{testMsg && <div className={`pvc-test-msg${testOk === false ? " err" : testOk === true ? " ok" : ""}`}>{testMsg}</div>}

							{/* 只读信息行(设计稿 14:去掉输入框外观) */}
							<div className="pvc-field">
								<label className="pvc-label">Base URL</label>
								<div className="pvc-info mono">{detailProvider?.baseUrl ?? "—"}</div>
							</div>

							<div className="pvc-field">
								<label className="pvc-label">API 格式</label>
								<div className="pvc-info mono">{apiFormatLabel(detail?.models?.[0]?.api)}</div>
							</div>

							<div className="pvc-field">
								<label className="pvc-label">API Key</label>
								{apiKeyHint !== null ? (
									/* 纯 oauth / 本机凭据:给说明,不给一个写了也会 400 的输入框 */
									<div className="pvc-info pvc-note">{apiKeyHint}</div>
								) : showKeyInput ? (
									<div className="pvc-key-row">
										<input
											type={keyVisible ? "text" : "password"}
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
										<button
											type="button"
											className="icon-btn"
											aria-label={keyVisible ? "隐藏" : "显示"}
											title={keyVisible ? "隐藏" : "显示"}
											onClick={() => setKeyVisible((v) => !v)}
										>
											<EyeIcon off={keyVisible} />
										</button>
										<button type="button" className="btn-ghost" disabled={keyBusy || keyValue.trim().length === 0} onClick={() => void saveKey()}>
											{keyBusy ? "保存中…" : "保存"}
										</button>
										{isConfigured && (
											<button type="button" className="btn-ghost" disabled={keyBusy} onClick={resetKeyEdit}>
												取消
											</button>
										)}
									</div>
								) : (
									<div className="pvc-key-row">
										<div className="pvc-info mono pvc-key-mask">••••••••••••••••</div>
										<button
											type="button"
											className="icon-btn"
											aria-label="更换 API Key"
											title="更换 API Key"
											disabled={keyBusy}
											onClick={() => {
												setEditingKey(true);
												setKeyValue("");
												setKeyVisible(true);
												setKeyErr(null);
											}}
										>
											<PencilIcon />
										</button>
									</div>
								)}
								{keyErr && <div className="pvc-err">{keyErr}</div>}
								{keySaved && !keyErr && <div className="pvc-saved">已保存</div>}
							</div>

							<div className="pvc-field">
								<div className="pvc-field-head">
									<label className="pvc-label">
										模型列表 <span className="pvc-count">{detail?.models?.length ?? 0} 个</span>
										{grouped && modelFamilies.length > 0 && (
											<span className="pvc-count"> · 聚合 {modelFamilies.length} 族</span>
										)}
									</label>
									{(detail?.models?.length ?? 0) > 0 && (
										<div className="pvc-seg" role="tablist" aria-label="模型列表视图">
											<button
												type="button"
												role="tab"
												aria-selected={grouped}
												className={grouped ? "on" : ""}
												onClick={() => setGrouped(true)}
											>
												按族聚合
											</button>
											<button
												type="button"
												role="tab"
												aria-selected={!grouped}
												className={!grouped ? "on" : ""}
												onClick={() => setGrouped(false)}
											>
												全部
											</button>
										</div>
									)}
								</div>
								{detail?.models && detail.models.length > 0 ? (
									grouped ? (
										<div className="pvc-m-list">
											{modelFamilies.map((f) => {
												const open = !!openFamilies[f.key];
												return (
													<div key={f.key} className="pvc-fam">
														{f.versions.length > 1 ? (
															<button
																type="button"
																className={`pvc-m-item pvc-fam-head${open ? " open" : ""}`}
																aria-expanded={open}
																onClick={() => setOpenFamilies((prev) => ({ ...prev, [f.key]: !prev[f.key] }))}
															>
																<span className="pvc-m-name mono">{f.versions[0]!.id}</span>
																{modelBadges(f.versions[0]!)}
																<span className="pvc-ver">{f.versions.length} 个版本</span>
																<span className={`pvc-arrow${open ? " open" : ""}`}>▾</span>
															</button>
														) : (
															<div className="pvc-m-item pvc-fam-head static">
																<span className="pvc-m-name mono">{f.versions[0]!.id}</span>
																{modelBadges(f.versions[0]!)}
															</div>
														)}
														{open &&
															f.versions.slice(1).map((m, i) => (
																<div className="pvc-m-sub" key={m.id}>
																	<span className="pvc-m-name mono">{m.id}</span>
																	{modelBadges(m)}
																	{i === 0 && <span className="pvc-tag latest">最新</span>}
																</div>
															))}
													</div>
												);
											})}
										</div>
									) : (
										<div className="pvc-m-list">
											{detail.models.map((m) => (
												<div className="pvc-m-item" key={m.id}>
													<span className="pvc-m-name mono">{m.id}</span>
													{modelBadges(m)}
												</div>
											))}
										</div>
									)
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

/** 归一模型引用为 "provider/id"(形状不符返回 null;字符串透传)。 */
function modelRefOf(m: unknown): string | null {
	if (typeof m === "string") return m.length > 0 ? m : null;
	if (typeof m !== "object" || m === null) return null;
	const o = m as Record<string, unknown>;
	if (typeof o.provider !== "string" || typeof o.id !== "string") return null;
	return `${o.provider}/${o.id}`;
}

/** 一族模型(同前缀的多个版本收成一条;单模型族 versions 只有一项)。 */
export interface ModelFamily {
	key: string;
	/** 最新版本在前(列表顺序即新→旧)。 */
	versions: ModelDto[];
}

/**
 * 按族聚合模型:族 key = 去掉尾部版本段(日期 / 纯数字版本 / vN)后的 id。
 * 例:`claude-opus-4-7` / `claude-opus-4-1` / `claude-opus-4-5` 归成一族
 * (前缀 claude-opus-4),每族的第一个为列表顺序里最靠前的那条。
 */
export function groupModelFamilies(models: readonly ModelDto[]): ModelFamily[] {
	const order: string[] = [];
	const groups = new Map<string, ModelDto[]>();
	for (const m of models) {
		const key = modelFamilyKey(m.id);
		let arr = groups.get(key);
		if (!arr) {
			arr = [];
			groups.set(key, arr);
			order.push(key);
		}
		arr.push(m);
	}
	return order.map((key) => ({ key, versions: groups.get(key)! }));
}

/** 取模型 id 的族 key(见 groupModelFamilies 规则)。 */
export function modelFamilyKey(id: string): string {
	const parts = id.split("-");
	while (parts.length > 1) {
		const last = parts[parts.length - 1]!;
		const isVersion = /^\d{4,}$/.test(last) || /^\d+$/.test(last) || /^v\d+$/i.test(last);
		if (!isVersion) break;
		parts.pop();
	}
	return parts.join("-") || id;
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

/** 模型徽章:上下文窗口(如 1M / 200K)+ 思考 + 视觉(设计稿 14 的胶囊顺序)。 */
function modelBadges(m: ModelDto) {
	return (
		<span className="pvc-m-tags">
			<span className="pvc-tag">{contextWindowLabel(m.contextWindow)}</span>
			{m.reasoning && <span className="pvc-tag">思考</span>}
			{m.input.includes("image") && <span className="pvc-tag vis">视觉</span>}
		</span>
	);
}

/** 上下文窗口标签:< 1000 原样,≥1000 按 K,M 缩写(向下取整,如 262144 → 256K)。 */
export function contextWindowLabel(ctx: number): string {
	if (ctx >= 1_000_000) return `${Math.floor(ctx / 1_000_000)}M`;
	if (ctx >= 1000) return `${Math.floor(ctx / 1000)}K`;
	return String(ctx);
}

/** 眼睛(off = 当前已可见,点了会隐藏)。 */
function EyeIcon({ off }: { off: boolean }) {
	return (
		<Lu icon={off ? "eye-off" : "eye"} size={15} strokeWidth={1.4} />
	);
}

/** 铅笔(编辑 API Key)。 */
function PencilIcon() {
	return (
		<Lu icon="pencil" size={15} strokeWidth={1.4} />
	);
}
