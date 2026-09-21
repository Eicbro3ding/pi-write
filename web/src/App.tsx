import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "./api/client.ts";
import { useLibrary } from "./library.ts";
import { syncPluginScripts } from "./plugin-scripts.ts";
import { IconEdit, IconGear, IconGlobe, IconStage } from "./components/Icons.tsx";
import { SetupWizard } from "./components/SetupWizard.tsx";
import { WritePage, type HeaderInfo } from "./pages/WritePage.tsx";
import { StagePage } from "./pages/StagePage.tsx";
import { WorldPage } from "./pages/WorldPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import {
	autoConfirmEditsEnabled,
	autoExpandThinkingEnabled,
	classicModeEnabled,
	debugModeEnabled,
	enterBehavior as readEnterBehavior,
	debugUnlocked,
	setAutoConfirmEdits as persistAutoConfirmEdits,
	setAutoExpandThinking as persistAutoExpandThinking,
	setClassicMode as persistClassicMode,
	setDebugMode as persistDebugMode,
	setEnterBehavior as persistEnterBehavior,
	subscribeDebugChanged,
} from "./settings.ts";
import type { ResolvedShellDto, ShellKindDto, WriterSettingsDto } from "./types.ts";
import type { EnterBehavior } from "./settings.ts";

/** 顶层视图:舞台(默认,导演讨论室/演出现场)| 编辑(正文 + 编剧)| 世界书 | 设置。 */
type View = "stage" | "edit" | "world" | "settings";

/**
 * 经典模式(单 agent)下仍然存在的视图:编辑页 + 世界书 + 设置——
 * 去掉的只有舞台(导演/演员/旁白那套多 agent 共演)。世界书页本身没有 agent,
 * 只是面向人的设定编辑器,留着自己改设定照样用。
 */
function isClassicView(v: View): boolean {
	return v !== "stage";
}

/** 顶栏保存状态 → 图标与颜色 class(文案来自 WritePage 上报的 SAVE_LABELS)。
 *  设计稿顶栏右侧是「● 已保存」——一个状态点 + 文案,不用勾选图标。 */
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
	 * 权威值在服务端(~/.pi/writer/settings.json,决定 agent 装配),这里读本地
	 * 缓存供首帧渲染(否则顶栏会先画出舞台入口再收回);挂载后 GET /api/settings
	 * 对账,并以服务端为准覆盖;其他窗口的切换经 settings_changed SSE 同步。
	 */
	const [classicMode, setClassicModeState] = useState<boolean>(() => classicModeEnabled());
	/** 顶栏视图;经典模式(本地缓存已开启)首帧直接落在编辑页。 */
	const [view, setView] = useState<View>(() => (classicModeEnabled() ? "edit" : "stage"));
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
	};
	// 控制台解锁/锁定后(requestDebugChanged 事件)同步界面:否则设置页要刷新才认账
	useEffect(
		() =>
			subscribeDebugChanged(() => {
				setDebugShown(debugUnlocked());
				setDebugModeState(debugModeEnabled());
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
	/** 首启向导状态:挂载时查一次服务端(~/.pi/writer/setup.json)。 */
	const [setupPhase, setSetupPhase] = useState<SetupPhase>("checking");
	/** 设置页「重新运行配置向导」:向导以覆盖层叠加(页面保持挂载,流式状态不丢)。 */
	const [rerunWizard, setRerunWizard] = useState(false);
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
			.then(({ settings, shell }) => {
				if (cancelled) return;
				applyClassicMode(settings.classicMode);
				applyShellEnabled(settings.enableShell);
				applyShellSettings(settings, shell);
			})
			.catch(() => {
				/* 读取失败:沿用本地缓存 */
			});
		const unsub = client.subscribeEvents((e) => {
			if (e.type !== "settings_changed") return;
			applyClassicMode(e.settings.classicMode);
			applyShellEnabled(e.settings.enableShell);
			applyShellSettings(e.settings);
		});
		return () => {
			cancelled = true;
			unsub();
		};
	}, [client, applyClassicMode, applyShellEnabled, applyShellSettings]);

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
				</nav>
				<div className="right">
					{header ? (
						<span className={!header.connected ? "stat err" : `stat ${SAVE_STYLE[header.save]?.cls ?? ""}`}>
							{header.connected ? (
								<>
									{/* 保存状态文案变化时柔和淡入;字数在各页页头,不在这里重复 */}
									<span className={`stat-icon ${SAVE_STYLE[header.save]?.cls ?? ""}`}>
										{SAVE_STYLE[header.save]?.icon ?? ""}
									</span>
									<span key={header.save} style={{ transition: "opacity 140ms" }}>
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
						<StagePage client={client} library={library} active={view === "stage"} onGoEdit={() => setView("edit")} debug={debugMode} enterBehavior={enterBehavior} />
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
						/>
					</section>
				<section className={`view ${view === "world" ? "" : "hidden"}`}>
					<WorldPage client={client} slug={currentSlug} active={view === "world"} />
				</section>
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
							shellEnabled={shellEnabled}
							onShellEnabledChange={changeShellEnabled}
							shellKind={shellKind}
							shellPath={shellPath}
							resolvedShell={resolvedShell}
							onShellSettingsChange={changeShellSettings}
							onRerunSetup={() => setRerunWizard(true)}
						/>
					</section>
			</div>
			{/* 重运行形态:覆盖层叠加在已挂载页面上,不打断流式状态;建书后刷新书库列表 */}
			{rerunWizard && (
				<SetupWizard
					client={client}
					autoExpandThinking={autoExpandThinking}
					onAutoExpandThinkingChange={setAutoExpandThinking}
					autoConfirmEdits={autoConfirmEdits}
					onAutoConfirmEditsChange={setAutoConfirmEdits}
					classicMode={classicMode}
					onClassicModeChange={changeClassicMode}
					onBooksChanged={() => void library.loadBooks()}
					onFinished={() => setRerunWizard(false)}
				/>
			)}
		</div>
	);
}
