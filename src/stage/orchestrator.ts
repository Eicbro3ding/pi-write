import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getBookSessionsDir, initChapterFile } from "../book-manager.ts";
import { resolveSkillsDir } from "../config.ts";
import { createSessionRuntimeFactory } from "../session-factory.ts";
import { SessionHost, type SessionContextUsage } from "../web/session-host.ts";
import type { WriterHost } from "../web/writer-host.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	type InlineExtension,
	SessionManager,
	type ToolDefinition,
} from "../../vendor/pi-coding-agent/src/index.ts";
import type { AgentMessage, ThinkingLevel } from "../../vendor/pi-agent-core/src/index.ts";
import type { AgentSessionEvent } from "../../vendor/pi-coding-agent/src/index.ts";
import { buildActorContextBlocks, formatStageLines, resolveWorldInjection } from "./assembler.ts";
import { loadCast, saveCast, validateCast, validateSceneCast } from "./cast.ts";
import { countStage } from "./counters.ts";
import { loadScript, reviseScript, saveScript } from "./script-store.ts";
import { appendStageEntry, makeStageEntry, readStage, truncateStage } from "./stage-store.ts";
import { ensureWorld } from "../world-data.ts";
import { buildStorylineView, constraintTargetMatches, NOTICE_INJECT_LIMIT } from "../world-context.ts";
import { actorRole, buildScriptMethodBlock, directorRole, writerRole } from "./stage-extension.ts";
import {
	type ActorText,
	type CastConfig,
	type DirectorMode,
	type SceneRules,
	type ScenePhase,
	type SceneScript,
	type ScriptPatch,
	type StageEntry,
	type StageStatus,
} from "./types.ts";

/**
 * StageOrchestrator — 舞台区编排器（demo）。
 *
 * 持有导演/演员/编剧三类会话（每角色一个 SessionHost），驱动场景状态机：
 *   idle → running（轮转共演）→ wrapping（收尾提示）→ closed（编剧成文）
 *
 * 角色消息组装经扩展 "context" 事件（transformContext 钩子）实现：
 *   演员 = [舞台切片 | 剧本文字段 | 实时计数块]（追加尾部，缓存纪律）
 *   导演 = [舞台区全幕视图]（demo 简化，后续换 digest+delta）
 */

export type StageEvent =
	| { type: "stage"; entry: StageEntry }
	| { type: "system"; text: string }
	// 舞台阶段变化(开演/收幕):前端收到后自动刷新快照(演出 UI 形态切换)
	| { type: "phase"; phase: ScenePhase }
	// 导演会话事件全量透传(与 writer_event 同款,内层是主会话同款会话事件):
	// 前端复用 processAgentEvent 归约 + MessageList 渲染——导演对话与编剧/主会话
	// 同一套对话逻辑(2026-08-11 统一重构);silent 回合(收幕自动指令)抑制
	| { type: "director_event"; event: AgentSessionEvent }
	// 剧本待确认(script_confirm 提交):前端收到后以卡片展示剧本并询问用户是否修改
	| { type: "script_confirm"; sceneId: string; script: SceneScript }
	// 世界书编辑信号(world_update 工具已写记录文件;前端回合结束读文件渲染预览卡)
	| { type: "world_edit" }
	// 收幕导演整理回合结束(① 块之后;无回合时也发):前端撤下「导演正在编辑消息」
	// 提示条——导演消息发完即撤,不等编剧成文(2026-08-11)
	| { type: "director_done" };

export interface StageOrchestratorOptions {
	bookDir: string;
	agentDir: string;
	/** 归属章节(舞台按章节隔离:每章一幕,导演会话文件按章;null = 书级兜底)。 */
	chapterFile?: string | null;
	/** --model 模式串（resolveCliModel 解析）。 */
	model?: string;
	thinkingLevel?: string;
	/**
	 * 常驻编剧宿主(web 模式注入):收幕成文委托给同一 (书, 章节) 编剧会话
	 * (常驻编剧 === 收幕编剧,2026-08-11);未注入(CLI)时收幕走内置 writer。
	 */
	writerHost?: WriterHost;
	/** MCP 外部工具(web 模式注入,导演/编剧会话可用;CLI 无 MCP)。 */
	mcpTools?: ToolDefinition[];
	onEvent?: (event: StageEvent) => void;
}

/** 每角色的会话装配参数。 */
export interface RoleSpec {
	systemPrompt: string;
	extensions: InlineExtension[];
	excludeTools?: string[];
	activeTools?: string[];
	noTools?: "all" | "builtin";
	customTools?: ToolDefinition[];
	/** 角色级思考级别覆盖（如演员默认 low，§10.6 第一人称思考成本可控）。 */
	thinkingLevel?: string;
}

/** 回合决策（纯函数）：下一轮是继续演、收尾收幕还是强制收幕。 */
export function decideTurnAction(
	status: StageStatus,
	lines: number,
	rules: SceneRules,
): "speak" | "wrap-close" | "force-close" {
	if (lines >= rules.maxLines) return "force-close";
	if (status === "wrapping" && lines >= rules.minLines) return "wrap-close";
	return "speak";
}

/**
 * 重演/续演通用提示(借鉴 SillyTavern Continue Nudge):只补新内容,不复读上一轮。
 * /retry 与 /fix 截断转录后都会注入,防止演员把刚被删掉的旧台词原样再说一遍。
 */
const CONTINUE_WITHOUT_REPEAT_NUDGE =
	"从被截断/要求修正的位置继续演出:只输出新的动作、神态与台词;不要复述上一轮已经写过的内容,也不要复述舞台提示本身";

/** 导演模式切换事件（三模式状态机的输入，只剩硬信号——文本意图检测已移除）。 */
export type DirectorModeEvent =
	| "tool-script-confirm"
	| "scene-started"
	| "scene-closed";

/** 三模式状态机（纯函数）：discussion ↔ scripting ↔ directing。 */
export function nextDirectorMode(current: DirectorMode, event: DirectorModeEvent): DirectorMode {
	switch (event) {
		case "tool-script-confirm":
			return "scripting";
		case "scene-started":
			return "directing";
		case "scene-closed":
			return "discussion";
	}
}

/** 全局轮数上限（含 pass，防无限空转——不针对任何角色，见 §10.3）。 */
export const MAX_TURNS = 40;
/** 叙述者插播节奏（每 N 个演员回合插播一次，§10.2）。 */
export const NARRATOR_EVERY = 4;

