import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ApiError, type ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { PluginInfoDto, ResolvedShellDto, ShellDialectDto, ShellKindDto, UserThemeInfo, WorldDataDto } from "../types.ts";
import { themeStarterCss, USER_THEME_PREFIX, userThemeFile, type ThemeId } from "../themes.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { ProviderList } from "../components/ProviderList.tsx";
import { McpServerList } from "../components/McpServerList.tsx";
import { PluginList } from "../components/PluginList.tsx";
import { PluginSettings } from "../components/PluginSettings.tsx";
import { ToggleSwitch } from "../components/ToggleSwitch.tsx";
import { Select } from "../components/Select.tsx";
import { ThemeCardsFromManifest } from "../components/ThemeCards.tsx";
import { IconBook, IconDoc, IconGear, IconGlobe, IconStage, IconX } from "../components/Icons.tsx";
import { Lu } from "../components/Lu.tsx";

/** 思考级别选项(与后端 session-host 的 ThinkingLevel 对齐)。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** vendor 模型元素的最小形状(id/provider 必填,其余字段忽略)。 */
interface ModelInfo {
	id: string;
	provider: string;
}

/** 设置侧栏分类图标(名字取自设计稿 pi-writer · 设置 v1 的 lucide icon 节点)。 */
const LuSliders = ({ size = 15 }: { size?: number }) => <Lu icon="sliders-horizontal" size={size} />;
const LuLayout = ({ size = 15 }: { size?: number }) => <Lu icon="layout-dashboard" size={size} />;
const LuBookOpen = ({ size = 15 }: { size?: number }) => <Lu icon="book-open" size={size} />;
const LuPuzzle = ({ size = 15 }: { size?: number }) => <Lu icon="puzzle" size={size} />;
const LuWrench = ({ size = 15 }: { size?: number }) => <Lu icon="wrench" size={size} />;

/**
 * 设置分类(左侧导航):模型 / 界面 / 世界书 / 集成 / 高级。
 * 设计稿 v1 把「危险设置」(外部命令 / Shell)从「界面」移出,单独成组。
 */
const SETTING_CATS = [
	{ id: "model", label: "模型", icon: LuSliders },
	{ id: "ui", label: "界面", icon: LuLayout },
	{ id: "world", label: "世界书", icon: LuBookOpen },
	{ id: "integrations", label: "集成", icon: LuPuzzle },
	{ id: "advanced", label: "高级", icon: LuWrench },
] as const;
type SettingCat = (typeof SETTING_CATS)[number]["id"];
/** 插件动态分类 id(plugin:<id>);类型上并入 SettingCat 判断分支。 */
const pluginCatPrefix = "plugin:";

/** 各分类页面头(标题 + 一句话说明;设计稿 11-13 的页头文案)。 */
const CAT_HEAD: Record<string, { title: string; desc: string }> = {
	model: { title: "模型", desc: "选择写作与演出使用的模型、思考强度与采样参数。修改都即时生效,无需保存。" },
	ui: { title: "界面", desc: "主题与日常偏好。会改变 AI 在你机器上行为的选项,已移到「高级」。" },
	world: { title: "世界书", desc: "决定 AI 每次对话时自动带上哪些世界书内容。" },
	integrations: { title: "集成", desc: "为 AI 接入外部工具与扩展写作能力。" },
	advanced: { title: "高级", desc: "会改变 AI 在你机器上行为的选项。这类设置的影响范围超出 pi-writer 自己,请在开启前读完说明。" },
};

/**
 * shell 解析结果的可读名(与服务端 src/shell-kind.ts 的 SHELL_DIALECT_LABELS 对齐;
 * 前端不 import src/,故此处单列一份展示用文案)。
 */
const SHELL_DIALECT_TEXT: Record<ShellDialectDto, string> = {
	none: "无 shell",
	bash: "bash",
	pwsh: "PowerShell 7(pwsh)",
	powershell: "Windows PowerShell 5.1",
};

