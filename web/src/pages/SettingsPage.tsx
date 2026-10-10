import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ApiError, type ApiClient } from "../api/client.ts";
import { formatProviderRefreshErrors, friendlyError } from "../errors.ts";
import { IMAGE_SIZE_PX_TEXT, type BuiltinPromptsDto, type ConversationScopeDto, type ThinkingHostResult, type ImageProviderDto, type ImageSizeDto, type PluginInfoDto, type ResolvedShellDto, type ShellDialectDto, type ShellKindDto, type UserThemeInfo, type WorldDataDto, type WriterSettingsDto } from "../types.ts";
import type { EnterBehavior } from "../settings.ts";
import { buildThemeFamilies, NIGHT_THEME, themeFamilyPick, themeLabelFromCss, themeStarterCss, USER_THEME_PREFIX, userThemeFile, type ThemeId } from "../themes.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { ProviderList } from "../components/ProviderList.tsx";
import { CreationModeCards } from "../components/CreationModeCards.tsx";
import { ConversationScopeCards } from "../components/ConversationScopeCards.tsx";
import { SHELL_CONFIRM_TEXT } from "../components/ShellCards.tsx";
import { McpServerList } from "../components/McpServerList.tsx";
import { PluginList } from "../components/PluginList.tsx";
import { PluginSettings } from "../components/PluginSettings.tsx";
import { PromptModal, type PromptModalMode } from "../components/PromptModal.tsx";
import { ToggleSwitch } from "../components/ToggleSwitch.tsx";
import { Select } from "../components/Select.tsx";
import { ThemeCardsFromManifest } from "../components/ThemeCards.tsx";
import { IconBook, IconDoc, IconGear, IconGlobe, IconStage, IconX } from "../components/Icons.tsx";
import { Lu, type LucideName } from "../components/Lu.tsx";
import { MobileHeader } from "../components/MobileHeader.tsx";
import { useIsPhone } from "../useMediaQuery.ts";
import { useExitPresence } from "../use-exit-presence.ts";
import { DUR } from "../motion.ts";

/** 思考级别选项(与后端 session-host 的 ThinkingLevel 对齐)。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 思考级别显示名(索引页「思考级别」行的值;下拉里仍用原值,模型侧认的就是它)。 */
const THINKING_LABELS: Record<string, string> = {
	off: "关闭",
	minimal: "最少",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最高",
};

/** vendor 模型元素的最小形状(id/provider 必填,其余字段忽略)。 */
interface ModelInfo {
	id: string;
	provider: string;
}

/** 设置侧栏分类图标。 */
const LuSliders = ({ size = 15 }: { size?: number }) => <Lu icon="sliders-horizontal" size={size} />;
const LuLayout = ({ size = 15 }: { size?: number }) => <Lu icon="layout-dashboard" size={size} />;
const LuBookOpen = ({ size = 15 }: { size?: number }) => <Lu icon="book-open" size={size} />;
const LuPuzzle = ({ size = 15 }: { size?: number }) => <Lu icon="puzzle" size={size} />;
const LuWrench = ({ size = 15 }: { size?: number }) => <Lu icon="wrench" size={size} />;
const LuWand = ({ size = 15 }: { size?: number }) => <Lu icon="wand-sparkles" size={size} />;

/**
 * 设置分类(左侧导航):模型 / 界面 / 世界书 / 集成 / 实验 / 高级。
 *  v1 把「危险设置」(外部命令 / Shell)从「界面」移出,单独成组;
 * 0.1.0 又在「集成」之后加了「实验」——图片生成这类尚未稳定的能力(2026-09-22,
 * 分类紧跟在「集成」下面)。
 */
const SETTING_CATS = [
	{ id: "model", label: "模型", icon: LuSliders },
	{ id: "ui", label: "界面", icon: LuLayout },
	{ id: "world", label: "世界书", icon: LuBookOpen },
	{ id: "integrations", label: "集成", icon: LuPuzzle },
	{ id: "experimental", label: "实验", icon: LuWand },
	{ id: "advanced", label: "高级", icon: LuWrench },
] as const;
type SettingCat = (typeof SETTING_CATS)[number]["id"];
/** 插件动态分类 id(plugin:<id>);类型上并入 SettingCat 判断分支。 */
const pluginCatPrefix = "plugin:";

/** 各分类页面头。 */
const CAT_HEAD: Record<string, { title: string; desc: string }> = {
	model: { title: "模型", desc: "选择写作与演出使用的模型与思考强度。修改都即时生效,无需保存。" },
	ui: { title: "界面", desc: "主题与日常偏好。会改变 AI 在你机器上行为的选项,已移到「高级」。" },
	world: { title: "世界书", desc: "决定 AI 每次对话时自动带上哪些世界书内容。" },
	integrations: { title: "集成", desc: "为 AI 接入外部工具与扩展写作能力。" },
	experimental: {
		title: "实验",
		desc: "尚未稳定的能力。开启前请理解它会改变 AI 的行为，并可能产生第三方费用。",
	},
	advanced: { title: "高级", desc: "会改变 AI 在你机器上行为的选项。这类设置的影响范围超出 pi-writer 自己,请在开启前读完说明。" },
};

/**
 * 手机端「一屏一件事」的页面表:索引行 → 桌面分类 + 这一页只显示的卡片 + 页头标题。
 *
 * 手机端不把桌面的「分类」当页面用:桌面一个分类里有四五张卡(模型 / 思考 /
 * 供应商),手机点一行进去看到一整张桌面页;而且桌面「标签 | 控件」的行在 393px 里
 * 会把标签挤成一列字。这里改成一行 = 一页 = 一张卡(`cards` 里可以有多张,比如
 * 「图片生成」带上「允许 AI 调用的时机」)。卡片 key 对应各 section 的 cardClass()。
 */
const PHONE_PAGES: Record<string, { cat: string; cards: string[]; title: string }> = {
	"theme-css": { cat: "ui", cards: ["theme-css"], title: "自定义主题" },
	model: { cat: "model", cards: ["model"], title: "默认模型" },
	thinking: { cat: "model", cards: ["thinking"], title: "思考级别" },
	world: { cat: "world", cards: ["world", "budget"], title: "世界书注入" },
	budget: { cat: "world", cards: ["budget"], title: "上下文预算" },
	image: { cat: "experimental", cards: ["image", "image-when"], title: "图片生成" },
	shell: { cat: "advanced", cards: ["shell"], title: "执行命令" },
	agent: { cat: "advanced", cards: ["agent"], title: "Agent 形态" },
	conversation: { cat: "advanced", cards: ["conversation"], title: "对话与章节" },
	prompts: { cat: "advanced", cards: ["prompts"], title: "系统提示词" },
	deps: { cat: "advanced", cards: ["deps", "wizard"], title: "依赖与配置向导" },
	mcp: { cat: "integrations", cards: ["mcp"], title: "MCP 服务器" },
	plugins: { cat: "integrations", cards: ["plugins"], title: "插件" },
};

/** 解析手机端子页 id:插件分类(`plugin:<id>`)动态取插件名,其余查 PHONE_PAGES。 */
function resolvePhonePage(id: string, plugins: PluginInfoDto[] | null): { cat: string; cards: string[]; title: string } | null {
	const hit = PHONE_PAGES[id];
	if (hit) return hit;
	if (id.startsWith(pluginCatPrefix)) {
		const p = (plugins ?? []).find((x) => `${pluginCatPrefix}${x.id}` === id);
		return { cat: id, cards: ["plugin"], title: p?.name ?? "插件设置" };
	}
	return null;
}

/**
 * 图片生成(实验)设置子集。用 Pick 从完整设置里取,
 * 避免两处各写一份字段清单 —— 服务端加字段时这边会跟着报类型错。
 */
export type ImageSettingsSlice = Pick<
	WriterSettingsDto,
	| "enableImageGen"
	| "imageProvider"
	| "imageModel"
	| "imageSize"
	| "imageBaseUrl"
	| "imageApiKey"
	| "imageInReply"
	| "imageWorldbook"
	| "imageConfirmBeforeGen"
>;

/**
 * 自定义系统提示词的设置子集(2026-10-10)。与服务端 settings.json 同源;
 * 空串 = 用内置 prompts/ 那份(不是「清空提示词」)。
 */
export type CustomPromptsSlice = Pick<WriterSettingsDto, "customWriterPrompt" | "customEditorPrompt">;

/**
 * 上下文预算的设置子集(2026-10-10 接上写路径)。五项数值都是"裁剪上限",
 * 决定每轮注入给 AI 的背景包能装多少 —— 详见 BUDGET_FIELDS 的逐项说明。
 * 用 Pick 从完整设置里取,服务端加字段时这里会跟着报类型错。
 */
export type BudgetSettingsSlice = Pick<
	WriterSettingsDto,
	"contextBudget" | "memoryBudget" | "activationDepth" | "noticeInjectLimit" | "completedMilestoneLimit"
