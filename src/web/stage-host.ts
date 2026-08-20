import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getBookDir } from "../config.ts";
import { getBookSessionsDir } from "../book-manager.ts";
import { chatTextOfMessage, chatThinkingOfMessage } from "../session-text.ts";
import { countStage } from "../stage/counters.ts";
import { loadCast } from "../stage/cast.ts";
import { readStage } from "../stage/stage-store.ts";
import { StageOrchestrator, type StageEvent } from "../stage/orchestrator.ts";
import type { CastConfig, DirectorMode, ScenePhase, SceneScript, ScriptPatch, StageEntry, StageStatus } from "../stage/types.ts";
import type { ToolDefinition } from "../../vendor/pi-coding-agent/src/index.ts";
import { ensureWorld } from "../world-data.ts";
import type { SessionContextUsage } from "./session-host.ts";
import type { WriterHost } from "./writer-host.ts";
import type { AgentSessionEvent } from "../../vendor/pi-coding-agent/src/index.ts";

/**
 * 舞台区 web 宿主：每本书一个 StageOrchestrator（惰性创建），把 CLI 命令面
 * 暴露为结构化命令，舞台事件转发给 server 广播到 SSE。
 *
 * 命令分两类：
 *   - 同步命令：orchestrator 方法即时返回文本（无模型回合）→ HTTP 200 { text }
 *   - 长命令：内部有模型回合（director/fix/cut）→ HTTP 202，结束时广播 done 事件
 *
 * 状态违规不抛错：orchestrator 方法返回中文提示文本（与 CLI 打印一致），
 * 前端直接展示。参数缺失/类型错误才抛 StageCommandError（→ 400）。
 */

export interface StageHostOptions {
	/** --model 模式串（传给 orchestrator 的 roleFactory 解析）。 */
	model?: string;
	/** --thinking 档位。 */
	thinkingLevel?: string;
	/** 全局采样温度（演员可被 cast.json 覆盖）。 */
	temperature?: number;
	/** 全局核采样概率（演员可被 cast.json 覆盖）。 */
	topP?: number;
	/** 常驻编剧宿主(收幕委托;未注入时编排器走内置 writer,CLI 行为)。 */
	writerHost?: WriterHost;
	/** MCP 外部工具惰性获取(web 注入,编排器创建时才取最新——启动时 stdio 连接
	 *  可能未就绪,构造时快照会拿到空,2026-08-11 实测)。 */
	getMcpTools?: () => ToolDefinition[];
	/** 测试注入：自定义编排器工厂（缺省创建真实编排器）。 */
	createOrchestrator?: (bookDir: string) => StageOrchestrator;
}

export type StageHostEvent =
	| { type: "entry"; slug: string; chapterFile: string | null; entry: StageEntry }
	| { type: "system"; slug: string; chapterFile: string | null; text: string }
	| { type: "done"; slug: string; chapterFile: string | null; cmd: string; ok: boolean; text?: string; thinking?: string }
	// 导演会话事件全量透传(与 writer_event 同款,内层是主会话同款会话事件):
	// 前端复用 processAgentEvent 归约 + MessageList 渲染(2026-08-11 统一重构);
	// 消息/思考/工具卡片/流式全在内层,不再需要独立的 tool_*/director_text 事件
	| { type: "director_event"; slug: string; chapterFile: string | null; event: AgentSessionEvent }
	// 剧本待确认(script_confirm 提交):前端以卡片展示剧本 + 确认/修改按钮
	| { type: "script_confirm"; slug: string; chapterFile: string | null; sceneId: string; script: SceneScript }
	// 世界书编辑信号(world_update 工具已写记录文件;前端回合结束读文件渲染预览卡)
	| { type: "world_edit"; slug: string; chapterFile: string | null }
	// 收幕导演整理回合结束:前端撤「导演正在编辑消息」提示条(不等编剧成文)
	| { type: "director_done"; slug: string; chapterFile: string | null }
	// 舞台阶段变化(开演/收幕):前端收到后自动刷新快照
	| { type: "phase"; slug: string; chapterFile: string | null; phase: ScenePhase };

export interface StageCommandResult {
	/** 命令即时文本结果（CLI 打印同款）。 */
	text: string;
	/** true = 长命令：结果经 done 事件到达（stage_done { cmd, text? }），HTTP 层回 202。 */
	async: boolean;
}

