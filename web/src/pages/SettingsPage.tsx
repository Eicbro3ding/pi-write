import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { WorldDataDto } from "../types.ts";
import { THEMES, type ThemeId } from "../themes.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { ProviderList } from "../components/ProviderList.tsx";
import { McpServerList } from "../components/McpServerList.tsx";

/** 思考级别选项(与后端 session-host 的 ThinkingLevel 对齐)。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** vendor 模型元素的最小形状(id/provider 必填,其余字段忽略)。 */
interface ModelInfo {
	id: string;
	provider: string;
}

/**
 * 归一模型引用为 "provider/id"(与服务端 resolveCliModel 的 canonical 格式一致)。
 * 元素形状不符/缺失时返回 null;字符串直接透传(防御:个别后端返回裸 id)。
 */
export function modelRef(m: unknown): string | null {
	if (typeof m === "string") return m.length > 0 ? m : null;
	if (typeof m !== "object" || m === null) return null;
	const o = m as Record<string, unknown>;
	if (typeof o.provider !== "string" || typeof o.id !== "string") return null;
	return `${o.provider}/${o.id}`;
}

/**
 * 认证变化后模型列表重拉,当前模型不可用时选第一个可用模型作为回退。
 * 返回 null 表示无需回退(当前仍可用 / 无当前模型 / 无任何模型)。
 */
export function pickFallbackModel(current: string | null, models: readonly ModelInfo[]): string | null {
	if (!current || models.length === 0) return null;
	if (models.some((m) => `${m.provider}/${m.id}` === current)) return null;
	return `${models[0]!.provider}/${models[0]!.id}`;
}

/** 从 getModels 的 models 数组中提取最小形状元素,形状不符的条目跳过。 */
function extractModels(models: readonly unknown[]): ModelInfo[] {
	const out: ModelInfo[] = [];
	for (const m of models) {
		if (typeof m !== "object" || m === null) continue;
		const o = m as Record<string, unknown>;
		if (typeof o.id === "string" && typeof o.provider === "string") {
			out.push({ id: o.id, provider: o.provider });
		}
	}
	return out;
}

/**
 * 设置页:模型选择、思考级别、世界书注入开关、模型提供商(key 管理)、MCP 服务器。
 * 数据源为 GET /api/models、GET /api/providers 与 GET /api/world;
 * 切换模型/思考级别/认证后重新拉取;注入开关读写 world.json(无会话 404 → 分组提示)。
 */
