import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { UserThemeInfo, WorldDataDto } from "../types.ts";
import { NIGHT_THEME, themeLabelFromCss, themeStarterCss, USER_THEME_PREFIX, userThemeFile, type ThemeId } from "../themes.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { ProviderList } from "../components/ProviderList.tsx";
import { McpServerList } from "../components/McpServerList.tsx";
import { ToggleSwitch } from "../components/ToggleSwitch.tsx";
import { IconBook, IconDoc, IconGear, IconGlobe } from "../components/Icons.tsx";

/** 思考级别选项(与后端 session-host 的 ThinkingLevel 对齐)。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** vendor 模型元素的最小形状(id/provider 必填,其余字段忽略)。 */
interface ModelInfo {
	id: string;
	provider: string;
}

/** 设置分类(左侧导航):模型 / 界面 / 世界书 / 集成。 */
const SETTING_CATS = [
	{ id: "model", label: "模型", icon: IconGear },
	{ id: "ui", label: "界面", icon: IconDoc },
	{ id: "world", label: "世界书", icon: IconBook },
	{ id: "integrations", label: "集成", icon: IconGlobe },
] as const;
type SettingCat = (typeof SETTING_CATS)[number]["id"];

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

/** 从用户主题 CSS 抽取 [背景, 强调, 文字] 三色做卡片预览;缺失回退中性色。 */
function swatchFromCss(css: string): [string, string, string] {
	const pick = (name: string): string => {
		const m = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
		return m ? m[1]!.trim() : "";
	};
	return [pick("--bg") || "#141414", pick("--amber") || "#d9a84e", pick("--ink") || "#e8e6e1"];
}

/**
 * 设置页(2026-08-12 分类导航布局):左侧分类栏(模型/界面/世界书/集成)+
 * 右侧分组设置项。数据源为 GET /api/models、GET /api/providers 与 GET /api/world;
 * 切换模型/思考级别/认证后重新拉取;注入开关读写 world.json(无会话 404 → 分组提示)。
 */
