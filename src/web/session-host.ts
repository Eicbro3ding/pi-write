/**
 * SessionHost —— 把 agent 会话引擎(AgentSessionRuntime)封装为 headless 服务端组件,
 * 供后续 HTTP 服务使用:持有 runtime、把会话事件扇出给订阅者、转发
 * prompt/abort/switchSession/setModel 等命令,并对外提供 getState() 状态快照。
 *
 * runtime 由调用方通过 createRuntime 工厂注入(工厂内部按 cli.ts 逻辑装配
 * writerExtension、隐藏 skill 命令、tools 列表),本类不自行构造 services。
 */

import { basename, dirname, join } from "node:path";
import type { ThinkingLevel } from "../../vendor/pi-agent-core/src/index.ts";
import {
	type AgentSessionEvent,
	type AgentSessionRuntime,
	createAgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	resolveCliModel,
	SessionManager,
} from "../../vendor/pi-coding-agent/src/index.ts";
import type { AuthInteraction } from "../../vendor/pi-ai/src/index.ts";
// 2026-10-04(T6):深层路径 import 收口到 pi-adapter,本文件不再直接碰 vendor 源码
import { fromFactoryHandle, fromHandle, projectUsageCost } from "../pi-adapter/index.ts";
import { settleDanglingAsks } from "../ask-user.ts";
import { getBooksDir } from "../config.ts";
import { buildSessionTree, type SessionTreeInfo } from "../session-tree.ts";
import { dedupePaths, skillDirsOf, toolGuardContext } from "../tool-guard.ts";
import {
	chatContentOfMessage,
	chatTextOfMessage,
	chatThinkingOfMessage,
	toolResultCallId,
	toolResultText,
	type ChatContentPart,
} from "../session-text.ts";
import { createKeyInteraction, deriveAuthKind, sortProviders, type ProviderDetail, type ProviderListItem } from "./provider-auth.ts";

// 2026-10-04(T6):以下 9 个对外接口迁入 pi-adapter/domain.ts,这里重导出,
// 保持既有 import 点(`from "./session-host.ts"`)不变。
// 迁走的理由:其中 SessionHostOptions 原先直接写着 vendor 的 SessionManager /
// CreateAgentSessionRuntimeFactory 类型,属于「vendor 类型泄漏」—— vendor 改名时
// 自研侧会同时红,而那跟写作领域毫无关系。
//
// 注意必须是「先 import 再 export」而不是 `export type { ... } from`:
// 本文件内部仍在用这些名字(SessionHostOptions / SessionStateSnapshot ...),
// 只 re-export 不会把它们带进当前作用域,会一路报 Cannot find name。
import type {
	ModelRefreshSummary,
	SessionCompactionResult,
	SessionContextUsage,
	SessionHostOptions,
	SessionStateSnapshot,
	SessionUsageStats,
	ThinkingLevelResult,
	ThinkingSummary,
} from "../pi-adapter/index.ts";

export type {
	ModelRefreshSummary,
	SessionCompactionResult,
	SessionContextUsage,
	SessionHostOptions,
	SessionStateSnapshot,
	SessionUsageStats,
	ThinkingLevelResult,
	ThinkingSummary,
};

export class SessionHost {
	private runtime: AgentSessionRuntime | undefined;
	private unsubscribeSession: (() => void) | undefined;
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly options: SessionHostOptions;
	/**
	 * 当前会话的 SessionManager。构造时来自 options;reloadRuntime() 重建
	 * runtime 时会以「当前会话文件」重新 open(保留切章后的会话位置)。
	 */
	private sessionManager: SessionManager;
	/**
	 * runtime 重建时要恢复的会话级设置(2026-10 审计 BUG-009):
	 * API 切过的模型/思考档位/采样参数,不能被启动参数在重建后盖回去。
	 */
	private runtimeDefaults: RuntimeDefaults = { model: null, thinkingLevel: null, temperature: null, topP: null };
	/** dispose() 之后置位:把「已释放」与「尚未 start」区分开(RISK-004 的诊断语义)。 */
	private released = false;

	constructor(options: SessionHostOptions) {
		this.options = options;
		// 2026-10-04(T6):对外契约收句柄(`SessionManagerHandle`),内部立刻还原为实体。
		// 句柄与实体运行期是同一个对象,这次转换零开销;收益是自研侧不再有人能
		// 顺着这个字段摸到 vendor 的 SessionManager 类型。
		this.sessionManager = fromHandle(options.sessionManager);
		// 上一进程/上一运行时留下的未答提问:闸门是纯内存的,重启后那张卡永远
		// 等不到回答,不补结果的话前端重载会弹出一张点不动的死卡(2026-09)。
		settleDanglingAsks(this.sessionManager);
	}

	async start(): Promise<void> {
		// createRuntime 工厂由调用方注入(内含 writerExtension、隐藏 skill 命令、tools 列表),
		// 返回 CreateAgentSessionRuntimeResult({ session, extensionsResult, services, diagnostics });
		// 经 createAgentSessionRuntime 包装成 AgentSessionRuntime(含 session/switchSession/dispose)后持有,
		// 与 cli.ts 的装配路径一致。
		this.runtime = await createAgentSessionRuntime(fromFactoryHandle(this.options.createRuntime), {
			cwd:
				(typeof this.sessionManager.getCwd === "function" && this.sessionManager.getCwd()) ||
				this.options.cwd,
			agentDir: this.options.agentDir,
			sessionManager: this.sessionManager,
			sessionStartEvent: undefined,
		});
		this.markStarted();
		this.bindSession();
		// 重建后把 API 切过的会话级设置重新套上(见 reloadRuntime 的说明/BUG-009)
		await this.applyRuntimeDefaults();
	}