/**
 * 演员回合输出归类（纯函数，§10.3/§10.4）：
 * - 含 `<pass>` → "pass"（完全沉默，无条目）；
 * - 清理串台后为空 → "invalid"（只写了别人的台词，视为 pass + 警告）；
 * - 否则 → "speak"（正常演出或动作演出——动作演出零特殊判定，输出即素材）。
 * cleaned 由调用方先经 cleanCrossTalk(raw, self, others) 得出。
 */
export function classifyActorOutput(raw: string, cleaned: string): "pass" | "speak" | "invalid" {
	if (raw.includes("<pass>")) return "pass";
	return cleaned ? "speak" : "invalid";
}

/**
 * 串台清理（纯函数，§10.4 P0）：剥离自称前缀（"李四: 台词" → "台词"）；
 * 出现其他角色名 + 冒号（代演他人台词）→ 从该行起截断。
 */
export function cleanCrossTalk(text: string, self: string, others: string[]): string {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(/^\s*([^\s:：]{1,8})\s*[:：]/);
		if (m && others.includes(m[1])) break; // 代演他人 → 截断
		out.push(i === 0 && m && m[1] === self ? line.slice(m[0].length) : line);
	}
	return out.join("\n").trim();
}

/** 编剧内心素材渲染（§10.7）：剧本 state（导演声明的内心，含矛盾）→ 编剧参考。 */
export function renderStateForWriter(script: SceneScript): string {
	const lines: string[] = [];
	for (const [actorId, fields] of Object.entries(script.text.perActor)) {
		const character = script.definition.cast[actorId]?.[0] ?? actorId;
		const parts: string[] = [];
		if (fields.objective) parts.push(`任务：${fields.objective}`);
		if (fields.state) parts.push(`内心：${fields.state}`);
		if (fields.relation) parts.push(`关系：${fields.relation}`);
		if (parts.length > 0) lines.push(`【${character}】${parts.join("；")}`);
	}
	return lines.join("\n") || "（导演未声明角色内心）";
}

/** 编剧成文消息组装（§10.7）：转录 + state + 世界书 + 文风采样 + 思考链（档3 可见性）。 */
export function buildWriterMessage(opts: {
	transcript: string;
	stateText: string;
	worldText: string;
	styleSample: string | null;
	chapter: string;
	thoughts: string | null;
	thoughtAccess: 1 | 2 | 3;
}): string {
	let msg = `【舞台转录】\n${opts.transcript}\n\n【剧本·角色内心（state，导演声明）】\n${opts.stateText}\n\n【世界书（导演已更新，含角色内心）】\n${opts.worldText}`;
	if (opts.styleSample) {
		// 文风采样：0.01 版机制（导演维护的标志性文本）——编剧的风格基准
		msg += `\n\n【文风采样】(来源: 导演维护的风格基准；只模仿语感与句式，不复用原文)\n${opts.styleSample}`;
	}
	msg += `\n\n你是编剧。请把以上舞台记录整理成正文小说：去掉对白标签与舞台指示，叙述化、连贯成文；参考角色内心与世界书，把潜台词与心理矛盾写进正文；遵循文风采样锁定语言风格。用 write 工具把正文写入 draft/${opts.chapter}.md。`;
	if (opts.thoughtAccess === 3 && opts.thoughts) {
		msg += `\n\n【演员思考链（用户已开启档3，仅供内心参考，不要直接引述）】\n${opts.thoughts}`;
	}
	return msg;
}

/** /revise 参数解析（纯函数）：min= / max= / wrap= / setting= / goal= / tone= /
 *  beats=|分隔 / forbidden=|分隔 / actor:<id>.<字段>=（字段缺省 objective，examples 用 | 分隔）。 */
export function parseReviseArgs(tokens: string[]): ScriptPatch {
	const patch: ScriptPatch = {};
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0) continue;
		const key = token.slice(0, eq).trim();
		const value = token.slice(eq + 1).trim();
		if (key === "min") patch.rules = { ...patch.rules, minLines: Number(value) };
		else if (key === "max") patch.rules = { ...patch.rules, maxLines: Number(value) };
		else if (key === "wrap") patch.rules = { ...patch.rules, wrapUpWindow: Number(value) };
		else if (key === "setting" || key === "goal" || key === "tone") {
			patch.text = { ...patch.text, shared: { ...patch.text?.shared, [key]: value } };
		} else if (key === "beats" || key === "forbidden") {
			patch.text = {
				...patch.text,
				shared: { ...patch.text?.shared, [key]: value.split("|").map((s) => s.trim()).filter(Boolean) },
			};
		} else if (key.startsWith("actor:")) {
			const rest = key.slice("actor:".length);
			const dot = rest.indexOf(".");
			const actorId = dot === -1 ? rest : rest.slice(0, dot);
			const field = dot === -1 ? "objective" : rest.slice(dot + 1);
			const fields: Partial<ActorText> =
				field === "examples" ? { examples: value.split("|").map((s) => s.trim()).filter(Boolean) } : { [field]: value };
			patch.text = { ...patch.text, perActor: { ...patch.text?.perActor, [actorId]: fields } };
		}
	}
	return patch;
}

/**
 * 等待整回合完成（send 即 session.prompt）。
 *
 * 2026-08-09 根因：agent_settled 在 _runAgentPrompt 的 finally 里、prompt() 返回前
 * 就已发出——若先 await sendMessage 再订阅 settle，事件必然错过，只能干等超时。
 * 因此直接以 sendMessage 完成 + 超时兜底为准：返回 true 表示回合完成（模型错误会
 * 直接 throw 上抛），false 表示超时（调用方优雅跳过，不崩进程）。
 */
async function runTurn(host: SessionHost, send: () => Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	try {
		const result = await Promise.race([send().then(() => "sent" as const), timeout]);
		return result === "sent";
	} finally {
		clearTimeout(timer);
	}
}

/** 编剧建议文件(书目录,常驻编剧维护;导演「讨论/剧本」模式注入)。 */
export const ADVICE_FILE = "advice.md";

/** 读编剧建议;不存在/为空返回 null。模块级导出供单测。 */
export async function readAdvice(bookDir: string): Promise<string | null> {
	try {
		const text = await readFile(join(bookDir, ADVICE_FILE), "utf8");
		return text.trim().length > 0 ? text : null;
	} catch {
		return null;
	}
}

export class StageOrchestrator {
	readonly bookDir: string;
	phase: ScenePhase = "idle";
	status: StageStatus = "normal";
	wrapRemaining: number | undefined;
	sceneId: string | null = null;
	script: SceneScript | null = null;