>;

/**
 * 五项预算的默认值(原 src/world-context.ts 的硬编码常量)。「全部还原默认」用,
 * 也用于卡片上标注「默认 X」。与 src/writer-settings.ts 的 defaultWriterSettings
 * **必须一致** —— 前端不 import src/,故此处单列一份。
 */
const BUDGET_DEFAULTS: Record<keyof BudgetSettingsSlice, number> = {
	contextBudget: 2000,
	memoryBudget: 1500,
	activationDepth: 0,
	noticeInjectLimit: 10,
	completedMilestoneLimit: 6,
};

/**
 * 五项预算的可调元数据 —— 字段名 / 标签 / 说明 / 范围 / 默认值。
 *
 * 集中成一张表而不是散在 JSX 里各写一遍:五项的结构完全相同(数字输入),
 * 只差文案与范围;而且服务端 `budgetItems()`(src/inspect/report.ts)已经有一份
 * 「字段 → 范围/作用」的表,这里的 range 与它**同一口径**(改一处记得改另一处)。
 *
 * `min`/`max` 只是前端输入框的软限制(`<input type="number">`),真正的钳制在
 * 服务端(parseWriterSettings / updateWriterSettings 同参),两者越界口径一致。
 */
const BUDGET_FIELDS: ReadonlyArray<{
	key: keyof BudgetSettingsSlice;
	label: string;
	unit: string;
	min: number;
	max: number;
	step: number;
	effect: string;
}> = [
	{
		key: "contextBudget",
		label: "背景包总量",
		unit: "token",
		min: 200,
		max: 20000,
		step: 100,
		effect: "每次对话注入的历史与设定文本的总上限。超出就按下面的顺序裁:先丢世界观概述,再按优先级挤掉世界书条目。",
	},
	{
		key: "memoryBudget",
		label: "跨章节记忆",
		unit: "token",
		min: 100,
		max: 20000,
		step: 100,
		effect: "memory.md(上一章留下的要点)注入前的裁剪上限。写长篇、需要长期记忆时调大。",
	},
	{
		key: "activationDepth",
		label: "关联激活深度",
		unit: "层",
		min: 0,
		max: 5,
		step: 1,
		effect: "0 = 只带出正文里被关键词命中的设定;调高后,与命中设定「有关系」的邻居也会一并带出,最远 N 层。",
	},
	{
		key: "noticeInjectLimit",
		label: "Notice 注入条数",
		unit: "条",
		min: 0,
		max: 50,
		step: 1,
		effect: "备忘录里最多带几条未完成事项给 AI。设 0 = 不带。",
	},
	{
		key: "completedMilestoneLimit",
		label: "已完成里程碑条数",
		unit: "条",
		min: 0,
		max: 30,
		step: 1,
		effect: "发展线里最多带几条「已完成」目标进去(用于提醒 AI 别再推进)。设 0 = 不带。",
	},
];

/** 出图尺寸档位选项(像素文案来自 IMAGE_SIZE_PX_TEXT,与服务端 IMAGE_SIZE_PX 对齐)。 */
const IMAGE_SIZE_OPTIONS: ReadonlyArray<ImageSizeDto> = ["1:1", "3:2", "16:9"];
/** 图片接口形态选项(目前只有一种)。 */
const IMAGE_PROVIDER_OPTIONS: ReadonlyArray<{ value: ImageProviderDto; label: string }> = [
	{ value: "openai-images", label: "OpenAI Images · 兼容" },
];

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