	/**
	 * 抓一份「当前会话级设置」,用于 runtime 重建后恢复(2026-10 审计 BUG-009)。
	 *
	 * 背景:装配工厂的 `model` / `thinkingLevel` 来自**启动参数**(web.ts 传 opts.model /
	 * opts.thinking),重建时它们会盖回 API 已经切换过的值 —— 用户切了模型 B、改过思考档位,
	 * 一次 MCP 配置变更(reloadRuntime)就静默退回 `--model A` / 启动档位。
	 */
	private captureRuntimeDefaults(rt: AgentSessionRuntime | undefined): RuntimeDefaults {
		const state = (rt?.session as { state?: { model?: unknown; thinkingLevel?: unknown; temperature?: unknown; topP?: unknown } } | undefined)?.state;
		const model = usableModelRef(state?.model);
		return {
			model,
			thinkingLevel: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null,
			temperature: typeof state?.temperature === "number" ? state.temperature : null,
			topP: typeof state?.topP === "number" ? state.topP : null,
		};
	}

	/**
	 * 把 {@link captureRuntimeDefaults} 抓到的设置套到**当前** runtime 上。
	 * 只在尚未显式设置过一次以后才需要恢复;首次 start 时 defaults 为空,是空操作。
	 *
	 * 模型走 vendor 的内部重绑(`resyncModelInstance`):这是「恢复用户已有选择」而不是
	 * 「用户主动换模型」,不该追加 model_change / 改写全局默认(BUG-008 同一原则)。
	 * 鉴权在发请求时再校验,重建过程不因为某个 provider 掉 key 而失败。
	 */
	private async applyRuntimeDefaults(): Promise<void> {
		const rt = this.runtime;
		if (!rt) return;
		const d = this.runtimeDefaults;
		if (d.model) {
			const fresh = rt.services.modelRuntime.getModel(d.model.provider, d.model.id);
			const session = rt.session as { resyncModelInstance?: (model: unknown) => unknown };
			if (fresh && typeof session.resyncModelInstance === "function") session.resyncModelInstance(fresh);
			else if (fresh) await rt.session.setModel(fresh).catch(() => undefined);
		}
		if (d.thinkingLevel) {
			(rt.session as { setThinkingLevel?: (level: string) => unknown }).setThinkingLevel?.(d.thinkingLevel);
		}
		if (d.temperature !== null || d.topP !== null) {
			// persist=false:这是恢复会话状态,不改全局默认(与演员级覆盖同款语义)
			(rt.session as { setSamplingParameters?: (t?: number | null, p?: number | null, persist?: boolean) => unknown }).setSamplingParameters?.(
				d.temperature,
				d.topP,
				false,
			);
		}
	}

	/**
	 * 重建运行时(如 MCP 配置变更后让新工具生效):关闭旧 runtime,
	 * 以当前会话文件重新 open SessionManager 并 start(createRuntime 工厂
	 * 会被再次调用,调用方工厂里的 McpManager.getTools() 已返回新工具)。
	 * 注意:reload 后 nextTurn 背景包会丢失,调用方需重新注入章节背景包。
	 * 分支位置(leaf 指针)只在内存,open 会落到文件最深路径——重建后恢复
	 * 原 leaf,避免配置保存把当前对话"切"到其他分支(串对话)。
	 */
	async reloadRuntime(): Promise<void> {
		const rt = this.runtime;
		const sessionFile = rt?.session.sessionManager.getSessionFile() ?? null;
		const prevLeafId = rt?.session.sessionManager.getLeafId() ?? null;
		const prevCwd = rt?.session.sessionManager.getCwd() ?? this.options.cwd;
		// 重建前抓当前会话级设置(BUG-009):装配工厂只认启动参数,不抓就会在重建后
		// 把 API 切换过的模型/思考档位静默退回 --model / --thinking
		this.runtimeDefaults = this.captureRuntimeDefaults(rt);
		await this.dispose();
		if (sessionFile) {
			// 会话文件在 sessions/<slug>/<file>.jsonl:父目录即 sessionsDir,cwd 保持不变
			this.sessionManager = SessionManager.open(sessionFile, dirname(sessionFile), prevCwd);
			if (prevLeafId && this.sessionManager.getEntry(prevLeafId)) {
				this.sessionManager.branch(prevLeafId);
			}
		}
		await this.start();
	}