	private readonly agentDir: string;
	private readonly model?: string;
	private readonly thinkingLevel?: string;
	/** 归属章节(舞台按章节隔离;null = 书级兜底,导演会话文件用 stage-director.jsonl)。 */
	private readonly chapterFile: string | null;
	private readonly onEvent?: (event: StageEvent) => void;
	/** 常驻编剧宿主(收幕委托;undefined = CLI 走内置 writer)。 */
	private readonly writerHost: WriterHost | undefined;
	/** MCP 外部工具(web 注入;undefined = CLI 无 MCP)。 */
	private readonly mcpTools: ToolDefinition[] | undefined;
	private cast: CastConfig | null = null;
	private director: SessionHost | null = null;
	private writer: SessionHost | null = null;
	private readonly actorHosts = new Map<string, SessionHost>();
	private turnIndex = 0;
	private turnRunning = false;
	/** 导演三模式（讨论/剧本/导演），事件驱动切换（见 nextDirectorMode；
	 *  文本意图检测已移除——进入剧本模式的唯一途径是导演主动调用 script_confirm）。 */
	private _directorMode: DirectorMode = "discussion";
	/**
	 * 待确认剧本（script_confirm 提交后、用户确认前）：stage_script 开演的门。
	 * confirmed 后导演可调 stage_script 开演（开演后清空）。
	 */
	private pendingScript: { sceneId: string; script: SceneScript; confirmed: boolean } | null = null;
	/** 导演会话的工具调用记录（tool_result 事件累计）。 */
	private readonly directorToolCalls: string[] = [];
	/** step/auto 推进（§10.1）：auto=false 时每轮等用户 /next。 */
	private autoMode = false;
	/** step 模式下等待 /next 的唤醒器。 */
	private nextTurnWaiter: (() => void) | null = null;
	/** /force 强制下一轮发言的 actor id（用后清空）。 */
	private forcedNextActor: string | null = null;
	/** 各演员连续 pass 计数（§10.3：连续 ≥2 警告 + 强制发言）。 */
	private readonly passStreak = new Map<string, number>();
	/** 全局连续 pass 计数（非 pass 清零；近似"一圈没人说话"判定）。 */
	private globalPassStreak = 0;
	/** 总轮数（含 pass，§10.3 maxTurns 兜底）。 */
	private totalTurns = 0;
	/** 重演说明（/retry 时注入演员回合指令）。 */
	private replayNote: string | null = null;
	/** 编剧思考链可见性（§10.6 三档，决策权在用户）：1 不看 / 2 导演提炼版（默认）/ 3 原始思考链。 */
	private writerThoughtAccess: 1 | 2 | 3 = 2;

	constructor(options: StageOrchestratorOptions) {
		this.bookDir = options.bookDir;
		this.agentDir = options.agentDir;
		this.chapterFile = options.chapterFile ?? null;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel;
		this.onEvent = options.onEvent;
		this.writerHost = options.writerHost;
		this.mcpTools = options.mcpTools;
	}

	private emit(text: string): void {
		this.onEvent?.({ type: "system", text });
	}

	/** 阶段变化广播:前端收到后自动刷新快照(演出 UI 形态切换,无需手动刷新)。 */
	private emitPhase(): void {
		this.onEvent?.({ type: "phase", phase: this.phase });
	}

	private emitEntry(entry: StageEntry): void {
		this.onEvent?.({ type: "stage", entry });
	}

	// ---- 导演模式 ----

	getDirectorMode(): DirectorMode {
		return this._directorMode;
	}

	/** 按事件切换模式（nextDirectorMode 纯函数），并广播。 */
	private setDirectorMode(event: DirectorModeEvent, reason: string): void {
		const next = nextDirectorMode(this._directorMode, event);
		if (next === this._directorMode) return;
		this._directorMode = next;
		const label: Record<DirectorMode, string> = {
			discussion: "讨论",
			scripting: "剧本",
			directing: "导演",
		};
		this.emit(`导演进入「${label[next]}」模式（${reason}）`);
	}

	/** 导演工具执行完成（扩展 tool_result 事件回调）。 */
	onDirectorToolResult(toolName: string): void {
		this.directorToolCalls.push(toolName);
		// 导演主动提交剧本（script_confirm 调用）→ 进入剧本模式（2026-08-11：
		// 意图识别已移除，模式切换只剩硬信号；开演后不回跳）
		if (toolName === "script_confirm" && !this.sceneId) {
			this.setDirectorMode("tool-script-confirm", "导演提交剧本");
		}
		// 世界书编辑信号(2026-08-11):world_update 成功时工具已把 before/after
		// 快照写进记录文件,这里只发信号——前端回合结束(agent_settled)读文件渲染预览卡
		if (toolName === "world_update") {
			this.onEvent?.({ type: "world_edit" });
		}
	}

	// ---- 生命周期 ----

	/** 启动：确保默认编制 + 创建导演会话。 */
	async start(): Promise<void> {
		await mkdir(this.bookDir, { recursive: true });
		await ensureDefaultCast(this.bookDir);
		this.director = await this.createRoleHost("stage-director", directorRole(this));
		// 导演会话事件全量透传:前端复用 processAgentEvent 归约 + MessageList 渲染,
		// 与编剧/主会话同一套对话逻辑(消息/思考/工具卡片/流式零新逻辑)。
		// silent 回合(收幕自动指令)整体抑制——回复不进前端对话流;但 agent_settled
		// 放行:前端据此撤下「导演正在编辑消息」提示条(导演消息发完即撤,不等编剧成文)
		this.director.subscribe((event) => {
			if (this.silentTurn && event.type !== "agent_settled") return;
			this.onEvent?.({ type: "director_event", event });
		});
	}

	/** 释放全部会话。 */
	async dispose(): Promise<void> {
		for (const host of this.actorHosts.values()) await host.dispose();
		this.actorHosts.clear();
		if (this.writer) await this.writer.dispose();
		if (this.director) await this.director.dispose();
		this.director = null;
	}

	// ---- 会话工厂 ----

	private async ensureRoleSession(fileBase: string): Promise<{ sessionsDir: string; abs: string }> {
		const sessionsDir = getBookSessionsDir(basename(this.bookDir));
		await mkdir(sessionsDir, { recursive: true });
		// 导演会话按章节隔离(每章一幕独立对话,切章不串):stage-director-<chapterId>.jsonl;
		// 演员/编剧会话保持书级(角色状态跨章节共享,2026-08-10)
		const chapterId = this.chapterFile ? this.chapterFile.replace(/\.jsonl$/, "") : null;
		const file = fileBase === "stage-director" && chapterId ? `${fileBase}-${chapterId}.jsonl` : `${fileBase}.jsonl`;
		const abs = join(sessionsDir, file);
		await initChapterFile(abs, this.bookDir);
		return { sessionsDir, abs };
	}