/** shell 方言下拉项。 */
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
	enterBehavior,
	onAutoExpandThinkingChange,
	onEnterBehaviorChange,
	autoConfirmEdits,
	onAutoConfirmEditsChange,
	classicMode,
	onClassicModeChange,
	conversationScope,
	onConversationScopeChange,
	shellEnabled,
	onShellEnabledChange,
	shellKind,
	shellPath,
	resolvedShell,
	onShellSettingsChange,
	onRerunSetup,
	image,
	onImageChange,
	customPrompts,
	onCustomPromptsChange,
	budget,
	onBudgetChange,
	focusModelToken,
	nav,
	appVersion,
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
	/** 回车行为(send = 回车即发送 / newline = 回车换行)。 */
	enterBehavior: EnterBehavior;
	/** 自动展开思考开关状态(思考块默认展开;缺省开启)。 */
	autoExpandThinking: boolean;
	onAutoExpandThinkingChange: (enabled: boolean) => void;
	/** 回车行为变化(设置页开关)。 */
	onEnterBehaviorChange: (v: EnterBehavior) => void;
	/** 编辑免确认开关状态(编剧编辑落盘即归档;缺省关闭,默认走待确认卡)。 */
	autoConfirmEdits: boolean;
	onAutoConfirmEditsChange: (enabled: boolean) => void;
	/** 经典模式(单 agent:只有编辑页,agent 带全量工具;存服务端 settings.json)。 */
	classicMode: boolean;
	/** 切换经典模式(写服务端并释放已建会话;失败抛出由本页展示)。 */
	onClassicModeChange: (enabled: boolean) => Promise<void>;
	/** 对话与章节的关系(chapter = 一节一段对话;book = 各聊各的,AI 可编辑任意章节)。 */
	conversationScope: ConversationScopeDto;
	/** 切换对话与章节的关系(写服务端并释放已建会话;失败抛出由本页展示)。 */
	onConversationScopeChange: (scope: ConversationScopeDto) => Promise<void>;
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
	/** 图片生成(实验)的设置子集(存服务端 settings.json)。 */
	image: ImageSettingsSlice;
	/** 更新图片生成设置(写服务端并释放会话;失败抛出由本页展示)。 */
	onImageChange: (patch: Partial<ImageSettingsSlice>) => Promise<void>;
	/** 自定义系统提示词(2026-10-10):整段替换内置提示词;空 = 用内置。 */
	customPrompts: CustomPromptsSlice;
	/** 更新自定义系统提示词(写服务端并释放会话;失败抛出由本页展示)。 */
	onCustomPromptsChange: (patch: Partial<CustomPromptsSlice>) => Promise<void>;
	/** 上下文预算(2026-10-10):背景包/记忆装配时的裁剪上限,存服务端 settings.json。 */
	budget: BudgetSettingsSlice;
	/** 更新上下文预算(写服务端,下次注入即生效;失败抛出由本页展示)。 */
	onBudgetChange: (patch: Partial<BudgetSettingsSlice>) => Promise<void>;
	/**
	 * 「切到模型分类」的信号(自增计数,值变化即生效)。
	 *
	 * 存在的理由:设置页在 App 里**常驻挂载**(切页只改 hidden,见 App 的说明),
	 * 所以「去设置模型 ›」这类跨页入口没法靠卸载重挂载回到默认分类 —— 用户上次
	 * 停在「界面」,点报错卡的链接进来会落在「界面」,那句话就成了谎。
	 * 用自增计数而不是 `cat` 字符串:同一个目标连点两次也必须生效(dep 变化)。
	 */
	focusModelToken?: number;
	/** 手机端页头导航(App 提供):设置页「←」回到编辑页。 */
	nav?: { view: string; onNavigate: (view: string) => void };
	/** 应用版本(页脚「pi·writer vX · 数据仅保存在本机」;拿不到就不显示版本段)。 */
	appVersion?: string | null;
}) {
	/** 当前分类(左侧导航激活项;默认「模型」;插件分类为 "plugin:<id>")。 */
	const [cat, setCat] = useState<SettingCat | string>("model");
	/** 手机端(≤700px):桌面分类栏与页头由手机端布局接管。 */
	const isPhone = useIsPhone();
	/**
	 * 手机端当前分类:null = 索引页,非空 = 进了某个分类。
	 * 桌面端不用它(左栏常驻,切分类不换页)。
	 */
	const [phoneCat, setPhoneCat] = useState<string | null>(null);
	/** 「切到模型分类」信号(见 props.focusModelToken):值一变就切过去。 */
	/** 「切到模型分类」见没见过的令牌:首帧的同值不算「跳过来」(初值也有定义)。 */
	const focusTokenSeenRef = useRef(focusModelToken);
	useEffect(() => {
		if (focusModelToken === undefined) return;
		if (focusTokenSeenRef.current === focusModelToken) return;
		focusTokenSeenRef.current = focusModelToken;
		setCat("model");
		// 手机端索引页也要跟着进分类 —— 报错卡的「去设置模型 ›」跳过来,
		// 停在索引等于要多点一次,而这句文案承诺的就是「直接到模型设置」
		setPhoneCat("model");
	}, [focusModelToken]);
	/** 插件设置分类(声明了 frontend.ui.settingsItems 的插件;左侧导航追加)。 */
	const [pluginCats, setPluginCats] = useState<PluginInfoDto[] | null>(null);
	/** 插件集变更代数:PluginList 里启停/信任/删除后 +1,触发下面重拉左栏分类。
	 *  2026-09-23 修:此前只在挂载时拉一次,而 SettingsPage 是四页常驻挂载 ——
	 *  在「集成」里启用带设置项的插件后,左栏不会出现对应分类(删除后也不会消失,
	 *  停在已删插件的分类上会一直显示「插件不存在或已删除」),要刷新页面才恢复。 */
	const [pluginCatToken, setPluginCatToken] = useState(0);
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
	}, [client, pluginCatToken]);
	/** null = 加载中;[] = 已加载但为空(或加载失败)。 */
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [current, setCurrent] = useState<string | null>(null);
	const [thinking, setThinking] = useState<string | null>(null);
	/**
	 * 当前模型**实际支持**的思考档位(BUG-012):null = 服务端拿不到,退回全量展示。
	 * 用它过滤下拉选项,不让用户点到「点了也会被回落」的档位。
	 */
	const [thinkingLevels, setThinkingLevels] = useState<string[] | null>(null);
	/** 最近一次「设置思考档位」的**宿主级**结果(BUG-013);null = 还没设置过 */
	const [thinkingHosts, setThinkingHosts] = useState<ThinkingHostResult[] | null>(null);
	/** 上一次请求的思考档位被模型能力回落到别的档位(非 null = 要解释一句)。 */
	const [thinkingClamped, setThinkingClamped] = useState<string | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [actErr, setActErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
	/** 模型提供商管理弹窗(新增/管理供应商与自定义模型已并入其中)。 */
	const [providersOpen, setProvidersOpen] = useState(false);
	/** 供应商整屏层/弹窗的退场:关掉后仍挂 200ms,让遮罩淡出 + 面板缩回(见 presence.css)。 */
	const providersPresence = useExitPresence(providersOpen);
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
	/** 「编辑主题 CSS」折叠区。 */
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

	/** 拉取模型列表/当前模型/思考等级并归一;返回解析结果供调用方直接使用。 */
	const load = useCallback(async (): Promise<{
		models: ModelInfo[];
		current: string | null;
		thinking: string | null;
	}> => {
		const r = await client.getModels();
		const models = extractModels(r.models);
		const current = modelRef(r.current);
		const thinking = typeof r.thinking === "string" ? r.thinking : null;
		setModels(models);
		setCurrent(current);
		setThinking(thinking);
		setThinkingLevels(Array.isArray(r.thinkingLevels) && r.thinkingLevels.length > 0 ? r.thinkingLevels : null);
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
	 * 失败不能静默——用户会以为已经切了)。busy 期间两张大卡禁用,避免连点。
	 */
	const [classicBusy, setClassicBusy] = useState(false);
	async function toggleClassicMode(checked: boolean) {
		if (classicBusy) return;
		setActErr(null);
		setClassicBusy(true);
		try {
			await onClassicModeChange(checked);
		} catch (e) {
			setActErr(`切换创作方式失败: ${friendlyError(e)}`);
		} finally {
			setClassicBusy(false);
		}
	}

	/**
	 * 切换「对话与章节」的关系:与创作方式同款 —— App 侧落盘 + 置位,服务端写失败
	 * 回滚状态,这里只负责把错误摆到页面上(切换会释放已建编剧会话,下次对话才生效)。
	 */
	const [scopeBusy, setScopeBusy] = useState(false);
	async function toggleConversationScope(scope: ConversationScopeDto) {
		if (scopeBusy) return;
		setActErr(null);
		setScopeBusy(true);
		try {
			await onConversationScopeChange(scope);
		} catch (e) {
			setActErr(`切换对话与章节失败: ${friendlyError(e)}`);
		} finally {
			setScopeBusy(false);
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

	// —— 图片生成——
	/** 图片设置提交中(避免连点)。 */
	const [imageBusy, setImageBusy] = useState(false);
	/**
	 * 三个文本字段的草稿。**不能逐键提交**:每次提交都会写 settings.json 并释放已建
	 * 会话(工具集要重装配),逐键提交等于把会话拆了重建几十次。失焦 / 点按钮才提交。
	 */
	const [imageDraft, setImageDraft] = useState({ model: image.imageModel, baseUrl: image.imageBaseUrl, key: image.imageApiKey });
	useEffect(() => {
		setImageDraft({ model: image.imageModel, baseUrl: image.imageBaseUrl, key: image.imageApiKey });
	}, [image.imageModel, image.imageBaseUrl, image.imageApiKey]);

	/** 提交图片生成设置(失败走操作错误条;成功由 App 侧更新 settings)。 */
	async function applyImage(patch: Partial<ImageSettingsSlice>) {
		setActErr(null);
		setImageBusy(true);
		try {
			await onImageChange(patch);
		} catch (e) {
			setActErr(`图片生成设置未保存: ${friendlyError(e)}`);
		} finally {
			setImageBusy(false);
		}
	}

	// —— 系统提示词(2026-10-10)——
	/**
	 * 提示词提交中(避免连点)。整份提示词数百行,每次保存都会写 settings.json
	 * 并释放已建会话 —— 所以编辑一律进弹层、按「保存」才提交,不做逐键自动保存。
	 */
	const [customBusy, setCustomBusy] = useState(false);
	/** 保存某一份提示词(空串 = 还原内置);失败走操作错误条,成功由 App 侧更新 settings。 */
	async function saveCustomPrompt(key: keyof CustomPromptsSlice, value: string) {
		setActErr(null);
		setCustomBusy(true);
		try {
			await onCustomPromptsChange({ [key]: value });
			// 写成功才关弹层:失败时窗口留着,用户改的文字还在,不至于白写
			setPromptModal((m) => (m ? { ...m, open: false } : m));
		} catch (e) {
			setActErr(`系统提示词未保存: ${friendlyError(e)}`);
		} finally {
			setCustomBusy(false);
		}
	}

	/**
	 * 内置提示词原文(GET /api/prompt-defaults)。null = 还没拉到。
	 * 进「高级」分类时按需拉一次并缓存 —— 不做全局常驻请求:绝大多数会话不会碰提示词。
	 */
	const [builtinPrompts, setBuiltinPrompts] = useState<BuiltinPromptsDto | null>(null);
	/** 内置原文拉取失败的原因(卡片信息行与只读弹层降级显示)。 */
	const [builtinError, setBuiltinError] = useState<string | null>(null);
	/** 正在拉内置原文(避免重复请求;弹层会显示「读取中」)。 */
	const builtinLoadingRef = useRef(false);
	const ensureBuiltinPrompts = useCallback(async (): Promise<BuiltinPromptsDto | null> => {
		if (builtinPrompts) return builtinPrompts;
		if (builtinLoadingRef.current) return null;
		builtinLoadingRef.current = true;
		try {
			const dto = await client.getPromptDefaults();
			setBuiltinPrompts(dto);
			setBuiltinError(null);
			return dto;
		} catch (e) {
			setBuiltinError(`内置原文读取失败: ${friendlyError(e)}`);
			return null;
		} finally {
			builtinLoadingRef.current = false;
		}
	}, [client, builtinPrompts]);

	/**
	 * 提示词弹层状态:null = 关着。`key` 决定改哪一份,`mode` 决定只读预览还是编辑。
	 * 两个键共用一个弹层实例 —— 同一时刻只可能开一个窗口,分两套状态会多出一份
	 * 「另一个还开着」的不可能态。
	 */
	const [promptModal, setPromptModal] = useState<{ key: keyof CustomPromptsSlice; mode: PromptModalMode; open: boolean } | null>(null);
	/**
	 * 编辑态草稿。打开弹层时以已保存值为起点;「载入内置原文」把它换成内置全文。
	 * 只读态不看它。
	 */
	const [promptDraft, setPromptDraft] = useState("");
	/** 弹层当前对应的卡片元数据(标题等);关窗后仍要渲染退场动画,故不能依赖 promptModal 是否存在。 */
	const promptCard = PROMPT_CARDS.find((c) => c.key === promptModal?.key) ?? PROMPT_CARDS[0];
	/** 该槽位的内置原文(没拉到就是 null,弹层显示读取中)。 */
	const promptBuiltin = builtinPrompts?.[promptCard.slot] ?? null;

	/**
	 * 打开弹层并确保内置原文已就位。
	 * 只读态**必须**等文本:一屏空白配「只读」徽标会让人以为内置提示词是空的。
	 * 编辑态不等 —— 先把用户已经写好的内容亮出来,内置原文到了再按需「载入」。
	 */
	async function openPromptModal(key: keyof CustomPromptsSlice, mode: PromptModalMode) {
		setActErr(null);
		if (mode === "edit") setPromptDraft(customPrompts[key]);
		setPromptModal({ key, mode, open: true });
		if (!builtinPrompts) await ensureBuiltinPrompts();
	}

	/** 把内置原文灌进编辑草稿(只读态脚部的「载入编辑器」也走这里,顺便切到编辑态)。 */
	function loadBuiltinToDraft() {
		const text = promptBuiltin?.text ?? "";
		if (!text) return;
		setPromptDraft(text);
		setPromptModal((m) => (m ? { ...m, mode: "edit", open: true } : m));
	}

	/**
	 * 进「高级」分类时把内置原文拉一次(卡片信息行要显示「内置 · 312 字」)。
	 * 放在分类变化上而不是挂载时:提示词卡片只在这个分类里,常驻挂载的设置页
	 * 在别的分类白白拉两份数百行文本没意义。
	 */
	useEffect(() => {
		if (cat !== "advanced") return;
		void ensureBuiltinPrompts();
	}, [cat, ensureBuiltinPrompts]);

	// —— 上下文预算(2026-10-10)——
	/** 预算写入中(避免连点)。 */
	const [budgetBusy, setBudgetBusy] = useState(false);
	/**
	 * 预算输入框的本地草稿:打字时只改草稿(否则每敲一位数字就写一次磁盘并广播),
	 * 失焦或点「保存」才提交。归一逻辑与 BUDGET_FIELDS 的 min/max 一致。
	 */
	const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>(() =>
		Object.fromEntries(BUDGET_FIELDS.map((f) => [f.key, String(budget[f.key])])),
	);
	// 外部值变化(对账拉回 / 另一窗口改了)时同步草稿 —— 但用户正在输入时不覆盖
	// (由 dirtyKeys 判断),沿用编辑页「正在打字不被顶掉」的惯例。
	const [budgetDirty, setBudgetDirty] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		setBudgetDraft((prev) => {
			const next = { ...prev };
			for (const f of BUDGET_FIELDS) {
				if (budgetDirty.has(f.key)) continue;
				next[f.key] = String(budget[f.key]);
			}
			return next;
		});
	}, [budget, budgetDirty]);

	/** 归一草稿:非法/空 → null(不提交);合法则钳制到字段区间。 */
	function normalizeBudgetField(key: keyof BudgetSettingsSlice, raw: string): number | null {
		const field = BUDGET_FIELDS.find((f) => f.key === key);
		if (!field) return null;
		const n = Number.parseInt(raw, 10);
		if (!Number.isFinite(n)) return null;
		return Math.min(field.max, Math.max(field.min, n));
	}

	/** 提交单个预算字段:草稿归一后与当前值不同才写服务端,失败走操作错误条。 */
	async function commitBudgetField(key: keyof BudgetSettingsSlice) {
		const n = normalizeBudgetField(key, budgetDraft[key] ?? "");
		// 非法输入:把草稿拉回当前值,不提交
		if (n === null) {
			setBudgetDraft((prev) => ({ ...prev, [key]: String(budget[key]) }));
			setBudgetDirty((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
			return;
		}
		setBudgetDraft((prev) => ({ ...prev, [key]: String(n) }));
		setBudgetDirty((prev) => {
			const next = new Set(prev);
			next.delete(key);
			return next;
		});
		if (n === budget[key]) return;
		setActErr(null);
		setBudgetBusy(true);
		try {
			await onBudgetChange({ [key]: n });
		} catch (e) {
			setActErr(`上下文预算未保存: ${friendlyError(e)}`);
			setBudgetDraft((prev) => ({ ...prev, [key]: String(budget[key]) }));
		} finally {
			setBudgetBusy(false);
		}
	}

	/** 全部还原为默认值(原 world-context.ts 的硬编码常量)。 */
	async function resetBudget() {
		setActErr(null);
		setBudgetBusy(true);
		try {
			await onBudgetChange({
				contextBudget: 2000,
				memoryBudget: 1500,
				activationDepth: 0,
				noticeInjectLimit: 10,
				completedMilestoneLimit: 6,
			});
			setBudgetDirty(new Set());
		} catch (e) {
			setActErr(`上下文预算未还原: ${friendlyError(e)}`);
		} finally {
			setBudgetBusy(false);
		}
	}

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

	/**
	 * 设置思考级别:setThinking → 刷新当前值;失败显示错误文案。
	 *
	 * 服务端会回报**实际生效**的档位:vendor 按模型能力 clamp(非推理模型只有 off),
	 * 请求 high 却落回 off 时必须说清楚 —— 否则用户看到的就是「选了没反应」(2026-10-04)。
	 *
	 * 2026-10 审计 BUG-013:响应现在是**分宿主**的(主会话 / 编剧 / 舞台)。各会话用的模型
	 * 可能不同,clamp 结果也就不同 —— 这里把每个宿主的实际档位摆出来,并点名没设上的。
	 * 另外只承诺「本地请求档位已设置」,不宣称第三方服务端一定按该档位推理(RISK-002)。
	 */
	async function changeThinking(level: string) {
		if (busy) return;
		setBusy(true);
		setActErr(null);
		setThinkingClamped(null);
		setThinkingHosts(null);
		try {
			const r = await client.setThinking(level);
			await load();
			setThinkingHosts(r.hosts ?? null);
			if (r.thinking && r.thinking !== level) setThinkingClamped(level);
			if (r.failures && r.failures.length > 0) {
				setActErr(`思考级别未在所有会话生效: ${r.failures.join("; ")}`);
			}
		} catch (e) {
			setActErr(`思考级别设置失败: ${friendlyError(e)}`);
		} finally {
			setBusy(false);
		}
	}

	/**
	 * 设置思考档位。
	 *

	/** 联网刷新模型目录:远程 catalog / 动态 provider 重新拉取,成功后刷新前端模型列表。 */
	async function refreshModelList() {
		if (modelRefreshBusy || busy) return;
		setModelRefreshBusy(true);
		setNotice(null);
		setActErr(null);
		try {
			const r = await client.refreshModels();
			await load();
			// BUG-001:errors 是 `{provider, message}` 对象数组,直接 join 只会得到
			// [object Object];统一格式化 helper 保证用户看得到是哪个供应商、什么错
			const failed = formatProviderRefreshErrors(r.errors);
			if (failed.length > 0) {
				setNotice(`模型列表已刷新，但部分目录更新失败: ${failed}`);
			} else {
				setNotice("模型列表已联网刷新");
			}
			// BUG-005:刷新同时广播到编剧/舞台宿主,哪里没刷上直接说出来
			const hostFailures = (r.hosts ?? []).filter((h) => !h.ok);
			if (hostFailures.length > 0) {
				setActErr(`部分会话未跟上最新模型目录: ${hostFailures.map((h) => `${h.host}(${h.error ?? "未知错误"})`).join("; ")}`);
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

	/** 当前主题显示名(索引页「主题」行的值;自定义主题按文件列表取名)。 */
	const themeLabel = useMemo(() => {
		// 主题清单里只有文件名与 CSS 原文,显示名要从 CSS 里取(与主题卡同一份逻辑)
		if (theme === NIGHT_THEME.id) return NIGHT_THEME.label;
		const hit = [...builtinThemes, ...userThemes].find((t) => {
			const name = t.file.replace(/\.css$/, "");
			return name === theme || `${USER_THEME_PREFIX}${name}` === theme;
		});
		return hit ? themeLabelFromCss(hit.css, hit.file) : theme;
	}, [theme, builtinThemes, userThemes]);

	/** 手机端选主题的弹层。 */
	const [themeMenuOpen, setThemeMenuOpen] = useState(false);
	/** 主题选单的退场:关掉后仍挂 140ms,让浮层播完下沉动画。 */
	const themeMenuPresence = useExitPresence(themeMenuOpen, DUR.fast * 1000);

	/** 手机端主题清单:与桌面主题卡同一套浅深合并(唯一实现在 themes.ts)。 */
	const phoneFamilies = useMemo(() => buildThemeFamilies(builtinThemes, userThemes), [builtinThemes, userThemes]);

	/**
	 * 手机端当前子页(见 PHONE_PAGES);null = 分组索引页。
	 *
	 * 桌面端恒为 null —— 桌面用的是左栏 + 分类,`phoneCat` 只被「去设置模型 ›」这类
	 * 跨页入口写一次,不能让它影响桌面的卡片可见性。
	 */
	const phonePage = isPhone && phoneCat ? resolvePhonePage(phoneCat, pluginCats) : null;

	/** 手机端子页的卡片样式:这一页之外的卡片直接隐藏(桌面端 phonePage 恒 null,全部照常)。 */
	const cardClass = (key: string) => (phonePage && !phonePage.cards.includes(key) ? "s-card m-card-off" : "s-card");

	/** 全局提示(加载/操作错误、成功通知):索引页与子页都要看得见,所以抽出来两边共用。 */
	const notices = (
		<>
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
		</>
	);

	/**
	 * 供应商管理整屏层(手机端索引行、桌面分类页入口共用)。
	 *
	 * 抽成变量而不是只放在下面那个 return 里:手机端索引页是**提前返回**的,
	 * 弹层只挂在最后一个 return 上时,索引页点「供应商」不会有任何反应(2026-09 修)。
	 */
	const providersDialog = providersPresence.mounted && (
		<div
			className={`dlg-overlay${isPhone ? " pvd-overlay" : ""}${providersPresence.closing ? " is-closing" : ""}`}
			role="dialog"
			aria-modal="true"
			aria-label="模型提供商"
		>
			<div className="dlg-panel pvd-panel">
				{/* 手机端:整屏页 + 返回箭头;桌面端保持弹窗 + 关闭叉 */}
				<header className="pvd-head">
					{isPhone && (
						<button type="button" className="m-icon-btn" aria-label="返回设置" title="返回设置" onClick={() => setProvidersOpen(false)}>
							<Lu icon="chevron-left" size={18} />
						</button>
					)}
					<div className="pvd-head-text">
						<span className="pvd-title">{isPhone ? "管理供应商" : "模型提供商"}</span>
						<span className="pvd-sub">
							{isPhone ? "API Key 只存在本机,不上传任何服务器。" : "配置 API key 后,其模型会出现在设置页的模型列表里。"}
						</span>
					</div>
					{!isPhone && (
						<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setProvidersOpen(false)}>
							<IconX size={16} />
						</button>
					)}
				</header>
				<div className="pvd-body">
					<ProviderList client={client} onAuthChanged={handleAuthChanged} />
				</div>
			</div>
		</div>
	);

	/**
	 * 手机端设置清单。
	 *
	 * 形态是**一层分组清单**:每行要么就地切(开关)、要么就地选(主题行下面的选单),
	 * 要么进一个只放这一项的页面。手机端不沿用桌面的「分类」——桌面一个分类里塞着
	 * 四五张卡,手机点进去看到的是一整张桌面页,而且桌面「标签 | 控件」的行在 393px
	 * 里会把标签挤成一列字(`.st-row` 的 flex 行,2026-09 用户截图)。每行的去向见
	 * PHONE_PAGES,页内只显示该页的卡片。
	 */
	const phoneIndex: Array<{ title: string; rows: Array<{
		key: string;
		icon: LucideName;
		label: string;
		sub?: string;
		value?: string;
		/** 进单页(见 PHONE_PAGES)。 */
		page?: string;
		/** 就地开关(带它就不用热区按钮,开关自己就是控件)。 */
		on?: boolean;
		onToggle?: (v: boolean) => void;
		/** 就地选主题:值这一侧改成 ▾,点开行下选单。 */
		menu?: boolean;
		/** 就地动作(不开页、不只是开关)。 */
		action?: () => void;
	}> }> = [
		{
			title: "外观",
			rows: [
				{ key: "theme", icon: "sun", label: "主题", value: themeLabel, menu: true },
				{
					key: "auto-expand",
					icon: "activity",
					label: "自动展开思考",
					sub: "思考块默认展开,无需逐条点击",
					on: autoExpandThinking,
					onToggle: onAutoExpandThinkingChange,
				},
				{
					key: "enter-send",
					icon: "message-square",
					label: "回车直接发送",
					sub: enterBehavior === "send" ? "回车发送 · Shift+Enter 换行" : "回车换行 · Ctrl+Enter 发送",
					on: enterBehavior === "send",
					onToggle: (v) => onEnterBehaviorChange(v ? "send" : "newline"),
				},
				{
					key: "auto-confirm",
					icon: "check",
					label: "编辑免确认",
					sub: classicMode ? "AI 的修改落盘即生效" : "编剧的修改落盘即生效",
					on: autoConfirmEdits,
					onToggle: onAutoConfirmEditsChange,
				},
				{ key: "theme-css", icon: "pen-line", label: "自定义主题", sub: "写一份 CSS 换掉配色", page: "theme-css" },
			],
		},
		{
			title: "模型与服务",
			rows: [
				{ key: "model", icon: "layers", label: "默认模型", value: current ?? "未选择", page: "model" },
				{ key: "thinking", icon: "sparkles", label: "思考级别", value: thinking ? (THINKING_LABELS[thinking] ?? thinking) : "默认", page: "thinking" },
				{
					key: "provider",
					icon: "key-round",
					label: "供应商",
					sub: "API Key 只存在本机",
					// 已配置的供应商 = 当前模型清单里出现过的服务(没有专门的计数接口)
					value: models === null ? "…" : `${new Set(models.map((m) => m.provider)).size} 个服务`,
					action: () => setProvidersOpen(true),
				},
			],
		},
		{
			title: "写作",
			rows: [
				{ key: "world", icon: "book-open", label: "世界书注入", value: world ? `${world.entries.length} 条目` : "…", page: "world" },
				{ key: "budget", icon: "sliders-horizontal", label: "上下文预算", value: `${budget.contextBudget} token`, page: "budget" },
			],
		},
		{
			title: "实验",
			rows: [
				{ key: "image", icon: "image", label: "图片生成", value: image.enableImageGen ? (image.imageModel || "已开启") : "关", page: "image" },
				...(debugShown
					? [{ key: "debug", icon: "eye" as LucideName, label: "调试模式", sub: "工具块退回原始参数与结果,并解锁「UI 房」组件陈列室", on: debugMode, onToggle: onDebugModeChange }]
					: []),
			],
		},
		{
			title: "高级",
			rows: [
				{ key: "shell", icon: "wrench", label: "执行命令(shell)", value: shellEnabled ? (resolvedShell?.dialect ?? shellKind) : "关", page: "shell" },
				{
					key: "agent",
					icon: "users",
					label: "Agent 形态",
					value: classicMode ? "单 Agent" : "多 Agent",
					page: "agent",
				},
				{
					key: "conversation",
					icon: "message-square",
					label: "对话与章节",
					value: conversationScope === "book" ? "分离" : "绑定章节",
					page: "conversation",
				},
				{
					key: "prompts",
					icon: "file-text",
					label: "系统提示词",
					// 摘要按两份里有没有自定义给:全内置说「内置」,有改的说改了几份
					value: (() => {
						const n = [customPrompts.customWriterPrompt, customPrompts.customEditorPrompt].filter((v) => v.trim().length > 0).length;
						return n === 0 ? "内置" : `已自定义 ${n} 份`;
					})(),
					page: "prompts",
				},
				{ key: "deps", icon: "info", label: "依赖与配置向导", sub: "运行环境要求 · 重走一遍向导", page: "deps" },
			],
		},
		{
			title: "集成",
			rows: [
				{ key: "mcp", icon: "link-2", label: "MCP 服务器", sub: "给 AI 挂外部工具", page: "mcp" },
				{ key: "plugins", icon: "puzzle", label: "插件", page: "plugins" },
				...(pluginCats ?? []).map((pl) => ({ key: `plugin:${pl.id}`, icon: "puzzle" as LucideName, label: pl.name, page: `${pluginCatPrefix}${pl.id}` })),
			],
		},
	];

	if (isPhone && phoneCat === null) {
		return (
			<div className="settings">
				<MobileHeader
					leading={{ icon: "chevron-left", label: "返回编辑", onPress: () => nav?.onNavigate("edit") }}
					title="设置"
					subtitle="本地优先 · 不上传"
					tone="ok"
				/>
				<div className="m-set">
					{notices}
					{phoneIndex.map((sec) => (
						<section key={sec.title} className="m-set-sec">
							<div className="m-set-sec-title">{sec.title}</div>
							{/* 主题选单要浮在下面几行之上:卡片默认 overflow:hidden 会把它裁掉 */}
							<div className={`m-set-card${themeMenuOpen ? " m-menu-open" : ""}`}>
								{sec.rows.map((row) => (
									<div key={row.key} className="m-set-row">
										<Lu icon={row.icon} size={17} />
										<span className="m-set-text">
											<span className="m-set-name">{row.label}</span>
											{row.sub && <span className="m-set-sub">{row.sub}</span>}
										</span>
										{row.onToggle ? (
											<ToggleSwitch checked={row.on ?? false} onChange={row.onToggle} ariaLabel={row.label} />
										) : (
											<>
												{row.value && <span className="m-set-val">{row.value}</span>}
												{(row.page || row.action || row.menu) && (
													/* 单枚 chevron + rotate 过渡:菜单行未展开 = 向下(rotate 90),
													   展开 = 向上(rotate -90);普通行进页行指向右(不旋转) */
													<Lu
														icon="chevron-right"
														size={15}
														className={`m-set-arrow${row.menu ? (themeMenuOpen ? " open" : " menu") : ""}`}
													/>
												)}
											</>
										)}
										{/* 整行可点:进单页 / 开主题选单 / 执行动作(开关行除外,开关自己就是控件) */}
										{!row.onToggle && (
											<button
												type="button"
												className="m-set-hit"
												aria-label={row.label}
												onClick={() => {
													if (row.menu) {
														setThemeMenuOpen((v) => !v);
														return;
													}
													if (row.page) {
														const p = resolvePhonePage(row.page, pluginCats);
														setCat(p?.cat ?? row.page);
														setPhoneCat(row.page);
														setThemeMenuOpen(false);
														return;
													}
													row.action?.();
												}}
											/>
										)}
										{row.menu && themeMenuPresence.mounted && (
											<div
												className={`m-set-menu${themeMenuPresence.closing ? " is-closing" : ""}`}
												role="menu"
												aria-label="选择主题"
											>
												{phoneFamilies.map((f) => {
													// 家族里当前选中的那一份(浅/深);没选中 = 这一行还没被用
													const activeId = theme === f.light.id ? f.light.id : f.dark && theme === f.dark.id ? f.dark.id : null;
													return (
														<button
															key={f.key}
															type="button"
															role="menuitemradio"
															aria-checked={activeId !== null}
															className={activeId ? "m-set-menu-item on" : "m-set-menu-item"}
															// 复选行为与桌面主题卡一致:未选中取浅色,已选中再点切浅 ⇄ 深
															onClick={() => {
																selectTheme(themeFamilyPick(f, theme));
																setThemeMenuOpen(false);
															}}
														>
															<span className="m-set-menu-label">{f.label}</span>
															{activeId && f.dark && (
																<span className="m-set-menu-mode">{activeId === f.dark.id ? "深色" : "浅色"}</span>
															)}
															{activeId && <Lu icon="check" size={15} />}
														</button>
													);
												})}
											</div>
										)}
									</div>
								))}
							</div>
						</section>
					))}
					<div className="m-set-foot">
						{appVersion ? `pi·writer v${appVersion} · ` : ""}数据仅保存在本机
					</div>
				</div>
				{providersDialog}
			</div>
		);
	}

	return (
		<div className="settings">
			{/* 手机端子页页头:← 回索引 | 这一页的名字。
			    桌面端不发这个页头,左栏常驻 */}
			{isPhone && (
				<MobileHeader
					leading={{ icon: "chevron-left", label: "返回设置", onPress: () => setPhoneCat(null) }}
					title={phonePage?.title ?? headOf(cat).title}
					subtitle="本地优先 · 不上传"
					tone="ok"
				/>
			)}
			{/* 左侧分类导航 */}
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
			<main className={isPhone && phonePage ? "settings-main m-focus" : "settings-main"}>
				<div className="settings-inner">
					{/* 页头:标题 + 分类说明 */}
					<header className="st-head">
						<h1 className="st-head-title">{headOf(cat).title}</h1>
						<p className="st-head-desc">{headOf(cat).desc}</p>
					</header>

					{/* 全局提示(加载/操作错误、成功通知):所有分类顶部可见 */}
					{notices}

					{cat === "model" && (
						<div className="st-cols">
							<div className="st-col-main">
								{/* 模型:当前使用模型 + 切换下拉 + 刷新 */}
								<section className={cardClass("model")}>
									<div className="st-card-head">
										<span className="s-card-head">模型</span>
										<span className="st-card-meta">
											{current && <span className="st-chip">{currentProviderId}</span>}
										</span>
									</div>
									<div className="s-card-desc">当前使用的模型。切换后立即生效，包括已经开着的对话（编剧与舞台会话一并更换）。</div>
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

							</div>

							<aside className="st-col-side">
								{/* 思考级别 */}
								<section className={cardClass("thinking")}>
									<div className="s-card-head">思考级别</div>
									<div className="st-row st-row-stack">
										<span className="st-row-label">强度</span>
										<Select
											className="sel-block"
											value={thinking ?? ""}
											options={(thinkingLevels ?? [...THINKING_LEVELS]).map((l) => ({ value: l, label: l }))}
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
										off = 关闭思考；max = 最强思考深度。切换后立即生效（舞台演员的思考档位属于角色设定，不受影响）。{busy && " 设置中…"}
										{thinkingLevels !== null && (
											<>
												{" "}
												当前模型可用档位：{thinkingLevels.join(" / ")}
												{thinkingLevels.length === 1 && thinkingLevels[0] === "off" && (
													<> —— 该模型未声明支持思考；自定义模型可在「编辑模型」里打开「支持思考」。</>
												)}
											</>
										)}
									</div>
									{thinkingClamped && (
										<div className="notice">
											当前模型不支持「{thinkingClamped}」这一档，已按模型能力回落到「{thinking ?? "off"}」。模型声明支持思考（自定义模型可在「编辑模型」里打开「支持思考」）后才能调深。
										</div>
									)}
									{thinkingHosts && thinkingHosts.length > 0 && (
										<div className="s-card-desc st-desc-tight">
											{/* BUG-013:各宿主用的模型可能不同,clamp 结果也就不同 —— 逐个摆出来 */}
											各会话实际档位：
											{thinkingHosts
												.map((h) => {
													if (!h.ok) return `${h.host}：失败(${h.error ?? (h.failed ?? []).join(",")})`;
													const level = h.levels.length > 0 ? h.levels.join(" / ") : "无会话";
													const extra = h.actorsOmitted ? `（${h.actorsOmitted} 个演员按角色设定，不随全局）` : "";
													return `${h.host}：${level}${extra}`;
												})
												.join("；")}
											。此结果是「本地请求档位」，第三方服务是否按其推理以其响应为准。
										</div>
									)}
								</section>

								{/* 模型供应商入口 */}
								<section className={cardClass("provider-entry")}>
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
								<section className={cardClass("theme")}>
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
								<section className={cardClass("ui-pref")}>
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
												<div className="s-pref-title">回车直接发送</div>
												<div className="s-pref-desc">
													开启:回车发送、Shift+Enter 换行。关闭(默认):回车换行、Ctrl+Enter 发送。
												</div>
											</div>
											<ToggleSwitch
												checked={enterBehavior === "send"}
												onChange={(v) => onEnterBehaviorChange(v ? "send" : "newline")}
												ariaLabel="回车直接发送"
											/>
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
								<section className={cardClass("theme-css")}>
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
									<section className={cardClass("debug")}>
										<div className="st-card-head">
											<span className="s-card-head">调试模式</span>
										</div>
										<div className="s-card-desc">
											每个工具调用退回完整卡:原始工具名 + 完整参数 + 完整结果,不再压缩成动作行。排查「模型到底怎么调的工具、错在哪一步」时用。开启后顶栏(手机端是抽屉导航)会多出
											「UI 房」——全部 UI 组件的陈列室,每个组件 2-4 个状态档。
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
								<section className={cardClass("shell")}>
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
												{/* 风险确认正文与首启向导「执行命令」步共用一份(ShellCards.tsx) */}
												<div className="s-plugin-trust-warn">{SHELL_CONFIRM_TEXT}</div>
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

								{/* Agent 形态:多 Agent / 单 Agent 两张大卡(与首启向导「创作方式」步同一实现) */}
								<section className={cardClass("agent")}>
									<div className="s-card-head">Agent 形态</div>
									<div className="s-card-desc">
										决定界面与 AI 的分工。切换会重建服务端会话,下一次对话生效(已写的正文与世界书不受影响)。
									</div>
									<CreationModeCards classic={classicMode} onPick={(v) => void toggleClassicMode(v)} busy={classicBusy} />
								</section>

								{/* 对话与章节:一节一段对话 / 对话与章节各聊各的(与首启向导「创作方式」步同一实现) */}
								<section className={cardClass("conversation")}>
									<div className="s-card-head">对话与章节</div>
									<div className="s-card-desc">
										决定「一段对话管一章」还是「对话与章节各聊各的」。分离后对话可以自由新建与切换,切章节不再切对话,对话里的
										AI 也能编辑任意章节。切换会重建编剧会话,下一次对话生效(已写的正文不受影响)。
									</div>
									<ConversationScopeCards
										scope={conversationScope}
										onPick={(v) => void toggleConversationScope(v)}
										busy={scopeBusy}
									/>
								</section>

								{/* 系统提示词:整段替换内置提示词(2026-10-10)。卡片只负责**说明现状**
								    与给入口,编辑一律进弹层 —— 卡片的模样不能像个输入框(设计稿 r9TyAM)。
								    两张卡各自独立,形态随状态变:内置态给「查看内置原文 / 改为自定义」,
								    自定义态多一个「还原内置」。 */}
								<section className={cardClass("prompts")}>
									<div className="st-card-head">
										<span className="s-card-head">系统提示词</span>
										<span className="st-chip st-chip-danger">⚠ 高风险</span>
									</div>
									<div className="s-card-desc">
										默认用内置提示词。想改动先「查看内置原文」把它载入编辑器,再按需改 ——
										保存后的内容会整段替换内置那一份,内置的角色设定、写作纪律与「你绝不做的事」
										等硬约束都不会再注入。
									</div>
									<div className="st-warn">
										⚠ 替换后 AI 的行为完全由你写的文字决定。删掉内置的落点与工具纪律,AI 可能写错文件位置或越权操作。
									</div>
									<div className="st-prompt-list">
										{PROMPT_CARDS.map((c) => (
											<PromptCard
												key={c.key}
												title={c.title}
												desc={c.desc}
												custom={customPrompts[c.key]}
												builtin={builtinPrompts?.[c.slot] ?? null}
												builtinError={builtinError}
												busy={customBusy}
												onView={() => void openPromptModal(c.key, "readonly")}
												onEdit={() => void openPromptModal(c.key, "edit")}
												onReset={() => void saveCustomPrompt(c.key, "")}
											/>
										))}
									</div>
									<div className="s-card-desc st-desc-tight">
										提示词存在本机(~/.pi/writer/settings.json);若填写的仍是原始内置文本,与留空等价。
									</div>
								</section>
							</div>

							<aside className="st-col-side">
								{onRerunSetup && (
									<section className={cardClass("wizard")}>
										<div className="s-card-head">配置向导</div>
										<div className="st-actions">
											<button type="button" className="btn-ghost" onClick={onRerunSetup}>
												重新运行配置向导
											</button>
										</div>
										<div className="s-card-desc st-desc-tight">重新走一遍创作方式 / 模型服务 / 默认模型 / 第一本书 / 界面偏好。</div>
									</section>
								)}

								<section className={cardClass("deps")}>
									<div className="s-card-head">依赖</div>
									<div className="s-card-desc">「执行命令」需要本机已装好的 shell;「插件」与「MCP」在「集成」分类里。</div>
								</section>
							</aside>
						</div>
					)}

					{cat === "world" && (
						<div className="st-cols">
							<div className="st-col-main">
								<section className={cardClass("world")}>
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
								{/* 上下文预算(2026-10-10):这五项此前只有读路径,只能手编 settings.json。
								    单独成卡而不是塞进「世界书注入」:那两个是开关(要不要),
								    这五个是刻度(装多少),混在一起会让"注入"这件事显得是一组同级选项。 */}
								<section className={cardClass("budget")}>
									<div className="st-card-head">
										<span className="s-card-head">上下文预算</span>
										<span className="st-chip">背景包</span>
									</div>
									<div className="s-card-desc">
										AI 每次对话都不会看到你的全部设定 —— 它只看一份临时的「背景包」:
										把世界观概述、本章相关设定、写作约束、Notice 备忘录、发展线、跨章节记忆
										拼成一段文本塞进这一轮。这几项数字就是那份包的大小上限,单位是 token
										(大致可当"字"来估,中文 1 字 ≈ 1 token)。
									</div>
									<div className="budget-explainer">
										<div className="budget-explainer-title">超出上限时会怎样</div>
										<ol className="budget-explainer-list">
											<li>先整段丢掉「世界观概述」;</li>
											<li>再按 人物人设 &gt; 世界设定 &gt; 时间线 &gt; 大纲 的顺序,把排在后面的世界书条目挤出去;</li>
											<li>最后连发展线里的「已完成」清单也可能被丢掉。</li>
										</ol>
										<div className="budget-explainer-note">
											被丢掉的内容不会消失(文件都还在,AI 需要时能自己读),但这一轮它就看不到了。
											写作页的「上下文检视」会如实列出每一轮丢掉了什么 —— 觉得常被裁,就在这里调大。
										</div>
									</div>
									<div className="s-pref-list">
										{BUDGET_FIELDS.map((f) => (
											<div className="s-pref-item" key={f.key}>
												<div className="s-pref-text">
													<div className="s-pref-title">
														{f.label}
														<span className="budget-default">默认 {BUDGET_DEFAULTS[f.key]}</span>
													</div>
													<div className="s-pref-desc">{f.effect}</div>
													<div className="budget-range">
														范围 {f.min} - {f.max} {f.unit}
													</div>
												</div>
												<div className="budget-input">
													<input
														type="number"
														inputMode="numeric"
														min={f.min}
														max={f.max}
														step={f.step}
														value={budgetDraft[f.key] ?? ""}
														disabled={budgetBusy}
														aria-label={f.label}
														onChange={(e) => {
															setBudgetDraft((prev) => ({ ...prev, [f.key]: e.target.value }));
															setBudgetDirty((prev) => new Set(prev).add(f.key));
														}}
														onBlur={() => void commitBudgetField(f.key)}
														onKeyDown={(e) => {
															if (e.key === "Enter") {
																e.preventDefault();
																void commitBudgetField(f.key);
															}
														}}
													/>
													<span className="budget-unit">{f.unit}</span>
												</div>
											</div>
										))}
									</div>
									<div className="budget-actions">
										<button type="button" className="btn-ghost" onClick={() => void resetBudget()} disabled={budgetBusy}>
											全部还原默认
										</button>
										<span className="budget-hint">改完失焦即保存,下一次对话生效。</span>
									</div>
								</section>
							</div>
							<aside className="st-col-side" />
						</div>
					)}

					{/* 实验(0.1.0):图片生成模型。
					    「测试连接 / 测试生成一张」两种按钮需要服务端的图片探测端点，
					    这一版没有，所以**不做**（宁缺勿假）。 */}
					{cat === "experimental" && (
						<div className="st-cols">
							<div className="st-col-main">
								<section className={cardClass("image")}>
									<div className="st-card-head">
										<span className="s-card-head">图片生成模型</span>
										<span className="st-chip">实验</span>
									</div>
									<div className="s-card-desc">
										允许 AI 在写作过程中调用图片模型：回复里直接嵌图，更新世界书条目时上传配图。
									</div>
									<div className="s-pref-list">
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">启用图片生成</div>
												<div className="s-pref-desc">关闭时图片相关工具对 AI 不可见，也不会出现在对话里。</div>
											</div>
											<ToggleSwitch
												checked={image.enableImageGen}
												disabled={imageBusy}
												onChange={(v) => void applyImage({ enableImageGen: v })}
												ariaLabel="启用图片生成"
											/>
										</div>
									</div>

									<div className="s-card-desc st-desc-tight">接入配置 · 兼容 OpenAI 图片接口</div>
									<div className="s-field-grid">
										<div className="s-field">
											<label className="s-field-label">Provider</label>
											<Select
												className="sel-block"
												value={image.imageProvider}
												options={IMAGE_PROVIDER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
												disabled={imageBusy}
												ariaLabel="图片接口"
												onChange={(v) => void applyImage({ imageProvider: v as ImageProviderDto })}
											/>
										</div>
										<div className="s-field">
											<label className="s-field-label">模型</label>
											<input
												className="s-input st-input-full"
												value={imageDraft.model}
												placeholder="gpt-image-1"
												disabled={imageBusy}
												onChange={(e) => setImageDraft((d) => ({ ...d, model: e.target.value }))}
												onBlur={() => {
													if (imageDraft.model !== image.imageModel) void applyImage({ imageModel: imageDraft.model });
												}}
											/>
										</div>
										<div className="s-field">
											<label className="s-field-label">默认尺寸</label>
											<div className="st-seg">
												{IMAGE_SIZE_OPTIONS.map((s) => (
													<button
														key={s}
														type="button"
														className={image.imageSize === s ? "st-seg-item on" : "st-seg-item"}
														disabled={imageBusy}
														onClick={() => void applyImage({ imageSize: s })}
													>
														{s}
													</button>
												))}
												<span className="st-mono muted">{IMAGE_SIZE_PX_TEXT[image.imageSize]}</span>
											</div>
										</div>
										<div className="s-field">
											<label className="s-field-label">Base URL</label>
											<input
												className="s-input st-input-full"
												value={imageDraft.baseUrl}
												placeholder="留空用官方地址"
												disabled={imageBusy}
												onChange={(e) => setImageDraft((d) => ({ ...d, baseUrl: e.target.value }))}
												onBlur={() => {
													if (imageDraft.baseUrl !== image.imageBaseUrl) void applyImage({ imageBaseUrl: imageDraft.baseUrl });
												}}
											/>
										</div>
										<div className="s-field">
											<label className="s-field-label">API Key</label>
											<input
												className="s-input st-input-full"
												type="password"
												value={imageDraft.key}
												placeholder="sk-…"
												disabled={imageBusy}
												onChange={(e) => setImageDraft((d) => ({ ...d, key: e.target.value }))}
												onBlur={() => {
													if (imageDraft.key !== image.imageApiKey) void applyImage({ imageApiKey: imageDraft.key });
												}}
											/>
										</div>
									</div>
									<div className="s-card-desc st-desc-tight">
										密钥只保存在本机（~/.pi/writer/settings.json）；生成请求由桌面端直接发出，不经过 pi-writer 服务器。
									</div>
									<div className="st-warn">
										图片生成会把提示词与参考图发送给第三方服务，可能产生费用。每次调用都会在对话里以工具卡形式显示，包括成功与失败。
									</div>
								</section>
							</div>

							<aside className="st-col-side">
								<section className={cardClass("image-info")}>
									<div className="s-card-head">实验性功能说明</div>
									<div className="s-card-desc">
										实验开关默认关闭。它们会改变 AI 的行为或界面，也可能在后续版本里被替换；关闭后相关工具立即对 AI 不可见。
									</div>
									<div className="s-pref-list">
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">图片生成模型</div>
												<div className="s-pref-desc">回复嵌图 · 世界书配图</div>
											</div>
											<span className={image.enableImageGen ? "s-val" : "s-val muted"}>
												{image.enableImageGen ? "已开启" : "未开启"}
											</span>
										</div>
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">语音朗读</div>
												<div className="s-pref-desc">把当前章节读出来</div>
											</div>
											<span className="s-val muted">未开放</span>
										</div>
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">自动插图</div>
												<div className="s-pref-desc">按场景批量生成插图</div>
											</div>
											<span className="s-val muted">未开放</span>
										</div>
									</div>
								</section>

								<section className={cardClass("image-when")}>
									<div className="s-card-head">允许 AI 调用的时机</div>
									<div className="s-card-desc">控制图片工具在哪些环节出现。</div>
									<div className="s-pref-list">
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">在回复里嵌入生成的图片</div>
												<div className="s-pref-desc">AI 判断需要配图时直接生成，插入到回复正文中。</div>
											</div>
											<ToggleSwitch
												checked={image.imageInReply}
												disabled={imageBusy}
												onChange={(v) => void applyImage({ imageInReply: v })}
												ariaLabel="在回复里嵌入生成的图片"
											/>
										</div>
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">更新世界书条目时上传配图</div>
												<div className="s-pref-desc">AI 新建或改写条目时，可以把图片写进条目的配图区。</div>
											</div>
											<ToggleSwitch
												checked={image.imageWorldbook}
												disabled={imageBusy}
												onChange={(v) => void applyImage({ imageWorldbook: v })}
												ariaLabel="更新世界书条目时上传配图"
											/>
										</div>
										<div className="s-pref-item">
											<div className="s-pref-text">
												<div className="s-pref-title">每次生成前先确认</div>
												<div className="s-pref-desc">生成前弹一次确认，避免意外消耗额度。</div>
											</div>
											<ToggleSwitch
												checked={image.imageConfirmBeforeGen}
												disabled={imageBusy}
												onChange={(v) => void applyImage({ imageConfirmBeforeGen: v })}
												ariaLabel="每次生成前先确认"
											/>
										</div>
									</div>
								</section>
							</aside>
						</div>
					)}

					{cat === "integrations" && (
						<div className="st-cols">
							<div className="st-col-main">
								<section className={cardClass("mcp")}>
									<div className="s-card-head">MCP 服务器</div>
									<div className="s-card-desc">
										为 AI 接入外部工具(如文件系统、资料库、计算器)。配置存 ~/.pi/writer/agent/mcp.json。
									</div>
									<McpServerList client={client} />
								</section>
								<section className={cardClass("plugins")}>
									<div className="s-card-head">插件</div>
									<div className="s-card-desc">
										扩展写作能力(工具/事件/命令)。插件目录 ~/.pi/writer/plugins/&lt;id&gt;,内含 plugin.json 与入口 index.mjs;切换启用后会话重建生效。
									</div>
									<PluginList client={client} onChanged={() => setPluginCatToken((k) => k + 1)} />
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
			{/* 系统提示词弹层(只读预览 / 编辑两形态共用外壳)。与两张卡片的入口联动,
			    始终挂载以播退场动画 —— 关窗后 mounted 转 false 内部自行返回 null */}
			<PromptModal
				open={promptModal?.open ?? false}
				mode={promptModal?.mode ?? "readonly"}
				title={promptCard.title}
				stateLabel={
					promptModal?.mode === "readonly"
						? "内置 · 只读"
						: customPrompts[promptCard.key].trim().length > 0
							? "已自定义"
							: "未自定义"
				}
				builtinText={promptBuiltin?.text ?? (builtinError ? `${builtinError}` : "正在读取内置提示词…")}
				draft={promptDraft}
				onDraft={setPromptDraft}
				busy={customBusy}
				onClose={() => setPromptModal((m) => (m ? { ...m, open: false } : m))}
				onLoadBuiltin={loadBuiltinToDraft}
				onReset={() => setPromptDraft("")}
				onSave={() => void saveCustomPrompt(promptCard.key, promptDraft.trim())}
			/>
			{/* 模型提供商管理悬浮层:双栏卡片(关闭即卸载,列表状态在下一次打开时重建) */}
			{providersDialog}
		</div>
	);
}

/** 分类页面头(插件分类用插件名占位,由内容区首行标题补足)。 */
function headOf(cat: string): { title: string; desc: string } {
	return CAT_HEAD[cat] ?? { title: "插件设置", desc: "该插件声明的设置项。" };
}

/** 两张提示词卡片的静态元数据(顺序即显示顺序)。 */
const PROMPT_CARDS: ReadonlyArray<{
	/** settings 里的字段名,同时也是保存/还原的键。 */
	key: keyof CustomPromptsSlice;
	/** GET /api/prompt-defaults 响应里的槽位。 */
	slot: "writer" | "editor";
	title: string;
	desc: string;
}> = [
	{
		key: "customWriterPrompt",
		slot: "writer",
		title: "主写作 agent",
		desc: "经典模式下的写作 agent;多 Agent 模式下它是编辑页的对话 AI(writer-main.md)。",
	},
	{
		key: "customEditorPrompt",
		slot: "editor",
		title: "常驻编剧",
		desc: "多 Agent 模式下的编剧对话;经典模式不涉及(writer-editor.md)。",
	},
];

/**
 * 单份系统提示词的**信息块卡片**(2026-10-10,设计稿定稿版)。
 *
 * 刻意不做成输入框:卡片的职责是「说清现在用的是哪一份、多少字」并给两个入口,
 * 编辑一律进弹层(PromptModal)—— 一张卡片长得像 textarea,用户就会以为改动即时生效,
 * 而这东西保存一次要重建会话,必须有个明确的「保存」动作把承诺说清楚。
 *
 * 形态随状态变(内置态 / 自定义态):内置态给「查看内置原文 / 改为自定义」;
 * 自定义态把胶囊换成琥珀「已自定义」,并多一个「还原内置」。两种形态共用同一套
 * 排布(标题行 + 描述 + 信息行 + 脚部),只是文案与按钮不同 —— 避免卡片高度跳变。
 */
function PromptCard({
	title,
	desc,
	custom,
	builtin,
	builtinError,
	busy,
	onView,
	onEdit,
	onReset,
}: {
	title: string;
	desc: string;
	/** 已保存的自定义文本;空 = 用内置。 */
	custom: string;
	/** 内置原文(还没拉到时为 null)。 */
	builtin: { text: string; chars: number } | null;
	/** 内置原文拉取失败的提示(卡片上的信息行降级显示)。 */
	builtinError: string | null;
	busy: boolean;
	/** 打开只读弹层看内置原文。 */
	onView: () => void;
	/** 打开编辑弹层(内置态是「改为自定义」,自定义态是「编辑」)。 */
	onEdit: () => void;
	/** 清空自定义,回落内置。 */
	onReset: () => void;
}) {
	const saved = custom.trim().length > 0;
	// 信息行的字数:自定义态看自己的份量,内置态看内置的份量 —— 都是「现在 AI 收到多少字」
	const chars = saved ? custom.trim().length : builtin?.chars;
	const charsText = builtinError ? builtinError : chars === undefined ? "读取中…" : `${chars.toLocaleString()} 字`;
	return (
		<div className="st-prompt-card">
			<div className="st-prompt-head">
				<div className="st-prompt-title-row">
					<span className="st-prompt-title">{title}</span>
					<span className={`st-prompt-chip${saved ? " is-custom" : ""}`}>
						<Lu icon={saved ? "pencil-line" : "lock"} size={11} />
						{saved ? "已自定义" : "使用内置"}
					</span>
					<span className="st-prompt-spacer" />
				</div>
				<div className="st-prompt-desc">{desc}</div>
			</div>

			<div className={`st-prompt-meta${saved ? " is-custom" : ""}`}>
				<Lu icon="file-text" size={13} className="st-prompt-meta-icon" />
				<span className="st-prompt-meta-label">当前提示词</span>
				<span className="st-prompt-meta-value">{saved ? `自定义 · ${charsText}` : `内置 · ${charsText}`}</span>
			</div>

			<div className="st-prompt-foot">
				<button type="button" className="st-prompt-btn" disabled={busy} onClick={onView}>
					<Lu icon="eye" size={13} />
					查看内置原文
				</button>
				{saved && (
					<button type="button" className="st-prompt-btn danger" disabled={busy} onClick={onReset}>
						<Lu icon="rotate-ccw" size={13} />
						还原内置
					</button>
				)}
				<span className="st-prompt-spacer" />
				<button type="button" className="st-prompt-btn is-primary" disabled={busy} onClick={onEdit}>
					<Lu icon="pencil-line" size={13} />
					{saved ? "编辑提示词" : "改为自定义"}
				</button>
			</div>
		</div>
	);
}