	/** 把事件扇出绑定到当前 session;先解除旧 session 的订阅,再订阅 this.runtime.session。 */
	private bindSession(): void {
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		const runtime = this.runtime;
		if (!runtime) return;
		this.unsubscribeSession = runtime.session.subscribe((event) => {
			// message_end 事件附加会话 entry id(vendor 的 AgentMessage 无 id 字段,
			// id 在 SessionEntry 层;前端实时消息据此获得稳定 id,撤回按钮才能定位)。
			// 注意:vendor 的 _handleAgentEvent 是先 emit 再 appendMessage(2026-08 实测),
			// emit 时「当前这条消息」通常尚未落盘;只按 role 同步反查会命中上一条
			// 同角色消息。因此先按 role + 文本精确匹配,匹配不到再等 append 完成后
			// 补发带 entryId 的 message_end(前端 reducer 重复处理幂等)。
			let enriched: AgentSessionEvent & { entryId?: string } = event;
			if (event.type === "message_end") {
				// vendor 先 emit 后 appendMessage;同步反查 branch 若只按 role 匹配会命中
				// 上一条同角色消息。这里先按 role + 文本精确匹配(测试与已落盘场景),
				// 匹配不到再延迟到 append 完成后补发带 entryId 的 message_end。
				const role = event.message.role;
				const eventText = chatTextOfMessage(event.message as { role?: string; content?: unknown });
				let matched = false;
				if (eventText !== undefined) {
					const branch = runtime.session.sessionManager.getBranch();
					for (let i = branch.length - 1; i >= 0; i--) {
						const entry = branch[i]!;
						if (entry.type !== "message") continue;
						const message = (entry as { message?: { role?: string; content?: unknown } }).message;
						if (message?.role === role && chatTextOfMessage(message) === eventText) {
							enriched = { ...event, entryId: entry.id };
							matched = true;
							break;
						}
					}
				}
				if (!matched) {
					const rt = runtime;
					// 事件时刻的分支长度:延迟补发只看**之后新追加**的 entry,
					// 否则会命中早先那条同角色的旧消息(RISK-003 的另一半)
					const beforeLen = runtime.session.sessionManager.getBranch().length;
					setTimeout(() => {
						// runtime 可能已被切书/重建(switchSession/reloadRuntime):放弃补发
						if (this.runtime !== rt) return;
						// 2026-10 审计 RISK-003:延迟回退此前**只按 role 反查**,同角色消息在
						// append 之前插进来就会把 entryId 绑到另一条消息上(前端撤回/编辑随后作用
						// 在错的对象上)。现在必须同时比较 role 与文本,且只认**唯一**命中:
						// 文本对不上或命中不唯一就**不补发** —— 宁可这条消息暂时没有稳定 id
						// (前端不给撤回按钮),也不能绑错。
						if (eventText === undefined) return;
						const branch2 = rt.session.sessionManager.getBranch();
						if (branch2.length <= beforeLen) return; // append 还没发生:放弃
						let hitId: string | undefined;
						let hits = 0;
						for (let i = beforeLen; i < branch2.length; i++) {
							const entry = branch2[i]!;
							if (entry.type !== "message") continue;
							const message = (entry as { message?: { role?: string; content?: unknown } }).message;
							if (message?.role !== role) continue;
							if (chatTextOfMessage(message) !== eventText) continue;
							hits++;
							hitId = entry.id;
						}
						if (hits !== 1 || hitId === undefined) return;
						const late = { ...event, entryId: hitId } as AgentSessionEvent & { entryId?: string };
						for (const l of this.listeners) l(late);
					}, 0);
				}
			}
			for (const l of this.listeners) l(enriched);
		});
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private requireRuntime(): AgentSessionRuntime {
		// 释放与「从未启动」区分开:前者是生命周期竞态(调用方该重试/换宿主),
		// 后者是装配顺序错误(2026-10 审计 RISK-004)
		if (!this.runtime) throw new Error(this.released ? "会话已释放" : "SessionHost 尚未 start");
		return this.runtime;
	}

	/** 在工具路径守卫上下文中执行(fn 内 session 工具调用的 cwd 由此确定)。 */
	private runInToolGuardContext<T>(fn: () => Promise<T>): Promise<T> {
		const rt = this.requireRuntime();
		const sm = (rt.session as { sessionManager?: { getCwd?: () => string } }).sessionManager;
		const cwd =
			(typeof sm?.getCwd === "function" && sm.getCwd()) ||
			this.options.cwd;
		return toolGuardContext.run(
			{
				bookDir: cwd,
				// 只读放行 = 调用方基线 + **本 runtime 实际加载到的技能目录**。
				// 后者才是权威:agentDir/skills、<cwd>/.pi/skills、插件与 package 的技能
				// 都会被 vendor 加载进系统提示词,基线清单里没有它们(2026-10-01)。
				readOnlyDirs: dedupePaths(
					this.options.toolGuard?.readOnlyDirs,
					skillDirsOf(rt.services.resourceLoader.getSkills().skills),
				),
				draftFile: this.options.toolGuard?.draftFile,
			},
			fn,
		);
	}

	async sendMessage(text: string): Promise<void> {
		await this.runInToolGuardContext(() => this.requireRuntime().session.prompt(text));
	}
	/**
	 * 以 nextTurn 模式注入一段上下文(custom 消息,随下个用户 prompt 进入,不触发独立回复)。
	 * display 为 vendor CustomMessage 必填字段;display true 表示消息会渲染进聊天,
	 * 但 web 路径经 extractMessages 只提取 user/assistant 文本,该 custom 消息对界面不可见。
	 */
	async injectContext(text: string): Promise<void> {
		await this.runInToolGuardContext(async () => {
			const rt = this.requireRuntime();
			await rt.session.sendCustomMessage(
				{ customType: "world-context", content: [{ type: "text", text }], display: true },
				{ deliverAs: "nextTurn" },
			);
		});
	}
	async abort(): Promise<void> {
		await this.requireRuntime().session.abort();
	}

	/** 上下文占用快照(纯读;runtime 未启动时 null)。 */
	getContextUsage(): SessionContextUsage | null {
		const rt = this.runtime;
		if (!rt) return null;
		const usage = rt.session.getContextUsage();
		return usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null;
	}

	/**
	 * 会话用量统计(2026-09-23):vendor 的 `getSessionStats()` 原生就有
	 * —— 消息计数 + tokens(input/output/cacheRead/cacheWrite/total)+ **cost**
	 * + 顺带 contextUsage。它累加**整个会话文件**的条目(含被压缩掉的历史),
	 * 口径是「真实计费」,不是「当前上下文多大」(那个看 getContextUsage)。
	 *
	 * 另外把成本拆分(`projectUsageCost`,经 pi-adapter 收口 vendor 的
	 * `getUsageCostBreakdown`)也带上 —— 失败时返回空数组,不影响总量。
	 *
	 * 注意:`sessionFile` / `sessionId` 不外传 —— 前端不需要绝对路径。
	 */
	getSessionStats(): SessionUsageStats | null {
		const rt = this.runtime;
		if (!rt) return null;
		const s = rt.session.getSessionStats();
		// 条目形状异常(老会话等)时 projectUsageCost 内部兜底为空数组,这里不必再 try
		const breakdown = projectUsageCost(rt.session.sessionManager.getEntries());
		return {
			userMessages: s.userMessages,
			assistantMessages: s.assistantMessages,
			toolCalls: s.toolCalls,
			toolResults: s.toolResults,
			totalMessages: s.totalMessages,
			tokens: { ...s.tokens },
			cost: s.cost,
			contextUsage: this.getContextUsage(),
			breakdown,
		};
	}

	/**
	 * 手动压缩当前会话上下文。vendor compact() 会先 abort 当前流式回合,
	 * 然后调用模型生成摘要并 append 到会话;compaction_start/end 事件经本类
	 * 的事件扇出走到 SSE(前端显示「正在压缩上下文」)。
	 */
	async compact(customInstructions?: string): Promise<SessionCompactionResult> {
		const result = await this.runInToolGuardContext(() =>
			this.requireRuntime().session.compact(customInstructions),
		);
		return {
			summary: result.summary,
			tokensBefore: result.tokensBefore,
			...(result.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}),
		};
	}
	/**
	 * 仅切换运行时会话;book.json 的 currentChapterFile 由服务端路由层维护。
	 * vendor 的 switchSession 会经工厂创建全新 session 并替换内部 _session,
	 * 旧 session 上的事件订阅随之失效,因此切换后必须重新绑定。
	 */
	async switchSession(chapterAbsPath: string, cwd?: string): Promise<void> {
		if (!this.runtime) {
			// 服务端删除当前书后 runtime 已释放:下次切章时按新书目录重新启动。
			const sessionsDir = dirname(chapterAbsPath);
			const bookDir = cwd ?? join(getBooksDir(), basename(sessionsDir));
			this.sessionManager = SessionManager.open(chapterAbsPath, sessionsDir, bookDir);
			await this.start();
			return;
		}
		const rt = this.requireRuntime();
		await rt.switchSession(chapterAbsPath, ...(cwd ? [{ cwdOverride: cwd }] : []));
		this.bindSession();
	}
	async setModel(model: string): Promise<void> {
		const rt = this.requireRuntime();
		// 与 cli.ts 相同的模型解析:模型 pattern 字符串 → Model,再交给 session
		const resolved = resolveCliModel({ cliModel: model, modelRuntime: rt.services.modelRuntime });
		if (resolved.error) throw new Error(resolved.error);
		if (resolved.warning) process.stderr.write(`${resolved.warning}\n`);
		if (resolved.model) await rt.session.setModel(resolved.model);
	}
	/**
	 * 当前模型**实际支持**的思考档位(2026-10 审计 BUG-012)。
	 *
	 * vendor 的 `getSupportedThinkingLevels()` 按模型能力给集合(非推理模型只有 off;
	 * 静态 DeepSeek 映射另有 thinkingLevelMap)。前端此前固定展示 off..max 七档,
	 * 用户选到不支持的档位只会被静默 clamp —— 现在把这组值发给前端,只展示可用档位。
	 * 拿不到(fake/旧会话)返回 null,前端退回展示全量。
	 */
	thinkingLevels(): string[] | null {
		const session = this.runtime?.session as { getAvailableThinkingLevels?: () => unknown } | undefined;
		if (!session || typeof session.getAvailableThinkingLevels !== "function") return null;
		try {
			const levels = session.getAvailableThinkingLevels();
			return Array.isArray(levels) ? levels.filter((l): l is string => typeof l === "string") : null;
		} catch {
			return null;
		}
	}

