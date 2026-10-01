/**
 * 首次启动配置向导(八步:介绍 → 创作方式 → 对话范围 → 执行命令 → 接入模型服务 →
 * 默认模型 → 建第一本书 → 界面偏好)。完成后经 client.completeSetup 把标记写到服务端
 * ~/.pi/writer/setup.json(跨窗口/跨浏览器一致),onFinished 交还控制权。
 *
 * 两种打开形态(由 App 控制,**组件不分叉**,只靠 CSS 区分):
 * - 首次启动:向导独占渲染,主界面四页尚未挂载——完成后才挂载,WritePage 的
 *   挂载效应会拉书列表并自动打开第一本书(向导建的书一进界面就打开);
 *   此时根节点是 #root 的直接子节点(`#root > .wz-overlay`)→ 铺满整屏($bg 底);
 * - 设置页「重新运行配置向导」:作为覆盖层叠加在已挂载页面上(`.app > .wz-overlay`),
 *   不打断流式状态 → 加一层 $mask 遮罩;此时建的书经 onBooksChanged 通知 App 刷新书库列表。
 *
 * 版式:顶栏(品牌 + 跳过向导)→ 八步进度条
 * (等宽 900,当前 $amber / 已过 $green / 未到 $line)→ 内容列(720,步骤号 + 34 号标题 +
 * 说明 + 卡片)→ 页脚(左侧提示 + 右侧主按钮,与内容列同宽对齐)。
 *
 * 三个「形态 / 权限」步(2026-10-02):
 *   1. 创作方式 —— 多 Agent / 单 Agent;
 *   2. 对话范围 —— 绑定章节 / 分离;
 *   3. 执行命令 —— 保持关闭 / 开启 shell(选中「开启」先过风险确认条)。
 * 三者都用同一套单选卡片(ChoiceCards.tsx;与设置页「Agent 形态」「对话与章节」卡同一
 * 实现,只有数据不同 —— 早先「执行命令」是挤在「创作方式」步里的一行开关,用户会
 * 顺手划过,而它是整份向导里唯一的权限授予)。值都写在服务端 settings.json,点了立即
 * 生效,所以不需要额外的「保存」动作。
 *
 * 各步骤「真正做过」的标记(点了什么、存了什么)随完成请求一并上报;
 * 「跳过向导」同样置完成标记(空 steps),避免每次启动重复弹。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { ConversationScopeDto, ProviderInfo, UserThemeInfo } from "../types.ts";
import type { SelectGroup } from "../select-logic.ts";
import type { ThemeId } from "../themes.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { CreationModeCards } from "./CreationModeCards.tsx";
import { ConversationScopeCards } from "./ConversationScopeCards.tsx";
import { SHELL_CONFIRM_TEXT, ShellCards } from "./ShellCards.tsx";
import { Select } from "./Select.tsx";
import { ThemeCardsFromManifest } from "./ThemeCards.tsx";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { IconEdit, IconGear, IconGlobe, IconStage } from "./Icons.tsx";
import { Lu } from "./Lu.tsx";

/** 思考级别选项(与后端 session-host 的 ThinkingLevel 对齐;同 SettingsPage)。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 向导步骤(id 与服务端 src/setup.ts 的 SETUP_STEPS 对齐;顺序即展示顺序)。 */
const WIZARD_STEPS = [
	{ id: "intro", label: "介绍" },
	{ id: "mode", label: "创作方式" },
	{ id: "scope", label: "对话范围" },
	{ id: "shell", label: "执行命令" },
	{ id: "provider", label: "模型服务" },
	{ id: "model", label: "默认模型" },
	{ id: "book", label: "第一本书" },
	{ id: "prefs", label: "界面偏好" },
] as const;

type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/**
 * 步骤 id → 下标。**所有跳转都走这里**,不写字面下标 —— 加/挪步骤时下标会整体顺移,
 * 写死一处就是「进度条在第 N 步、界面还是第 N-1 步的控件」(2026-10-02 加「对话范围」
 * 「执行命令」两步时,原来的 setStep(1..5) 全部顺移了一次)。
 */
function stepIndex(id: WizardStepId): number {
	return WIZARD_STEPS.findIndex((s) => s.id === id);
}

/** 各步骤的大标题。 */
const STEP_TITLE: Record<WizardStepId, string> = {
	intro: "欢迎使用 pi-writer",
	mode: "你更希望以哪一种方式创作",
	scope: "AI 的对话怎么和章节对应",
	shell: "要不要给 AI 执行命令的权限",
	provider: "接入模型服务",
	model: "选择默认模型",
	book: "创建第一本书",
	prefs: "界面偏好",
};

/** 页脚左侧的一行提示(与各步语境对应)。 */
const STEP_FOOT_HINT: Record<WizardStepId, string> = {
	intro: "共 8 步,随时可以跳过,稍后在设置里补",
	mode: "选完即生效,随时可以在「设置 → 高级 → Agent 形态」里改",
	scope: "选完即生效,随时可以在「设置 → 高级 → 对话与章节」里改",
	shell: "默认关闭更安全;开启前会再问一次,随时可以在「设置 → 高级」里关掉",
	provider: "key 只存在本地,不会上传。稍后可在「设置 → 模型」中修改",
	model: "保存后立即生效;稍后可在「设置 → 模型」里修改",
	book: "首启已自动建了一本「未命名」,这里起名即复用它;留空则保持默认名",
	prefs: "完成后可在「设置」里随时修改这些偏好",
};