	private roleFactory(spec: RoleSpec): CreateAgentSessionRuntimeFactory {
		const { agentDir, model, thinkingLevel } = this;
		return createSessionRuntimeFactory({
			agentDir,
			// skills 目录只读放行(与 web.ts 同款):模型经 read 工具加载 skill
			// 文件(绝对路径)时不能被守卫误拦(2026-08-09 修复)
			readOnlyDirs: [resolveSkillsDir()],
			systemPromptOverride: () => spec.systemPrompt,
			extensionFactories: spec.extensions,
			model,
			thinkingLevel: (spec.thinkingLevel ?? thinkingLevel) as ThinkingLevel | undefined,
			excludeTools: spec.excludeTools,
			initialActiveToolNames: spec.activeTools,
			noTools: spec.noTools,
			// MCP 外部工具与角色自定义工具合并(web 模式;2026-08-11 修复导演无 MCP 的根因)
			customTools: [...(spec.customTools ?? []), ...(this.mcpTools ?? [])],
		});
	}

	private async createRoleHost(fileBase: string, spec: RoleSpec): Promise<SessionHost> {
		const { sessionsDir, abs } = await this.ensureRoleSession(fileBase);
		const sessionManager = SessionManager.open(abs, sessionsDir, this.bookDir);
		const host = new SessionHost({
			createRuntime: this.roleFactory(spec),
			cwd: this.bookDir,
			agentDir: this.agentDir,
			sessionManager,
			toolGuard: { readOnlyDirs: [resolveSkillsDir()] },
		});
		await host.start();
		return host;
	}

	private async createActorHost(actorId: string): Promise<SessionHost> {
		return this.createRoleHost(`stage-actor-${actorId}`, actorRole(this, actorId));
	}

	// ---- 导演 ----

	/** 自动回合标记:silent 回合(收幕思考链提炼等)的回复不进前端对话流。
	 *  由 directorSay 的 silent 选项驱动,回合结束还原。 */
	private silentTurn = false;

	/** 导演对话：发送并等待回合（模式切换只由硬信号驱动，意图检测已移除）。
	 *  silent: 自动回合(非用户发起的收幕指令等)——回复不流式转发、不进 directorChat。 */
	async directorSay(text: string, options?: { silent?: boolean }): Promise<void> {
		if (!this.director) throw new Error("导演会话未启动");
		this.silentTurn = !!options?.silent;
		try {
			// 导演回合可能很长（多工具调用 + 高思考档），10 分钟兜底，超时只跳过不崩
			if (!(await runTurn(this.director, () => this.director!.sendMessage(text), 600_000))) {
				this.emit("导演回合超时（>10 分钟），本轮跳过");
			}
		} finally {
			this.silentTurn = false;
		}
	}

	/** 导演最近一条回复文本。 */
	getDirectorLast(): string | undefined {
		if (!this.director) return undefined;
		const state = this.director.getState();
		for (let i = state.messages.length - 1; i >= 0; i--) {
			if (state.messages[i].role === "assistant") return state.messages[i].text;
		}
		return undefined;
	}

	/** 导演最近一条回复的思考链(供 stage_done 实时事件携带;无则 undefined)。 */
	getDirectorLastThinking(): string | undefined {
		if (!this.director) return undefined;
		const state = this.director.getState();
		for (let i = state.messages.length - 1; i >= 0; i--) {
			if (state.messages[i].role === "assistant") return state.messages[i].thinking;
		}
		return undefined;
	}

	/** 自动回合指令前缀(收幕思考链提炼等):这些指令及导演回复不进前端对话(快照恢复也不显示)。 */
	private static readonly AUTO_DIRECTOR_PREFIXES = ["【本幕各演员思考链】"];

	/**
	 * 导演讨论历史(用户提问 + 导演回复,按时间顺序;空文本跳过;assistant 带思考链)。
	 * 自动回合(指令以 AUTO_DIRECTOR_PREFIXES 开头)及其回复跳过——收幕内部流程
	 * 不进前端对话(快照恢复 directorChat 时同样过滤,刷新后不复活)。
	 * 供快照恢复前端对话气泡——讨论只存于导演会话内存,快照不含历史时刷新页面
	 * 气泡会全部消失(仅剩 directorLast 一行)。
	 */
	getDirectorChat(): Array<{ role: "user" | "assistant"; text: string; thinking?: string }> {
		if (!this.director) return [];
		const chat: Array<{ role: "user" | "assistant"; text: string; thinking?: string }> = [];
		let skip = false;
		for (const m of this.director.getState().messages) {
			if (m.role === "user" || m.role === "assistant") {
				const text = (m.text ?? "").trim();
				if (text.length === 0) continue;
				if (m.role === "user") {
					skip = StageOrchestrator.AUTO_DIRECTOR_PREFIXES.some((p) => text.startsWith(p));
				}
				if (!skip) chat.push({ role: m.role, text, thinking: m.thinking });
			}
		}
		return chat;
	}

	/** 导演会话上下文占用(纯读;无活跃导演会话返回 null)。 */
	getDirectorUsage(): SessionContextUsage | null {
		return this.director?.getContextUsage() ?? null;
	}

	/** 手动压缩导演会话上下文(失败抛出;stage-host 经 runLong 转成 done 事件回报)。 */
	async directorCompact(customInstructions?: string): Promise<string> {
		if (!this.director) return "导演会话尚未开始，暂无上下文可压缩";
		const result = await this.director.compact(customInstructions);
		return `上下文已压缩：${result.tokensBefore} → ${result.estimatedTokensAfter ?? "?"} tokens`;
	}