	/** 本会话当前可用的模型(null = 还没选到,见 usableModelRef)。 */
	currentModel(): { provider: string; id: string } | null {
		return usableModelRef(this.runtime?.session.state.model);
	}
	/**
	 * 重读 models.json,让**已经建好的会话**看到新加/新删的自定义供应商与模型。
	 *
	 * 每个会话宿主在装配时各建一份 ModelRuntime(models.json 是那一刻读的),所以只在
	 * 主会话上刷新等于别处全是旧目录:设置页刚加完模型并选中时,已建编剧/舞台会话解析
	 * 不到那个模型(POST /api/model 报 not found),而对话继续拿 unknown 占位模型发请求,
	 * 报「No API key found for the selected model」(2026-10-04 实测根因)。
	 *
	 * 刷新后还要把会话手里的 Model 换成目录里的新实例(见 resyncModelCapabilities)。
	 *
	 * `allowNetwork` 为 true 时同时联网刷新远程目录(设置页「刷新模型列表 / 测试连接」);
	 * 缺省只重读本地 models.json(配置变更后的热重载,不发任何请求)。
	 */
	async refreshModels(options?: { allowNetwork?: boolean }): Promise<{ errors: Array<{ provider: string; message: string }>; modelCount: number }> {
		const rt = this.requireRuntime();
		// 联网刷新必须 force(远程目录有缓存);本地热重载保持原来的最小参数形态
		const result = await rt.services.modelRuntime.refresh(
			options?.allowNetwork === true ? { allowNetwork: true, force: true } : { allowNetwork: false },
		);
		await this.resyncModelCapabilities(rt);
		// 目录统计是旁支信息:最小 fake runtime 没有 getAvailable,不该让刷新整体失败
		let modelCount = 0;
		try {
			modelCount = (await rt.services.modelRuntime.getAvailable()).length;
		} catch {
			modelCount = 0;
		}
		return {
			// pi-ai 的 ModelsRefreshResult.errors 是 ReadonlyMap<providerId, Error>
			errors: [...(result?.errors ?? new Map<string, Error>()).entries()].map(([provider, e]) => ({ provider, message: e.message })),
			modelCount,
		};
	}

