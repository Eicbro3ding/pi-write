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
import { getBooksDir } from "../config.ts";
import { toolGuardContext } from "../tool-guard.ts";
import { chatTextOfMessage, chatThinkingOfMessage } from "../session-text.ts";
import { createKeyInteraction, deriveAuthKind, sortProviders, type ProviderListItem } from "./provider-auth.ts";

/** SessionHost 构造选项;createRuntime 由调用方注入,SessionHost 不自己构造 services。 */
export interface SessionHostOptions {
	createRuntime: CreateAgentSessionRuntimeFactory;
	cwd: string; // 书目录
	agentDir: string;
	sessionManager: SessionManager;
	/** 工具路径守卫与 world_update/word_count 所需的会话上下文(readOnlyDirs/draftFile)。
	 *  缺省时仅使用 cwd 作为书目录,不额外放行只读目录、不限制正文白名单。 */
	toolGuard?: { readOnlyDirs?: string[]; draftFile?: string };
}

/** getState() 返回的会话状态快照。 */
export interface SessionStateSnapshot {
	sessionFile: string | null;
	bookSlug: string | null; // 会话文件所在书目录名
	chapterFile: string | null; // 会话文件 basename
	isStreaming: boolean;
	/**
	 * 消息列表(沿会话 leaf 链提取;撤回后旧分支消息自然消失)。
	 * id 是会话 entry 的稳定 id(撤回/编辑的定位依据);timestamp 同 entry。
	 * thinking:assistant 消息的思考链(实时经 SSE thinking_delta 流式进来,
	 * 历史水合时从会话文件提取,保证刷新/重开页面后思考块仍在)。
	 */
	messages: Array<{ role: "user" | "assistant"; text: string; thinking?: string; timestamp?: string; id?: string }>;
	diagnostics: Array<{ type: "error" | "warning" | "info"; message: string }>;
}

/** 会话上下文占用(与 vendor AgentSession.getContextUsage 对齐;前端 /compact 提示用)。 */
export interface SessionContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** 手动压缩返回摘要(与 vendor CompactionResult 对齐)。 */
export interface SessionCompactionResult {
	summary: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

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

	constructor(options: SessionHostOptions) {
		this.options = options;
		this.sessionManager = options.sessionManager;
	}

