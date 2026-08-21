import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { ProviderInfo } from "../types.ts";

/**
 * 模型提供商列表区:搜索过滤、添加/更新 API key(行内掩码表单)、
 * 移除确认。认证变化(添加/移除 key)后回调 onAuthChanged,由外层
 * 刷新模型列表并处理当前模型失效回退。
 */
export function ProviderList({ client, onAuthChanged }: { client: ApiClient; onAuthChanged: () => void | Promise<void> }) {
	/** null = 加载中;[] = 已加载但为空(或加载失败)。 */
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [query, setQuery] = useState("");
	const [loadErr, setLoadErr] = useState<string | null>(null);
	/** 正在编辑 key 的 provider id(null = 无)。 */
	const [editingId, setEditingId] = useState<string | null>(null);
	const [keyValue, setKeyValue] = useState("");
	/** 正在移除确认的 provider id(null = 无)。 */
	const [confirmId, setConfirmId] = useState<string | null>(null);
	/** 行内进行中状态(防重复提交):provider id 或 null。 */
	const [busyId, setBusyId] = useState<string | null>(null);
	const [rowErr, setRowErr] = useState<string | null>(null);

	const load = useCallback(async () => {
		setProviders(await client.getProviders());
	}, [client]);

	useEffect(() => {
		let cancelled = false;
		setLoadErr(null);
		void load().catch((e) => {
			if (cancelled) return;
			setProviders([]);
			setLoadErr(`提供商加载失败: ${friendlyError(e)}`);
		});
		return () => {
			cancelled = true;
		};
	}, [load]);

	const filtered = useMemo(() => {
		const list = providers ?? [];
		if (query.trim().length === 0) return list;
		const q = query.trim().toLowerCase();
		return list.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
	}, [providers, query]);

	/** 保存 key:提交后刷新列表 + 通知外层刷新模型。 */
	async function saveKey(id: string) {
		if (busyId) return;
		setBusyId(id);
		setRowErr(null);
		try {
			await client.setProviderApiKey(id, keyValue);
		} catch (e) {
			setRowErr(`保存失败: ${friendlyError(e)}`);
			setBusyId(null);
			return;
		}
		setEditingId(null);
		setKeyValue("");
		try {
			await load();
		} catch {
			setRowErr("提供商列表刷新失败");
		}
		try {
			await onAuthChanged();
		} catch (e) {
			setRowErr(`认证状态刷新失败: ${friendlyError(e)}`);
		}
		setBusyId(null);
	}

	/** 移除凭据:确认后删除 + 刷新 + 通知外层。 */
	async function removeKey(id: string) {
		if (busyId) return;
		setBusyId(id);
		setRowErr(null);
		try {
			await client.deleteProvider(id);
		} catch (e) {
			setRowErr(`移除失败: ${friendlyError(e)}`);
			setBusyId(null);
			return;
		}
		setConfirmId(null);
		try {
			await load();
		} catch {
			setRowErr("提供商列表刷新失败");
		}
		try {
			await onAuthChanged();
		} catch (e) {
			setRowErr(`认证状态刷新失败: ${friendlyError(e)}`);
		}
		setBusyId(null);
	}

	return (
		<>
			{loadErr && <div className="notice err">{loadErr}</div>}
			{rowErr && <div className="notice err">{rowErr}</div>}
			<input
				className="s-search"
				type="search"
				placeholder="搜索 provider…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>
			{filtered.length === 0 ? (
				<div className="s-empty-row">
					<span className="s-val muted">未找到匹配的 provider</span>
				</div>
			) : (
				<div className="s-provider-list">
					{filtered.map((p) => (
						<div className={`s-provider-row${p.configured ? " configured" : ""}`} key={p.id}>
							<div className="s-provider-main">
								<span className="s-provider-id">{p.id}</span>
								{p.configured ? (
									<span className="s-tag ok">已配置{p.source === "stored" ? " · 已存 key" : ""}</span>
								) : p.authKind === "ambient" ? (
									<span className="s-tag">环境变量</span>
								) : (
									<span className="s-tag muted">未配置</span>
								)}
								<span className="s-actions">
									{p.authKind === "api_key" || p.authKind === "both" ? (
										<>
											<button
												className="btn-ghost"
												disabled={busyId !== null}
												onClick={() => {
													setEditingId(p.id);
													setKeyValue("");
													setConfirmId(null);
												}}
											>
												{p.configured ? "更新" : "添加 key"}
											</button>
											{p.configured && (
												<button className="btn-ghost danger" disabled={busyId !== null} onClick={() => setConfirmId(p.id)}>
													移除
												</button>
											)}
										</>
									) : p.authKind === "oauth" ? (
										<span className="s-note-inline">支持订阅登录(暂未支持)</span>
									) : null}
								</span>
							</div>
							{editingId === p.id && (
								<div className="s-provider-form">
									<input
										type="password"
										className="s-input"
										placeholder="粘贴 API key"
										value={keyValue}
										autoFocus
										onChange={(e) => setKeyValue(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && keyValue.trim().length > 0) void saveKey(p.id);
											if (e.key === "Escape") {
												setEditingId(null);
												setKeyValue("");
											}
										}}
									/>
									<button className="btn-ghost" disabled={busyId !== null || keyValue.trim().length === 0} onClick={() => void saveKey(p.id)}>
										{busyId === p.id ? "保存中…" : "保存"}
									</button>
									<button className="btn-ghost" disabled={busyId !== null} onClick={() => { setEditingId(null); setKeyValue(""); }}>
										取消
									</button>
								</div>
							)}
							{confirmId === p.id && (
								<div className="s-provider-confirm">
									<span>移除后该 provider 将无法使用,确认?</span>
									<button className="btn-ghost danger" disabled={busyId !== null} onClick={() => void removeKey(p.id)}>
										{busyId === p.id ? "移除中…" : "确认移除"}
									</button>
									<button className="btn-ghost" disabled={busyId !== null} onClick={() => setConfirmId(null)}>
										取消
									</button>
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</>
	);
}