/** shell 方言下拉项(设计稿 13:bash / PowerShell,标签精简)。 */
const SHELL_KIND_OPTIONS = [
	{ value: "auto", label: "自动(按平台识别)" },
	{ value: "bash", label: "bash" },
	{ value: "pwsh", label: "PowerShell" },
];

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
 * 设置页(v1 重做:左分类栏 + 「左主列 + 右窄列」两栏卡片)。
 *
 * 左栏(约 180)按组列出分类:模型 / 界面 / 世界书 / 集成 / 高级,再是插件设置分类;
 * 内容列 1160,主列放宽卡片、右列(min 300)放次级信息(思考级别、供应商入口、
 * 配置向导、依赖说明)。数据与写操作全部沿用原逻辑:
 * GET /api/models、GET /api/providers、GET /api/world、主题读写与 settings 读写。
 */
export function SettingsPage({
	client,
	slug,
	debugMode,
	debugShown,
	onDebugModeChange,
	autoExpandThinking,
	onAutoExpandThinkingChange,
	autoConfirmEdits,
	onAutoConfirmEditsChange,
	classicMode,
	onClassicModeChange,
	shellEnabled,
	onShellEnabledChange,
	shellKind,
	shellPath,
	resolvedShell,
	onShellSettingsChange,
	onRerunSetup,
}: {
	client: ApiClient;
	/** 当前打开的书 slug(世界书注入分组随打开书重拉;null = 未打开书)。 */
	slug: string | null;
	/** 调试模式开关状态(工具块退回原始参数与结果;缺省关闭)。 */
	debugMode: boolean;
	/** 界面是否已解锁显示「调试模式」(未解锁则不渲染该项)。 */
	debugShown: boolean;
	/** 调试模式开关变化(仅解锁后可见,见 debugShown)。 */
	onDebugModeChange: (enabled: boolean) => void;
	/** 自动展开思考开关状态(思考块默认展开;缺省开启)。 */
	autoExpandThinking: boolean;
	onAutoExpandThinkingChange: (enabled: boolean) => void;
	/** 编辑免确认开关状态(编剧编辑落盘即归档;缺省关闭,默认走待确认卡)。 */
	autoConfirmEdits: boolean;
	onAutoConfirmEditsChange: (enabled: boolean) => void;
	/** 经典模式(单 agent:只有编辑页,agent 带全量工具;存服务端 settings.json)。 */
	classicMode: boolean;
	/** 切换经典模式(写服务端并释放已建会话;失败抛出由本页展示)。 */
	onClassicModeChange: (enabled: boolean) => Promise<void>;
	/** 外部命令(bash):agent 能否执行 shell 命令(存服务端 settings.json,缺省关闭)。 */
	shellEnabled: boolean;
	/** 开关外部命令(写服务端并重建会话;失败抛出由本页展示)。 */
	onShellEnabledChange: (enabled: boolean) => Promise<void>;
	/** shell 方言(bash / pwsh)。 */
	shellKind: ShellKindDto;
	/** 显式 shell 可执行文件路径;空 = 自动探测。 */
	shellPath: string;
	/** 服务端按当前设置解析出的实际方言/路径(选 pwsh 但没装时 dialect = "none")。 */
	resolvedShell: ResolvedShellDto | null;
	/** 更新方言/路径(写服务端并重建会话;失败抛出由本页展示)。 */
	onShellSettingsChange: (
		patch: { shellKind?: ShellKindDto; shellPath?: string },
		prev: { shellKind: ShellKindDto; shellPath: string },
	) => Promise<void>;
	/** 重新运行首次启动配置向导(App 弹覆盖层;缺省不显示入口)。 */
	onRerunSetup?: () => void;
}) {
	/** 当前分类(左侧导航激活项;默认「模型」;插件分类为 "plugin:<id>")。 */
	const [cat, setCat] = useState<SettingCat | string>("model");
	/** 插件设置分类(声明了 frontend.ui.settingsItems 的插件;左侧导航追加)。 */
	const [pluginCats, setPluginCats] = useState<PluginInfoDto[] | null>(null);
	useEffect(() => {
		let cancelled = false;
		client
			.getPlugins()
			.then((plugins) => {
				if (cancelled) return;
				setPluginCats(plugins.filter((p) => (p.frontend?.ui?.settingsItems?.length ?? 0) > 0));
			})
			.catch(() => {
				if (!cancelled) setPluginCats([]);
			});
		return () => {
			cancelled = true;
		};
	}, [client]);
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
	/** 模型提供商管理弹窗(新增/管理供应商与自定义模型已并入其中)。 */
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
	/** 「编辑主题 CSS」折叠区(设计稿 12:默认收起,展开后才是自定义主题界面)。 */
	const [themeEditorOpen, setThemeEditorOpen] = useState(false);
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

	/**
	 * 切换经典模式:App 侧落盘 + 置位(开关即时响应),服务端写失败会回滚状态,
	 * 这里只负责把错误摆到页面上(服务端切换会释放已建会话,下次对话才生效,
	 * 失败不能静默——用户会以为已经切了)。
	 */
	async function toggleClassicMode(checked: boolean) {
		setActErr(null);
		try {
			await onClassicModeChange(checked);
		} catch (e) {
			setActErr(`切换经典模式失败: ${friendlyError(e)}`);
		}
	}

	/** 外部命令的开启确认条(关:直接生效,无风险;开:先弹确认)。 */
	const [shellConfirm, setShellConfirm] = useState(false);

	function askShellEnable(checked: boolean) {
		setActErr(null);
		if (checked) {
			setShellConfirm(true);
			return;
		}
		void toggleShell(false);
	}

	async function toggleShell(enabled: boolean) {
		setShellConfirm(false);
		setActErr(null);
		try {
			await onShellEnabledChange(enabled);
		} catch (e) {
			setActErr(`切换外部命令失败: ${friendlyError(e)}`);
		}
	}

	/** shell 方言切换中(避免连点;下拉先乐观置位,失败回滚)。 */
	const [shellBusy, setShellBusy] = useState(false);
	/** 路径输入草稿:打字不逐键写服务端,点「保存路径」才提交。 */
	const [shellPathDraft, setShellPathDraft] = useState(shellPath);
	useEffect(() => {
		setShellPathDraft(shellPath);
	}, [shellPath]);

	async function changeShellKind(kind: ShellKindDto) {
		if (kind === shellKind) return;
		setActErr(null);
		setShellBusy(true);
		try {
			await onShellSettingsChange({ shellKind: kind }, { shellKind, shellPath });
		} catch (e) {
			setActErr(`切换 shell 方言失败: ${friendlyError(e)}`);
		} finally {
			setShellBusy(false);
		}
	}

	async function saveShellPath() {
		setActErr(null);
		setShellBusy(true);
		try {
			await onShellSettingsChange({ shellPath: shellPathDraft.trim() }, { shellKind, shellPath });
		} catch (e) {
			setActErr(`保存 shell 路径失败: ${friendlyError(e)}`);
		} finally {
			setShellBusy(false);
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
			// 选中自定义主题时自动展开折叠区,否则用户看不到刚打开的编辑器
			setThemeEditorOpen(true);
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

	/** 下拉用分组选项(Select 的 groups;标签为 "provider · id")。 */
	const modelGroups = useMemo(
		() =>
			groups.map(([provider, list]) => ({
				label: provider,
				options: list.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider} · ${m.id}` })),
			})),
		[groups],
	);

	/** 当前模型 id(去掉 provider 前缀;无值时占位)。 */
	const currentModelId = current ? current.split("/").slice(1).join("/") || current : "未设置";
	const currentProviderId = current ? current.split("/")[0] ?? "" : "";

	/** 编辑器是否打开着「当前正在使用的用户主题」(右侧折叠区标题用)。 */
	const editingIsCurrent = !!editingFile && theme === userIdOf(editingFile);

	/** 插件设置分类 id → 插件(左栏第二组)。 */
	const pluginCatItems = (pluginCats ?? []).map((p) => ({ id: `${pluginCatPrefix}${p.id}`, label: p.name }));

	/** 分类导航按钮(组内复用)。 */
	function catButton(id: string, label: string, Icon: (p: { size?: number }) => ReactElement) {
		return (
			<button
				key={id}
				type="button"
				role="tab"
				aria-selected={cat === id}
				className={cat === id ? "st-cat active" : "st-cat"}
				onClick={() => setCat(id)}
			>
				<Icon size={15} />
				<span>{label}</span>
			</button>
		);
	}

	return (
		<div className="settings">
			{/* 左侧分类导航(约 180;设计稿 11:模型 / 界面 / 世界书 / 集成 / 高级 + 插件组) */}
			<aside className="settings-side">
				<div className="settings-side-title">设置</div>
				<nav className="settings-nav" role="tablist" aria-label="设置分类">
					{SETTING_CATS.map((c) => catButton(c.id, c.label, c.icon))}
				</nav>
				{pluginCatItems.length > 0 && (
					<>
						<div className="settings-nav-sep" />
						<nav className="settings-nav" role="tablist" aria-label="插件设置">
							{pluginCatItems.map((p) => catButton(p.id, p.label, IconGear))}
						</nav>
					</>
				)}
			</aside>
			<main className="settings-main">
				<div className="settings-inner">
					{/* 页头:标题 + 分类说明(设计稿 11-13;保存状态留在顶栏,这里不重复) */}
					<header className="st-head">
						<h1 className="st-head-title">{headOf(cat).title}</h1>
						<p className="st-head-desc">{headOf(cat).desc}</p>
					</header>

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
						<div className="st-cols">
							<div className="st-col-main">
								{/* 模型:当前使用模型 + 切换下拉 + 刷新 */}
								<section className="s-card">
									<div className="st-card-head">
										<span className="s-card-head">模型</span>
										<span className="st-card-meta">
											{current && <span className="st-chip">{currentProviderId}</span>}
										</span>
									</div>
									<div className="s-card-desc">当前使用的模型。切换后对下一次对话生效。</div>
									<div className="st-row">
										<span className="st-row-label">模型</span>
										<div className="st-row-ctl">
											<Select
												className="sel-block"
												value={current ?? ""}
												groups={modelGroups}
												placeholder={models === null ? "加载中…" : "请选择模型"}
												disabled={busy || modelRefreshBusy || models === null}
												ariaLabel="切换模型"
												onChange={(v) => {
													setNotice(null);
													void changeModel(v);
												}}
											/>
											<button
												type="button"
												className="btn-ghost"
												disabled={busy || modelRefreshBusy || models === null}
												onClick={() => void refreshModelList()}
												title="重新联网拉取模型目录"
											>
												{modelRefreshBusy ? "刷新中…" : "刷新"}
											</button>
											{busy && <span className="s-busy">设置中…</span>}
										</div>
									</div>
									<div className="s-card-desc st-desc-tight">
										按供应商分组。{current && <>当前为 <span className="st-mono">{currentModelId}</span>。</>}列表来自本地配置,点「刷新」即可重新拉取。
									</div>
								</section>

								{/* 采样参数:temperature / top_p + 应用 / 恢复默认 */}
								<section className="s-card">
									<div className="s-card-head">采样参数</div>
									<div className="s-card-desc">留空表示沿用模型默认值。</div>
									<div className="s-field-grid">
										<div className="s-field">
											<label className="s-field-label">temperature</label>
											<input
												className="s-input st-input-full"
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
												className="s-input st-input-full"
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
									<div className="st-actions">
										<button type="button" className="wz-primary st-btn-apply" disabled={busy} onClick={() => void changeSampling()}>
											{busy ? "设置中…" : "应用"}
										</button>
										<button type="button" className="btn-ghost" disabled={busy} onClick={() => void resetTemperature()}>
											{busy ? "处理中…" : "恢复默认采样参数"}
										</button>
									</div>
									<div className="s-card-desc st-desc-tight">
										「恢复默认采样参数」会清除全局与所有演员的 temperature 覆盖,所有 agent 恢复 provider 默认;top_p 不受影响。
									</div>
								</section>
							</div>

							<aside className="st-col-side">
								{/* 思考级别 */}
								<section className="s-card">
									<div className="s-card-head">思考级别</div>
									<div className="st-row st-row-stack">
										<span className="st-row-label">强度</span>
										<Select
											className="sel-block"
											value={thinking ?? ""}
											options={THINKING_LEVELS.map((l) => ({ value: l, label: l }))}
											placeholder={thinking === null ? "未设置" : "请选择"}
											disabled={busy}
											ariaLabel="思考强度"
											onChange={(v) => {
												setNotice(null);
												void changeThinking(v);
											}}
										/>
									</div>
									<div className="s-card-desc st-desc-tight">
										off = 关闭思考；max = 最强思考深度。{busy && " 设置中…"}
									</div>
								</section>

								{/* 模型供应商入口 */}
								<section className="s-card">
									<div className="s-card-head">模型供应商</div>
									<div className="s-card-desc">管理供应商与 API key。添加 key 后,其模型自动出现在上方的模型列表里。</div>
									<div className="st-actions">
										<button type="button" className="btn-ghost" onClick={() => setProvidersOpen(true)}>
											管理供应商
										</button>
									</div>
								</section>
							</aside>
						</div>
					)}

					{cat === "ui" && (
						<div className="st-cols">
							<div className="st-col-main">
								{/* 主题(浅深合并的 5 张卡) */}
								<section className="s-card">
									<div className="st-card-head">
										<span className="s-card-head">主题</span>
										<span className="st-card-meta st-meta-dim">深浅已合并 · 点已选中的卡可切换</span>
									</div>
									<ThemeCardsFromManifest
										builtin={builtinThemes}
										user={userThemes}
										current={theme}
										onPick={(id) => selectTheme(id)}
									/>
								</section>

								{/* 界面偏好(只留外观与日常偏好) */}
								<section className="s-card">
									<div className="s-card-head">界面偏好</div>
									<div className="s-pref-list">
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">自动展开思考</div>
												<div className="s-pref-desc">思考块默认展开,无需逐条点击。</div>
											</div>
											<ToggleSwitch checked={autoExpandThinking} onChange={onAutoExpandThinkingChange} ariaLabel="自动展开思考" />
										</div>
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">编辑免确认</div>
												<div className="s-pref-desc">
													{classicMode ? "AI 的修改落盘即生效,不再弹「待确认」卡。" : "编剧的修改落盘即生效,不再弹「待确认」卡。"}
												</div>
											</div>
											<ToggleSwitch checked={autoConfirmEdits} onChange={onAutoConfirmEditsChange} ariaLabel="编辑免确认" />
										</div>
									</div>
								</section>
							</div>

							<aside className="st-col-side">
								{/* 自定义主题:代码编辑器下沉成折叠区(默认收起) */}
								<section className="s-card">
									<div className="s-card-head">自定义主题</div>
									<div className="s-card-desc">
										主题就是一份 CSS 文件。放进 ~/pi/writer/themes/ 会自动出现在左边的列表里;文件名以 <span className="st-mono">-dark</span> 结尾会自动和同名浅色主题配成一对。
									</div>
									<button
										type="button"
										className="st-collapse-head"
										aria-expanded={themeEditorOpen}
										onClick={() => setThemeEditorOpen((v) => !v)}
									>
										<span className={`s-collapsible-arrow${themeEditorOpen ? " open" : ""}`}>▶</span>
										<span className="st-collapse-label">
											{themeEditorOpen && editingFile ? `编辑主题 CSS · ${editingFile}` : "编辑主题 CSS"}
										</span>
										<span className="st-chip st-chip-dim">开发者</span>
									</button>
									{themeEditorOpen ? (
										<div className="st-collapse-body">
											<div className="s-field-row">
												<input
													className="s-input"
													placeholder="主题名(如 moon,仅字母数字._-)"
													value={newThemeName}
													onChange={(e) => setNewThemeName(e.target.value)}
												/>
												<button
													type="button"
													className="btn-ghost"
													disabled={themeBusy || !newThemeName.trim()}
													onClick={() => void createTheme()}
												>
													新建
												</button>
											</div>
											{userThemes.length > 0 && (
												<div className="st-field-block">
													<Select
														className="sel-block"
														value={editingFile ?? ""}
														options={userThemes.map((ut) => ({ value: ut.file, label: ut.file.replace(/\.css$/, "") }))}
														placeholder="编辑已有主题…"
														ariaLabel="编辑已有主题"
														onChange={(f) => {
															if (f) selectTheme(userIdOf(f));
															else setEditingFile(null);
														}}
													/>
												</div>
											)}
											{themeErr && <div className="notice err">{themeErr}</div>}
											{editingFile ? (
												<>
													<div className="st-edit-head">
														<span className="st-mono st-edit-file">编辑 {editingFile}</span>
														<span className="s-val muted">{editingIsCurrent ? "保存后生效" : "未在使用"}</span>
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
														<button type="button" className="btn-ghost danger" disabled={themeBusy} onClick={() => void deleteTheme()}>
															删除
														</button>
													</div>
												</>
											) : (
												<div className="s-card-desc st-desc-tight">展开后可新建 / 编辑 / 删除自定义主题文件。</div>
											)}
										</div>
									) : (
										<div className="s-card-desc st-desc-tight">展开后可新建 / 编辑 / 删除自定义主题文件。</div>
									)}
								</section>
							</aside>
						</div>
					)}

					{cat === "advanced" && (
						<div className="st-cols">
							<div className="st-col-main">
								{/* 调试模式:平时**不渲染**(debugShown 由控制台解锁决定,见 settings.ts)。
								    它不是显示偏好,是排障开关——把每个工具块退回原始工具名 + 完整参数 +
								    完整结果,好看清模型到底怎么调的、错在哪一步。 */}
								{debugShown && (
									<section className="s-card">
										<div className="st-card-head">
											<span className="s-card-head">调试模式</span>
										</div>
										<div className="s-card-desc">
											每个工具调用退回完整卡:原始工具名 + 完整参数 + 完整结果,不再压缩成动作行。排查「模型到底怎么调的工具、错在哪一步」时用。
										</div>
										<div className="s-pref-list">
											<div className="s-pref-item">
												<div className="s-pref-text">
													<div className="s-pref-title">启用调试模式</div>
													<div className="s-pref-desc">
														默认关闭。在控制台运行 <code>piWriterDebugOff()</code> 可关闭并重新隐藏这一项。
													</div>
												</div>
												<ToggleSwitch checked={debugMode} onChange={onDebugModeChange} ariaLabel="调试模式" />
											</div>
										</div>
									</section>
								)}
								{/* 执行命令(shell):高风险胶囊 + 红色警示块 + 关闭时次级态 */}
								<section className="s-card">
									<div className="st-card-head">
										<span className="s-card-head">执行命令(shell)</span>
										<span className="st-chip st-chip-danger">⚠ 高风险</span>
									</div>
									<div className="s-card-desc">给 AI 放开本机 shell,适合让它调 pandoc、git 这类工具。</div>
									<div className="st-warn">
										⚠ 命令以与 pi-writer 相同的权限在真实 shell 里运行:可以读写整盘磁盘、访问网络,书目录的路径限制对它无效。它只能被「看得见」约束——每条命令与输出都会实时显示在对话里。
									</div>
									<div className={`s-pref-list st-shell-body${shellEnabled ? "" : " st-shell-off"}`}>
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">启用外部命令</div>
												<div className="s-pref-desc">默认关闭。开启后命令与输出会实时显示在对话里(调试模式下也可见)。</div>
											</div>
											<ToggleSwitch checked={shellEnabled} onChange={askShellEnable} ariaLabel="外部命令" />
										</div>
										{shellConfirm && (
											<div className="s-plugin-trust-confirm">
												<div className="s-plugin-trust-warn">
													开启后,命令以与 pi-writer 相同的权限在真实 shell 里运行:可以读写整台磁盘、访问网络,书目录的路径限制对它无效。它只能被「看得见」约束——每条命令与输出都会实时显示在对话里。确认开启吗?
												</div>
												<div className="st-actions">
													<button type="button" className="btn-ghost danger" onClick={() => void toggleShell(true)}>
														确认启用
													</button>
													<button type="button" className="btn-ghost" onClick={() => setShellConfirm(false)}>
														取消
													</button>
												</div>
											</div>
										)}
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">Shell 方言</div>
												<div className="s-pref-desc">
													决定 AI 实际执行哪种 shell 语法,系统提示词会照实说明。**自动** = 按平台识别:Windows 上优先 PowerShell(7 → 5.1),其余平台用 bash。选了 bash 但 Windows 上没装 Git Bash 会报错;想固定方言就显式选。
												</div>
											</div>
											<Select
												className="sel-row"
												value={shellKind}
												options={SHELL_KIND_OPTIONS}
												disabled={shellBusy || !shellEnabled}
												ariaLabel="Shell 方言"
												onChange={(v) => void changeShellKind(v as ShellKindDto)}
											/>
										</div>
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">Shell 可执行文件路径</div>
												<div className="s-pref-desc">
													留空则自动探测。也可指定 Cygwin / MSYS2 的 bash.exe(Windows 上 bash 依次找 Git Bash → PATH → /bin/bash)。
												</div>
											</div>
											<div className="st-path-ctl">
												<input
													className="s-input"
													placeholder="留空 = 自动探测"
													value={shellPathDraft}
													disabled={shellBusy || !shellEnabled}
													onChange={(e) => setShellPathDraft(e.target.value)}
												/>
												<button
													type="button"
													className="btn-ghost"
													disabled={shellBusy || !shellEnabled || shellPathDraft.trim() === shellPath}
													onClick={() => void saveShellPath()}
												>
													{shellBusy ? "保存中…" : "保存"}
												</button>
											</div>
										</div>
									</div>
									{/* 开启时显示实际方言;**关着但有 warning 也要显示** ——
									    「自动」在 Windows 上没探到 PowerShell、或选了 pwsh 但本机没装,
									    正是要在启用之前就看到的那条信息 */}
									{(shellEnabled || resolvedShell?.warning !== undefined) && resolvedShell && (
										<div className="s-card-desc st-desc-tight">
											实际使用:{SHELL_DIALECT_TEXT[resolvedShell.dialect]}
											{resolvedShell.path ? `(${resolvedShell.path})` : ""}
											{resolvedShell.warning ? ` — ${resolvedShell.warning}` : ""}
											{resolvedShell.dialect === "none" ? ";此时不会给 AI 放开 shell 工具" : ""}
										</div>
									)}
								</section>

								{/* Agent 形态:经典模式(单 Agent) */}
								<section className="s-card">
									<div className="s-card-head">Agent 形态</div>
									<div className="s-pref-list">
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">经典模式(单 Agent)</div>
												<div className="s-pref-desc">
													开启后去掉舞台(没有导演 / 演员 / 旁白),编辑页换成带全量工具的单一写作 agent。切换会重建服务端会话,下一次对话生效。
												</div>
											</div>
											<ToggleSwitch checked={classicMode} onChange={(v) => void toggleClassicMode(v)} ariaLabel="经典模式" />
										</div>
									</div>
								</section>
							</div>

							<aside className="st-col-side">
								{onRerunSetup && (
									<section className="s-card">
										<div className="s-card-head">配置向导</div>
										<div className="st-actions">
											<button type="button" className="btn-ghost" onClick={onRerunSetup}>
												重新运行配置向导
											</button>
										</div>
										<div className="s-card-desc st-desc-tight">重新走一遍模型服务 / 默认模型 / 第一本书 / 界面偏好。</div>
									</section>
								)}

								<section className="s-card">
									<div className="s-card-head">依赖</div>
									<div className="s-card-desc">「执行命令」需要本机已装好的 shell;「插件」与「MCP」在「集成」分类里。</div>
								</section>
							</aside>
						</div>
					)}

					{cat === "world" && (
						<div className="st-cols">
							<div className="st-col-main">
								<section className="s-card">
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
								</section>
							</div>
							<aside className="st-col-side" />
						</div>
					)}

					{cat === "integrations" && (
						<div className="st-cols">
							<div className="st-col-main">
								<section className="s-card">
									<div className="s-card-head">MCP 服务器</div>
									<div className="s-card-desc">
										为 AI 接入外部工具(如文件系统、资料库、计算器)。配置存 ~/.pi/writer/agent/mcp.json。
									</div>
									<McpServerList client={client} />
								</section>
								<section className="s-card">
									<div className="s-card-head">插件</div>
									<div className="s-card-desc">
										扩展写作能力(工具/事件/命令)。插件目录 ~/.pi/writer/plugins/&lt;id&gt;,内含 plugin.json 与入口 index.mjs;切换启用后会话重建生效。
									</div>
									<PluginList client={client} />
								</section>
							</div>
							<aside className="st-col-side" />
						</div>
					)}

					{/* 插件设置分类:声明了设置菜单的插件各占一个分类(左侧导航 plugin:<id>) */}
					{cat.startsWith(pluginCatPrefix) &&
						(() => {
							const plugin = (pluginCats ?? []).find((p) => `${pluginCatPrefix}${p.id}` === cat);
							if (!plugin) {
								return (
									<div className="s-card">
										<div className="s-empty-row">
											<span className="s-val muted">插件不存在或已删除。</span>
										</div>
									</div>
								);
							}
							return (
								<div className="s-card" data-plugin-mount={plugin.id}>
									<div className="s-card-head">{plugin.name}</div>
									{plugin.description && <div className="s-card-desc">{plugin.description}</div>}
									<PluginSettings client={client} plugin={plugin} />
								</div>
							);
						})()}
				</div>
			</main>
			{/* 模型提供商管理弹窗:双栏卡片悬浮层(关闭即卸载,列表状态在下一次打开时重建) */}
			{providersOpen && (
				<div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="模型提供商">
					<div className="dlg-panel pvd-panel">
						<header className="pvd-head">
							<div className="pvd-head-text">
								<span className="pvd-title">模型提供商</span>
								<span className="pvd-sub">配置 API key 后,其模型会出现在设置页的模型列表里。</span>
							</div>
							<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setProvidersOpen(false)}>
								<IconX size={16} />
							</button>
						</header>
						<div className="pvd-body">
							<ProviderList client={client} onAuthChanged={handleAuthChanged} />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 分类页面头(插件分类用插件名占位,由内容区首行标题补足)。 */
function headOf(cat: string): { title: string; desc: string } {
	return CAT_HEAD[cat] ?? { title: "插件设置", desc: "该插件声明的设置项。" };
}