	/** 导演的 "context" 事件处理器：按模式注入（scripting → 写作方法；directing → 舞台视图）。 */
	async directorContext(messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		// 编剧建议(advice.md):未开演(讨论/剧本模式)时注入——导演规划下一章的依据
		const advice = await readAdvice(this.bookDir);
		const adviceBlock = advice ? `\n\n【编剧建议（来自 advice.md，收幕编剧整理）】\n${advice}` : "";
		// 发展线视图(当前目标 + 已完成列表)——导演推进世界书/规划下一幕前核对
		// 进度,已完成目标勿重复追求(借鉴 AI-Novel completedMilestones,2026-08-12)
		let storylineBlock = "";
		try {
			const world = await ensureWorld(this.bookDir);
			const view = buildStorylineView(world);
			if (view) {
				const lines: string[] = [];
				if (view.currentTitle) lines.push(`当前目标：${view.currentTitle}`);
				if (view.completed.length > 0) lines.push(`已完成（禁止重复追求/推进）：${view.completed.join("、")}`);
				storylineBlock = `\n\n【发展线】\n${lines.join("\n")}`;
			}
			// 全局备忘录(Notice 待办,未完成项)——导演埋伏笔/记重要事项(2026-08-12 回到初衷)
			const noticeOpen = world.notice.items.filter((i) => !i.done).slice(0, NOTICE_INJECT_LIMIT);
			if (world.notice.enabled && noticeOpen.length > 0) {
				storylineBlock += `\n\n【Notice·备忘录】\n${noticeOpen.map((i) => `- [ ] ${i.text}`).join("\n")}`;
			}
			// 写作约束(按 target 过滤:导演收 director/all)——酒馆式规则包(2026-08-12)
			const directorConstraints = world.constraints.filter((c) => c.enabled && constraintTargetMatches(c.target, "director"));
			if (directorConstraints.length > 0) {
				storylineBlock += `\n\n【写作约束】\n${directorConstraints.map((c) => `- ${c.name}: ${c.text}`).join("\n")}`;
			}
		} catch {
			/* 世界书缺失:跳过发展线注入,不阻断 */
		}
		if (this._directorMode === "scripting") {
			return [...messages, { role: "user", content: buildScriptMethodBlock(resolveSkillsDir()) + adviceBlock + storylineBlock, timestamp: Date.now() }];
		}
		if (this._directorMode === "directing" && this.sceneId) {
			const entries = await readStage(this.bookDir, this.sceneId);
			if (entries.length === 0) return undefined;
			const counts = countStage(entries);
			const view = `【舞台区】\n${formatStageLines(entries).join("\n")}\n——对话 ${counts.lines} 条，${counts.cnChars} 字`;
			return [...messages, { role: "user", content: view, timestamp: Date.now() }];
		}
		if (this._directorMode === "discussion" && (advice || storylineBlock)) {
			return [...messages, { role: "user", content: `${advice ? `【编剧建议（来自 advice.md，收幕编剧整理）】\n${advice}` : ""}${storylineBlock}`, timestamp: Date.now() }];
		}
		return undefined;
	}

	// ---- 剧本确认门（script_confirm，2026-08-11） ----

	/** script_confirm 工具回调：剧本已落盘，置待确认状态并广播卡片事件（前端展示 + 用户确认）。 */
	async submitScript(sceneId: string): Promise<{ ok: boolean; text: string }> {
		const script = await loadScript(this.bookDir, sceneId);
		if (!script) return { ok: false, text: `剧本不存在：${sceneId}` };
		this.pendingScript = { sceneId, script, confirmed: false };
		this.onEvent?.({ type: "script_confirm", sceneId, script });
		this.emit(`剧本已提交（${script.scene} v${script.version}），等待用户确认`);
		return { ok: true, text: `剧本已提交（${script.scene} v${script.version}），等待用户确认` };
	}

	/** 用户确认剧本（HTTP confirm_script / CLI /confirm）：置 confirmed + 提示导演开演。 */
	async confirmScript(): Promise<string> {
		if (!this.pendingScript) return "当前没有待确认的剧本（导演尚未用 script_confirm 提交）";
		if (this.pendingScript.confirmed) return "剧本已确认，可直接开演（导演会收到提示）";
		this.pendingScript.confirmed = true;
		// nextTurn 注入（SessionHost.injectContext）：随导演下一次 prompt 进入上下文，零模型回合
		try {
			await this.director?.injectContext(
				"【系统】用户已确认你提交的剧本。请调用 stage_script 工具开演（确认前该工具不可用，现已放行）。",
			);
		} catch {
			/* 注入失败不阻断：导演后续回合仍可被用户提示 */
		}
		this.emit(`剧本已确认（${this.pendingScript.sceneId}），可开演`);
		// 确认即自动开演（2026-08-11）：确认后立即唤起导演回合——导演带着注入指令调
		// stage_script 开演，无需用户再发话；导演仍在回复时 sendMessage 抛「AI 正在
		// 回复中」，注入顺延到下一回合，此处静默跳过
		if (this.director) {
			await this.directorSay("剧本已确认——请开演。").catch(() => {});
		}
		return `剧本已确认，可开演`;
	}

	/** 待确认剧本快照（前端「待确认」态展示）。 */
	getPendingScript(): { sceneId: string; script: SceneScript; confirmed: boolean } | null {
		return this.pendingScript;
	}

	// ---- 演出推进（§10.1） ----

	/** /next：step 模式唤醒下一轮。 */
	async userNext(): Promise<string> {
		if (this.phase !== "running" && this.phase !== "wrapping") return "当前没有在演的一幕";
		if (this.autoMode) return "自动模式下无需 /next（/auto 可切回逐步）";
		this.nextTurnWaiter?.();
		this.nextTurnWaiter = null;
		return "下一轮";
	}

	/** /auto：切换自动连续演（任何用户输入会由 CLI 自动回 step）。 */
	async userAuto(): Promise<string> {
		this.autoMode = true;
		this.nextTurnWaiter?.();
		this.nextTurnWaiter = null;
		this.emit("已切换自动连续演（输入任何内容自动回逐步）");
		return "已切换自动模式";
	}

	/** 用户输入触发回 step（§10.1"输入即停"）。 */
	backToStep(): void {
		if (this.autoMode) {
			this.autoMode = false;
			this.emit("已回逐步模式（输入即停）");
		}
	}

	/** /force <角色或演员id>：强制下一轮指定角色发言（§10.2 用户覆盖）。 */
	async userForce(target: string): Promise<string> {
		if (!this.script || (this.phase !== "running" && this.phase !== "wrapping")) return "当前没有在演的一幕";
		const actorId = Object.keys(this.script.definition.cast).find(
			(id) => id === target || this.script?.definition.cast[id]?.[0] === target,
		);
		if (!actorId) {
			const names = Object.entries(this.script.definition.cast).map(([id, ch]) => `${id}(${ch[0]})`).join("、");
			return `未找到角色「${target}」。当前演员：${names}`;
		}
		this.forcedNextActor = actorId;
		this.emit(`下一轮强制：${this.script.definition.cast[actorId][0]}（${actorId}）`);
		return `已指定 ${this.script.definition.cast[actorId][0]} 下一轮发言`;
	}

	/** /thoughts <1|2|3>：编剧思考链可见性（§10.6，默认档2 导演提炼版）。 */
	async userThoughts(level: number): Promise<string> {
		if (level !== 1 && level !== 2 && level !== 3) {
			return "档位必须是 1（不看）/ 2（导演提炼版）/ 3（原始思考链）";
		}
		this.writerThoughtAccess = level;
		const label = level === 1 ? "不看" : level === 2 ? "导演提炼版" : "原始思考链";
		this.emit(`编剧思考链可见性 → 档${level}（${label}）`);
		return `已设为档${level}（${label}）`;
	}

