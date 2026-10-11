import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "./api/client.ts";
import { useLibrary } from "./library.ts";
import { useExitPresence } from "./use-exit-presence.ts";
import { syncPluginScripts } from "./plugin-scripts.ts";
import { PluginWindows, usePluginWindows } from "./components/PluginWindows.tsx";
import { IconEdit, IconGear, IconGlobe, IconStage } from "./components/Icons.tsx";
import { Lu } from "./components/Lu.tsx";
import { SetupWizard } from "./components/SetupWizard.tsx";
import { WritePage, type HeaderInfo } from "./pages/WritePage.tsx";
import { StagePage } from "./pages/StagePage.tsx";
import { WorldPage } from "./pages/WorldPage.tsx";
import { SettingsPage, type BudgetSettingsSlice, type CustomPromptsSlice, type ImageSettingsSlice } from "./pages/SettingsPage.tsx";
import { UIRoom } from "./pages/UIRoom.tsx";
import {
	autoConfirmEditsEnabled,
	autoExpandThinkingEnabled,
	classicModeEnabled,
	conversationScope as readConversationScope,
	debugModeEnabled,
	enterBehavior as readEnterBehavior,
	debugUnlocked,
	setAutoConfirmEdits as persistAutoConfirmEdits,
	setAutoExpandThinking as persistAutoExpandThinking,
	setClassicMode as persistClassicMode,
	setConversationScope as persistConversationScope,
	setDebugMode as persistDebugMode,
	setEnterBehavior as persistEnterBehavior,
	subscribeDebugChanged,
} from "./settings.ts";
import type { ConversationScopeDto, ResolvedShellDto, ShellKindDto, WriterSettingsDto } from "./types.ts";
import type { EnterBehavior } from "./settings.ts";

/**
 * 顶层视图:舞台(默认,导演讨论室/演出现场)| 编辑(正文 + 编剧)| 世界书 | 设置
 * | UI 房(组件陈列室,**只在调试模式里可达**,见 nav.ts / pages/UIRoom.tsx)。
 */
type View = "stage" | "edit" | "world" | "settings" | "uiroom";

/**
 * 经典模式(单 agent)下仍然存在的视图:编辑页 + 世界书 + 设置——
 * 去掉的只有舞台(导演/演员/旁白那套多 agent 共演)。世界书页本身没有 agent,
 * 只是面向人的设定编辑器,留着自己改设定照样用。
 */
function isClassicView(v: View): boolean {
	return v !== "stage";
}

/** 顶栏保存状态 → 图标与颜色 class(文案来自 WritePage 上报的 SAVE_LABELS)。
 *  顶栏右侧是「● 已保存」——一个状态点 + 文案,不用勾选图标。 */
const SAVE_STYLE: Record<string, { icon: string; cls: string }> = {
	"已保存": { icon: "●", cls: "ok" },
	"未保存": { icon: "●", cls: "dirty" },
	"保存中": { icon: "…", cls: "busy" },
	"保存失败": { icon: "!", cls: "err" },
	"加载中": { icon: "", cls: "loading" },
};

/** 首启向导检查相位:checking 拉取中 / pending 未完成(弹向导)/ done 已完成或检查失败。 */
type SetupPhase = "checking" | "pending" | "done";