	/**
	 * 把 `agent.state.model` 换成目录里的**新实例**。
	 *
	 * `state.model` 是装配那一刻的对象,`reasoning` / `thinkingLevelMap` / `contextWindow` /
	 * `maxTokens` / `input` / `baseUrl` / `headers` / `compat` 这些字段跟着它走。所以
	 * 「编辑模型 → 打开支持思考 / 改上下文窗口 / 换地址」之后只刷目录不重绑,已建会话就
	 * 继续按旧能力发请求(用户在设置页看到的是新配置,实际请求用的是旧的)。
	 *
	 * 2026-10 审计 BUG-006:此前只比 `reasoning` 与 `thinkingLevelMap`,其它字段变化被
	 * 整个漏掉;现在用 MODEL_CAPABILITY_FIELDS 全量比较。
	 *
	 * 2026-10 审计 BUG-008:重绑走 vendor 的 `resyncModelInstance`(内部维护动作)——
	 * 普通 `setModel` 会顺手 `setDefaultModelAndProvider`(改写全局默认模型)并追加
	 * `model_change`(伪造一次用户主动切换),把目录热更新记成用户的模型选择。
	 * 极小的 fake session 没有该方法时退回旧路径,只为了让既有单测桩继续可用。
	 */
	private async resyncModelCapabilities(rt: AgentSessionRuntime): Promise<void> {
		// 取 state 用可选链:测试里的最小 fake session 没有 state(真会话恒有)
		const live = (rt.session as { state?: { model?: unknown } }).state?.model as { provider?: unknown; id?: unknown } | null | undefined;
		if (!live || typeof live.provider !== "string" || typeof live.id !== "string") return;
		if (live.provider === "unknown" || live.id === "unknown") return; // 占位:没有可重绑的模型
		const fresh = rt.services.modelRuntime.getModel(live.provider, live.id);
		if (!fresh) return;
		if (!modelCapabilitiesDiffer(live, fresh)) return;
		const session = rt.session as { resyncModelInstance?: (model: unknown) => unknown };
		if (typeof session.resyncModelInstance === "function") {
			session.resyncModelInstance(fresh);
			return;
		}
		try {
			await rt.session.setModel(fresh);
		} catch {
			/* 该 provider 此刻没鉴权等:保留旧实例,不影响对话(下次选模型会重绑) */
		}
	}
	setThinkingLevel(level: string): ThinkingLevelResult {
		// ThinkingLevel 是字符串字面量联合,由调用方保证传入合法值
		const session = this.requireRuntime().session;
		session.setThinkingLevel(level as ThinkingLevel);
		// vendor 的 getSupportedThinkingLevels 会按模型能力把档位 clamp 回去
		// (非推理模型只有 off)。回报**实际**档位,别把回落说成设置成功(2026-10 审计 BUG-013)。
		const state = (session as { state?: { thinkingLevel?: unknown } }).state;
		const actual = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
		return { level: actual, clamped: actual !== null && actual !== level };
	}
	/** 设置采样参数(temperature/topP);undefined 保持当前值, null 恢复模型默认。persist=false 时不写全局默认(演员级覆盖用)。 */
	setSamplingParameters(temperature?: number | null, topP?: number | null, persist = true): void {
		this.requireRuntime().session.setSamplingParameters(temperature, topP, persist);
	}

	/**
	 * 撤回某条用户消息及其之后的所有消息:把会话 leaf 指针移回该消息之前,
	 * 再以新 leaf 链重建 AI 上下文(vendor session tree 导航的同一模式:
	 * branch/resetLeaf + buildSessionContext → agent.state.messages)。
	 * 只允许撤回用户消息(工具结果/assistant 消息不可作撤回锚点);不限最新一条——
	 * 非最新消息之后的 leaf 内容一并移除(保留在文件里,不再进上下文与 getState,
	 * 与 branchMessage 同款语义,只是锚点消息本身也移除)。
	 * replacement 存在时不发送(由调用方异步重发,保持端点快速返回)。
	 */
	async retractMessage(entryId: string): Promise<void> {
		const rt = this.requireRuntime();
		const sm = rt.session.sessionManager;
		const branch = sm.getBranch();
		const entry = branch.find((e) => e.id === entryId);
		if (!entry) throw new Error(`消息不存在或不在当前对话: ${entryId}`);
		const role = (entry as { message?: { role?: string } }).message?.role;
		if (role !== "user") throw new Error("只能撤回用户消息");
		if (rt.session.isStreaming) throw new Error("AI 正在回复中,请先中止");
		// leaf 移到目标消息之前:新消息 append 时成为其父的子节点,形成新分支
		const parentId = entry.parentId;
		if (parentId) {
			sm.branch(parentId);
		} else {
			sm.resetLeaf();
		}
		// 同步内存上下文:下轮 prompt 不再包含被撤回的消息
		rt.session.agent.state.messages = sm.buildSessionContext().messages;
	}

	/**
	 * 分支对话:从某条消息处开始新分支——该消息保留(新分支起点),
	 * 其后的所有消息离开当前 leaf 链(保留在文件里,不再进上下文与 getState)。
	 * 之后新发送的消息 append 到该消息之下。回溯/改写历史对话的入口。
	 */
	async branchMessage(entryId: string): Promise<void> {
		const rt = this.requireRuntime();
		const sm = rt.session.sessionManager;
		const branch = sm.getBranch();
		const entry = branch.find((e) => e.id === entryId);
		if (!entry) throw new Error(`消息不存在或不在当前对话: ${entryId}`);
		if (entry.type !== "message") throw new Error("只能从消息处分支");
		if (rt.session.isStreaming) throw new Error("AI 正在回复中,请先中止");
		// leaf 移到该消息:其后消息离开当前分支
		sm.branch(entryId);
		rt.session.agent.state.messages = sm.buildSessionContext().messages;
	}

	/**
	 * 切换到任意消息(不限于当前 leaf 链):把 leaf 移到该消息,以其为当前分支
	 * 重建 AI 上下文。用于分支栏在多个分支之间来回切换(数据始终保留在文件里)。
	 */
	async navigateTo(entryId: string): Promise<void> {
		const rt = this.requireRuntime();
		const sm = rt.session.sessionManager;
		if (!sm.getEntry(entryId)) throw new Error(`消息不存在: ${entryId}`);
		if (rt.session.isStreaming) throw new Error("AI 正在回复中,请先中止");
		sm.branch(entryId);
		rt.session.agent.state.messages = sm.buildSessionContext().messages;
	}