	// ---- 精准重演（§10.5） ----

	/** stage_revise 工具回调：同步编排器内存态剧本（下一轮演出生效；execute 已确认是当前一幕）。 */
	applyScriptUpdate(script: SceneScript): void {
		this.script = script;
	}

	/** /retry [说明]：就地重试——截断最后一条，同演员重演（可带说明）。 */
	async userRetry(note?: string): Promise<string> {
		if (!this.sceneId || (this.phase !== "running" && this.phase !== "wrapping")) return "当前没有在演的一幕";
		const entries = await readStage(this.bookDir, this.sceneId);
		if (entries.length === 0) return "舞台为空，无可重试";
		const last = entries[entries.length - 1];
		await truncateStage(this.bookDir, this.sceneId, entries.length - 1);
		this.resetActorSession(last.actor);
		this.forcedNextActor = last.actor;
		this.replayNote = [note ?? "用户要求重演这一条", CONTINUE_WITHOUT_REPEAT_NUDGE].join("；");
		this.emit(`重演第 ${entries.length} 条（${last.character}）`);
		this.nextTurnWaiter?.();
		this.nextTurnWaiter = null;
		return `已重试（${last.character} 重演）`;
	}

	/** /fix <序号> <反馈>：反馈包（舞台全貌+用户反馈）→ 导演修订 → 从问题处续演。 */
	async userFix(entryIndex: number, feedback: string): Promise<string> {
		if (!this.sceneId || !this.script) return "当前没有在演的一幕";
		const entries = await readStage(this.bookDir, this.sceneId);
		const target = entries[entryIndex - 1];
		if (!target) return `未找到第 ${entryIndex} 条（当前共 ${entries.length} 条）`;
		const beforeVersion = this.script.version;
		const stageView = formatStageLines(entries).join("\n");
		this.emit(`用户反馈第 ${entryIndex} 条（${target.character}）：${feedback}`);
		await this.directorSay(
			`【当前舞台全貌】\n${stageView}\n\n【用户反馈】\n第 ${entryIndex} 条（${target.character}）：${feedback}\n\n请用 stage_revise 修订剧本修正该问题，然后简短回复确认。`,
		);
		if (this.script && this.script.version > beforeVersion) {
			await truncateStage(this.bookDir, this.sceneId, entryIndex - 1);
			this.resetActorSession(target.actor);
			this.forcedNextActor = target.actor;
			this.replayNote = `导演已按用户反馈修订剧本。${CONTINUE_WITHOUT_REPEAT_NUDGE}`;
			this.emit(`剧本已修订 v${this.script.version}，从第 ${entryIndex - 1} 条处续演`);
			this.nextTurnWaiter?.();
			this.nextTurnWaiter = null;
			return `导演已修订剧本（v${this.script.version}），已从问题处续演`;
		}
		this.emit("导演未修订剧本（版本未变）");
		return "导演未修订剧本，请检查反馈";
	}

	// ---- 开演 ----

	/** stage_script 工具回调：校验选角 → 惰性建演员会话 → 开演。 */
	async startScene(sceneId: string): Promise<{ ok: boolean; errors: string[] }> {
		// 确认门（script_confirm，2026-08-11）：剧本必须经用户确认后才能开演
		if (!this.pendingScript || !this.pendingScript.confirmed) {
			return {
				ok: false,
				errors: [
					this.pendingScript
						? "剧本已提交，等待用户确认（确认后即可开演）"
						: "请先用 script_confirm 提交剧本并经用户确认，再调用 stage_script 开演",
				],
			};
		}
		if (this.pendingScript.sceneId !== sceneId) {
			return { ok: false, errors: [`待确认的剧本是 ${this.pendingScript.sceneId}，与本次调用的 ${sceneId} 不一致`] };
		}
		this.pendingScript = null; // 确认已消费：开演后清空，下一幕须重新提交+确认
		const script = await loadScript(this.bookDir, sceneId);
		if (!script) return { ok: false, errors: [`剧本不存在：${sceneId}`] };
		const cast = await loadCast(this.bookDir);
		const missing = Object.keys(script.definition.cast).filter((id) => !cast.actors.some((a) => a.id === id));
		if (missing.length > 0) {
			for (const id of missing) cast.actors.push({ id, type: "pool" });
			await saveCast(this.bookDir, cast);
			this.emit(`编制自动补充：${missing.join("、")}（pool 槽位，可在 cast.json 中调整）`);
		}
		const errors = [...validateCast(cast), ...validateSceneCast(script, cast)];
		if (errors.length > 0) return { ok: false, errors };
		this.cast = cast;
		this.script = script;
		this.sceneId = sceneId;
		this.status = "normal";
		this.wrapRemaining = undefined;
		this.turnIndex = 0;
		for (const actorId of Object.keys(script.definition.cast)) {
			if (!this.actorHosts.has(actorId)) {
				this.actorHosts.set(actorId, await this.createActorHost(actorId));
			}
		}
		this.phase = "running";
		this.setDirectorMode("scene-started", "开演");
		this.emitPhase();
		const rules = script.definition.rules;
		this.emit(
			`开演：${script.scene}（v${script.version}，演员 ${Object.keys(script.definition.cast).length} 名，${rules.minLines}-${rules.maxLines} 条，收尾窗口 ${rules.wrapUpWindow}）`,
		);
		void this.runTurnLoop();
		return { ok: true, errors: [] };
	}

	// ---- 共演轮转 ----

	private async runTurnLoop(): Promise<void> {
		if (this.turnRunning) return;
		this.turnRunning = true;
		try {
			while (this.phase === "running" || this.phase === "wrapping") {
				// maxTurns 兜底（§10.3）：全局轮数上限，防无限空转
				if (this.totalTurns >= MAX_TURNS) {
					this.emit(`已达最大轮数 ${MAX_TURNS}，强制收幕`);
					await this.closeScene(true);
					break;
				}
				// step 模式：每轮等用户 /next（§10.1）
				if (!this.autoMode) await this.waitForNextTurn();
				if ((await this.runOneTurn()) === "closed") break;
			}
		} catch (error) {
			this.emit(`舞台异常：${error instanceof Error ? error.message : String(error)}`);
			this.phase = "closed";
		} finally {
			this.turnRunning = false;
		}
	}

	private waitForNextTurn(): Promise<void> {
		return new Promise((resolve) => {
			this.nextTurnWaiter = resolve;
		});
	}