export function SettingsPage({
	client,
	slug,
	simplifiedTools,
	onSimplifiedToolsChange,
	autoExpandThinking,
	onAutoExpandThinkingChange,
	autoConfirmEdits,
	onAutoConfirmEditsChange,
}: {
	client: ApiClient;
	/** 当前打开的书 slug(世界书注入分组随打开书重拉;null = 未打开书)。 */
	slug: string | null;
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
	/** 当前分类(左侧导航激活项;默认「模型」)。 */
	const [cat, setCat] = useState<SettingCat>("model");
	/** null = 加载中;[] = 已加载但为空(或加载失败)。 */
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [current, setCurrent] = useState<string | null>(null);
	const [thinking, setThinking] = useState<string | null>(null);
	const [temperature, setTemperature] = useState<string>("");
	const [topP, setTopP] = useState<string>("");
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [actErr, setActErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
	/** 自定义模型表单(openai-completions 协议,如本地 mock LLM)。 */
	const [customProvider, setCustomProvider] = useState("");
	const [customModel, setCustomModel] = useState("");
	const [customBaseUrl, setCustomBaseUrl] = useState("");
	const [customApiKey, setCustomApiKey] = useState("");
	const [customBusy, setCustomBusy] = useState(false);
	const [customErr, setCustomErr] = useState<string | null>(null);
	/** 折叠状态 */
	const [customOpen, setCustomOpen] = useState(false);
	const [providersOpen, setProvidersOpen] = useState(false);
	const [theme, setTheme] = useState<ThemeId>(() => currentTheme());
	/** 内置主题列表(资产文件自动发现,零 ts 注册;night 无文件,单独用 NIGHT_THEME)。 */
	const [builtinThemes, setBuiltinThemes] = useState<UserThemeInfo[]>([]);
	/** 用户自定义主题列表(文件 + 全文)。 */
	const [userThemes, setUserThemes] = useState<UserThemeInfo[]>([]);
	/** 正在编辑的用户主题文件名(含 .css);null = 关闭编辑器。 */
	const [editingFile, setEditingFile] = useState<string | null>(null);
	/** 编辑器的用户主题 CSS 文本。 */
	const [editCss, setEditCss] = useState("");
	/** 新建主题名输入。 */
	const [newThemeName, setNewThemeName] = useState("");
	/** 主题新建/保存/删除进行中。 */
	const [themeBusy, setThemeBusy] = useState(false);
	/** 主题操作错误文案。 */
	const [themeErr, setThemeErr] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	/** 世界书注入分组:null = 未加载成功(加载中/失败);worldErr 为分组加载错误;noBook = 无打开书(404)。 */
	const [world, setWorld] = useState<WorldDataDto | null>(null);
	const [worldErr, setWorldErr] = useState<string | null>(null);
	const [noBook, setNoBook] = useState(false);
	const [worldBusy, setWorldBusy] = useState(false);
	const [worldReloadKey, setWorldReloadKey] = useState(0);
	/** 最近一次加载/保存成功时磁盘 world.json mtime(If-Match 条件写;0 = 未知)。 */
	const lastWorldMtimeRef = useRef(0);

	/** 拉取模型列表/当前模型/思考等级/采样参数并归一;返回解析结果供调用方直接使用。 */
	const load = useCallback(async (): Promise<{
		models: ModelInfo[];
		current: string | null;
		thinking: string | null;
		temperature: number | null;
		topP: number | null;
	}> => {
		const r = await client.getModels();
		const models = extractModels(r.models);
		const current = modelRef(r.current);
		const thinking = typeof r.thinking === "string" ? r.thinking : null;
		const temperature = typeof r.temperature === "number" ? r.temperature : null;
		const topP = typeof r.topP === "number" ? r.topP : null;
		setModels(models);
		setCurrent(current);
		setThinking(thinking);
		setTemperature(temperature === null ? "" : String(temperature));
		setTopP(topP === null ? "" : String(topP));
		return { models, current, thinking, temperature, topP };
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

	// 世界书注入:打开书(slug)变化或重试时读取 world.json(无打开书直接 noBook;
	// 无会话 404 同样走 noBook,非 404 走分组错误 + 重试)。此前只在挂载加载一次,
	// 四页常驻下启动时无书 → 404 noBook 后不再重拉,打开书也看不到开关(2026-08-13)。
	useEffect(() => {
		if (!slug) {
			setWorld(null);
			setNoBook(true);
			setWorldErr(null);
			return;
		}
		let cancelled = false;
		void client
			.getWorld(slug)
			.then((r) => {
				if (cancelled) return;
				setWorld(r.world);
				setNoBook(false);
				setWorldErr(null);
				lastWorldMtimeRef.current = r.mtime; // 磁盘版本,保存时作 If-Match
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
	}, [client, slug, worldReloadKey]);

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
			// If-Match 条件写:磁盘 mtime 已变(其他窗口/AI 改过)→ 409,回滚并提示
			const mtime = await client.putWorld(next, lastWorldMtimeRef.current || undefined, slug ?? undefined);
			if (mtime > 0) lastWorldMtimeRef.current = mtime;
		} catch (e) {
			setWorld(before); // 回滚:恢复上次成功状态
			setActErr(`世界书注入设置失败: ${friendlyError(e)}`);
		} finally {
			setWorldBusy(false);
		}
	}

	/** 拉取主题清单(内置资产 + 用户自定义)。 */
	const refreshThemes = useCallback(async () => {
		const m = await client.getThemes();
		setBuiltinThemes(m.builtin);
		setUserThemes(m.user);
	}, [client]);

	/** 挂载时加载主题清单。 */
	useEffect(() => {
		let cancelled = false;
		void client
			.getThemes()
			.then((m) => {
				if (cancelled) return;
				setBuiltinThemes(m.builtin);
				setUserThemes(m.user);
			})
			.catch(() => {
				/* 拉取失败:保持空列表,主题不显示 */
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	/** 用户主题文件名 → id。 */
	function userIdOf(file: string): ThemeId {
		return `${USER_THEME_PREFIX}${file.replace(/\.css$/, "")}` as ThemeId;
	}

	/** 选择主题:应用 + 更新 state;用户主题顺带打开编辑器。
	 *  cssOverride 供「刚写入文件、列表尚未刷新」的场景(如新建主题)显式传入内容,
	 *  否则 userThemes 闭包仍是旧渲染快照,取不到新文件会打开空编辑器(2026-08 修复)。 */
	function selectTheme(id: ThemeId, cssOverride?: string) {
		setTheme(id);
		applyTheme(id);
		const file = userThemeFile(id);
		if (file) {
			const ut = userThemes.find((x) => x.file === file);
			setEditingFile(file);
			setEditCss(cssOverride ?? ut?.css ?? "");
		} else {
			setEditingFile(null);
		}
	}

	/** 新建用户主题:写 26 色骨架 → 刷新列表 → 选中并打开编辑器(编辑器预填刚写入的骨架)。 */
	async function createTheme() {
		const name = newThemeName.trim();
		if (!/^[A-Za-z0-9._-]+$/.test(name)) {
			setThemeErr("主题名只能含字母、数字、点、下划线、连字符");
			return;
		}
		setThemeBusy(true);
		setThemeErr(null);
		try {
			const file = `${name}.css`;
			await client.putUserTheme(file, themeStarterCss());
			await refreshThemes();
			setNewThemeName("");
			selectTheme(`user:${name}`, themeStarterCss());
		} catch (e) {
			setThemeErr(`新建主题失败: ${friendlyError(e)}`);
		} finally {
			setThemeBusy(false);
		}
	}

	/** 保存当前编辑的用户主题。 */
	async function saveTheme() {
		if (!editingFile) return;
		setThemeBusy(true);
		setThemeErr(null);
		try {
		await client.putUserTheme(editingFile, editCss);
		await refreshThemes();
		} catch (e) {
			setThemeErr(`保存主题失败: ${friendlyError(e)}`);
		} finally {
			setThemeBusy(false);
		}
	}

	/** 删除当前编辑的用户主题;若正被使用则回退 night。 */
	async function deleteTheme() {
		if (!editingFile) return;
		setThemeBusy(true);
		setThemeErr(null);
		try {
			await client.deleteUserTheme(editingFile);
			if (theme === userIdOf(editingFile)) {
				setTheme("night");
				applyTheme("night");
			}
			setEditingFile(null);
			setEditCss("");
			await refreshThemes();
		} catch (e) {
			setThemeErr(`删除主题失败: ${friendlyError(e)}`);
		} finally {
			setThemeBusy(false);
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

	/** 一键恢复模型默认温度:清除全局与所有演员(含当前舞台 cast.json)的 temperature 覆盖。 */
	async function resetTemperature() {
		if (busy) return;
		setBusy(true);
		setActErr(null);
		try {
			await client.setSampling({ temperature: null });
			await load();
			setNotice("已恢复模型默认温度：所有 agent（含演员）不再修改 temperature");
		} catch (e) {
			setActErr(`恢复默认温度失败: ${friendlyError(e)}`);
		} finally {
			setBusy(false);
		}
	}

	/** 设置采样参数:温度/top_p 至少填一个(留空=不修改)。 */
	async function changeSampling() {
		if (busy) return;
		const t = temperature.trim() === "" ? undefined : Number(temperature);
		const p = topP.trim() === "" ? undefined : Number(topP);
		if ((t === undefined || Number.isNaN(t)) && (p === undefined || Number.isNaN(p))) {
			setActErr("请至少填写 temperature 或 topP 之一");
			return;
		}
		if (t !== undefined && Number.isNaN(t)) {
			setActErr("temperature 必须是数字");
			return;
		}
		if (p !== undefined && Number.isNaN(p)) {
			setActErr("topP 必须是数字");
			return;
		}
		setBusy(true);
		setActErr(null);
		try {
			await client.setSampling({ ...(t !== undefined ? { temperature: t } : {}), ...(p !== undefined ? { topP: p } : {}) });
			await load();
			setNotice("采样参数已保存");
		} catch (e) {
			setActErr(`采样参数设置失败: ${friendlyError(e)}`);
		} finally {
			setBusy(false);
		}
	}

	/** 联网刷新模型目录:远程 catalog / 动态 provider 重新拉取,成功后刷新前端模型列表。 */
	async function refreshModelList() {
		if (modelRefreshBusy || busy) return;
		setModelRefreshBusy(true);
		setNotice(null);
		setActErr(null);
		try {
			const r = await client.refreshModels();
			await load();
			if (r.errors && r.errors.length > 0) {
				setNotice(`模型列表已刷新，但部分目录更新失败: ${r.errors.join("; ")}`);
			} else {
				setNotice("模型列表已联网刷新");
			}
		} catch (e) {
			setActErr(`模型列表刷新失败: ${friendlyError(e)}`);
		} finally {
			setModelRefreshBusy(false);
		}
	}

	/** 添加自定义模型(写 models.json + 服务端热重载)→ 刷新列表并自动切换到新模型。 */
	async function addCustomModel() {
		if (customBusy) return;
		if (!customProvider.trim() || !customModel.trim() || !customBaseUrl.trim()) {
			setCustomErr("provider id、模型 id 与 baseUrl 必填");
			return;
		}
		setCustomBusy(true);
		setCustomErr(null);
		try {
			await client.addCustomModel({
				provider: customProvider.trim(),
				model: customModel.trim(),
				baseUrl: customBaseUrl.trim(),
				...(customApiKey.trim() ? { apiKey: customApiKey.trim() } : {}),
			});
			await load();
			const ref = `${customProvider.trim()}/${customModel.trim()}`;
			const ok = await changeModel(ref);
			setNotice(ok ? `自定义模型已添加并切换: ${ref}` : `自定义模型已添加,请手动选择: ${ref}`);
			setCustomBaseUrl("");
			setCustomApiKey("");
		} catch (e) {
			setCustomErr(`添加失败: ${friendlyError(e)}`);
		} finally {
			setCustomBusy(false);
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
			// 无可用回退时清掉前端当前模型,避免设置页继续显示已失效的旧模型
			setCurrent(null);
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
			{/* 左侧分类导航(窄屏横排胶囊) */}
			<aside className="settings-side">
				<div className="settings-side-title">设置</div>
				<nav className="settings-nav" role="tablist" aria-label="设置分类">
					{SETTING_CATS.map((c) => (
						<button
							key={c.id}
							type="button"
							role="tab"
							aria-selected={cat === c.id}
							className={cat === c.id ? "st-cat active" : "st-cat"}
							onClick={() => setCat(c.id)}
						>
							<c.icon size={15} />
							<span>{c.label}</span>
						</button>
					))}
				</nav>
			</aside>
			<main className="settings-main">
				<div className="settings-inner">
					{/* 全局提示(加载/操作错误、成功通知):所有分类顶部可见 */}
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
					{notice && <div className="notice">{notice}</div>}

					{cat === "model" && (
						<>
							{/* 模型选择(含当前模型信息行) */}
							<div className="s-card">
								<div className="s-card-head">模型</div>
								<div className="s-current-model-row">
									<span className="s-key">当前</span>
									<span className="s-current-model-name">{current ? current.split("/")[1] ?? current : "未设置"}</span>
									<span className="s-current-model-provider">
										{current && <span className="s-badge">{current.split("/")[0]}</span>}
									</span>
								</div>
								<div className="s-field" style={{ marginBottom: 0 }}>
									<label className="s-field-label">切换模型</label>
									<div className="s-field-row">
										<select
											className="s-select s-select-full"
											value={current ?? ""}
											onChange={(e) => {
												setNotice(null);
												void changeModel(e.target.value);
											}}
											disabled={busy || modelRefreshBusy || models === null}
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
										<button
											type="button"
											className="btn-ghost"
											disabled={busy || modelRefreshBusy || models === null}
											onClick={() => void refreshModelList()}
											title="重新联网拉取模型目录"
										>
											{modelRefreshBusy ? "刷新中…" : "联网刷新"}
										</button>
									</div>
								</div>
							</div>

							{/* 思考级别 */}
							<div className="s-card">
								<div className="s-card-head">思考级别</div>
								<div className="s-field" style={{ marginBottom: 0 }}>
									<label className="s-field-label">强度</label>
									<div className="s-field-row">
										<select
											className="s-select s-select-full"
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
									<div className="s-field-desc">off = 关闭思考; max = 最强思考深度</div>
								</div>
							</div>

							{/* 采样参数 */}
							<div className="s-card">
								<div className="s-card-head">采样参数</div>
								<div className="s-field-grid">
									<div className="s-field">
										<label className="s-field-label">temperature</label>
										<input
											className="s-input s-input-short"
											placeholder="默认"
											type="number"
											min="0"
											max="2"
											step="0.1"
											value={temperature}
											disabled={busy}
											onChange={(e) => setTemperature(e.target.value)}
										/>
									</div>
									<div className="s-field">
										<label className="s-field-label">top_p</label>
										<input
											className="s-input s-input-short"
											placeholder="默认"
											type="number"
											min="0"
											max="1"
											step="0.05"
											value={topP}
											disabled={busy}
											onChange={(e) => setTopP(e.target.value)}
										/>
									</div>
								</div>
								<div className="s-field-row" style={{ marginTop: 10 }}>
									<button type="button" className="btn-ghost" disabled={busy} onClick={() => void changeSampling()}>
										{busy ? "设置中…" : "应用"}
									</button>
									<button type="button" className="btn-ghost" disabled={busy} onClick={() => void resetTemperature()}>
										{busy ? "处理中…" : "恢复默认温度"}
									</button>
								</div>
								<div className="s-card-desc" style={{ marginTop: 8 }}>
									「恢复默认温度」会清除全局与所有演员的 temperature 覆盖，所有 agent 恢复 provider 默认；top_p 不受影响。留空表示不修改对应项。
								</div>
							</div>

							{/* 自定义模型 — 可折叠 */}
							<div className="s-card s-collapsible">
								<button
									type="button"
									className="s-collapsible-head"
									onClick={() => setCustomOpen((v) => !v)}
								>
									<span>自定义模型</span>
									<span className={`s-collapsible-arrow${customOpen ? " open" : ""}`}>▸</span>
								</button>
								{customOpen && (
									<div className="s-collapsible-body">
										<div className="s-card-desc">添加 OpenAI 兼容的自定义模型(如本地 mock 服务器)。模型引用为 provider id / 模型 id。</div>
										<div className="s-field-grid">
											<div className="s-field">
												<label className="s-field-label">provider id</label>
												<input
													className="s-input"
													placeholder="如 mock"
													value={customProvider}
													disabled={customBusy}
													onChange={(e) => setCustomProvider(e.target.value)}
												/>
											</div>
											<div className="s-field">
												<label className="s-field-label">模型 id</label>
												<input
													className="s-input"
													placeholder="如 mock-1"
													value={customModel}
													disabled={customBusy}
													onChange={(e) => setCustomModel(e.target.value)}
												/>
											</div>
											<div className="s-field">
												<label className="s-field-label">baseUrl</label>
												<input
													className="s-input"
													placeholder="http://127.0.0.1:8787/v1"
													value={customBaseUrl}
													disabled={customBusy}
													onChange={(e) => setCustomBaseUrl(e.target.value)}
												/>
											</div>
											<div className="s-field">
												<label className="s-field-label">apiKey(可选)</label>
												<input
													className="s-input"
													placeholder="留空则无鉴权"
													value={customApiKey}
													disabled={customBusy}
													onChange={(e) => setCustomApiKey(e.target.value)}
												/>
											</div>
										</div>
										<div className="s-field-row" style={{ marginTop: 10 }}>
											<button className="btn-ghost" type="button" disabled={customBusy} onClick={() => void addCustomModel()}>
												{customBusy ? "添加中…" : "添加并切换"}
											</button>
											{customErr && <span className="s-busy err">{customErr}</span>}
										</div>
									</div>
								)}
							</div>

							{/* 模型提供商 — 可折叠 */}
							<div className="s-card s-collapsible">
								<button
									type="button"
									className="s-collapsible-head"
									onClick={() => setProvidersOpen((v) => !v)}
								>
									<span>模型提供商</span>
									<span className={`s-collapsible-arrow${providersOpen ? " open" : ""}`}>▸</span>
								</button>
								{providersOpen && (
									<div className="s-collapsible-body">
										<div className="s-card-desc">
											为 provider 添加 API key 后其模型即可在「切换模型」中使用;key 存储在 ~/.pi/writer/agent/auth.json。
										</div>
										<ProviderList client={client} onAuthChanged={handleAuthChanged} />
									</div>
								)}
							</div>
						</>
					)}

					{cat === "ui" && (
						<>
							<div className="s-card">
								<div className="s-card-head">主题</div>
								<div className="theme-cards">
									{/* night:默认内置,无资产文件(token 收敛在 styles.css :root 防闪) */}
									<button
										key={NIGHT_THEME.id}
										className={`theme-card${theme === NIGHT_THEME.id ? " active" : ""}`}
										onClick={() => selectTheme(NIGHT_THEME.id)}
									>
										<span className="theme-swatch">
											{NIGHT_THEME.swatch.map((c) => (
												<i key={c} style={{ background: c }} />
											))}
										</span>
										<span className="theme-label">{NIGHT_THEME.label}</span>
										<span className="theme-desc">内置 · 默认</span>
									</button>
									{/* 内置主题:资产文件自动发现(id = 文件名,名字取首行注释,色板取 token) */}
									{builtinThemes.map((bt) => {
										const id = bt.file.replace(/\.css$/, "");
										const swatch = swatchFromCss(bt.css);
										return (
											<button
												key={bt.file}
												className={`theme-card${theme === id ? " active" : ""}`}
												onClick={() => selectTheme(id)}
											>
												<span className="theme-swatch">
													{swatch.map((c) => (
														<i key={c} style={{ background: c }} />
													))}
												</span>
												<span className="theme-label">{themeLabelFromCss(bt.css, bt.file)}</span>
												<span className="theme-desc">内置</span>
											</button>
											);
										})}
									{userThemes.map((ut) => {
										const id = userIdOf(ut.file);
										const swatch = swatchFromCss(ut.css);
										return (
											<button
												key={ut.file}
												className={`theme-card${theme === id ? " active" : ""}`}
												onClick={() => selectTheme(id)}
											>
												<span className="theme-swatch">
													{swatch.map((c) => (
														<i key={c} style={{ background: c }} />
													))}
												</span>
												<span className="theme-label">{ut.file.replace(/\.css$/, "")}</span>
												<span className="theme-desc">自定义</span>
											</button>
											);
										})}
									</div>
									<div className="s-card-desc">主题即 CSS 文件:内置为 web/public/themes/*.css,自定义为 ~/.pi/writer/themes/*.css,放入即自动出现在列表。</div>
								</div>

							<div className="s-card">
								<div className="s-card-head">自定义主题</div>
								<div className="s-field-row">
									<input
										className="s-input"
										placeholder="主题名(如 moon,仅字母数字._-)"
										value={newThemeName}
										onChange={(e) => setNewThemeName(e.target.value)}
									/>
									<button type="button" className="btn-ghost" disabled={themeBusy || !newThemeName.trim()} onClick={() => void createTheme()}>
										新建
									</button>
									{userThemes.length > 0 && (
										<select
											className="s-select"
											value={editingFile ?? ""}
											onChange={(e) => {
												const f = e.target.value;
												if (f) selectTheme(userIdOf(f));
												else setEditingFile(null);
											}}
										>
											<option value="">编辑已有主题…</option>
											{userThemes.map((ut) => (
												<option key={ut.file} value={ut.file}>
													{ut.file.replace(/\.css$/, "")}
												</option>
											))}
										</select>
									)}
								</div>
								{themeErr && <div className="notice err">{themeErr}</div>}
								{editingFile && (
									<>
										<div className="s-field-row" style={{ marginTop: 8 }}>
											<span className="s-key">编辑 {editingFile}</span>
											<span className="s-val muted">保存后生效</span>
										</div>
										<textarea
											className="theme-css-editor"
											value={editCss}
											spellCheck={false}
											onChange={(e) => setEditCss(e.target.value)}
										/>
										<div className="s-field-row">
											<button type="button" className="btn-ghost" disabled={themeBusy} onClick={() => void saveTheme()}>
												{themeBusy ? "保存中…" : "保存"}
											</button>
											<button type="button" className="btn-ghost" disabled={themeBusy} onClick={() => void deleteTheme()}>
												删除
											</button>
										</div>
									</>
								)}
							</div>

							<div className="s-card">
								<div className="s-card-head">界面偏好</div>
								<div className="s-pref-list">
									<div className="s-pref-item">
										<div className="s-pref-text">
											<div className="s-pref-title">简化输出</div>
											<div className="s-pref-desc">开启后对话中不显示工具调用卡片,以「正在阅读 / 正在编辑」等动态提示代替。</div>
										</div>
										<ToggleSwitch checked={simplifiedTools} onChange={onSimplifiedToolsChange} ariaLabel="简化输出" />
									</div>
									<div className="s-pref-item">
										<div className="s-pref-text">
											<div className="s-pref-title">自动展开思考</div>
											<div className="s-pref-desc">开启后思考块默认展开,无需逐条点击;关闭后回到手动展开。</div>
										</div>
										<ToggleSwitch checked={autoExpandThinking} onChange={onAutoExpandThinkingChange} ariaLabel="自动展开思考" />
									</div>
									<div className="s-pref-item">
										<div className="s-pref-text">
											<div className="s-pref-title">编辑免确认</div>
											<div className="s-pref-desc">开启后编剧的修改落盘即生效,不再弹「待确认」卡。</div>
										</div>
										<ToggleSwitch checked={autoConfirmEdits} onChange={onAutoConfirmEditsChange} ariaLabel="编辑免确认" />
									</div>
								</div>
							</div>
						</>
					)}

					{cat === "world" && (
						<div className="s-card">
							<div className="s-card-head">世界书注入</div>
							{worldErr ? (
								<div className="notice err">
									{worldErr}
									<button type="button" className="btn-ghost" onClick={() => setWorldReloadKey((k) => k + 1)}>
										重试
									</button>
								</div>
							) : noBook ? (
								<div className="s-card-desc">
									未打开书,无法读取世界书注入设置。请先在写作页打开一本书,再到此页切换开关。
								</div>
							) : world === null ? (
								<div className="s-card-desc">世界书注入设置加载中…</div>
							) : (
								<div className="s-pref-list">
									<div className="s-pref-item">
										<div className="s-pref-text">
											<div className="s-pref-title">Notice 注入</div>
											<div className="s-pref-desc">背景包包含当前剧情指引</div>
										</div>
										<ToggleSwitch
											checked={world.notice.enabled}
											onChange={(v) => void toggleInjection("notice", v)}
											disabled={worldBusy}
											ariaLabel="Notice 注入"
										/>
									</div>
									<div className="s-pref-item">
										<div className="s-pref-text">
											<div className="s-pref-title">发展线注入</div>
											<div className="s-pref-desc">背景包包含剧情进度与下一步</div>
										</div>
										<ToggleSwitch
											checked={world.storyline.enabled}
											onChange={(v) => void toggleInjection("storyline", v)}
											disabled={worldBusy}
											ariaLabel="发展线注入"
										/>
									</div>
								</div>
							)}
						</div>
					)}

					{cat === "integrations" && (
						<div className="s-card">
							<div className="s-card-head">MCP 服务器</div>
							<div className="s-card-desc">
								为 AI 接入外部工具(如文件系统、资料库、计算器)。配置存 ~/.pi/writer/agent/mcp.json。
							</div>
							<McpServerList client={client} />
						</div>
					)}
				</div>
			</main>
		</div>
	);
}