export function App() {
	const client = useMemo(() => new ApiClient(), []);
	/**
	 * 经典模式(单 agent):去掉舞台入口(没有导演/演员/旁白的多 agent 共演),
	 * 编辑页的 AI 换成带全量工具的写作 agent;世界书页与设置页照常。
	 *
	 * **缺省开启**(2026-10-02:多 agent 那套要用户先理解角色分工,新用户容易卡住)。
	 * 权威值在服务端(~/.pi/writer/settings.json,决定 agent 装配),这里读本地
	 * 缓存供首帧渲染(否则顶栏会先画出舞台入口再收回);挂载后 GET /api/settings
	 * 对账,并以服务端为准覆盖;其他窗口的切换经 settings_changed SSE 同步。
	 */
	const [classicMode, setClassicModeState] = useState<boolean>(() => classicModeEnabled());
	/** 顶栏视图;经典模式(本地缓存已开启,含**缺省**)首帧直接落在编辑页。 */
	const [view, setView] = useState<View>(() => (classicModeEnabled() ? "edit" : "stage"));
	/**
	 * 「去设置模型」信号(报错卡的动作行):自增计数 → 设置页据此把左栏切回「模型」。
	 * 设置页是常驻挂载的,不能靠重挂载回默认分类(见 SettingsPage 的 props 说明)。
	 * 计数与导航一起做:点一次 = 切页 + 切分类,同一个动作两件事。
	 */
	const [settingsModelToken, setSettingsModelToken] = useState(0);
	const openModelSettings = useCallback(() => {
		setSettingsModelToken((n) => n + 1);
		setView("settings");
	}, []);
	const [header, setHeader] = useState<HeaderInfo | null>(null);
	/**
	 * 调试模式(每个工具块退回原始工具名 + 完整参数 + 完整结果)。
	 * **不是显示偏好,是开发者的排障开关**:默认关闭,且平时设置页里没有这一项——
	 * 要在 F12 控制台跑 `piWriterDebug()` 解锁才出现(见 main.tsx / settings.ts)。
	 */
	const [debugMode, setDebugModeState] = useState<boolean>(() => debugModeEnabled());
	/** 界面是否已解锁显示「调试模式」(未解锁时设置页不渲染这一项)。 */
	const [debugShown, setDebugShown] = useState<boolean>(() => debugUnlocked());
	const setDebugMode = (v: boolean) => {
		persistDebugMode(v);
		setDebugModeState(v);
		// UI 房只在调试模式里挂载:关掉开关时人可能正站在那一页上 → 拉回编辑页,别停白屏
		if (!v) setView((cur) => (cur === "uiroom" ? "edit" : cur));
	};
	// 控制台解锁/锁定后(requestDebugChanged 事件)同步界面:否则设置页要刷新才认账
	useEffect(
		() =>
			subscribeDebugChanged(() => {
				setDebugShown(debugUnlocked());
				const on = debugModeEnabled();
				setDebugModeState(on);
				// 控制台 piWriterDebugOff() 也会走到这里,同样要把人从 UI 房拉回来
				if (!on) setView((cur) => (cur === "uiroom" ? "edit" : cur));
			}),
		[],
	);
	/** 当前打开的书 slug(由书库状态上报;世界书页据此判断有无会话并加载世界书)。 */
	const [currentSlug, setCurrentSlug] = useState<string | null>(null);
	/** 书库状态唯一真相源:舞台页与编辑页共用,书库栏两页常驻且状态同步。 */
	const library = useLibrary(client, setCurrentSlug);
	/** 自动展开思考(思考块默认展开),缺省开启;切换经设置页持久化。 */
	const [autoExpandThinking, setAutoExpandThinkingState] = useState<boolean>(() => autoExpandThinkingEnabled());
	const setAutoExpandThinking = (v: boolean) => {
		persistAutoExpandThinking(v);
		setAutoExpandThinkingState(v);
	};
	/** 回车行为(send = 回车即发送 / newline = 回车换行),缺省 newline(旧行为)。 */
	const [enterBehavior, setEnterBehaviorState] = useState<EnterBehavior>(() => readEnterBehavior());
	const setEnterBehavior = (v: EnterBehavior) => {
		persistEnterBehavior(v);
		setEnterBehaviorState(v);
	};
	/** 编辑免确认(编剧编辑落盘即归档),缺省关闭;切换经设置页持久化。 */
	const [autoConfirmEdits, setAutoConfirmEditsState] = useState<boolean>(() => autoConfirmEditsEnabled());
	const setAutoConfirmEdits = (v: boolean) => {
		persistAutoConfirmEdits(v);
		setAutoConfirmEditsState(v);
	};
	/**
	 * 落地经典模式状态:写本地缓存 + 置 state;开启时把视图从已隐藏的页
	 * (舞台)拉回编辑页,避免停在一张不存在的页面上。
	 */
	const applyClassicMode = useCallback((enabled: boolean) => {
		persistClassicMode(enabled);
		setClassicModeState(enabled);
		if (enabled) setView((v) => (isClassicView(v) ? v : "edit"));
	}, []);
	/**
	 * 对话与章节的关系(chapter = 一节一段对话 / book = 各聊各的)。与经典模式同款:
	 * 权威值在服务端 settings.json(决定 WriterHost 的会话身份语义),这里读本地缓存
	 * 供首帧渲染(否则编辑页会先按 chapter 模式画一帧、再冒出对话切换器),挂载后
	 * GET /api/settings 对账并以服务端为准,其他窗口的切换经 settings_changed 同步。
	 */
	const [conversationScope, setConversationScopeState] = useState<ConversationScopeDto>(() => readConversationScope());
	const applyConversationScope = useCallback((scope: ConversationScopeDto) => {
		persistConversationScope(scope);
		setConversationScopeState(scope);
	}, []);
	/**
	 * 外部命令(bash):agent 能否执行 shell 命令。同样以服务端为准——
	 * 它不改变页面结构(没有首帧渲染依赖),所以不落 localStorage,直接随服务端对账。
	 */
	const [shellEnabled, setShellEnabledState] = useState(false);
	const applyShellEnabled = useCallback((enabled: boolean) => {
		setShellEnabledState(enabled);
	}, []);
	/**
	 * shell 方言(bash / pwsh)与显式路径:同样以服务端为准(它决定 agent 实际执行
	 * 哪种 shell 与提示词怎么叙述)。`resolvedShell` 是服务端解析结果——选了 pwsh 但
	 * 本机没装时 dialect 为 "none",设置页据此给出提示。
	 */
	const [shellKind, setShellKindState] = useState<ShellKindDto>("bash");
	const [shellPath, setShellPathState] = useState("");
	const [resolvedShell, setResolvedShell] = useState<ResolvedShellDto | null>(null);
	const applyShellSettings = useCallback((settings: WriterSettingsDto, resolved?: ResolvedShellDto) => {
		setShellKindState(settings.shellKind);
		setShellPathState(settings.shellPath);
		if (resolved) setResolvedShell(resolved);
	}, []);
	/**
	 * 更新 shell 方言/路径:先乐观置位(下拉即时响应),再写服务端;服务端是权威值,
	 * 以它的解析结果回写(失败回滚到调用方给的 prev 并抛给调用方展示错误)。
	 * 服务端写入会释放已建会话,下次对话按新装配重建(agent 实际执行的 shell 与
	 * 提示词里的方言说明都在装配时定下),所以这一步不能只改本地。
	 */
	const changeShellSettings = useCallback(
		async (patch: { shellKind?: ShellKindDto; shellPath?: string }, prev: { shellKind: ShellKindDto; shellPath: string }) => {
			setShellKindState(patch.shellKind ?? prev.shellKind);
			setShellPathState(patch.shellPath ?? prev.shellPath);
			try {
				const { settings, shell } = await client.putSettings(patch);
				applyShellSettings(settings, shell);
			} catch (e) {
				setShellKindState(prev.shellKind);
				setShellPathState(prev.shellPath);
				throw e;
			}
		},
		[client, applyShellSettings],
	);
	const changeShellEnabled = useCallback(
		async (v: boolean) => {
			const prev = shellEnabled;
			applyShellEnabled(v);
			try {
				const { settings, shell } = await client.putSettings({ enableShell: v });
				applyShellEnabled(settings.enableShell);
				applyShellSettings(settings, shell);
			} catch (e) {
				applyShellEnabled(prev);
				throw e;
			}
		},
		[client, shellEnabled, applyShellEnabled, applyShellSettings],
	);
	/**
	 * 图片生成(实验,0.1.0):整份子集以服务端为准 —— 它决定 `image_generate` 工具
	 * 存不存在(关了就对 AI 不可见)。与 shell 开关同款,不落 localStorage。
	 * 初值取默认设置,挂载后由 GET /api/settings 对账覆盖。
	 */
	/** 应用版本(GET /api/settings 附带;设置页页脚展示)。null = 还没拿到。 */
	const [appVersion, setAppVersion] = useState<string | null>(null);
	const [imageSettings, setImageSettingsState] = useState<ImageSettingsSlice>(() => ({
		enableImageGen: false,
		imageProvider: "openai-images",
		imageModel: "gpt-image-1",
		imageSize: "3:2",
		imageBaseUrl: "",
		imageApiKey: "",
		imageInReply: true,
		imageWorldbook: true,
		imageConfirmBeforeGen: true,
	}));
	const applyImageSettings = useCallback((settings: WriterSettingsDto) => {
		setImageSettingsState({
			enableImageGen: settings.enableImageGen,
			imageProvider: settings.imageProvider,
			imageModel: settings.imageModel,
			imageSize: settings.imageSize,
			imageBaseUrl: settings.imageBaseUrl,
			imageApiKey: settings.imageApiKey,
			imageInReply: settings.imageInReply,
			imageWorldbook: settings.imageWorldbook,
			imageConfirmBeforeGen: settings.imageConfirmBeforeGen,
		});
	}, []);
	/**
	 * 上下文预算(2026-10-10):五项数值设置,决定背景包/记忆装配时的裁剪上限。
	 * 与图片生成同款 —— 权威值在服务端 settings.json,不落 localStorage,
	 * 挂载后由 GET /api/settings 对账覆盖,其他窗口的改动经 settings_changed 同步。
	 * 初值用服务端默认值(见 src/writer-settings.ts 的 defaultWriterSettings)。
	 */
	const [budgetSettings, setBudgetSettingsState] = useState<BudgetSettingsSlice>(() => ({
		contextBudget: 2000,
		memoryBudget: 1500,
		activationDepth: 0,
		noticeInjectLimit: 10,
		completedMilestoneLimit: 6,
	}));
	const applyBudgetSettings = useCallback((settings: WriterSettingsDto) => {
		setBudgetSettingsState({
			contextBudget: settings.contextBudget,
			memoryBudget: settings.memoryBudget,
			activationDepth: settings.activationDepth,
			noticeInjectLimit: settings.noticeInjectLimit,
			completedMilestoneLimit: settings.completedMilestoneLimit,
		});
	}, []);
	/**
	 * 更新上下文预算:先乐观置位(输入框即时响应),再写服务端 —— 服务端会按与
	 * parseWriterSettings 同一套规则钳制越界值,故以它返回的完整设置回写
	 * (用户输入 50000 会显示成 20000,而不是显示 50000 却按 20000 装配)。
	 * 失败回滚并把错误抛给设置页展示。
	 *
	 * 这类改动**不释放已建会话** —— 装配时现读设置(见 server.ts injectChapterContext),
	 * 下一次注入即用新值,不像经典模式/提示词那样需要重建 agent。
	 */
	const changeBudgetSettings = useCallback(
		async (patch: Partial<BudgetSettingsSlice>) => {
			const prev = budgetSettings;
			setBudgetSettingsState({ ...prev, ...patch });
			try {
				const { settings } = await client.putSettings(patch);
				applyBudgetSettings(settings);
			} catch (e) {
				setBudgetSettingsState(prev);
				throw e;
			}
		},
		[client, budgetSettings, applyBudgetSettings],
	);
	/**
	 * 更新图片生成设置:先乐观置位(开关即时响应),再写服务端 —— 服务端是权威值,
	 * 以它返回的完整设置回写;失败回滚并把错误抛给设置页展示。
	 */
	const changeImageSettings = useCallback(
		async (patch: Partial<ImageSettingsSlice>) => {
			const prev = imageSettings;
			setImageSettingsState({ ...prev, ...patch });
			try {
				const { settings } = await client.putSettings(patch);
				applyImageSettings(settings);
			} catch (e) {
				setImageSettingsState(prev);
				throw e;
			}
		},
		[client, imageSettings, applyImageSettings],
	);
	/**
	 * 自定义系统提示词(2026-10-10)。与服务端 settings.json 同源,不落 localStorage:
	 * 它决定会话装配用的提示词文本,只有服务端那一份才算数。
	 * 初值取空串(空 = 用内置),挂载后由 GET /api/settings 对账覆盖。
	 */
	const [customPrompts, setCustomPromptsState] = useState<CustomPromptsSlice>({ customWriterPrompt: "", customEditorPrompt: "" });
	const applyCustomPrompts = useCallback((settings: WriterSettingsDto) => {
		setCustomPromptsState({
			customWriterPrompt: settings.customWriterPrompt,
			customEditorPrompt: settings.customEditorPrompt,
		});
	}, []);
	/**
	 * 更新自定义提示词:先乐观置位(文本框即时响应),再写服务端 —— 服务端是权威值,
	 * 以它返回的完整设置回写(它可能已经做了限长/纯空白归一);失败回滚并抛给设置页展示。
	 * 服务端写入会释放已建会话,下次对话按新提示词装配。
	 */
	const changeCustomPrompts = useCallback(
		async (patch: Partial<CustomPromptsSlice>) => {
			const prev = customPrompts;
			setCustomPromptsState({ ...prev, ...patch });
			try {
				const { settings } = await client.putSettings(patch);
				applyCustomPrompts(settings);
			} catch (e) {
				setCustomPromptsState(prev);
				throw e;
			}
		},
		[client, customPrompts, applyCustomPrompts],
	);
	/**
	 * 切换经典模式:先本地落盘 + 置位(开关即时响应),再写服务端;服务端是权威值,
	 * 以它的返回为准回写(失败回滚本地并抛给调用方展示错误)。服务端写入会释放
	 * 已建会话,下次对话按新装配重建 agent,所以这一步不能只改本地。
	 */
	const changeClassicMode = useCallback(
		async (v: boolean) => {
			const prev = classicMode;
			applyClassicMode(v);
			try {
				const { settings } = await client.putSettings({ classicMode: v });
				applyClassicMode(settings.classicMode);
			} catch (e) {
				applyClassicMode(prev);
				throw e;
			}
		},
		[client, classicMode, applyClassicMode],
	);
	/**
	 * 切换对话与章节的关系:先本地落盘 + 置位(开关即时响应),再写服务端;
	 * 服务端是权威值,以它的返回为准回写(失败回滚本地并抛给调用方展示错误)。
	 * 服务端写入会释放已建编剧会话,下次对话按新语义定位 —— 所以不能只改本地。
	 */
	const changeConversationScope = useCallback(
		async (scope: ConversationScopeDto) => {
			const prev = conversationScope;
			applyConversationScope(scope);
			try {
				const { settings } = await client.putSettings({ conversationScope: scope });
				applyConversationScope(settings.conversationScope);
			} catch (e) {
				applyConversationScope(prev);
				throw e;
			}
		},
		[client, conversationScope, applyConversationScope],
	);
	/** 首启向导状态:挂载时查一次服务端(~/.pi/writer/setup.json)。 */
	const [setupPhase, setSetupPhase] = useState<SetupPhase>("checking");
	/** 设置页「重新运行配置向导」:向导以覆盖层叠加(页面保持挂载,流式状态不丢)。 */
	const [rerunWizard, setRerunWizard] = useState(false);
	/** 向导覆盖层的退场:关掉后仍挂 200ms,让整屏壳淡出(见 styles/presence.css)。 */
	const wizardPresence = useExitPresence(rerunWizard);
	useEffect(() => {
		let cancelled = false;
		client
			.getSetup()
			.then((r) => {
				if (!cancelled) setSetupPhase(r.completed ? "done" : "pending");
			})
			.catch(() => {
				// 状态检查失败不挡主界面:当作已完成(下次启动会再查)
				if (!cancelled) setSetupPhase("done");
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	// 服务端设置对账 + 多窗口同步:挂载时拉一次(~/.pi/writer/settings.json,权威值),
	// 之后由 settings_changed 广播驱动(另一窗口切了经典模式,本窗口导航跟着变)。
	// 拉取失败沿用本地缓存——设置读取失败不该把界面卡在未知状态。
	useEffect(() => {
		let cancelled = false;
		client
			.getSettings()
			.then(({ settings, shell, appVersion }) => {
				if (cancelled) return;
				setAppVersion(appVersion);
				applyClassicMode(settings.classicMode);
				applyConversationScope(settings.conversationScope);
				applyShellEnabled(settings.enableShell);
				applyShellSettings(settings, shell);
				applyImageSettings(settings);
				applyCustomPrompts(settings);
				applyBudgetSettings(settings);
			})
			.catch(() => {
				/* 读取失败:沿用本地缓存 */
			});
		const unsub = client.subscribeEvents((e) => {
			if (e.type !== "settings_changed") return;
			applyClassicMode(e.settings.classicMode);
			applyConversationScope(e.settings.conversationScope);
			applyShellEnabled(e.settings.enableShell);
			applyShellSettings(e.settings);
			applyImageSettings(e.settings);
			applyCustomPrompts(e.settings);
			applyBudgetSettings(e.settings);
		});
		return () => {
			cancelled = true;
			unsub();
		};
	}, [client, applyClassicMode, applyConversationScope, applyShellEnabled, applyShellSettings]);

	// 插件前端 JS:trusted 插件的 frontend.mjs 经 <script module> 注入;状态变化(启停)
	// 由设置页操作驱动,此处仅挂载+定期对账(30s);插件脚本错误静默不影响主界面。
	useEffect(() => {
		if (setupPhase !== "done") return;
		let cancelled = false;
		const sync = () => {
			client
				.getPlugins()
				.then((plugins) => {
					if (!cancelled) syncPluginScripts(plugins);
				})
				.catch(() => {
					/* 插件列表拉取失败:脚本对账跳过(下次再试) */
				});
		};
		sync();
		const timer = setInterval(sync, 30_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [client, setupPhase]);

	// 声明式浮窗:插件在 plugin.json 里声明的 windows 渲染到全局层。
	// 与上面同一份插件列表(30s 对账 + 状态变化即时刷新)。
	const { windows: pluginWindows, layerRef: pluginLayerRef } = usePluginWindows(client, setupPhase === "done");

	// 首启:向导独占渲染,主界面四页尚未挂载——完成后才挂载,WritePage 的挂载
	// 效应会拉书列表并自动打开第一本书(向导建的书记得一进去就打开)。
	if (setupPhase === "checking") return <div className="wz-boot" />;
	if (setupPhase === "pending") {
		return (
			<SetupWizard
				client={client}
				autoExpandThinking={autoExpandThinking}
				onAutoExpandThinkingChange={setAutoExpandThinking}
				autoConfirmEdits={autoConfirmEdits}
				onAutoConfirmEditsChange={setAutoConfirmEdits}
				classicMode={classicMode}
				onClassicModeChange={changeClassicMode}
				conversationScope={conversationScope}
				onConversationScopeChange={changeConversationScope}
				shellEnabled={shellEnabled}
				onShellEnabledChange={changeShellEnabled}
				onFinished={() => setSetupPhase("done")}
			/>
		);
	}
	return (
		<div className="app">
			<header className="topbar">
				<div className="brand">
					pi<i>·writer</i>
				</div>
				{/* 导航紧跟品牌靠左(旧版把它推到右侧),书名/字数交给各页自己的页头,
				    顶栏只留「我现在在哪」与「存没存」两件事 */}
				<nav className="top-nav">
					{/* 经典模式(单 agent)去掉的只有舞台:导演/演员/旁白那套多 agent 共演。
					    世界书页没有 agent(面向人的设定编辑器),留着照常用 */}
					{!classicMode && (
						<button
							type="button"
							className={view === "stage" ? "top-entry active" : "top-entry"}
							onClick={() => setView("stage")}
						>
							<IconStage size={15} />
							<span className="top-entry-label">舞台</span>
						</button>
					)}
					<button
						type="button"
						className={view === "edit" ? "top-entry active" : "top-entry"}
						onClick={() => setView("edit")}
					>
						<IconEdit size={15} />
						<span className="top-entry-label">编辑</span>
					</button>
					<button
						type="button"
						className={view === "world" ? "top-entry active" : "top-entry"}
						onClick={() => setView("world")}
					>
						<IconGlobe size={15} />
						<span className="top-entry-label">世界书</span>
					</button>
					<button
						type="button"
						className={view === "settings" ? "top-entry active" : "top-entry"}
						onClick={() => setView("settings")}
					>
						<IconGear size={15} />
						<span className="top-entry-label">设置</span>
					</button>
					{/* UI 房:组件陈列室,只在调试模式里出现(它是开发者的排障页,不是给用户的第五页) */}
					{debugMode && (
						<button
							type="button"
							className={view === "uiroom" ? "top-entry active" : "top-entry"}
							onClick={() => setView("uiroom")}
						>
							<Lu icon="layout-grid" size={15} />
							<span className="top-entry-label">UI 房</span>
						</button>
					)}
				</nav>
				<div className="right">
					{header ? (
						<span className={!header.connected ? "stat err" : `stat ${SAVE_STYLE[header.save]?.cls ?? ""}`}>
							{header.connected ? (
								<>
									{/* 保存状态变化时柔和淡入:key 换掉 → 重挂载 → 播 .stat-text 的 fade-in
									    (原来是 keyed span + 内联 transition,重挂载的元素没有过渡起点 = 空转) */}
									<span className={`stat-icon ${SAVE_STYLE[header.save]?.cls ?? ""}`}>
										{SAVE_STYLE[header.save]?.icon ?? ""}
									</span>
									<span key={header.save} className="stat-text">
										{header.save}
									</span>
								</>
							) : (
								"连接失败"
							)}
						</span>
					) : (
						<span className="stat">未连接</span>
					)}
				</div>
			</header>
			<div className="main">
				{/* 四页常驻挂载,切换只改 hidden:写作/会话/舞台的流式状态不能随卸载丢失
				    (流式增量只在客户端,卸载后重水合会丢未完成消息);隐藏页不再重播
				    入场动画,换取状态连续性。
				    经典模式下舞台直接不挂载(不是隐藏):它的后台会话与 SSE 订阅正是
				    多 agent 那套,留着等于「关了还在跑」;切回多 agent 时重新挂载并从
				    服务端重新水合,状态不丢 */}
				{!classicMode && (
					<section className={`view ${view === "stage" ? "" : "hidden"}`}>
						<StagePage
							client={client}
							library={library}
							active={view === "stage"}
							onGoEdit={() => setView("edit")}
							debug={debugMode}
							enterBehavior={enterBehavior}
							nav={{ view, onNavigate: (v) => setView(v as View) }}
						/>
					</section>
				)}
					<section className={`view ${view === "edit" ? "" : "hidden"}`}>
						<WritePage
							client={client}
							library={library}
							onHeader={setHeader}
							debug={debugMode}
							enterBehavior={enterBehavior}
							autoConfirmEdits={autoConfirmEdits}
							classicMode={classicMode}
							conversationScope={conversationScope}
							/* 报错卡的「去设置模型 ›」:导航由 App 独占(WritePage 只管请求) */
							onOpenSettings={openModelSettings}
							/* 手机端顶栏下线,四个页面入口收进书库抽屉(App 持有当前页与切页) */
							nav={{ view, onNavigate: (v) => setView(v as View) }}
						/>
					</section>
				<section className={`view ${view === "world" ? "" : "hidden"}`}>
					<WorldPage
						client={client}
						slug={currentSlug}
						active={view === "world"}
						nav={{ view, onNavigate: (v) => setView(v as View) }}
					/>
				</section>
					{/* UI 房:与调试模式同生命周期(关掉就卸载,不留一个空壳页面) */}
					{debugMode && (
						<section className={`view ${view === "uiroom" ? "" : "hidden"}`}>
							<UIRoom
								client={client}
								slug={currentSlug}
								library={library}
								classicMode={classicMode}
								nav={{ view, onNavigate: (v) => setView(v as View) }}
							/>
						</section>
					)}
					<section className={`view ${view === "settings" ? "" : "hidden"}`}>
						<SettingsPage
							client={client}
							slug={currentSlug}
							debugMode={debugMode}
							debugShown={debugShown}
							onDebugModeChange={setDebugMode}
							autoExpandThinking={autoExpandThinking}
							onAutoExpandThinkingChange={setAutoExpandThinking}
							enterBehavior={enterBehavior}
							onEnterBehaviorChange={setEnterBehavior}
							autoConfirmEdits={autoConfirmEdits}
							onAutoConfirmEditsChange={setAutoConfirmEdits}
							classicMode={classicMode}
							onClassicModeChange={changeClassicMode}
							conversationScope={conversationScope}
							onConversationScopeChange={changeConversationScope}
							shellEnabled={shellEnabled}
							onShellEnabledChange={changeShellEnabled}
							shellKind={shellKind}
							shellPath={shellPath}
							resolvedShell={resolvedShell}
							onShellSettingsChange={changeShellSettings}
							image={imageSettings}
							onImageChange={changeImageSettings}
							customPrompts={customPrompts}
							onCustomPromptsChange={changeCustomPrompts}
							budget={budgetSettings}
							onBudgetChange={changeBudgetSettings}
							focusModelToken={settingsModelToken}
							onRerunSetup={() => setRerunWizard(true)}
							nav={{ view, onNavigate: (v) => setView(v as View) }}
							appVersion={appVersion}
						/>
					</section>
			</div>
			{/* 插件全局层:浮窗与 trusted 插件自由渲染的落脚点。position:fixed 覆盖全屏,
			    自身 pointer-events:none(不挡下层的点击),子元素各自开 auto。
			    data-plugin-layer 是给 frontend.mjs 的稳定挂载契约 —— 插件不必再
			    querySelector 猜 DOM,直接往 [data-plugin-layer] 里塞即可。 */}
			<div className="plugin-layer" data-plugin-layer ref={pluginLayerRef}>
				<PluginWindows plugins={pluginWindows} layerRef={pluginLayerRef} />
			</div>
			{/* 重运行形态:覆盖层叠加在已挂载页面上,不打断流式状态;建书后刷新书库列表 */}
			{wizardPresence.mounted && (
				<SetupWizard
					client={client}
					autoExpandThinking={autoExpandThinking}
					onAutoExpandThinkingChange={setAutoExpandThinking}
					autoConfirmEdits={autoConfirmEdits}
					onAutoConfirmEditsChange={setAutoConfirmEdits}
					classicMode={classicMode}
					onClassicModeChange={changeClassicMode}
					conversationScope={conversationScope}
					onConversationScopeChange={changeConversationScope}
					shellEnabled={shellEnabled}
					onShellEnabledChange={changeShellEnabled}
					closing={wizardPresence.closing}
					onBooksChanged={() => void library.loadBooks()}
					onFinished={() => setRerunWizard(false)}
				/>
			)}
		</div>
	);
}