	/** 选下一个发言者（§10.2）：force 优先 → 叙述者按节奏插播 → 对话角色轮转。 */
	private pickNextActor(script: SceneScript): string | null {
		const cast = script.definition.cast;
		const actorIds = Object.keys(cast);
		const narrators = actorIds.filter((id) => cast[id][0] === "叙述者");
		const speakers = actorIds.filter((id) => !narrators.includes(id));
		if (this.forcedNextActor) {
			const forced = this.forcedNextActor;
			this.forcedNextActor = null;
			return forced;
		}
		const speakerTurn = this.turnIndex;
		this.turnIndex++;
		if (speakers.length === 0) return narrators[0] ?? null;
		if (narrators.length > 0 && speakerTurn > 0 && speakerTurn % NARRATOR_EVERY === 0) {
			return narrators[Math.floor(speakerTurn / NARRATOR_EVERY) % narrators.length];
		}
		return speakers[speakerTurn % speakers.length];
	}

	private async runOneTurn(): Promise<"continue" | "closed"> {
		const script = this.script;
		const sceneId = this.sceneId;
		if (!script || !sceneId) return "closed";
		const entries = await readStage(this.bookDir, sceneId);
		const counts = countStage(entries);
		const action = decideTurnAction(this.status, counts.lines, script.definition.rules);
		if (action !== "speak") {
			await this.closeScene(action === "force-close");
			return "closed";
		}
		const actorId = this.pickNextActor(script);
		if (!actorId) return "closed";
		const character = script.definition.cast[actorId][0];
		const host = this.actorHosts.get(actorId);
		if (!host) throw new Error(`演员会话缺失：${actorId}`);
		let instruction = `（舞台提示：轮到你饰演「${character}」了。只以该角色身份演出：台词、动作、神态；可提及他人，不代演他人、不描写其动作反应；环境描写留给叙述者。无话可说时优先输出动作/神态描写，确无行动可演才输出 <pass>。直接输出内容。）`;
		if (this.replayNote) {
			instruction += `\n（重演说明：${this.replayNote}）`;
			this.replayNote = null;
		}
		let raw: string | undefined;
		try {
			// 演员回合 10 分钟兜底：超时/异常只跳过本回合，不关幕
			if (!(await runTurn(host, () => host.sendMessage(instruction), 600_000))) {
				this.emit(`警告：${character} 的回合超时（>10 分钟），跳过`);
				return "continue";
			}
			const state = host.getState();
			for (let i = state.messages.length - 1; i >= 0; i--) {
				if (state.messages[i].role === "assistant" && state.messages[i].text) {
					raw = state.messages[i].text;
					break;
				}
			}
		} catch (error) {
			this.emit(`警告：${character} 的回合异常（${error instanceof Error ? error.message : String(error)}），跳过`);
			return "continue";
		}
		if (raw === undefined) {
			this.emit(`警告：${character} 没有产出内容，跳过`);
			return "continue";
		}
		this.totalTurns++;
		// 串台清理（§10.4 P0）：剥离自称前缀、截断其他角色代演
		const others = Object.values(script.definition.cast)
			.flat()
			.filter((c) => c !== character && c !== "叙述者");
		const cleaned = cleanCrossTalk(raw, character, others);
		const kind = classifyActorOutput(raw, cleaned);
		if (kind === "pass") {
			const streak = (this.passStreak.get(actorId) ?? 0) + 1;
			this.passStreak.set(actorId, streak);
			this.globalPassStreak++;
			this.emit(`（${character} 选择了沉默，跳过）`);
			// 兜底①：连续 pass ≥ 2 → 警告 + 下轮强制发言
			if (streak >= 2) {
				this.emit(`警告：${character} 连续沉默 ${streak} 次，下轮强制发言`);
				this.forcedNextActor = actorId;
			}
			// 兜底②：全局连续 pass 达到"一圈没人说话" → 收幕提示/强制
			const speakerCount = Math.max(2, Object.keys(script.definition.cast).length);
			if (this.globalPassStreak >= speakerCount + 1) this.emit("全员沉默——本幕可以收束，或导演介入");
			if (this.globalPassStreak >= speakerCount + 2) {
				await this.closeScene(false);
				return "closed";
			}
			return "continue";
		}
		if (kind === "invalid") {
			this.emit(`警告：${character} 的回合只输出了他人的台词，已视为沉默（${actorId}）`);
			this.globalPassStreak++;
			return "continue";
		}
		this.passStreak.set(actorId, 0);
		this.globalPassStreak = 0;
		const entry = makeStageEntry(sceneId, counts.turn + 1, actorId, character, cleaned);
		await appendStageEntry(this.bookDir, entry);
		this.emitEntry(entry);
		return "continue";
	}

	/** 演员的 "context" 事件处理器：重装 [世界书·你可知 | 舞台切片 | 剧本文字段 | 计数块]。 */
	async actorContext(actorId: string, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		if (!this.script || !this.sceneId || (this.phase !== "running" && this.phase !== "wrapping")) {
			return undefined;
		}
		const entries = await readStage(this.bookDir, this.sceneId);
		const injection = await resolveWorldInjection(this.bookDir, this.script.definition.inject[actorId]);
		const blocks = buildActorContextBlocks(this.script, entries, actorId, this.status, {
			wrapRemaining: this.wrapRemaining,
			worldInjection: injection?.text ?? null,
		});
		const tail: AgentMessage[] = [];
		if (blocks.worldBlock) {
			tail.push({ role: "user", content: `【世界书·你可知】\n${blocks.worldBlock}`, timestamp: Date.now() });
		}
		if (blocks.slice.length > 0) {
			tail.push({
				role: "user",
				content: `【舞台区·最近轮次】\n${formatStageLines(blocks.slice).join("\n")}`,
				timestamp: Date.now(),
			});
		}
		tail.push({
			role: "user",
			content: `【剧本·演出指令（v${this.script.version}）】\n${blocks.scriptLines.join("\n")}`,
			timestamp: Date.now(),
		});
		tail.push({ role: "user", content: blocks.counterBlock, timestamp: Date.now() });
		return [...messages, ...tail];
	}

	// ---- 用户命令 ----

	/** /revise：修改剧本（版本 +1，下一轮生效）。 */
	async userRevise(patch: ScriptPatch): Promise<string> {
		if (!this.script || !this.sceneId) return "当前没有在演的剧本";
		const revised = reviseScript(this.script, patch);
		await saveScript(this.bookDir, this.sceneId, revised);
		this.script = revised;
		this.emit(`剧本已修订 → v${revised.version}（下一轮生效）`);
		return `剧本 v${revised.version} 已生效`;
	}