export interface StageSnapshot {
	slug: string;
	/** 归属章节(舞台按章节隔离;null = 书级)。 */
	chapterFile: string | null;
	sceneId: string | null;
	phase: ScenePhase;
	status: StageStatus;
	mode: DirectorMode;
	script: SceneScript | null;
	/** 待确认剧本（script_confirm 提交后、用户确认前；null = 无待确认）。 */
	pendingScript: { sceneId: string; script: SceneScript; confirmed: boolean } | null;
	cast: CastConfig;
	transcript: StageEntry[];
	counts: ReturnType<typeof countStage>;
	directorLast: string | undefined;
	/** 导演讨论历史(用户/导演消息对,assistant 带思考链;供前端恢复气泡与思考折叠;
	 *  服务端仅内存态,重启丢失)。 */
	directorChat: Array<{ role: "user" | "assistant"; text: string; thinking?: string }>;
	/** 角色名 → 世界书条目头像文件(world.json entries 中 avatar 非空者,按 title 匹配;前端无头像走首字兜底)。 */
	avatars: Record<string, string>;
	/** 导演会话上下文占用(供前端「建议 /compact」提示;无活跃会话/未知时为 null)。 */
	directorUsage: SessionContextUsage | null;
}

/** 从世界书收集角色头像:仅取 avatar 非空的条目(title → avatar 文件引用)。 */
async function collectAvatars(bookDir: string): Promise<Record<string, string>> {
	try {
		const world = await ensureWorld(bookDir);
		const out: Record<string, string> = {};
		for (const e of world.entries) {
			if (e.avatar) out[e.title] = e.avatar;
		}
		return out;
	} catch {
		return {};
	}
}

/** 导演讨论历史类型(快照字段与 getDirectorChat 共用)。 */
export type DirectorChatMessage = { role: "user" | "assistant"; text: string; thinking?: string };

/**
 * 从磁盘导演会话文件恢复讨论历史——导演会话由 SessionManager 持久化,服务重启后
 * orchestrator 未创建时,快照仍能给出气泡与「导演最近一句」(否则重启后对话看起来
 * 全丢)。文件按章节隔离(stage-director-<chapterId>.jsonl,舞台按章节一幕,2026-08-10)。
 * 坏行跳过。
 */
function readDirectorChatFromDisk(slug: string, chapterFile: string | null): DirectorChatMessage[] {
	try {
		const chapterId = chapterFile ? chapterFile.replace(/\.jsonl$/, "") : null;
		const file = chapterId ? `stage-director-${chapterId}.jsonl` : "stage-director.jsonl";
		const abs = join(getBookSessionsDir(slug), file);
		if (!existsSync(abs)) return [];
		const chat: DirectorChatMessage[] = [];
		for (const line of readFileSync(abs, "utf-8").split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const rec = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
				const message = rec.message;
				if (rec.type !== "message" || !message) continue;
				const role = message.role;
				if (role !== "user" && role !== "assistant") continue;
				const text = chatTextOfMessage(message);
				if (!text) continue;
				const thinking = role === "assistant" ? chatThinkingOfMessage(message) || undefined : undefined;
				chat.push({ role, text, thinking });
			} catch {
				/* 坏行跳过(会话文件可能被并发写/截断) */
			}
		}
		return chat;
	} catch {
		return [];
	}
}

/** 命令参数校验错误（server 映射为 400）。 */
export class StageCommandError extends Error {}

export class StageHost {
	private readonly options: StageHostOptions;
	private temperature?: number;
	private topP?: number;
	private readonly orchestrators = new Map<string, StageOrchestrator>();
	/** 事件转发（server 构造时注入 → broadcast 到 SSE）；注入前静默丢弃。 */
	private eventSink: (slug: string, event: StageHostEvent) => void = () => {};

	constructor(options: StageHostOptions) {
		this.options = options;
		this.temperature = options.temperature;
		this.topP = options.topP;
	}

	/** server 构造时注入事件转发（StageHost 在 web.ts 先于 server 创建）。 */
	setEventSink(sink: (slug: string, event: StageHostEvent) => void): void {
		this.eventSink = sink;
	}

	/** 设置采样参数：更新未来编排器的默认值，并即时应用到已创建的导演/演员/编剧会话。null 恢复模型默认。 */
	async setSamplingParameters(temperature?: number | null, topP?: number | null): Promise<void> {
		if (temperature !== undefined) this.temperature = temperature ?? undefined;
		if (topP !== undefined) this.topP = topP ?? undefined;
		await Promise.all([...this.orchestrators.values()].map((orch) => orch.setSamplingParameters(temperature, topP)));
	}

	/** 编排器键:书 + 章节(舞台按章节隔离——每章一幕独立对话/演出,切章不串,2026-08-10)。 */
	private static key(slug: string, chapterFile: string | null | undefined): string {
		return `${slug}:${chapterFile ?? "default"}`;
	}