export function SettingsPage({
	client,
	simplifiedTools,
	onSimplifiedToolsChange,
	autoExpandThinking,
	onAutoExpandThinkingChange,
	autoConfirmEdits,
	onAutoConfirmEditsChange,
}: {
	client: ApiClient;
	/** 简化输出开关状态(工具调用卡片隐藏;缺省开启)。 */
	simplifiedTools: boolean;
	onSimplifiedToolsChange: (enabled: boolean) => void;
	/** 自动展开思考开关状态(思考块默认展开;缺省开启)。 */
	autoExpandThinking: boolean;
	onAutoExpandThinkingChange: (enabled: boolean) => void;
	/** 编辑免确认开关状态(编剧编辑落盘即归档;缺省关闭,默认走待确认卡)。 */
	autoConfirmEdits: boolean;
	onAutoConfirmEditsChange: (enabled: boolean) => void;
}) {
	/** null = 加载中;[] = 已加载但为空(或加载失败)。 */
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [current, setCurrent] = useState<string | null>(null);
	const [thinking, setThinking] = useState<string | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [actErr, setActErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [theme, setTheme] = useState<ThemeId>(() => currentTheme());
	const [notice, setNotice] = useState<string | null>(null);
	/** 世界书注入分组:null = 未加载成功(加载中/失败);worldErr 为分组加载错误;noBook = 无打开书(404)。 */
	const [world, setWorld] = useState<WorldDataDto | null>(null);
	const [worldErr, setWorldErr] = useState<string | null>(null);
	const [noBook, setNoBook] = useState(false);
	const [worldBusy, setWorldBusy] = useState(false);
	const [worldReloadKey, setWorldReloadKey] = useState(0);

	/** 拉取模型列表/当前模型/思考等级并归一;返回解析结果供调用方直接使用。 */
	const load = useCallback(async (): Promise<{ models: ModelInfo[]; current: string | null; thinking: string | null }> => {
		const r = await client.getModels();
		const models = extractModels(r.models);
		const current = modelRef(r.current);
		const thinking = typeof r.thinking === "string" ? r.thinking : null;
		setModels(models);
		setCurrent(current);
		setThinking(thinking);
		return { models, current, thinking };
	}, [client]);

	// 挂载时加载
	useEffect(() => {
		let cancelled = false;
		setLoadErr(null);
		void load().catch((e) => {
			if (cancelled) return;
			setModels([]);
			setLoadErr(`设置加载失败: ${friendlyError(e)}`);
		});
		return () => {
			cancelled = true;
		};
	}, [load]);

	// 世界书注入:挂载时读取 world.json(无会话 404 → 分组提示未打开书,非 404 走分组错误 + 重试)
	useEffect(() => {
		let cancelled = false;
	void client
		.getWorld()
		.then((r) => {
			if (cancelled) return;
			setWorld(r.world);
			setNoBook(false);
			setWorldErr(null);
		})
			.catch((e) => {
				if (cancelled) return;
				setWorld(null);
				if (e instanceof ApiError && e.status === 404) {
					setNoBook(true);
					setWorldErr(null);
				} else {
					setNoBook(false);
					setWorldErr(`世界书注入设置加载失败: ${friendlyError(e)}`);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [client, worldReloadKey]);

	/** 切换注入开关:改本地 world → putWorld 整体保存;失败回滚并显示错误。 */
	async function toggleInjection(key: "notice" | "storyline", checked: boolean) {
		if (!world || worldBusy) return;
		const before = world;
		const next: WorldDataDto =
			key === "notice"
				? { ...world, notice: { ...world.notice, enabled: checked } }
				: { ...world, storyline: { ...world.storyline, enabled: checked } };
		setNotice(null);
		setActErr(null);
		setWorld(next);
		setWorldBusy(true);
		try {
			await client.putWorld(next);
		} catch (e) {
			setWorld(before); // 回滚:恢复上次成功状态
			setActErr(`世界书注入设置失败: ${friendlyError(e)}`);
		} finally {
			setWorldBusy(false);
		}
	}

	/** 切换模型:setModel → 刷新当前值;失败显示错误文案并返回 false。 */
	async function changeModel(ref: string): Promise<boolean> {
		if (busy) return false;
		setBusy(true);
		setActErr(null);
		try {
			await client.setModel(ref);
			await load();
			return true;
		} catch (e) {
			setActErr(`模型切换失败: ${friendlyError(e)}`);
			return false;
		} finally {
			setBusy(false);
		}
	}

	/** 设置思考级别:setThinking → 刷新当前值;失败显示错误文案。 */
	async function changeThinking(level: string) {
		if (busy) return;
		setBusy(true);
		setActErr(null);
		try {
			await client.setThinking(level);
			await load();
		} catch (e) {
			setActErr(`思考级别设置失败: ${friendlyError(e)}`);
		} finally {
			setBusy(false);
		}
	}

	/**
	 * 提供商认证变化(添加/移除 key)后刷新模型;当前模型失效时自动回退
	 * 到第一个可用模型,无可用模型则提示手动选择。
	 */
	async function handleAuthChanged() {
		setNotice(null);
		const before = current;
		const r = await load();
		const fallback = pickFallbackModel(before, r.models);
		if (fallback) {
			const ok = await changeModel(fallback);
			if (ok) setNotice(`当前模型已不可用,已自动切换到 ${fallback}`);
		} else if (before && !r.models.some((m) => `${m.provider}/${m.id}` === before)) {
			setNotice("当前模型已不可用,请重新选择模型");
		}
	}

	/** 模型下拉按 provider 分组(组内按 id 排序)。 */
	const groups = useMemo(() => {
		const byProvider = new Map<string, ModelInfo[]>();
		for (const m of models ?? []) {
			const arr = byProvider.get(m.provider) ?? [];
			arr.push(m);
			byProvider.set(m.provider, arr);
		}
		return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [models]);

	return (
		<div className="settings">
			<div className="settings-inner">
				{models === null && !loadErr && <div className="notice">设置加载中…</div>}
				{loadErr && (
					<div className="notice err">
						{loadErr}
						<button
							type="button"
							className="btn-ghost"
							onClick={() => {
								// 重试:回到加载态;失败时与挂载 effect 相同方式呈现错误
								setLoadErr(null);
								setModels(null);
								void load().catch((e) => {
									setModels([]);
									setLoadErr(`设置加载失败: ${friendlyError(e)}`);
								});
							}}
						>
							重试
						</button>
					</div>
				)}
				{actErr && <div className="notice err">{actErr}</div>}

				<div className="s-head">主题</div>
				<div className="theme-cards">
					{THEMES.map((t) => (
						<button
							key={t.id}
							className={`theme-card${theme === t.id ? " active" : ""}`}
							onClick={() => {
								setTheme(t.id);
								applyTheme(t.id);
							}}
						>
							<span className="theme-swatch">
								{t.swatch.map((c) => (
									<i key={c} style={{ background: c }} />
								))}
							</span>
							<span className="theme-label">{t.label}</span>
							<span className="theme-desc">{t.desc}</span>
						</button>
					))}
				</div>

				<div className="s-head">界面偏好</div>
				<div className="s-row">
					<span className="s-key">简化输出</span>
					<span className="s-val">
						<label className="w-switch">
							<input
								type="checkbox"
								checked={simplifiedTools}
								onChange={(e) => onSimplifiedToolsChange(e.target.checked)}
							/>
							<span>{simplifiedTools ? "已开启" : "已关闭"}</span>
						</label>
					</span>
				</div>
				<div className="s-note">开启后对话中不显示工具调用卡片,以「正在阅读 / 正在编辑」等动态提示代替(默认开启)。</div>

				<div className="s-row">
					<span className="s-key">自动展开思考</span>
					<span className="s-val">
						<label className="w-switch">
							<input
								type="checkbox"
								checked={autoExpandThinking}
								onChange={(e) => onAutoExpandThinkingChange(e.target.checked)}
							/>
							<span>{autoExpandThinking ? "已开启" : "已关闭"}</span>
						</label>
					</span>
				</div>
				<div className="s-note">开启后思考块默认展开,无需逐条点击;关闭后回到手动展开(默认开启)。</div>

				<div className="s-row">
					<span className="s-key">编辑免确认</span>
					<span className="s-val">
						<label className="w-switch">
							<input
								type="checkbox"
								checked={autoConfirmEdits}
								onChange={(e) => onAutoConfirmEditsChange(e.target.checked)}
							/>
							<span>{autoConfirmEdits ? "已开启" : "已关闭"}</span>
						</label>
					</span>
				</div>
				<div className="s-note">开启后编剧(编辑 agent)的修改落盘即生效,不再弹「待确认」卡;关闭则每次编辑需手动确认/回退(默认关闭)。</div>

				{notice && <div className="notice">{notice}</div>}

				<div className="s-head">模型</div>
				<div className="s-row">
					<span className="s-key">当前提供商</span>
					<span className="s-val">{current ? current.split("/")[0] : "未设置"}</span>
				</div>
				<div className="s-row">
					<span className="s-key">当前模型</span>
					<span className="s-val">{current ?? "未设置"}</span>
				</div>
				<div className="s-row">
					<span className="s-key">切换模型</span>
					<select
						className="s-select"
						value={current ?? ""}
						onChange={(e) => {
							setNotice(null);
							void changeModel(e.target.value);
						}}
						disabled={busy || models === null}
						title="按 provider 分组选择模型"
					>
						<option value="" disabled>
							{models === null ? "加载中…" : "请选择模型"}
						</option>
						{groups.map(([provider, list]) => (
							<optgroup key={provider} label={provider}>
								{list.map((m) => (
									<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
										{m.provider} · {m.id}
									</option>
								))}
							</optgroup>
						))}
					</select>
					{busy && <span className="s-busy">设置中…</span>}
				</div>

				<div className="s-head">思考级别</div>
				<div className="s-row">
					<span className="s-key">思考级别</span>
					<select
						className="s-select"
						value={thinking ?? ""}
						onChange={(e) => {
							setNotice(null);
							void changeThinking(e.target.value);
						}}
						disabled={busy || thinking === null}
						title="思考强度(off 关闭;max 最强)"
					>
						<option value="" disabled>
							{thinking === null ? "未设置" : "请选择"}
						</option>
						{THINKING_LEVELS.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</select>
						{busy && <span className="s-busy">设置中…</span>}
					</div>

					<div className="s-head">世界书注入</div>
					{worldErr ? (
						<div className="notice err">
							{worldErr}
							<button type="button" className="btn-ghost" onClick={() => setWorldReloadKey((k) => k + 1)}>
								重试
							</button>
						</div>
					) : noBook ? (
						<div className="s-note">
							未打开书,无法读取世界书注入设置。请先在写作页打开一本书,再到此页切换开关。
						</div>
					) : world === null ? (
						<div className="s-note">世界书注入设置加载中…</div>
					) : (
						<>
							<label className="s-row w-switch">
								<input
									type="checkbox"
									checked={world.notice.enabled}
									disabled={worldBusy}
									onChange={(e) => void toggleInjection("notice", e.target.checked)}
								/>
								<span className="s-key">Notice 注入</span>
								<span className="s-val muted">背景包包含当前剧情指引</span>
								{worldBusy && <span className="s-busy">设置中…</span>}
							</label>
							<label className="s-row w-switch">
								<input
									type="checkbox"
									checked={world.storyline.enabled}
									disabled={worldBusy}
									onChange={(e) => void toggleInjection("storyline", e.target.checked)}
								/>
								<span className="s-key">发展线注入</span>
								<span className="s-val muted">背景包包含剧情进度与下一步</span>
								{worldBusy && <span className="s-busy">设置中…</span>}
							</label>
						</>
					)}

					<div className="s-head">模型提供商</div>
				<div className="s-note">
					为 provider 添加 API key 后其模型即可在「切换模型」中使用;key 存储在 ~/.pi/writer/agent/auth.json。
				</div>
				<ProviderList client={client} onAuthChanged={() => void handleAuthChanged()} />

					<div className="s-head">MCP 服务器</div>
				<div className="s-note">
					为 AI 接入外部工具(如文件系统、资料库、计算器)。配置存 ~/.pi/writer/agent/mcp.json。
				</div>
				<McpServerList client={client} />
			</div>
		</div>
	);
}