	/**
	 * 会话树概览(分支 UI 数据):分支概览(起点/结尾摘要、消息数、当前标记)+
	 * 每条消息的版本视图(「‹ 2/2 ›」就地切换的数据来源)。
	 *
	 * 构造逻辑收敛在 `src/session-tree.ts`(与磁盘只读恢复路径同一份实现)——
	 * 这里只负责取运行时。
	 */
	async getSessionTree(): Promise<SessionTreeInfo> {
		const rt = this.runtime;
		if (!rt) return { currentLeafId: null, branches: [], versions: {} };
		return buildSessionTree(rt.session.sessionManager);
	}

	getRuntime(): AgentSessionRuntime {
		return this.requireRuntime();
	}

	/**
	 * 全部 provider(内置目录 + models.json 自定义)的认证状态列表,已配置置顶。
	 * 枚举依据:ModelRuntime.getModels() 返回全量模型目录(不按认证过滤,
	 * getAvailable 才过滤),按 model.provider 去重即得全部 provider id;
	 * getRegisteredProviderIds() 只含 models.json/扩展注册项,不含内置,不可用。
	 */
	async listProviders(): Promise<ProviderListItem[]> {
		const mr = this.requireRuntime().services.modelRuntime;
		const ids = [...new Set(mr.getModels().map((m) => m.provider))].sort();
		const items: ProviderListItem[] = ids.map((id) => {
			const provider = mr.getProvider(id);
			const status = mr.getProviderAuthStatus(id);
			return {
				id,
				name: provider?.name ?? id,
				configured: status.configured,
				authKind: provider ? deriveAuthKind(provider) : "ambient",
				source: status.source,
				label: status.label,
			};
		});
		return sortProviders(items);
	}

	/** 为 provider 写入 API key(官方 login 路径;多提示 provider 由 interaction 拒绝)。 */
	async setProviderApiKey(providerId: string, key: string): Promise<void> {
		const interaction: AuthInteraction = createKeyInteraction(key);
		await this.requireRuntime().services.modelRuntime.login(providerId, "api_key", interaction);
	}

	/**
	 * 供应商详情:基本信息 + 模型列表(默认模型步/设置页详情卡用)。
	 * 模型来自 getModels(providerId) 全量目录,**不按认证过滤**——未配置的
	 * 供应商也能看到它的模型(与 getAvailable 只含已认证的区别);未知 id 返回 null。
	 */
	async getProviderDetail(providerId: string): Promise<ProviderDetail | null> {
		const mr = this.requireRuntime().services.modelRuntime;
		// getModels(providerId) 对未注册 id 返回空数组;先经 getProvider 确认存在
		const provider = mr.getProvider(providerId);
		if (!provider) return null;
		const models = mr.getModels(providerId);
		const status = mr.getProviderAuthStatus(providerId);
		return {
			provider: {
				id: provider.id,
				name: provider.name ?? providerId,
				configured: status.configured,
				authKind: deriveAuthKind(provider),
				source: status.source,
				label: status.label,
				baseUrl: provider.baseUrl,
			},
			models: models.map((m) => ({
				id: m.id,
				name: m.name,
				api: m.api,
				baseUrl: m.baseUrl,
				reasoning: m.reasoning,
				input: m.input,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			})),
		};
	}

	/** 移除 provider 凭据(官方 logout 路径,自动刷新可用模型快照)。 */
	async removeProvider(providerId: string): Promise<void> {
		await this.requireRuntime().services.modelRuntime.logout(providerId);
	}

	getState(): SessionStateSnapshot {
		const rt = this.runtime;
		if (!rt) {
			return { sessionFile: null, bookSlug: null, chapterFile: null, isStreaming: false, messages: [], diagnostics: [] };
		}
		const sessionFile = rt.session.sessionManager.getSessionFile() ?? null;
		return {
			sessionFile,
			bookSlug: sessionFile ? basename(dirname(sessionFile)) : null,
			chapterFile: sessionFile ? basename(sessionFile) : null,
			isStreaming: rt.session.isStreaming,
			messages: extractMessages(rt),
			diagnostics: rt.diagnostics.map((d) => ({ type: d.type, message: d.message })),
		};
	}

	async dispose(): Promise<void> {
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		// 2026-10 审计 RISK-004:**先摘掉 runtime 再 await 关闭**。此前是
		// `await runtime.dispose()` 之后才置 undefined,关闭期间到达的请求(并发 prompt /
		// compact / 设置写入)会握着正在释放的 session 去写 —— 结果未定义。现在这些请求
		// 会拿到明确的「会话已释放」错误,由调用方重试或走新 runtime。
		const rt = this.runtime;
		this.runtime = undefined;
		this.released = true;
		await rt?.dispose();
	}

	/** 释放后再 start() 视为重新装配,复位释放标记(会话状态由调用方负责重建)。 */
	private markStarted(): void {
		this.released = false;
	}
}

/**
 * vendor 未解析到模型时给的是 `{provider:"unknown", id:"unknown", api:"unknown"}` 占位
 * (pi-agent-core 的 DEFAULT_MODEL)—— 归一为 null:前端据此显示「未设置」,模型目录
 * 变更时据此判定「这个会话还没有模型」。唯一实现,别在各处再写一遍 provider !== "unknown"。
 */
export function usableModelRef(model: unknown): { provider: string; id: string } | null {
	const m = model as { provider?: unknown; id?: unknown } | null | undefined;
	if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return null;
	return m.provider === "unknown" || m.id === "unknown" ? null : { provider: m.provider, id: m.id };
}

/**
 * 影响请求的模型字段清单(2026-10 审计 BUG-006)。
 *
 * 会话手里的 `Model` 实例是装配那一刻从目录取的;**目录里同 provider/id 的条目改了
 * 这些字段中的任何一个**,已建会话都必须换成新实例,否则「设置页显示新配置、实际请求
 * 用旧配置」。修复前只比 `reasoning` 与 `thinkingLevelMap`,于是改上下文窗口 / 最大输出 /
 * 输入类型 / 地址 / 鉴权头 / 兼容开关全都不生效。
 */