	/** 取（或惰性创建并启动）某书某章的编排器。 */
	private async getOrCreate(slug: string, chapterFile: string | null | undefined): Promise<StageOrchestrator> {
		const key = StageHost.key(slug, chapterFile);
		const existing = this.orchestrators.get(key);
		if (existing) return existing;
		const bookDir = getBookDir(slug);
		const orch = this.options.createOrchestrator
			? this.options.createOrchestrator(bookDir)
				: new StageOrchestrator({
						bookDir,
						agentDir: getAgentDir(),
						chapterFile: chapterFile ?? null,
						model: this.options.model,
						thinkingLevel: this.options.thinkingLevel,
						temperature: this.temperature,
						topP: this.topP,
						writerHost: this.options.writerHost,
						mcpTools: this.options.getMcpTools?.(),
						onEvent: (event) => {
							const cf = chapterFile ?? null;
							if (event.type === "stage") {
								this.eventSink(slug, { type: "entry", slug, chapterFile: cf, entry: event.entry });
							} else if (event.type === "system") {
								this.eventSink(slug, { type: "system", slug, chapterFile: cf, text: event.text });
							} else if (event.type === "director_event") {
								this.eventSink(slug, { type: "director_event", slug, chapterFile: cf, event: event.event });
								} else if (event.type === "script_confirm") {
									this.eventSink(slug, { type: "script_confirm", slug, chapterFile: cf, sceneId: event.sceneId, script: event.script });
								} else if (event.type === "world_edit") {
									this.eventSink(slug, { type: "world_edit", slug, chapterFile: cf });
								} else if (event.type === "director_done") {
									this.eventSink(slug, { type: "director_done", slug, chapterFile: cf });
								} else if (event.type === "phase") {
								this.eventSink(slug, { type: "phase", slug, chapterFile: cf, phase: event.phase });
							} else {
								this.eventSink(slug, { type: "done", slug, chapterFile: cf, cmd: "director", ok: true });
							}
						},
					});
		await orch.start();
		this.orchestrators.set(key, orch);
		return orch;
	}

	/** 全部编排器释放（server stop 时调用）。 */
	async disposeAll(): Promise<void> {
		const all = [...this.orchestrators.values()];
		this.orchestrators.clear();
		await Promise.allSettled(all.map((o) => o.dispose()));
	}

	/** 释放某本书的全部章节编排器（删除书前调用;无编排器时静默）。
	 *  不释放则删除后编排器仍在内存,继续写 world.json/outline.md,目录复活。 */
	async dispose(slug: string): Promise<void> {
		const all: StageOrchestrator[] = [];
		for (const [key, orch] of this.orchestrators) {
			if (key.startsWith(`${slug}:`)) all.push(orch);
		}
		for (const key of [...this.orchestrators.keys()]) {
			if (key.startsWith(`${slug}:`)) this.orchestrators.delete(key);
		}
		await Promise.allSettled(all.map((o) => o.dispose()));
	}

	/** 舞台快照（纯读，不创建编排器；无活跃编排器时返回空态）。 */
	async snapshot(slug: string, chapterFile?: string | null): Promise<StageSnapshot> {
		const orch = this.orchestrators.get(StageHost.key(slug, chapterFile));
		const bookDir = getBookDir(slug);
		if (!orch) {
			// 无活跃编排器(服务重启/从未对话):导演讨论从磁盘会话文件恢复,
			// 否则刷新/重启后对话气泡全丢(directorLast 同源恢复)
			const chat = readDirectorChatFromDisk(slug, chapterFile ?? null);
			return {
				slug,
				chapterFile: chapterFile ?? null,
				sceneId: null,
				phase: "idle",
				status: "normal",
				mode: "discussion",
				script: null,
				pendingScript: null,
				cast: await loadCast(bookDir),
				transcript: [],
				counts: { lines: 0, perActor: {}, perCharacter: {}, cnChars: 0, turn: 0 },
				directorLast: chat.filter((m) => m.role === "assistant").at(-1)?.text,
				directorChat: chat,
				avatars: await collectAvatars(bookDir),
				directorUsage: null,
			};
		}
			const entries = orch.sceneId ? await readStage(bookDir, orch.sceneId) : [];
			return {
				slug,
				chapterFile: chapterFile ?? null,
				sceneId: orch.sceneId,
				phase: orch.phase,
				status: orch.status,
				mode: orch.getDirectorMode(),
				script: orch.script,
				/** 待确认剧本（script_confirm 提交后、用户确认前；前端显示「待确认」态）。 */
				pendingScript: orch.getPendingScript(),
				cast: await loadCast(bookDir),
				transcript: entries,
				counts: countStage(entries),
				directorLast: orch.getDirectorLast(),
				directorChat: orch.getDirectorChat(),
				avatars: await collectAvatars(bookDir),
				directorUsage: orch.getDirectorUsage(),
			};
		}