/** 各步骤是否真正走过(完成请求的 steps 载荷)。 */
type StepFlags = Record<WizardStepId, boolean>;

/** vendor 模型元素最小形状(同 SettingsPage 的 ModelInfo)。 */
interface ModelInfo {
	id: string;
	provider: string;
}

/** 归一模型引用为 "provider/id"(与服务端 canonical 格式一致)。 */
function modelRef(m: unknown): string | null {
	if (typeof m === "string") return m.length > 0 ? m : null;
	if (typeof m !== "object" || m === null) return null;
	const o = m as Record<string, unknown>;
	if (typeof o.provider !== "string" || typeof o.id !== "string") return null;
	return `${o.provider}/${o.id}`;
}

/** 从 getModels 的 models 数组提取最小形状(形状不符跳过)。 */
function extractModels(models: readonly unknown[]): ModelInfo[] {
	const out: ModelInfo[] = [];
	for (const m of models) {
		if (typeof m !== "object" || m === null) continue;
		const o = m as Record<string, unknown>;
		if (typeof o.id === "string" && typeof o.provider === "string") out.push({ id: o.id, provider: o.provider });
	}
	return out;
}

export function SetupWizard({
	client,
	autoExpandThinking,
	onAutoExpandThinkingChange,
	autoConfirmEdits,
	onAutoConfirmEditsChange,
	classicMode,
	onClassicModeChange,
	conversationScope,
	onConversationScopeChange,
	shellEnabled,
	onShellEnabledChange,
	onBooksChanged,
	onFinished,
	closing = false,
}: {
	client: ApiClient;
	/** 自动展开思考开关(思考块默认展开;缺省开启)。 */
	autoExpandThinking: boolean;
	onAutoExpandThinkingChange: (enabled: boolean) => void;
	/** 编辑免确认开关(缺省关闭)。 */
	autoConfirmEdits: boolean;
	onAutoConfirmEditsChange: (enabled: boolean) => void;
	/** 经典模式(单 Agent:只有编辑页 + 全量工具;存服务端 settings.json,缺省关闭)。 */
	classicMode: boolean;
	/** 切换经典模式(写服务端;失败抛出由本步显示错误)。 */
	onClassicModeChange: (enabled: boolean) => Promise<void>;
	/** 对话与章节的关系(chapter 缺省 = 一节一段对话;book = 各聊各的)。 */
	conversationScope: ConversationScopeDto;
	/** 切换对话与章节的关系(写服务端;失败抛出由本步显示错误)。 */
	onConversationScopeChange: (scope: ConversationScopeDto) => Promise<void>;
	/** 外部命令(shell)是否放开(服务端 settings.json 的 enableShell,缺省关闭)。 */
	shellEnabled: boolean;
	/** 开关外部命令(写服务端并重建会话;失败抛出由本步显示错误)。 */
	onShellEnabledChange: (enabled: boolean) => Promise<void>;
	/** 向导创建了书后回调(重运行形态下 App 刷新书库列表;首启形态不需要)。 */
	onBooksChanged?: () => void | Promise<void>;
	/** 向导完成(含跳过)后回调;完成标记已写到服务端。 */
	onFinished: () => void;
	/** 退场中(重运行形态由 App 的 useExitPresence 传入):给整屏壳加 .is-closing。 */
	closing?: boolean;
}) {
	/** 当前步骤下标(0..5)。 */
	const [step, setStep] = useState(0);
	/**
	 * 当前步骤 id。**步骤判断一律用它,不用下标** —— 2026-10-02 在介绍后插入
	 * 「创作方式」步时,所有 `step === N` 都要顺移一次,漏一处就是"进度条在第三步、
	 * 界面还是第二步的控件";按 id 判断则插步骤不用改这些分支。
	 */
	const stepId = WIZARD_STEPS[step]!.id;
	const [flags, setFlags] = useState<StepFlags>({
		intro: false,
		mode: false,
		scope: false,
		shell: false,
		provider: false,
		model: false,
		book: false,
		prefs: false,
	});
	const mark = useCallback((id: WizardStepId) => {
		setFlags((f) => (f[id] ? f : { ...f, [id]: true }));
	}, []);

	// —— 完成请求 ——
	const [finishing, setFinishing] = useState(false);
	const [finishErr, setFinishErr] = useState<string | null>(null);

	// —— 创作方式 / 对话范围 / 执行命令三步的状态 ——
	/** 创作方式切换中(两张大卡进入禁用态,避免连点)。 */
	const [modeBusy, setModeBusy] = useState(false);
	/** 对话与章节关系切换中(两张大卡进入禁用态,避免连点)。 */
	const [scopeBusy, setScopeBusy] = useState(false);
	/** 外部命令的开启确认条(关:直接生效,无风险;开:先过确认 —— 与设置页同款)。 */
	const [shellConfirm, setShellConfirm] = useState(false);
	/** 外部命令开关请求进行中。 */
	const [shellBusy, setShellBusy] = useState(false);

	// —— 服务商步状态 ——
	/** null = 未加载(进入该步时拉取)。 */
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	/** 列表展开了全部服务商(默认只列前几个)。 */
	const [showAllProviders, setShowAllProviders] = useState(false);
	const [providerId, setProviderId] = useState<string | null>(null);
	const [keyValue, setKeyValue] = useState("");
	const [keyBusy, setKeyBusy] = useState(false);
	const [keyErr, setKeyErr] = useState<string | null>(null);
	const [keySaved, setKeySaved] = useState(false);

	// —— 模型步状态 ——
	/** null = 未加载(进入模型步时拉取;provider 认证变化后置空重拉)。 */
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [currentModel, setCurrentModel] = useState<string | null>(null);
	const [modelSel, setModelSel] = useState("");
	const [thinkingCur, setThinkingCur] = useState<string | null>(null);
	const [thinkingSel, setThinkingSel] = useState("");
	const [modelBusy, setModelBusy] = useState(false);

	// —— 建书步状态 ——
	const [bookTitle, setBookTitle] = useState("");
	const [chapterTitle, setChapterTitle] = useState("");
	const [bookBusy, setBookBusy] = useState(false);

	// —— 界面偏好步状态 ——
	const [theme, setTheme] = useState<ThemeId>(() => currentTheme());
	const [builtinThemes, setBuiltinThemes] = useState<UserThemeInfo[]>([]);
	const [userThemes, setUserThemes] = useState<UserThemeInfo[]>([]);

	/** 当前步骤内的操作错误(模型设置失败/建书失败等;切步清除)。 */
	const [stepErr, setStepErr] = useState<string | null>(null);

	/**
	 * 从「界面偏好」步的「改」按钮跳回卡片步时为 true:这三个卡片步的「下一步」变成
	 * 「返回界面偏好」,直接跳回末步 —— 否则用户改完一个选项要重走模型 / 建书几步,
	 * 而**建书步不能重走**(书名已被改成用户输入的名字,`findAutoCreatedBook` 只认
	 * 「未命名」,再走一次会真的又建一本,2026-10-02 修)。
	 */
	const [returnToPrefs, setReturnToPrefs] = useState(false);

	/** 主题清单:挂载时拉一次(失败只剩 night,不挡向导)。 */
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
				/* 拉取失败:主题列表为空,仅展示 night */
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	/** 拉取服务商清单(返回最新列表,便于保存 key 后就地刷新「已配置」胶囊)。 */
	const loadProviders = useCallback(async () => {
		const list = await client.getProviders();
		setProviders(list);
		return list;
	}, [client]);

	/** 进入服务商步且未加载过 → 拉取;默认选中第一个已配置的(没有则第一个)。 */
	useEffect(() => {
		if (stepId !== "provider" || providers !== null) return;
		let cancelled = false;
		setStepErr(null);
		void loadProviders()
			.then((list) => {
				if (cancelled) return;
				setProviderId((cur) =>
					cur && list.some((p) => p.id === cur) ? cur : list.find((p) => p.configured)?.id ?? list[0]?.id ?? null,
				);
			})
			.catch((e) => {
				if (cancelled) return;
				setProviders([]);
				setStepErr(`服务商加载失败: ${friendlyError(e)}`);
			});
		return () => {
			cancelled = true;
		};
	}, [stepId, providers, loadProviders]);

	/** 列表默认只列前 5 个,展开后列全部;已选中项一定可见。 */
	const providerRows = useMemo(() => {
		const list = providers ?? [];
		if (showAllProviders) return list;
		const head = list.slice(0, 5);
		const cur = list.find((p) => p.id === providerId);
		if (cur && !head.includes(cur)) return [...head.slice(0, 4), cur];
		return head;
	}, [providers, showAllProviders, providerId]);

	const selectedProvider = useMemo(
		() => (providers ?? []).find((p) => p.id === providerId) ?? null,
		[providers, providerId],
	);

	/**
	 * 保存 API key:写凭据 → 刷新列表(「已配置」胶囊)→ 通知 provider 步走过并把模型
	 * 列表置空(下一步重拉)。请求序列与原 ProviderList 内的保存流程一致。
	 */
	async function saveKey() {
		if (!providerId || keyBusy) return;
		setKeyBusy(true);
		setKeyErr(null);
		setKeySaved(false);
		try {
			await client.setProviderApiKey(providerId, keyValue);
		} catch (e) {
			setKeyErr(`保存失败: ${friendlyError(e)}`);
			setKeyBusy(false);
			return;
		}
		setKeyValue("");
		setKeySaved(true);
		window.setTimeout(() => setKeySaved(false), 3000);
		try {
			await loadProviders();
		} catch {
			/* 列表刷新失败不阻塞(下次进入该步会重新拉) */
		}
		try {
			await handleAuthChanged();
		} catch (e) {
			setKeyErr(`认证状态刷新失败: ${friendlyError(e)}`);
		}
		/*
		 * 存完立刻探一次(2026-09-23):此前这一步对密钥**零校验** —— 粘贴一把已被供应商
		 * 删掉的 key 也会挂上「已配置」并放行到下一步,第一次真对话才炸。
		 * 目录刷新会带上该 provider 的鉴权错误(会联网拉模型目录的供应商当场就能验出),
		 * 所以这里读一次 errors 就能当场说清。探测本身失败不阻塞保存。
		 */
		try {
			const r = await client.refreshModels();
			const fail = (r.errors ?? []).find((e) => e.provider === providerId);
			if (fail) setKeyErr(`已保存到本机,但供应商拒绝了这个密钥: ${fail.message}`);
		} catch {
			/* 探测失败:保持"已保存"的结论,别把探测故障说成密钥问题 */
		}
		setKeyBusy(false);
	}

	/** 拉取模型列表/当前模型/思考级别并回填选择器。 */
	const loadModels = useCallback(async () => {
		const r = await client.getModels();
		const list = extractModels(r.models);
		const cur = modelRef(r.current);
		setModels(list);
		setCurrentModel(cur);
		setModelSel(cur ?? "");
		const t = typeof r.thinking === "string" ? r.thinking : null;
		setThinkingCur(t);
		setThinkingSel(t ?? "");
	}, [client]);

	/** 进入模型步且未加载过 → 拉取(models 置空表示需要重拉,如 provider 认证变化)。 */
	useEffect(() => {
		if (stepId !== "model" || models !== null) return;
		let cancelled = false;
		setStepErr(null);
		void loadModels().catch((e) => {
			if (cancelled) return;
			setModels([]);
			setStepErr(`模型加载失败: ${friendlyError(e)}`);
		});
		return () => {
			cancelled = true;
		};
	}, [stepId, models, loadModels]);

	/** provider 步认证变化:标记步骤走过 + 模型列表置空(下一步重新拉)。 */
	function handleAuthChanged() {
		mark("provider");
		setModels(null);
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

	/** 统一 Select 的分组选项(provider = 组标题,模型 id = 选项)。 */
	const modelGroups = useMemo<SelectGroup[]>(
		() => groups.map(([provider, list]) => ({ label: provider, options: list.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.id })) })),
		[groups],
	);

	/** 联网刷新模型目录(远程 catalog / 动态 provider),成功后回填选择器。 */
	async function refreshModels() {
		if (modelBusy) return;
		setModelBusy(true);
		setStepErr(null);
		try {
			await client.refreshModels();
			await loadModels();
		} catch (e) {
			setStepErr(`模型列表刷新失败: ${friendlyError(e)}`);
		} finally {
			setModelBusy(false);
		}
	}

	/**
	 * 首启自动建的那本空书(服务端 resolveInitialBook 建的「未命名」)。
	 * 只在「书库里正好只有这一本、且它就叫未命名」时返回它 —— 多一本书的情况
	 * (用户已有别的工作区)不动它,照旧新建。
	 */
	async function findAutoCreatedBook(): Promise<{ slug: string } | null> {
		try {
			const books = await client.getBooks();
			const only = books.length === 1 ? books[0] : undefined;
			return only && only.title === "未命名" ? { slug: only.slug } : null;
		} catch {
			return null; // 读不到列表就别乱复用,走新建
		}
	}

	/** 选主题:立即应用(所见即所得)+ 标记偏好步走过。 */
	function selectTheme(id: ThemeId) {
		setTheme(id);
		applyTheme(id);
		mark("prefs");
	}

	/** 偏好开关:即时生效(经 App 的持久化 setter)+ 标记偏好步走过。 */
	function togglePref(key: "autoExpand" | "autoConfirm", v: boolean) {
		if (key === "autoExpand") onAutoExpandThinkingChange(v);
		else onAutoConfirmEditsChange(v);
		mark("prefs");
	}

	/**
	 * 选创作方式:写服务端(settings.json,决定 agent 装配),失败留在本步显示错误
	 * —— 静默失败会让用户以为已经切到单 Agent。切换会释放已建会话,下次对话生效。
	 */
	async function pickMode(classic: boolean) {
		if (modeBusy) return;
		setStepErr(null);
		setModeBusy(true);
		try {
			await onClassicModeChange(classic);
			mark("mode");
		} catch (e) {
			setStepErr(`创作方式设置失败: ${friendlyError(e)}`);
		} finally {
			setModeBusy(false);
		}
	}

	/**
	 * 选「对话与章节」的关系:与创作方式同款 —— 写服务端(settings.json,决定
	 * WriterHost 的会话身份语义),失败留在本步显示错误;切换会释放已建会话。
	 */
	async function pickConversationScope(scope: ConversationScopeDto) {
		if (scopeBusy) return;
		setStepErr(null);
		setScopeBusy(true);
		try {
			await onConversationScopeChange(scope);
			mark("scope");
		} catch (e) {
			setStepErr(`对话与章节设置失败: ${friendlyError(e)}`);
		} finally {
			setScopeBusy(false);
		}
	}

	/** 执行命令卡片:开要过风险确认条,关直接生效(与设置页同款)。 */
	function askShellEnable(checked: boolean) {
		setStepErr(null);
		if (checked) {
			setShellConfirm(true);
			return;
		}
		void toggleShell(false);
	}

	async function toggleShell(enabled: boolean) {
		if (shellBusy) return;
		setShellConfirm(false);
		setStepErr(null);
		setShellBusy(true);
		try {
			await onShellEnabledChange(enabled);
			mark("shell");
		} catch (e) {
			setStepErr(`执行命令设置失败: ${friendlyError(e)}`);
		} finally {
			setShellBusy(false);
		}
	}

	/** 上一步(回到模型步时保留已选值;错误清除)。 */
	function back() {
		setStepErr(null);
		setReturnToPrefs(false);
		setStep((s) => Math.max(0, s - 1));
	}

	/**
	 * 进入下一步。**只按 +1 走**(不写字面下标):加/挪步骤时这里不用改,
	 * 各步的收口动作只决定「什么时候可以走」。
	 */
	function nextStep() {
		setStep((s) => Math.min(s + 1, WIZARD_STEPS.length - 1));
	}

	/**
	 * 三个卡片步的「下一步」:从偏好页跳回来的 → 直接回偏好页(不重走中间几步),
	 * 否则正常前进。
	 */
	function leaveCardStep() {
		if (returnToPrefs) {
			setReturnToPrefs(false);
			setStep(stepIndex("prefs"));
			return;
		}
		nextStep();
	}

	/** 从偏好页的「改」跳到某个卡片步:记住要回来。 */
	function editFromPrefs(id: WizardStepId) {
		setStepErr(null);
		setReturnToPrefs(true);
		setStep(stepIndex(id));
	}

	/** 下一步/完成:各步收口(模型与建书是异步操作,失败留在原步显示错误)。 */
	async function next() {
		setStepErr(null);
		if (stepId === "intro") {
			mark("intro");
			nextStep();
			return;
		}
		if (stepId === "mode") {
			// 创作方式 / 对话与章节 / shell 都是「点了就落盘」的即时设置,
			// 这三步没有别的收口动作
			if (modeBusy) return;
			leaveCardStep();
			return;
		}
		if (stepId === "scope") {
			if (scopeBusy) return;
			leaveCardStep();
			return;
		}
		if (stepId === "shell") {
			// 确认条还挂着 = 还没决定,别让它跟着翻页(回来时状态还在)
			if (shellBusy || shellConfirm) return;
			leaveCardStep();
			return;
		}
		if (stepId === "provider") {
			// provider 步不强求配置(列表内部自行处理错误);认证与否都放行。
			// 但**已经配好的供应商也算这一步走过** —— 否则重跑向导(或上次已经存过 key)
			// 时该标记永远是 false,用户看着像"我明明配过"(2026-09-23)。
			if (selectedProvider?.configured) mark("provider");
			nextStep();
			return;
		}
		if (stepId === "model") {
			if (modelBusy) return;
			setModelBusy(true);
			try {
				if (modelSel && modelSel !== currentModel) await client.setModel(modelSel);
				if (thinkingSel && thinkingSel !== thinkingCur) await client.setThinking(thinkingSel);
				if (modelSel || thinkingSel) mark("model");
				nextStep();
			} catch (e) {
				setStepErr(`模型设置失败: ${friendlyError(e)}`);
			} finally {
				setModelBusy(false);
			}
			return;
		}
		if (stepId === "book") {
			// 建第一本书:标题留空 = 跳过(不创建);填写则建书 + 可选首章
			const title = bookTitle.trim();
			if (title === "") {
				nextStep();
				return;
			}
			if (bookBusy) return;
			setBookBusy(true);
			try {
				/*
				 * 首启时服务端**已经**自动建了一本「未命名」(src/web.ts 的 resolveInitialBook:
				 * 一本书都没有就建一本,否则主会话没有落脚点)。2026-09-23 修:此前这一步再
				 * createBook 一次 —— 走完向导书库里就是两本(未命名 + 用户刚起名的)。
				 * 现在只在「确实只有这一本自动建的空书」时复用它(改名),其余情况照旧新建。
				 */
				const reuse = await findAutoCreatedBook();
				const book = reuse ? await client.renameBook(reuse.slug, title) : await client.createBook(title);
				if (chapterTitle.trim().length > 0) await client.createChapter(book.slug, chapterTitle.trim());
				mark("book");
				try {
					await onBooksChanged?.();
				} catch {
					/* 列表刷新失败不影响向导(首启形态下页面挂载时会全量重拉) */
				}
				nextStep();
			} catch (e) {
				setStepErr(`建书失败: ${friendlyError(e)}`);
			} finally {
				setBookBusy(false);
			}
			return;
		}
		// stepId === "prefs":完成
		await finish();
	}

	/** 完成向导:写服务端标记 → onFinished。失败显示错误并提供两条出路(重试/仍要进入)。 */
	async function finish() {
		if (finishing) return;
		setFinishing(true);
		setFinishErr(null);
		try {
			await client.completeSetup(flags);
			onFinished();
		} catch (e) {
			setFinishErr(`向导状态保存失败: ${friendlyError(e)}`);
			setFinishing(false);
		}
	}

	const busy = finishing || modelBusy || bookBusy || modeBusy || scopeBusy || shellBusy;
	const isLast = step === WIZARD_STEPS.length - 1;
	/** 正在「改」卡片步(从偏好页跳回来的):主按钮回偏好页,页脚提示跟着换。 */
	const backToPrefs = returnToPrefs && (stepId === "mode" || stepId === "scope" || stepId === "shell");

	/** 主按钮文案:完成/下一步 + 各异步步的进行态。 */
	const primaryLabel = isLast
		? finishing
			? "保存中…"
			: "完成 ✓"
		: backToPrefs
			? "返回界面偏好 →"
			: modelBusy && stepId === "model"
				? "设置中…"
				: bookBusy && stepId === "book"
					? "创建中…"
					: "下一步 →";

	return (
		<div className={`wz-overlay${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label="首次启动配置向导">
			{/* 顶栏:与主界面同语言(品牌 + 右侧次要动作);整屏引导下无边框 */}
			<header className="wz-top">
				<div className="brand">
					pi<i>·writer</i>
				</div>
				<button type="button" className="wz-skip" disabled={finishing} onClick={() => void finish()}>
					跳过向导
				</button>
			</header>

			{/* 八步进度条:每步等宽,线上色即状态(当前 $amber / 已过 $green / 未到 $line) */}
			<nav className="wz-steps" aria-label="配置向导步骤">
				{WIZARD_STEPS.map((s, i) => (
					<div key={s.id} className={`wz-step${i === step ? " on" : ""}${i < step ? " done" : ""}`}>
						<span className="wz-step-bar" />
						<span className="wz-step-label">{s.label}</span>
					</div>
				))}
			</nav>

			<div className="wz-main">
				<div className="wz-col">
					<div className="wz-kicker">
						步骤 {step + 1} / {WIZARD_STEPS.length}
					</div>
					<h1 className="wz-h1">{STEP_TITLE[stepId]}</h1>

					{stepId === "intro" && (
						<>
							<p className="wz-lead">AI 长篇写作工作台。只需一分钟完成初始配置,之后随时可以在设置里修改。</p>
							<div className="wz-feats">
								{/* 经典模式(单 Agent)下没有舞台,不列出来免得与实际界面对不上;
								    世界书页两种模式都在 */}
								{!classicMode && (
									<div className="wz-feat">
										<span className="wz-feat-ico">
											<IconStage size={18} />
										</span>
										<div className="wz-feat-text">
											<div className="wz-feat-title">舞台</div>
											<div className="wz-feat-desc">多角色即兴演出,导演控制节奏</div>
										</div>
									</div>
								)}
								<div className="wz-feat">
									<span className="wz-feat-ico">
										<IconEdit size={18} />
									</span>
									<div className="wz-feat-text">
										<div className="wz-feat-title">编辑</div>
										<div className="wz-feat-desc">
											{classicMode ? "正文 + 单一写作 agent(全量工具)" : "章节正文 + 常驻编剧 AI 伙伴"}
										</div>
									</div>
								</div>
								<div className="wz-feat">
									<span className="wz-feat-ico">
										<IconGlobe size={18} />
									</span>
									<div className="wz-feat-text">
										<div className="wz-feat-title">世界书</div>
										<div className="wz-feat-desc">人物、设定、时间线与关系图</div>
									</div>
								</div>
								<div className="wz-feat">
									<span className="wz-feat-ico">
										<IconGear size={18} />
									</span>
									<div className="wz-feat-text">
										<div className="wz-feat-title">设置</div>
										<div className="wz-feat-desc">模型、主题与 MCP 集成</div>
									</div>
								</div>
							</div>
						</>
					)}

					{stepId === "mode" && (
						<>
							<p className="wz-lead">
								两种方式的界面与 AI 分工不同;不确定就用带「默认」的那一张,随时可以在「设置 → 高级 →
								Agent 形态」改回来。
							</p>
							{/* 两张大卡:与设置页「Agent 形态」卡同一实现(骨架与文案都只写一份) */}
							<CreationModeCards classic={classicMode} onPick={(v) => void pickMode(v)} busy={modeBusy || finishing} />
						</>
					)}

					{stepId === "scope" && (
						<>
							<p className="wz-lead">
								决定 AI 的对话按什么单位走:跟着章节走,还是和章节各聊各的。不确定就用带「默认」的那一张,随时可以在「设置 →
								高级 → 对话与章节」改回来。
							</p>
							{/* 与设置页「对话与章节」卡同一实现(骨架与文案都只写一份) */}
							<ConversationScopeCards
								scope={conversationScope}
								onPick={(v) => void pickConversationScope(v)}
								busy={scopeBusy || finishing}
							/>
							<div className="wz-hint">
								改这里会释放已建的编剧会话,下一次对话按新关系走。两种关系在编辑器里都能用,区别只在「一段对话记得多少、能改哪里」。
							</div>
						</>
					)}

					{stepId === "shell" && (
						<>
							<p className="wz-lead">
								这是整份向导里唯一一项权限授予:开了 AI 才能在你这台机器上真执行命令。默认关闭,只有需要它调 pandoc、git
								这类外部工具时才打开。
							</p>
							{/* 两选一卡片:风险确认文案与设置页那一处共用一份(SHELL_CONFIRM_TEXT) */}
							<ShellCards enabled={shellEnabled} onPick={askShellEnable} busy={shellBusy || finishing} />
							{shellConfirm && (
								<div className="s-plugin-trust-confirm">
									<div className="s-plugin-trust-warn">{SHELL_CONFIRM_TEXT}</div>
									<div className="st-actions">
										<button type="button" className="btn-ghost danger" disabled={shellBusy} onClick={() => void toggleShell(true)}>
											确认启用
										</button>
										<button type="button" className="btn-ghost" onClick={() => setShellConfirm(false)}>
											取消
										</button>
									</div>
								</div>
							)}
							<div className="wz-hint">
								开启后命令与输出会实时显示在对话里(调试模式下也可见);方言与可执行文件路径在「设置 →
								高级 → 执行命令」里改。
							</div>
						</>
					)}

					{stepId === "provider" && (
						<>
							<p className="wz-lead">
								选一个服务商,填入 API key,它的模型就能在下一步选为默认。key 只保存在本地{" "}
								<code className="wz-mono">~/.pi/writer/agent/auth.json</code>。
							</p>
							<div className="wz-card wz-prov">
								<div className="wz-prov-list" role="radiogroup" aria-label="模型服务商">
									{providerRows.length === 0 && (
										<div className="wz-prov-empty">{providers === null ? "加载中…" : "暂无可选服务商,稍后可在「设置 → 模型」中添加"}</div>
									)}
									{providerRows.map((p) => (
										<button
											key={p.id}
											type="button"
											role="radio"
											aria-checked={p.id === providerId}
											className={`wz-prov-row${p.id === providerId ? " on" : ""}`}
											onClick={() => {
												setProviderId(p.id);
												setKeyErr(null);
												setKeySaved(false);
											}}
										>
											<span className="wz-radio" aria-hidden="true" />
											<span className="wz-prov-name">{p.name}</span>
											{p.configured && (
												<span className="wz-pill">
													<span className="wz-pill-dot" aria-hidden="true" />
													已配置
												</span>
											)}
										</button>
									))}
									{providers !== null && providers.length > providerRows.length && (
										<button type="button" className="wz-prov-more" onClick={() => setShowAllProviders((v) => !v)}>
											{showAllProviders ? "收起列表 ‹" : `搜索或展开全部 ${providers.length} 个服务商 ›`}
										</button>
									)}
								</div>
							</div>
							<div className="wz-field">
								<label className="wz-label" htmlFor="wz-provider-key">
									{selectedProvider?.name ?? "服务商"} API Key
								</label>
								<div className="wz-field-row">
									<span className="wz-input-wrap">
										<span className="wz-input-ico" aria-hidden="true">
											<IconLock />
										</span>
										<input
											id="wz-provider-key"
											className="wz-input wz-input-mono"
											type="password"
											autoComplete="off"
											placeholder={selectedProvider?.id === "anthropic" ? "sk-ant-…" : "粘贴 API key"}
											value={keyValue}
											disabled={keyBusy}
											onChange={(e) => setKeyValue(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && keyValue.trim().length > 0) void saveKey();
											}}
										/>
									</span>
									<button
										type="button"
										className="wz-primary wz-save"
										disabled={keyBusy || keyValue.trim().length === 0}
										onClick={() => void saveKey()}
									>
										{keyBusy ? "保存中…" : "保存"}
									</button>
								</div>
								{keyErr && <div className="wz-key-err">{keyErr}</div>}
								{keySaved && !keyErr && <div className="wz-key-ok">已保存</div>}
								<div className="wz-hint">保存后会自动拉取该服务商的模型列表。没有 key 也可以先跳过这一步。</div>
							</div>
						</>
					)}

					{stepId === "model" && (
						<>
							<p className="wz-lead">选择默认模型与思考级别;列表为空时请先配置服务商或联网刷新。</p>
							<div className="wz-card">
								<div className="wz-field">
									<label className="wz-label">默认模型</label>
									<div className="wz-field-row">
										<Select
											className="wz-sel"
											value={modelSel}
											onChange={setModelSel}
											options={models === null ? [{ value: "", label: "加载中…" }] : [{ value: "", label: "暂不设置" }]}
											groups={modelGroups}
											disabled={modelBusy || models === null}
											ariaLabel="默认模型"
										/>
										<button type="button" className="wz-ghost" disabled={modelBusy} onClick={() => void refreshModels()}>
											{modelBusy ? "刷新中…" : "联网刷新"}
										</button>
									</div>
								</div>
								<div className="wz-field">
									<label className="wz-label">思考级别</label>
									<Select
										className="wz-sel"
										value={thinkingSel}
										onChange={setThinkingSel}
										options={[{ value: "", label: "保持现状" }, ...THINKING_LEVELS.map((l) => ({ value: l, label: l }))]}
										disabled={modelBusy}
										ariaLabel="思考级别"
									/>
									<div className="wz-hint">off = 关闭思考;max = 最强思考深度</div>
								</div>
							</div>
						</>
					)}

					{stepId === "book" && (
						<>
							<p className="wz-lead">创建你的第一本书;标题留空则跳过,之后随时在编辑页新建。</p>
							<div className="wz-card">
								<div className="wz-field">
									<label className="wz-label" htmlFor="wz-book-title">
										书名
									</label>
									<input
										id="wz-book-title"
										className="wz-input"
										placeholder="如:星槎远航志"
										value={bookTitle}
										disabled={bookBusy}
										onChange={(e) => setBookTitle(e.target.value)}
									/>
								</div>
								<div className="wz-field">
									<label className="wz-label" htmlFor="wz-book-chapter">
										首章标题(可选)
									</label>
									<input
										id="wz-book-chapter"
										className="wz-input"
										placeholder="如:第一章 · 夜航船"
										value={chapterTitle}
										disabled={bookBusy}
										onChange={(e) => setChapterTitle(e.target.value)}
									/>
								</div>
							</div>
						</>
					)}

					{stepId === "prefs" && (
						<>
							<p className="wz-lead">挑选主题与界面偏好,立即生效,随时可在设置中修改。</p>
							<div className="wz-sec">
								<div className="wz-sec-head">
									<span className="wz-sec-label">主题</span>
									<span className="wz-sec-hint">深浅已合并 · 点已选中的卡可切换明暗</span>
								</div>
								{/* 深浅配对/落点规则在 themes.ts + ThemeCards 内部,这里不重复实现 */}
								<ThemeCardsFromManifest builtin={builtinThemes} user={userThemes} current={theme} onPick={selectTheme} />
							</div>
							<div className="wz-prefs">
								{/*
								 * 三个「形态 / 权限」设置在各自那一步用大卡选过,这里只回显 + 一键跳回。
								 * 跳回走 editFromPrefs:那三步的主按钮会变成「返回界面偏好」,不重走中间几步
								 * (建书步不能重走,2026-10-02)。
								 */}
								<div className="wz-pref-row">
									<div className="wz-pref-text">
										<div className="wz-pref-title">创作方式</div>
										<div className="wz-pref-desc">
											当前:{classicMode ? "单 Agent 写作(经典模式)" : "多 Agent 协作"}。
										</div>
									</div>
									<button type="button" className="btn-ghost" disabled={busy} onClick={() => editFromPrefs("mode")}>
										改
									</button>
								</div>
								<div className="wz-pref-row">
									<div className="wz-pref-text">
										<div className="wz-pref-title">对话与章节</div>
										<div className="wz-pref-desc">
											当前:{conversationScope === "book" ? "分离(各聊各的)" : "绑定章节(新章节 = 新对话)"}。
										</div>
									</div>
									<button type="button" className="btn-ghost" disabled={busy} onClick={() => editFromPrefs("scope")}>
										改
									</button>
								</div>
								<div className="wz-pref-row">
									<div className="wz-pref-text">
										<div className="wz-pref-title">执行命令(shell)</div>
										<div className="wz-pref-desc">
											当前:{shellEnabled ? "已开启(命令与输出实时可见)" : "关闭(不给 AI 本机命令权限)"}。
										</div>
									</div>
									<button type="button" className="btn-ghost" disabled={busy} onClick={() => editFromPrefs("shell")}>
										改
									</button>
								</div>
								<div className="wz-pref-row">
									<div className="wz-pref-text">
										<div className="wz-pref-title">自动展开思考</div>
										<div className="wz-pref-desc">思考块默认展开,无需逐条点击。</div>
									</div>
									<ToggleSwitch
										checked={autoExpandThinking}
										onChange={(v) => togglePref("autoExpand", v)}
										ariaLabel="自动展开思考"
									/>
								</div>
								<div className="wz-pref-row">
									<div className="wz-pref-text">
										<div className="wz-pref-title">编辑免确认</div>
										<div className="wz-pref-desc">编剧的修改落盘即生效,不再弹「待确认」卡。</div>
									</div>
									<ToggleSwitch
										checked={autoConfirmEdits}
										onChange={(v) => togglePref("autoConfirm", v)}
										ariaLabel="编辑免确认"
									/>
								</div>
							</div>
						</>
					)}

					{stepErr && <div className="notice err wz-step-err">{stepErr}</div>}
				</div>
			</div>

			<footer className="wz-foot">
				<div className="wz-foot-inner">
					{finishErr && (
						<div className="notice err wz-finish-err">
							<span>{finishErr}</span>
							<button type="button" className="btn-ghost notice-action" onClick={() => void finish()}>
								重试
							</button>
							<button type="button" className="btn-ghost notice-action" onClick={onFinished}>
								仍要进入
							</button>
						</div>
					)}
					<div className="wz-foot-row">
						<div className="wz-foot-hint">
							{backToPrefs ? "改完点右下角回「界面偏好」,不用重走中间几步" : STEP_FOOT_HINT[stepId]}
						</div>
						<div className="wz-foot-actions">
							{step > 0 && (
								<button type="button" className="wz-ghost" disabled={busy} onClick={back}>
									← 上一步
								</button>
							)}
							<button type="button" className="wz-primary" disabled={busy} onClick={() => void next()}>
								{primaryLabel}
							</button>
						</div>
					</div>
				</div>
			</footer>
		</div>
	);
}

/** 锁图标(API key 输入框左侧):与 Icons.tsx 同细线语言,只在本文件用。 */
function IconLock() {
	return (
		<Lu icon="key-round" size={13} strokeWidth={1.6} />
	);
}