export const MODEL_CAPABILITY_FIELDS = [
	"api",
	"baseUrl",
	"reasoning",
	"thinkingLevelMap",
	"contextWindow",
	"maxTokens",
	"input",
	"headers",
	"compat",
] as const;

/** 两个模型字段是否等价(函数值按引用比 —— headers 之类可以是函数)。 */
function sameCapabilityField(a: unknown, b: unknown): boolean {
	if (typeof a === "function" || typeof b === "function") return a === b;
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 判断目录里的新实例是否与会话手里的旧实例**在影响请求的字段上有差异**。
 * 无差异时调用方不该重绑(免得每次刷新都动一次会话)。
 */
export function modelCapabilitiesDiffer(live: unknown, fresh: unknown): boolean {
	if (typeof live !== "object" || live === null || typeof fresh !== "object" || fresh === null) return false;
	for (const key of MODEL_CAPABILITY_FIELDS) {
		const a = (live as Record<string, unknown>)[key];
		const b = (fresh as Record<string, unknown>)[key];
		if (!sameCapabilityField(a, b)) return true;
	}
	return false;
}

/**
 * 把「在一批会话上设置思考档位」的结果聚合成宿主级摘要(2026-10 审计 BUG-013)。
 *
 * 逐个尝试、失败不抛:某个会话临时没有 runtime 不该让其余的也跟着不动,但失败**必须**
 * 出现在 `failed` 里(调用方据此在响应里点名是哪个宿主没设上,而不是一律回 ok)。
 */
export function collectThinkingSummary(entries: Iterable<SessionHost>, level: string): ThinkingSummary {
	const levels: string[] = [];
	const failed: string[] = [];
	let sessions = 0;
	for (const host of entries) {
		sessions++;
		try {
			const r = host.setThinkingLevel(level);
			if (r?.level && !levels.includes(r.level)) levels.push(r.level);
		} catch (err) {
			failed.push(err instanceof Error ? err.message : String(err));
		}
	}
	return { sessions, levels, clamped: levels.some((l) => l !== level), failed };
}

/**
 * runtime 重建时要恢复的会话级设置(2026-10 审计 BUG-009,见 SessionHost.reloadRuntime)。
 */
interface RuntimeDefaults {
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	temperature: number | null;
	topP: number | null;
}

/**
 * 模型目录(models.json)变更后,让一批已建会话跟上最新目录;返回**该被释放的会话键**。
 *
 * 分两种情况(2026-10-04):
 *  - 会话有模型 → 重读 models.json。不刷新的话,「设置页刚加完模型并选中」在已建会话上
 *    解析不到该模型(POST /api/model 报 not found),对话继续拿 unknown 占位模型发请求。
 *  - 会话还是 unknown 占位(建会话时一个可用模型都没有,比如首启没配模型就聊过一句)
 *    → 报为 stale,由调用方**释放**:vendor 只在**创建**会话时解析初始模型
 *    (findInitialModel),空壳留着永远修不好,用户加完模型不手动重选就一直是那句
 *    No API key found;释放后下次对话按最新目录重新装配并自动选中可用模型。
 *
 * 逐个尝试、失败不抛:目录刷新不是用户那次写盘操作的成败条件。
 * `allowNetwork` 透传给会话宿主(设置页「刷新模型列表」要真的联网拉远程目录)。
 */
export async function refreshModelsOfHosts(
	entries: Iterable<readonly [string, SessionHost]>,
	options?: { allowNetwork?: boolean },
): Promise<{ stale: string[]; sessions: number; errors: Array<{ provider: string; message: string }> }> {
	const stale: string[] = [];
	const errors: Array<{ provider: string; message: string }> = [];
	let sessions = 0;
	for (const [key, host] of entries) {
		sessions++;
		try {
			if (host.currentModel() === null) {
				stale.push(key);
				continue;
			}
			const summary = await host.refreshModels(options);
			if (summary?.errors) errors.push(...summary.errors);
		} catch {
			/* 单个会话刷新失败不影响其余(它下次装配仍会读最新 models.json) */
		}
	}
	return { stale, sessions, errors };
}

/**
 * 从会话 entries 提取 user/assistant 文本消息(统一实现见 session-text.ts,
 * 与 TUI extension 共用);entry 无 message 或 role 非 user/assistant 跳过。
 * 分组规则(服务端为唯一分组权威,前端实时路径与 store.ts 保持一致):
 * user 消息开新组;同一 user 之后的多个 assistant 消息(一次回复里的多轮工具调用)
 * 合并为一条气泡——text 以空行拼接。id 取组内最后一条 entry 的 id
 * (撤回只作用于 user 消息,user 的 id 即该组起点 entry 的 id,不受合并影响)。
 * 接受任意 SessionManager(逻辑同 extractMessages)——供 server 只读端点读取
 * 指定章节会话,不依赖 runtime。
 *
 * 2026-09-19 起每条消息另带 `content`:**有序内容块**(思考 / 正文 / 工具调用),
 * 工具结果按 toolCallId 从独立 toolResult entry 配对回填到调用块上。
 * 改造前这里只提 text + thinking —— 多段思考被拼成一坨、工具调用整段丢弃,
 * 于是「刷新页面后历史工具卡全没了」且思考链与工具的真实先后无从还原。
 * text/thinking 作为兼容投影保留(TUI 与分支摘要仍按整条消息取文本)。
 */
export function extractMessagesFromManager(sm: SessionManager): SessionStateSnapshot["messages"] {
	const out: SessionStateSnapshot["messages"] = [];
	/** 当前 assistant 组的块序列(工具结果要回填到其中的调用块上)。 */
	let groupParts: ChatContentPart[] = [];
	/** toolCallId → 调用块(跨段查找:结果 entry 紧跟其段,但配对按 id 而非位置)。 */
	const partById = new Map<string, Extract<ChatContentPart, { type: "toolCall" }>>();
	/** 组内首条 entry 的时间(ms)——回合耗时起点。 */
	let groupStart: number | undefined;

	const timeOf = (entry: { timestamp?: unknown }): number | undefined => {
		const raw = entry.timestamp;
		if (typeof raw === "number") return raw;
		if (typeof raw === "string") {
			const t = Date.parse(raw);
			return Number.isNaN(t) ? undefined : t;
		}
		return undefined;
	};

	/** 取字符串字段(缺省/非字符串 → undefined;防御 vendor 消息的异构形状)。 */
	const strField = (m: { role?: string; content?: unknown }, key: string): string | undefined => {
		const v = (m as Record<string, unknown>)[key];
		return typeof v === "string" && v.length > 0 ? v : undefined;
	};

	// 只走 leaf 链(getBranch 沿 parentId 回溯):撤回后旧分支不显示,与上下文一致
	for (const entry of sm.getBranch()) {
		const msg = (entry as { message?: { role?: string; content?: unknown; toolCallId?: unknown } }).message;
		if (!msg) continue;

		// 工具结果:回填到对应调用块(独立 entry,不是气泡)
		const callId = toolResultCallId(msg as { role?: string; toolCallId?: unknown });
		if (callId !== undefined) {
			const part = partById.get(callId);
			if (part) {
				part.result = toolResultText(msg as { content?: unknown });
				part.isError = (msg as { isError?: unknown }).isError === true;
			}
			continue;
		}

		const text = chatTextOfMessage(msg);
		if (msg.role === "user") {
			if (!text) continue;
			groupParts = [];
			partById.clear();
			groupStart = timeOf(entry as { timestamp?: unknown });
			out.push({
				role: "user",
				text,
				content: [{ type: "text", text }],
				timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				...(groupStart !== undefined ? { startedAt: groupStart, endedAt: groupStart } : {}),
				id: entry.id,
			});
			continue;
		}
		if (msg.role !== "assistant") continue;

		// provider 侧报错:vendor 不抛异常,而是给 assistant 消息落
		// stopReason="error" + errorMessage(content 为空)。必须**在**下面那句
		// 「无正文无思考即丢弃」之前拦下 —— 否则整条报错被丢掉,界面上只剩一个
		// 空气泡、刷新后连气泡都没了(需求 1「原文照实显示」的兜底数据源)。
		const errorMessage = strField(msg, "errorMessage");
		if (errorMessage !== undefined) {
			// 独立成条(不参与同组合并:报错就是这一轮的终点),并把组状态清干净
			out.push({
				role: "assistant",
				text: "",
				content: [],
				errorMessage,
				...(strField(msg, "provider") !== undefined ? { provider: strField(msg, "provider")! } : {}),
				...(strField(msg, "model") !== undefined ? { model: strField(msg, "model")! } : {}),
				timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				id: entry.id,
			});
			groupParts = [];
			partById.clear();
			groupStart = undefined;
			continue;
		}

		const parts = chatContentOfMessage(msg as { role?: string; content?: unknown });
		// 思考链一并提取(历史水合:刷新/重开页面后思考块仍在)
		const thinking = chatThinkingOfMessage(msg as { role?: string; content?: unknown });
		// 工具调用段可能既无正文也无思考:改造前这种 entry 会被 `if (!text) continue` 整条丢掉
		if (!text && parts.length === 0) continue;
		const at = timeOf(entry as { timestamp?: unknown });
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
		const last = out[out.length - 1];
		// 报错记录不参与同组合并:它是这一轮的终点,合并会把 errorMessage 抹掉
		// (合并分支只重建 text/thinking/content 三个字段)
		if (last && last.role === "assistant" && !last.errorMessage) {
			// 并入当前组:同轮回复的多段 assistant 输出(工具调用轮次)合并为一条气泡。
			// **块按序追加**——顺序就是真实顺序,不再把多段 thinking 拼成一个字符串
			groupParts.push(...parts);
			for (const p of parts) if (p.type === "toolCall") partById.set(p.id, p);
			out[out.length - 1] = {
				role: "assistant",
				text: text ? (last.text.length > 0 ? `${last.text}\n\n${text}` : text) : last.text,
				thinking: [last.thinking, thinking].filter((s) => s && s.length > 0).join("\n\n") || undefined,
				content: groupParts,
				// id 取组内**最后一条** entry(与改造前一致;撤回只作用于 user 消息,
				// user 的 id 是组起点、不受合并影响)
				id: entry.id,
				// 首段 entry 是这条气泡在树上的「位置」:版本切换按它建键(见 firstEntryId)
				...(last.firstEntryId !== undefined ? { firstEntryId: last.firstEntryId } : {}),
				...(last.startedAt !== undefined ? { startedAt: last.startedAt } : {}),
				...(at !== undefined ? { endedAt: at } : {}),
				timestamp,
			};
			continue;
		}
		if (parts.length === 0 && thinking.length === 0 && !text) continue;
		groupParts = parts;
		partById.clear();
		for (const p of parts) if (p.type === "toolCall") partById.set(p.id, p);
		out.push({
			role: "assistant",
			text: text ?? "",
			thinking: thinking || undefined,
			content: groupParts,
			...(at !== undefined ? { startedAt: at, endedAt: at } : {}),
			timestamp,
			id: entry.id,
			// 组首段 = 这个位置本身(多段合并后 id 会推进到最后一段,首段要留住)
			firstEntryId: entry.id,
		});
	}
	return out;
}

function extractMessages(rt: AgentSessionRuntime): SessionStateSnapshot["messages"] {
	return extractMessagesFromManager(rt.session.sessionManager);
}
