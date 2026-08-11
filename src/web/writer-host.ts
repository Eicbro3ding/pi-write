/**
 * 常驻编剧(编辑 agent)web 宿主:每本书每章一个 writer 会话(惰性创建,会话文件
 * sessions/<slug>/writer-<章节>.jsonl)。
 *
 * **常驻编剧 === 收幕编剧(2026-08-11 统一)**:编排器收幕时若本宿主已注入
 * (StageOrchestratorOptions.writerHost),成文任务委托给同一 (书, 章节) 会话
 * (chatAndWait)——编辑页「编剧」标签的对话与收幕成文是同一个编剧、同一份记忆;
 * CLI 模式无本宿主,收幕仍走编排器内置 writer(stage-writer.jsonl)。
 *
 * 上下文注入(context 钩子,每次调用前):当前章节草稿 + 世界书角色条目 +
 * 文风采样 + 最近一幕舞台转录——编剧据此讨论行文/取舍/评戏/维护 advice.md。
 * 章节由 chat() 的 chapterFile 声明(每书记最近一次,无则只注入世界书)。
 *
 * 事件:SessionHost.subscribe 的原生会话事件(含 message_end 附加的 entryId)
 * 原样转发给 eventSink,由 server 经 /api/events 广播为 writer_event { slug, event };
 * 前端复用 processAgentEvent 归约(消息/思考/工具卡片与主会话同款逻辑)。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getBookSessionsDir, initChapterFile } from "../book-manager.ts";
import { getAgentDir, getBookDir, resolveSkillsDir } from "../config.ts";
import { createSessionRuntimeFactory } from "../session-factory.ts";
import { chatTextOfMessage } from "../session-text.ts";
import { extractMessagesFromManager } from "./session-host.ts";
import type { AgentMessage, ThinkingLevel } from "../../vendor/pi-agent-core/src/index.ts";
import type { ToolDefinition } from "../../vendor/pi-coding-agent/src/index.ts";
import {
	type AgentSessionEvent,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	SessionManager,
} from "../../vendor/pi-coding-agent/src/index.ts";
import { ensureWorld } from "../world-data.ts";
import { SessionHost } from "./session-host.ts";
import { formatStageLines } from "../stage/assembler.ts";
import { countStage } from "../stage/counters.ts";
import { readStage } from "../stage/stage-store.ts";

/** 常驻编剧系统提示:讨论为主、修改为辅,改动说明意图;收幕委托为正式写作任务。 */
const EDITOR_PROMPT = `你是「编剧」,写作台的常驻编辑伙伴。随时可与用户讨论行文、取舍、节奏、人物与细节。
· 你可以在思考里面拟人化的对剧进行吐槽和思考;
· 需要修改正文时用 write/edit 工具直接修改,并在回复里说明改了什么、为什么;
· 正文文件固定为 draft/<章节id>.md(如 draft/ch01.md),由当前章节决定——文件不存在时用 write 创建该路径,不得自创其他文件名,也不要在 draft/ 目录写别的文件(写其他路径会被工具拒绝);
· 你的修改会立即落盘,用户在批注栏能看到「待确认」卡片并可回退——所以改动前想清楚,每次改动尽量小、意图明确;
· 上下文里的【当前正文】是讨论对象,不是必须保留的定稿;【世界书】与【文风采样】是背景知识,引用时保持设定一致;
· 讨论为主、修改为辅:用户没让你改,不要擅自大改;
· 收幕委托:导演收幕时会发来【舞台转录】并要求你把舞台记录整理成正文——消息里会写明目标文件(draft/…),这是你的正式写作任务,完成后用 write 工具落盘;
· 为导演维护书目录下的 advice.md:写下对下一章的建议(节奏/人物/悬念/可补充的世界书设定)(主要是剧本),导演开下一幕前会读到;没有想说的可保持原样;
· 禁止直接修改世界书文件(world.json 与 .writer/ 目录)——世界书由导演维护,你的世界书相关建议写进 advice.md;`;

/** 注入块长度上限(草稿/世界书正文截断,防上下文膨胀)。 */
const DRAFT_LIMIT = 4000;
const WORLD_LIMIT = 3000;
const STYLE_LIMIT = 800;
const STAGE_LIMIT = 8000;