	/**
	 * 命令分发。同步命令直接返回 { text, async: false }；
	 * 长命令校验通过后后台执行（结果经 onEvent done 事件），返回 { text: "", async: true }。
	 */
	async command(slug: string, cmdName: string, args: Record<string, unknown>, chapterFile?: string | null): Promise<StageCommandResult> {
		const orch = await this.getOrCreate(slug, chapterFile);
		switch (cmdName) {
			case "next":
				return { text: await orch.userNext(), async: false };
			case "auto":
				return { text: await orch.userAuto(), async: false };
			case "force":
				return { text: await orch.userForce(requireString(args, "target")), async: false };
			case "retry": {
				const note = optionalString(args, "note");
				return { text: await orch.userRetry(note), async: false };
			}
			case "revise": {
				const patch = requireObject(args, "patch") as ScriptPatch;
				return { text: await orch.userRevise(patch), async: false };
			}
			case "wrap": {
				const n = optionalInt(args, "n");
				return { text: await orch.userWrap(n), async: false };
			}
			case "thoughts": {
				const level = requireInt(args, "level");
				if (level < 1 || level > 3) throw new StageCommandError("thoughts 等级必须是 1-3");
				return { text: await orch.userThoughts(level), async: false };
			}
			case "mode": {
				const label: Record<DirectorMode, string> = { discussion: "讨论", scripting: "剧本", directing: "导演" };
				return { text: `导演当前模式：${label[orch.getDirectorMode()]}`, async: false };
			}
			case "director": {
				const text = requireString(args, "text");
				void this.runLong(
					slug,
					chapterFile ?? null,
					cmdName,
					async () => {
						await orch.directorSay(text);
						return orch.getDirectorLast() ?? "";
					},
					() => orch.getDirectorLastThinking(),
				);
				return { text: "", async: true };
			}
			case "fix": {
				const index = requireInt(args, "index");
				const feedback = requireString(args, "feedback");
				if (index < 1) throw new StageCommandError("fix 序号必须 ≥ 1");
				void this.runLong(slug, chapterFile ?? null, cmdName, async () => orch.userFix(index, feedback));
				return { text: "", async: true };
			}
			case "cut":
				void this.runLong(slug, chapterFile ?? null, cmdName, async () => orch.userCut());
				return { text: "", async: true };
			case "compact": {
				// 手动压缩导演会话上下文(模型总结回合):compaction_start/end 经
				// director_event 驱动前端「正在压缩上下文」提示,完成经 done 回报。
				const instructions = optionalString(args, "instructions");
				void this.runLong(slug, chapterFile ?? null, cmdName, async () => orch.directorCompact(instructions));
				return { text: "", async: true };
			}
			case "confirm_script":
				// 用户确认剧本（前端卡片确认按钮）→ 置 confirmed + 提示导演开演；同步返回
				return { text: await orch.confirmScript(), async: false };
			default:
				throw new StageCommandError(`未知命令：${cmdName}（next/auto/force/retry/revise/wrap/thoughts/mode/director/fix/cut/compact/confirm_script）`);
		}
	}

	/** 长命令执行：异常不崩进程，经 done 事件带 ok:false 回报（前端显示友好错误）。
	 *  thinkingFn 可选：导演发言等命令在 done 事件携带回复的思考链（前端折叠查看）。 */
	private async runLong(
		slug: string,
		chapterFile: string | null,
		cmdName: string,
		fn: () => Promise<string>,
		thinkingFn?: () => string | undefined,
	): Promise<void> {
		try {
			const text = await fn();
			this.eventSink(slug, {
				type: "done",
				slug,
				chapterFile,
				cmd: cmdName,
				ok: true,
				...(text ? { text } : {}),
				...(thinkingFn ? { thinking: thinkingFn() } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.eventSink(slug, { type: "system", slug, chapterFile, text: `舞台异常：${message}` });
			this.eventSink(slug, { type: "done", slug, chapterFile, cmd: cmdName, ok: false, text: message });
		}
	}
}

// ---- 参数校验小工具 ----

function requireString(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	if (typeof v !== "string" || v.length === 0) throw new StageCommandError(`缺少字段 ${key}`);
	return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw new StageCommandError(`字段 ${key} 必须是字符串`);
	return v;
}

function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
	const v = args[key];
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new StageCommandError(`缺少字段 ${key}（对象）`);
	return v as Record<string, unknown>;
}

function requireInt(args: Record<string, unknown>, key: string): number {
	const v = args[key];
	if (typeof v !== "number" || !Number.isInteger(v)) throw new StageCommandError(`缺少字段 ${key}（整数）`);
	return v;
}

function optionalInt(args: Record<string, unknown>, key: string): number | undefined {
	const v = args[key];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v)) throw new StageCommandError(`字段 ${key} 必须是整数`);
	return v;
}
