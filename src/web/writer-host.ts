/**
 * 常驻编剧(编辑 agent)web 宿主:每本书一个 writer 会话(惰性创建,会话文件
 * sessions/<slug>/writer.jsonl,与主写作会话/舞台区编剧隔离)。
 *
 * 与舞台区收幕编剧(编排器内 writer)是独立会话:常驻编剧随时可对话,不受
 * 编排器内存态影响;收幕流程维持现状(§16.1「writer 常驻对话」的会话层)。
 *
 * 上下文注入(context 钩子,每次调用前):当前章节草稿 + 世界书角色条目 +
 * 文风采样——编剧据此讨论行文/取舍/编辑正文。章节由 chat() 的 chapterFile
 * 声明(每书记最近一次,无则只注入世界书)。
 *
 * 事件:SessionHost.subscribe 的原生会话事件(含 message_end 附加的 entryId)
 * 原样转发给 eventSink,由 server 经 /api/events 广播为 writer_event { slug, event };
 * 前端复用 processAgentEvent 归约(消息/思考/工具卡片与主会话同款逻辑)。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBookSessionsDir, initChapterFile } from "../book-manager.ts";
import { getAgentDir, getBookDir, resolveSkillsDir } from "../config.ts";
import { createSessionRuntimeFactory } from "../session-factory.ts";
import { chatTextOfMessage } from "../session-text.ts";
import { extractMessagesFromManager } from "./session-host.ts";
import type { AgentMessage, ThinkingLevel } from "../../vendor/pi-agent-core/src/index.ts";
import {
	type AgentSessionEvent,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	SessionManager,
} from "../../vendor/pi-coding-agent/src/index.ts";
import { ensureWorld } from "../world-data.ts";
import { SessionHost } from "./session-host.ts";

/** 常驻编剧系统提示:讨论为主、修改为辅,改动说明意图(与 WRITER_PROMPT 的收幕整理职责区分)。 */
const EDITOR_PROMPT = `你是「编剧」,写作台的常驻编辑伙伴。随时可与用户讨论行文、取舍、节奏、人物与细节。
· 需要修改正文时用 write/edit 工具直接修改,并在回复里说明改了什么、为什么;
· 你的修改会立即落盘,用户在批注栏能看到「待确认」卡片并可回退——所以改动前想清楚,每次改动尽量小、意图明确;
· 上下文里的【当前正文】是讨论对象,不是必须保留的定稿;【世界书】与【文风采样】是背景知识,引用时保持设定一致;
· 讨论为主、修改为辅:用户没让你改,不要擅自大改。`;

/** 注入块长度上限(草稿/世界书正文截断,防上下文膨胀)。 */
const DRAFT_LIMIT = 4000;
const WORLD_LIMIT = 3000;
const STYLE_LIMIT = 800;

export interface WriterHostOptions {
	/** --model 模式串(传给 createSessionRuntimeFactory 解析)。 */
	model?: string;
	/** --thinking 档位。 */
	thinkingLevel?: string;
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
	private readonly hosts = new Map<string, SessionHost>();
	/** 每书最近一次对话声明的章节文件。 */
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

	/** 取(或惰性创建并启动)某本书的常驻编剧会话。 */
	private async getOrCreate(slug: string): Promise<SessionHost> {
		const existing = this.hosts.get(slug);
		if (existing) return existing;
		const host = this.options.createHost
			? await this.options.createHost(slug)
			: await this.createHost(slug);
		host.subscribe((event) => this.eventSink(slug, event));
		this.hosts.set(slug, host);
		return host;
	}