	async start(): Promise<void> {
		// createRuntime 工厂由调用方注入(内含 writerExtension、隐藏 skill 命令、tools 列表),
		// 返回 CreateAgentSessionRuntimeResult({ session, extensionsResult, services, diagnostics });
		// 经 createAgentSessionRuntime 包装成 AgentSessionRuntime(含 session/switchSession/dispose)后持有,
		// 与 cli.ts 的装配路径一致。
		this.runtime = await createAgentSessionRuntime(this.options.createRuntime, {
			cwd:
				(typeof this.sessionManager.getCwd === "function" && this.sessionManager.getCwd()) ||
				this.options.cwd,
			agentDir: this.options.agentDir,
			sessionManager: this.sessionManager,
			sessionStartEvent: undefined,
		});
		this.bindSession();
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
					setTimeout(() => {
						// runtime 可能已被切书/重建(switchSession/reloadRuntime):放弃补发
						if (this.runtime !== rt) return;
						const branch2 = rt.session.sessionManager.getBranch();
						for (let i = branch2.length - 1; i >= 0; i--) {
							const entry = branch2[i]!;
							if (entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === role) {
								const late = { ...event, entryId: entry.id } as AgentSessionEvent & { entryId?: string };
								for (const l of this.listeners) l(late);
								break;
							}
						}
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
		if (!this.runtime) throw new Error("SessionHost 尚未 start");
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
				readOnlyDirs: this.options.toolGuard?.readOnlyDirs ?? [],
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
	async setThinkingLevel(level: string): Promise<void> {
		// ThinkingLevel 是字符串字面量联合,由调用方保证传入合法值
		this.requireRuntime().session.setThinkingLevel(level as ThinkingLevel);
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
	 * 会话树概览(分支栏数据):枚举全部叶子分支,每个分支给出
	 * 起点摘要(路径上第一条 user 消息)、结尾摘要与消息数;currentLeafId 标记当前分支。
	 */
	async getSessionTree(): Promise<{
		currentLeafId: string | null;
		branches: Array<{
			leafId: string;
			isCurrent: boolean;
			count: number;
			summary: string;
			tail: string;
		}>;
	}> {
		const rt = this.runtime;
		if (!rt) return { currentLeafId: null, branches: [] };
		const sm = rt.session.sessionManager;
		const roots = sm.getTree() as unknown as Array<{
			entry: { id: string };
			children: unknown[];
		}>;
		const leaves: string[] = [];
		const walk = (nodes: Array<{ entry: { id: string }; children: unknown[] }>): void => {
			for (const n of nodes) {
				if (n.children.length === 0) leaves.push(n.entry.id);
				else walk(n.children as never);
			}
		};
		walk(roots);
		const currentLeafId = sm.getLeafId();
		// 分支候选 = 树叶子 ∪ 当前 leaf 指针(branch 后 leaf 可能指向非叶子节点,
		// 该节点的子树仍在树里——它也是合法的分支终点)
		const candidates = new Set<string>(leaves);
		if (currentLeafId) candidates.add(currentLeafId);
		const branches = [...candidates].map((leafId) => {
			const path = sm.getBranch(leafId);
			const texts: string[] = [];
			let summary = "";
			for (const e of path) {
				if (e.type !== "message") continue;
				const msg = (e as { message?: { role?: string; content?: unknown } }).message;
				const text = msg ? chatTextOfMessage(msg) : undefined;
				if (!text) continue;
				// 摘要取「路径上最后一条 user 消息」:分支后各分支共享前缀,
				// 取第一条会得到相同摘要(看起来像串对话);最后一条提问最能区分分支
				if (msg?.role === "user") summary = text;
				texts.push(text);
			}
			return {
				leafId,
				isCurrent: leafId === currentLeafId,
				count: texts.length,
				summary: summary.slice(0, 24) || "开始",
				tail: (texts[texts.length - 1] ?? "").slice(0, 24),
			};
		});
		return { currentLeafId, branches };
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
		await this.runtime?.dispose();
		this.runtime = undefined;
	}
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
 */
export function extractMessagesFromManager(sm: SessionManager): SessionStateSnapshot["messages"] {
	const out: SessionStateSnapshot["messages"] = [];
	// 只走 leaf 链(getBranch 沿 parentId 回溯):撤回后旧分支不显示,与上下文一致
	for (const entry of sm.getBranch()) {
		const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (!msg) continue;
		const text = chatTextOfMessage(msg);
		if (!text) continue;
		const role = msg.role === "user" ? "user" : "assistant";
		const base = {
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
			id: entry.id,
		};
		if (role === "user") {
			out.push({ role, text, ...base });
			continue;
		}
		// 思考链一并提取(历史水合:刷新/重开页面后思考块仍在)
		const thinking = chatThinkingOfMessage(msg);
		const last = out[out.length - 1];
		if (last && last.role === "assistant") {
			// 并入当前组:同轮回复的多段 assistant 输出(工具调用轮次)合并为一条气泡
			out[out.length - 1] = {
				role: "assistant",
				text: `${last.text}\n\n${text}`,
				thinking: [last.thinking, thinking].filter((s) => s && s.length > 0).join("\n\n"),
				...(base.id ? { id: base.id } : {}),
				timestamp: base.timestamp,
			};
		} else {
			out.push({ role, text, thinking: thinking || undefined, ...base });
		}
	}
	return out;
}

function extractMessages(rt: AgentSessionRuntime): SessionStateSnapshot["messages"] {
	return extractMessagesFromManager(rt.session.sessionManager);
}