export interface WriterHostOptions {
	/** --model 模式串(传给 createSessionRuntimeFactory 解析)。 */
	model?: string;
	/** --thinking 档位。 */
	thinkingLevel?: string;
	/** MCP 外部工具惰性获取(web 注入,编剧会话可用;导演同款,2026-08-11)。 */
	getMcpTools?: () => ToolDefinition[];
	/** 测试注入:自定义宿主工厂(缺省创建真实会话)。 */
	createHost?: (slug: string) => Promise<SessionHost>;
}

/** 前端可消费的编剧会话状态(纯读,不创建会话)。 */
export interface WriterState {
	bookSlug: string;
	/** 最近一次对话声明的章节会话文件 basename(无则 null)。 */
	chapterFile: string | null;
	/** 会话文件是否已创建(未对话过的书无会话)。 */
	exists: boolean;
	isStreaming: boolean;
	messages: Array<{ role: "user" | "assistant"; text: string; thinking?: string; timestamp?: string; id?: string }>;
}

/** 读取文本文件;不存在/读取失败返回 null。 */
async function readTextSafe(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

export class WriterHost {
	private readonly options: WriterHostOptions;
	/** 会话键 = `${slug}:${chapterFile}`(编剧对话按章节隔离——切章后各章独立
	 *  对话/历史/上下文,不再整本书共用,2026-08-10)。 */
	private readonly hosts = new Map<string, SessionHost>();
	/** 每书最近一次对话声明的章节文件(无 chapterFile 参数的端点兜底定位)。 */
	private readonly currentChapter = new Map<string, string | null>();
	/** 事件转发(server 构造时注入 → broadcast 为 writer_event);注入前静默丢弃。 */
	private eventSink: (slug: string, event: AgentSessionEvent) => void = () => {};

	constructor(options: WriterHostOptions) {
		this.options = options;
	}

	/** server 构造时注入事件转发(WriterHost 在 web.ts 先于 server 创建)。 */
	setEventSink(sink: (slug: string, event: AgentSessionEvent) => void): void {
		this.eventSink = sink;
	}

	/** 会话键:书 + 章节(chat 未声明章节时用 currentChapter 兜底,再无则 "default")。 */
	private static key(slug: string, chapterFile: string | null | undefined): string {
		return `${slug}:${chapterFile ?? "default"}`;
	}

	/** 取(或惰性创建并启动)某书某章的常驻编剧会话。 */
	private async getOrCreate(slug: string, chapterFile: string | null): Promise<SessionHost> {
		const key = WriterHost.key(slug, chapterFile);
		const existing = this.hosts.get(key);
		if (existing) return existing;
		const host = this.options.createHost
			? await this.options.createHost(`${key}`)
			: await this.createHost(slug, chapterFile);
		host.subscribe((event) => this.eventSink(slug, event));
		this.hosts.set(key, host);
		return host;
	}

	/** 装配常驻编剧会话(复用 createSessionRuntimeFactory;工具 = write/read,无 bash)。
	 *  会话文件按章节隔离(sessions/<slug>/writer-<chapterId>.jsonl)。 */
	private async createHost(slug: string, chapterFile: string | null): Promise<SessionHost> {
		const agentDir = getAgentDir();
		const { model, thinkingLevel } = this.options;
		const bookDir = getBookDir(slug);
		const sessionsDir = getBookSessionsDir(slug);
		await mkdir(sessionsDir, { recursive: true });
		const abs = join(sessionsDir, writerSessionFile(chapterFile));
		await initChapterFile(abs, bookDir);
		const runtimeFactory = this.roleFactory(slug, chapterFile);
		const sessionManager = SessionManager.open(abs, sessionsDir, bookDir);
		const host = new SessionHost({
			createRuntime: runtimeFactory,
			cwd: bookDir,
			agentDir,
			sessionManager,
		});
		await host.start();
		return host;
	}

	/** 会话装配工厂(与 stage 角色同款样板;context 钩子注入本会话章节/世界书/文风采样)。 */
	private roleFactory(slug: string, chapterFile: string | null): CreateAgentSessionRuntimeFactory {
		const agentDir = getAgentDir();
		const { model, thinkingLevel } = this.options;
		const inject = (messages: AgentMessage[]): Promise<AgentMessage[] | undefined> => this.editorContext(slug, chapterFile, messages);
		// 正文文件白名单:write 只允许写当前章节文件(agent 自创文件名会把正文写到
		// 前端读不到的路径——2026-08-11 编剧乱写 draft/第一章.md 的根因)
		const draftFile = chapterFile ? chapterFile.replace(/\.jsonl$/, ".md") : undefined;
		return createSessionRuntimeFactory({
			agentDir,
			// skills 目录只读放行(与 web.ts 同款):模型经 read 工具加载 skill 文件时不被守卫误拦
			readOnlyDirs: [resolveSkillsDir()],
			draftFile,
			systemPromptOverride: () => EDITOR_PROMPT,
			extensionFactories: [
				{
					name: `writer-resident-${slug}-${writerSessionFile(chapterFile)}`,
					factory: (pi: ExtensionAPI) => {
						pi.on("context", async (event) => {
							const result = await inject(event.messages);
							return result ? { messages: result } : undefined;
						});
					},
				},
			],
			model,
			thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
			excludeTools: ["bash"],
			initialActiveToolNames: ["write", "read"],
			customTools: this.options.getMcpTools?.(),
		});
	}

	/** 上下文注入:本会话章节草稿 + 世界观概述 + 世界书角色条目 + 文风采样 + 最近一幕舞台转录(截断保护)。
	 *  章节随会话固定——切章后新会话注入新章,旧会话不再被使用。 */
	private async editorContext(slug: string, chapterFile: string | null, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		const blocks: string[] = [];
		if (chapterFile) {
			const file = `draft/${chapterFile.replace(/\.jsonl$/, ".md")}`;
			const draft = await readTextSafe(join(getBookDir(slug), file));
			if (draft !== null && draft.trim().length > 0) {
				const body = draft.length > DRAFT_LIMIT ? `${draft.slice(0, DRAFT_LIMIT)}\n…(截断)` : draft;
				blocks.push(`【当前正文 · ${file}】\n${body}`);
			} else {
				// 正文文件不存在/为空:仍注入路径约定——信息缺失是 agent 自创文件名
				// (draft/第一章.md)导致前端按约定路径读到空的根因(2026-08-11)
				blocks.push(`【当前正文 · ${file}】尚未创建——你的写作/修改请用 write 工具写入此文件(路径如上),不要自创其他文件名`);
			}
		}
		try {
			const world = await ensureWorld(getBookDir(slug));
			// 简要世界观概述(常驻,与写作会话同款语义;为空跳过,截断保护同采样)
			const summary = world.worldSummary?.trim();
			if (summary && summary.length > 0) {
				const body = summary.length > STYLE_LIMIT ? `${summary.slice(0, STYLE_LIMIT)}\n…(截断)` : summary;
				blocks.push(`【世界观概述】\n${body}`);
			}
			const chars = world.entries
				.filter((e) => e.type === "character" || e.type === "world")
				.map((e) => `【${e.title}】${e.body}`)
				.join("\n");
			if (chars.trim().length > 0) {
				const body = chars.length > WORLD_LIMIT ? `${chars.slice(0, WORLD_LIMIT)}\n…(截断)` : chars;
				blocks.push(`【世界书】\n${body}`);
			}
			const style = world.styleSample?.text;
			if (style && style.trim().length > 0) {
				const body = style.length > STYLE_LIMIT ? `${style.slice(0, STYLE_LIMIT)}…(截断)` : style;
				blocks.push(`【文风采样】\n${body}`);
			}
		} catch {
			/* 世界书缺失:跳过注入,不阻断对话 */
		}
		// 最近一幕舞台转录(评戏与 advice.md 的依据;收幕委托回合消息内已含【舞台转录】,
		// 此处会重复注入同源内容——截断上限兜底,可接受)
		const transcript = await latestStageTranscript(getBookDir(slug));
		if (transcript) blocks.push(`【最近一幕舞台转录】\n${transcript}`);
		if (blocks.length === 0) return undefined;
		return [...messages, { role: "user", content: blocks.join("\n\n"), timestamp: Date.now() }];
	}

	/** 编剧会话状态快照(纯读;未对话过的章节返回空态,不创建会话)。
	 *  chapterFile 缺省用该书最近一次对话声明的章节。 */
	async state(slug: string, chapterFile?: string | null): Promise<WriterState> {
		const file = chapterFile ?? this.currentChapter.get(slug) ?? null;
		const key = WriterHost.key(slug, file);
		const host = this.hosts.get(key);
		if (!host) {
			// 服务重启后 hosts 内存为空:从磁盘会话文件恢复分支视图——否则前端对齐
			// 拿到空态,编剧对话「看起来全丢」(与舞台导演同源问题,2026-08-10);
			// SessionManager.open 只读解析,只显示当前 leaf 的消息(撤回的旧分支不混入)
			const fromDisk = readSessionFromDisk(slug, file);
			if (fromDisk) {
				return {
					bookSlug: slug,
					chapterFile: file,
					exists: fromDisk.messages.length > 0,
					isStreaming: false,
					messages: fromDisk.messages,
				};
			}
			return { bookSlug: slug, chapterFile: file, exists: false, isStreaming: false, messages: [] };
		}
		const st = host.getState();
		return {
			bookSlug: slug,
			chapterFile: file,
			exists: true,
			isStreaming: st.isStreaming,
			messages: st.messages,
		};
	}

	/** 发消息给编剧(惰性建会话;失败抛出,由 server 广播 chat_error)。
	 *  chapterFile 声明会话归属章节(无则用最近声明,再无则 default)。 */
	async chat(slug: string, text: string, chapterFile?: string): Promise<void> {
		if (chapterFile) this.currentChapter.set(slug, chapterFile);
		const file = chapterFile ?? this.currentChapter.get(slug) ?? null;
		const host = await this.getOrCreate(slug, file);
		await host.sendMessage(text);
	}

	/**
	 * 发消息给编剧并**等待回合完成**(收幕委托专用——编排器需在正文落盘后才
	 * 继续 emit「编剧已完成」)。与编排器 runTurn 同款语义:sendMessage 完成
	 * 即回合完成(agent_settled 在 prompt() 返回前已发出,勿再订阅),超时返回
	 * false 由调用方优雅降级;模型错误直接 throw 上抛。
	 */
	async chatAndWait(slug: string, text: string, chapterFile: string | null | undefined, timeoutMs = 600_000): Promise<boolean> {
		if (chapterFile) this.currentChapter.set(slug, chapterFile);
		const file = chapterFile ?? this.currentChapter.get(slug) ?? null;
		const host = await this.getOrCreate(slug, file);
		const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
		const result = await Promise.race([host.sendMessage(text).then(() => "sent" as const), timer]);
		return result === "sent";
	}

	/** 中止编剧当前生成(无会话时静默)。 */
	async abort(slug: string): Promise<void> {
		// 中止该书全部章节会话的生成(端点不带章节参数;生成中的章节中止即可)
		for (const [key, host] of this.hosts) {
			if (key.startsWith(`${slug}:`)) await host.abort();
		}
	}

	/** 编剧会话「编辑重发」:撤回最新用户消息(及之后),replacement 非空时撤回后重发。
	 *  内存无会话时从磁盘恢复再操作(服务重启后浏览器历史仍在,retract 不能因内存空而失败)。 */
	async retractMessage(slug: string, entryId: string, replacement?: string, chapterFile?: string | null): Promise<void> {
		const file = chapterFile ?? this.currentChapter.get(slug) ?? null;
		const host = await this.getOrCreate(slug, file);
		await host.retractMessage(entryId);
		if (replacement !== undefined && replacement.trim().length > 0) {
			void host.sendMessage(replacement).catch((err) => {
				process.stderr.write(`[writer] 编辑重发失败: ${err instanceof Error ? err.message : String(err)}\n`);
			});
		}
	}

	/** 编剧会话分支树(切换 UI 数据):纯读,无会话时从磁盘恢复(不创建运行时)。 */
	async getSessionTree(slug: string, chapterFile?: string | null): Promise<{ currentLeafId: string | null; branches: Array<{ leafId: string; isCurrent: boolean; count: number; summary: string; tail: string }> }> {
		const file = chapterFile ?? this.currentChapter.get(slug) ?? null;
		const key = WriterHost.key(slug, file);
		const host = this.hosts.get(key);
		if (!host) {
			const fromDisk = readSessionFromDisk(slug, file);
			return fromDisk ? { currentLeafId: fromDisk.currentLeafId, branches: fromDisk.branches } : { currentLeafId: null, branches: [] };
		}
		return host.getSessionTree();
	}

	/** 编剧会话分支切换:leaf 移到指定 entry(分支栏切换);前端经 messages_retracted 对齐。 */
	async navigate(slug: string, entryId: string, chapterFile?: string | null): Promise<void> {
		const file = chapterFile ?? this.currentChapter.get(slug) ?? null;
		const host = await this.getOrCreate(slug, file);
		await host.navigateTo(entryId);
	}

	/** 全部会话释放(server stop 时调用)。 */
	async disposeAll(): Promise<void> {
		const all = [...this.hosts.values()];
		this.hosts.clear();
		this.currentChapter.clear();
		await Promise.allSettled(all.map((h) => h.dispose()));
	}

	/** 释放某本书的全部章节编剧会话(删除书前调用;无会话时静默)。
	 *  不释放则删除后会话仍在内存,AI 继续写 draft/writer 文件,文件复活。 */
	async dispose(slug: string): Promise<void> {
		const all: SessionHost[] = [];
		for (const [key, host] of this.hosts) {
			if (key.startsWith(`${slug}:`)) all.push(host);
		}
		for (const key of [...this.hosts.keys()]) {
			if (key.startsWith(`${slug}:`)) this.hosts.delete(key);
		}
		this.currentChapter.delete(slug);
		await Promise.allSettled(all.map((h) => h.dispose()));
	}
}

/**
 * 从磁盘编剧会话文件恢复会话视图——服务重启后 hosts 内存为空,
 * state()/getSessionTree() 仍能给出与内存一致的分支视图(当前 leaf 消息 + 分支树,
 * 撤回/编辑重发产生的旧分支也在),前端对齐不丢记录、分支栏可切换。
 * SessionManager.open 只读加载,不启动 agent 运行时;解析失败返回 null。
 */
function readSessionFromDisk(slug: string, chapterFile: string | null): {
	messages: WriterState["messages"];
	currentLeafId: string | null;
	branches: Array<{ leafId: string; isCurrent: boolean; count: number; summary: string; tail: string }>;
} | null {
	try {
		const sessionsDir = getBookSessionsDir(slug);
		const abs = join(sessionsDir, writerSessionFile(chapterFile));
		if (!existsSync(abs)) return null;
		const sm = SessionManager.open(abs, sessionsDir, getBookDir(slug));
		const messages = extractMessagesFromManager(sm);
		// 分支树:与 SessionHost.getSessionTree 同款 walk(叶子 + 当前 leaf 指针为候选)
		const roots = sm.getTree() as unknown as Array<{ entry: { id: string }; children: unknown[] }>;
		const leaves: string[] = [];
		const walk = (nodes: Array<{ entry: { id: string }; children: unknown[] }>): void => {
			for (const n of nodes) {
				if (n.children.length === 0) leaves.push(n.entry.id);
				else walk(n.children as never);
			}
		};
		walk(roots);
		const currentLeafId = sm.getLeafId();
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
		return { messages, currentLeafId, branches };
	} catch {
		return null;
	}
}

/** 会话文件 basename:writer-<章节 id>.jsonl(default 无章节)。模块级(readSessionFromDisk 共用)。 */
function writerSessionFile(chapterFile: string | null | undefined): string {
	const id = (chapterFile ?? "default").replace(/\.jsonl$/, "") || "default";
	return `writer-${id}.jsonl`;
}

/**
 * 最近一幕舞台转录(书目录 stage/ 下最新 .jsonl,格式化 + 截断)。
 * 无舞台数据/读取失败返回 null。模块级导出供单测(fixture 书目录)。
 */
export async function latestStageTranscript(bookDir: string): Promise<string | null> {
	try {
		const dir = join(bookDir, "stage");
		const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
		if (files.length === 0) return null;
		const stats = await Promise.all(
			files.map(async (f) => ({ f, m: (await stat(join(dir, f))).mtimeMs })),
		);
		stats.sort((a, b) => b.m - a.m);
		const sceneId = stats[0].f.replace(/\.jsonl$/, "");
		const entries = await readStage(bookDir, sceneId);
		if (entries.length === 0) return null;
		const counts = countStage(entries);
		const header = `【场景 ${sceneId} · 对话 ${counts.lines} 条，${counts.cnChars} 字】`;
		const body = formatStageLines(entries).join("\n");
		const full = `${header}\n${body}`;
		return full.length > STAGE_LIMIT ? `${full.slice(0, STAGE_LIMIT)}\n…(截断)` : full;
	} catch {
		return null;
	}
}