	/** 装配常驻编剧会话(复用 createSessionRuntimeFactory;工具 = write/read,无 bash)。 */
	private async createHost(slug: string): Promise<SessionHost> {
		const agentDir = getAgentDir();
		const { model, thinkingLevel } = this.options;
		const bookDir = getBookDir(slug);
		const sessionsDir = getBookSessionsDir(slug);
		await mkdir(sessionsDir, { recursive: true });
		const abs = join(sessionsDir, "writer.jsonl");
		await initChapterFile(abs, bookDir);
		const runtimeFactory = this.roleFactory(slug);
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

	/** 会话装配工厂(与 stage 角色同款样板;context 钩子注入当前章节/世界书/文风采样)。 */
	private roleFactory(slug: string): CreateAgentSessionRuntimeFactory {
		const agentDir = getAgentDir();
		const { model, thinkingLevel } = this.options;
		const inject = (messages: AgentMessage[]): Promise<AgentMessage[] | undefined> => this.editorContext(slug, messages);
		return createSessionRuntimeFactory({
			agentDir,
			// skills 目录只读放行(与 web.ts 同款):模型经 read 工具加载 skill 文件时不被守卫误拦
			readOnlyDirs: [resolveSkillsDir()],
			systemPromptOverride: () => EDITOR_PROMPT,
			extensionFactories: [
				{
					name: `writer-resident-${slug}`,
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
		});
	}

	/** 上下文注入:当前章节草稿 + 世界书角色条目 + 文风采样(截断保护)。 */
	private async editorContext(slug: string, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		const chapterFile = this.currentChapter.get(slug) ?? null;
		const blocks: string[] = [];
		if (chapterFile) {
			const file = `draft/${chapterFile.replace(/\.jsonl$/, ".md")}`;
			const draft = await readTextSafe(join(getBookDir(slug), file));
			if (draft !== null && draft.trim().length > 0) {
				const body = draft.length > DRAFT_LIMIT ? `${draft.slice(0, DRAFT_LIMIT)}\n…(截断)` : draft;
				blocks.push(`【当前正文 · ${file}】\n${body}`);
			}
		}
		try {
			const world = await ensureWorld(getBookDir(slug));
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
		if (blocks.length === 0) return undefined;
		return [...messages, { role: "user", content: blocks.join("\n\n"), timestamp: Date.now() }];
	}

	/** 编剧会话状态快照(纯读;未对话过的书返回空态,不创建会话)。 */
	async state(slug: string): Promise<WriterState> {
		const host = this.hosts.get(slug);
		if (!host) {
			// 服务重启后 hosts 内存为空:从磁盘会话文件恢复分支视图——否则前端对齐
			// 拿到空态,编剧对话「看起来全丢」(与舞台导演同源问题,2026-08-10);
			// SessionManager.open 只读解析,只显示当前 leaf 的消息(撤回的旧分支不混入)
			const fromDisk = readSessionFromDisk(slug);
			if (fromDisk) {
				return {
					bookSlug: slug,
					chapterFile: null,
					exists: fromDisk.messages.length > 0,
					isStreaming: false,
					messages: fromDisk.messages,
				};
			}
			return { bookSlug: slug, chapterFile: null, exists: false, isStreaming: false, messages: [] };
		}
		const st = host.getState();
		return {
			bookSlug: slug,
			chapterFile: this.currentChapter.get(slug) ?? null,
			exists: true,
			isStreaming: st.isStreaming,
			messages: st.messages,
		};
	}

	/** 发消息给编剧(惰性建会话;失败抛出,由 server 广播 chat_error)。 */
	async chat(slug: string, text: string, chapterFile?: string): Promise<void> {
		const host = await this.getOrCreate(slug);
		if (chapterFile) this.currentChapter.set(slug, chapterFile);
		await host.sendMessage(text);
	}

	/** 中止编剧当前生成(无会话时静默)。 */
	async abort(slug: string): Promise<void> {
		await this.hosts.get(slug)?.abort();
	}

	/** 编剧会话「编辑重发」:撤回最新用户消息(及之后),replacement 非空时撤回后重发。
	 *  内存无会话时从磁盘恢复再操作(服务重启后浏览器历史仍在,retract 不能因内存空而失败)。 */
	async retractMessage(slug: string, entryId: string, replacement?: string): Promise<void> {
		const host = await this.getOrCreate(slug);
		await host.retractMessage(entryId);
		if (replacement !== undefined && replacement.trim().length > 0) {
			void host.sendMessage(replacement).catch((err) => {
				process.stderr.write(`[writer] 编辑重发失败: ${err instanceof Error ? err.message : String(err)}\n`);
			});
		}
	}

	/** 编剧会话分支树(切换 UI 数据):纯读,无会话时从磁盘恢复(不创建运行时)。 */
	async getSessionTree(slug: string): Promise<{ currentLeafId: string | null; branches: Array<{ leafId: string; isCurrent: boolean; count: number; summary: string; tail: string }> }> {
		const host = this.hosts.get(slug);
		if (!host) {
			const fromDisk = readSessionFromDisk(slug);
			return fromDisk ? { currentLeafId: fromDisk.currentLeafId, branches: fromDisk.branches } : { currentLeafId: null, branches: [] };
		}
		return host.getSessionTree();
	}

	/** 编剧会话分支切换:leaf 移到指定 entry(分支栏切换);前端经 messages_retracted 对齐。 */
	async navigate(slug: string, entryId: string): Promise<void> {
		const host = await this.getOrCreate(slug);
		await host.navigateTo(entryId);
	}

	/** 全部会话释放(server stop 时调用)。 */
	async disposeAll(): Promise<void> {
		const all = [...this.hosts.values()];
		this.hosts.clear();
		this.currentChapter.clear();
		await Promise.allSettled(all.map((h) => h.dispose()));
	}

	/** 释放某本书的编剧会话(删除书前调用;无会话时静默)。
	 *  不释放则删除后会话仍在内存,AI 继续写 draft/writer.jsonl,文件复活。 */
	async dispose(slug: string): Promise<void> {
		const host = this.hosts.get(slug);
		if (!host) return;
		this.hosts.delete(slug);
		this.currentChapter.delete(slug);
		await host.dispose();
	}
}

/**
 * 从磁盘编剧会话文件(writer.jsonl)恢复会话视图——服务重启后 hosts 内存为空,
 * state()/getSessionTree() 仍能给出与内存一致的分支视图(当前 leaf 消息 + 分支树,
 * 撤回/编辑重发产生的旧分支也在),前端对齐不丢记录、分支栏可切换。
 * SessionManager.open 只读加载,不启动 agent 运行时;解析失败返回 null。
 */
function readSessionFromDisk(slug: string): {
	messages: WriterState["messages"];
	currentLeafId: string | null;
	branches: Array<{ leafId: string; isCurrent: boolean; count: number; summary: string; tail: string }>;
} | null {
	try {
		const sessionsDir = getBookSessionsDir(slug);
		const abs = join(sessionsDir, "writer.jsonl");
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