	/** /wrap [N]：注入收尾提示（默认剧本 wrapUpWindow）。 */
	async userWrap(n?: number): Promise<string> {
		if (!this.script || this.phase !== "running") return "当前没有在演的一幕";
		this.status = "wrapping";
		this.wrapRemaining = n ?? this.script.definition.rules.wrapUpWindow;
		this.emit(`收尾提示已注入（剩余约 ${this.wrapRemaining} 条）`);
		return `收尾提示已注入（剩余约 ${this.wrapRemaining} 条）`;
	}

	/** /cut：立即收幕（在途轮次自然完成后收）。 */
	async userCut(): Promise<string> {
		if (this.phase !== "running" && this.phase !== "wrapping") return "当前没有在演的一幕";
		await this.closeScene(false);
		return "已收幕";
	}

	// ---- 收幕与编剧 ----

	private async closeScene(forced: boolean): Promise<void> {
		this.phase = "closed";
		this.emitPhase();
		const script = this.script;
		this.emit(forced ? `收幕（已达上限 ${script?.definition.rules.maxLines ?? "?"} 条）` : "收幕");
		if (!script || !this.sceneId) return;
		try {
			const entries = await readStage(this.bookDir, this.sceneId);
			if (entries.length > 0) {
				// ① 导演看思考链（§10.6/§10.7）：提炼内心 → world_update 更新世界书
				const thoughts = await this.collectActorThoughts();
				if (thoughts) {
					this.emit("收幕：导演正在检视各演员思考链并提炼角色内心…");
					// silent:自动回合,回复不进前端对话流(用户不看收幕内部流程)
					await this.directorSay(
						`【本幕各演员思考链】\n${thoughts}\n\n本幕已收幕。请：1) 从思考链提炼各角色内心（含矛盾），用 world_update 更新世界书角色条目；2) 简短回复确认。本幕已完结，不要提议继续演下一幕——新的一幕由用户切换章节后开始。`,
						{ silent: true },
					);
				}
				// 导演整理回合结束(或无此回合):前端撤「导演正在编辑消息」提示条——
				// 编剧成文阶段不再提示(2026-08-11)
				this.onEvent?.({ type: "director_done" });
				// ② 编剧成文（§10.7 修订）：输入 = 舞台转录 + 剧本 state + 世界书（导演已更新）
				const lines = formatStageLines(entries).join("\n");
				const stateText = renderStateForWriter(script);
				const world = await ensureWorld(this.bookDir);
				const worldText = world.entries
					.filter((e) => e.type === "character" || e.type === "world")
					.map((e) => `【${e.title}】${e.body}`)
					.join("\n");
				// 章节文件基名(ch01):收幕成文(draft/ch01.md)与编剧会话(writer-ch01.jsonl)
				// 都按「章节文件」命名,与编辑页/常驻编剧读取一致(2026-08-11 修:此前用
				// script.chapter 标题,产出 draft/第一章.md、writer-第一章.jsonl,
				// 编辑页按 ch01 读不到——草稿空白、编剧对话不重载的根因)
				const chapter = this.chapterFile ? this.chapterFile.replace(/\.jsonl$/, "") : script.chapter;
				const styleSample = world.styleSample && world.styleSample.text ? world.styleSample.text : null;
				const writerMsg = buildWriterMessage({
					transcript: lines,
					stateText,
					worldText,
					styleSample,
					chapter,
					thoughts,
					thoughtAccess: this.writerThoughtAccess,
				});
				// 编剧回合 10 分钟兜底：超时则正文缺失，但收尾流程继续（"一幕完成" 仍会提示）
				if (this.writerHost) {
					// 常驻编剧 === 收幕编剧(2026-08-11):委托同一 (书, 章节) 会话
					// (chapterFile = <章节文件基名>.jsonl,如 ch01.jsonl)——编辑页「编剧」
					// 标签的对话与收幕成文同一份记忆;无 writerHost(CLI)走内置 stage-writer
					if (!(await this.writerHost.chatAndWait(basename(this.bookDir), writerMsg, `${chapter}.jsonl`, 600_000))) {
						this.emit("编剧回合超时（>10 分钟），正文未生成");
					}
				} else {
					const writer = await this.ensureWriter();
					if (!(await runTurn(writer, () => writer.sendMessage(writerMsg), 600_000))) {
						this.emit("编剧回合超时（>10 分钟），正文未生成");
					}
				}
				this.emit(`编剧已完成，正文 → draft/${chapter}.md`);
			}
		} catch (error) {
			this.emit(`编剧整理失败：${error instanceof Error ? error.message : String(error)}`);
		}
		this.emit("一幕完成。这一幕已完结：可在本章内修订重演，或切换到新章节开始下一幕的讨论。");
		this.setDirectorMode("scene-closed", "收幕");
	}

	/** 收集各演员会话的思考链（§10.6：导演收幕检视用；不进转录）。 */
	private async collectActorThoughts(): Promise<string | null> {
		const parts: string[] = [];
		for (const [actorId, host] of this.actorHosts) {
			const state = host.getState();
			const thoughts = state.messages
				.filter((m) => m.role === "assistant" && m.thinking)
				.map((m) => m.thinking)
				.join("\n");
			if (thoughts.trim()) parts.push(`【${actorId}】\n${thoughts}`);
		}
		return parts.length > 0 ? parts.join("\n\n") : null;
	}

	/** 重置演员会话历史（§10.5 精准重演：旧演出必须清掉，否则带跑新演出）。 */
	private resetActorSession(actorId: string): void {
		const host = this.actorHosts.get(actorId);
		if (!host) return;
		try {
			const agent = (host.getRuntime().session as unknown as { agent?: { state?: { messages?: unknown[] } } }).agent;
			if (agent?.state) agent.state.messages = [];
		} catch {
			// 重置失败不致命——新演出仍可继续（旧历史可能残留，可观察）
		}
	}

	private async ensureWriter(): Promise<SessionHost> {
		if (!this.writer) this.writer = await this.createRoleHost("stage-writer", writerRole());
		return this.writer;
	}
}

/** 默认编制：4 群演槽位 + 1 叙述者（导演可在 cast.json 中调整）。 */
async function ensureDefaultCast(bookDir: string): Promise<void> {
	const cast = await loadCast(bookDir);
	if (cast.actors.length > 0) return;
	cast.actors.push({ id: "actor-1", type: "pool" }, { id: "actor-2", type: "pool" }, { id: "actor-3", type: "pool" }, { id: "actor-4", type: "narrator" });
	await saveCast(bookDir, cast);
}
