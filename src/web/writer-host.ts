/**
 * 常驻编剧(编辑 agent)web 宿主:每本书的每一段对话一个 writer 会话(惰性创建,
 * 会话文件 sessions/<slug>/writer-<对话 id>.jsonl)。
 *
 * **会话身份 = conversationId(2026-10-03 泛化)**:对话键从「章节文件」泛化成不透明的
 * 对话 id,由 `conversationScope` 决定它是什么(见 src/writer-settings.ts):
 * - `"chapter"`(缺省,现状):conversationId **就是章节文件名**(`ch01.jsonl`),
 *   会话文件 `writer-ch01.jsonl` —— 与本次改动前逐字节一致,不迁移、不改名;
 * - `"book"`:对话与章节分离,conversationId 是不透明 id(`c-xxxxxx`,
 *   见 createConversation),会话文件仍走同一个命名函数 `writer-<id>.jsonl`。
 * 两种形态共用一套 hosts/键,(书, 对话 id) 定位唯一宿主。
 *
 * **常驻编剧 === 收幕编剧(2026-08-11 统一)**:编排器收幕时若本宿主已注入
 * (StageOrchestratorOptions.writerHost),成文任务委托给同一 (书, 章节) 会话
 * (chatAndWait)——编辑页「编剧」标签的对话与收幕成文是同一个编剧、同一份记忆;
 * CLI 模式无本宿主,收幕仍走编排器内置 writer(stage-writer.jsonl)。
 * **例外**:`chatAndWait` 永远按**章节键**取宿主,不受 conversationScope 影响 ——
 * 收幕成文天然要落某一章的正文,它不能跑进一段与章节无关的自由对话。
 *
 * 上下文注入分两类:**稳定块**(世界观概述/世界书条目/写作约束)按
 * 指纹持久化进会话(nextTurn custom 消息,内容变化才重注入,可缓存前缀的一部分);
 * **易变块**(当前章节草稿 + 发展线 + Notice 备忘录 + 最近一幕舞台转录)经
 * context 钩子每次调用前追加在消息尾部——编剧据此讨论行文/取舍/评戏/维护 advice.md。
 * 章节由 chat() 的 chapterFile 声明(每书记最近一次,无则只注入世界书);
 * book 模式下 chapterFile 不再决定会话身份,只登记「用户正在看的章节」(setViewChapter,
 * 每次调用现读),会话身份由 conversationId 决定。
 *
 * 事件:SessionHost.subscribe 的原生会话事件(含 message_end 附加的 entryId)
 * 原样转发给 eventSink,由 server 经 /api/events 广播为 writer_event { slug, event };
 * 前端复用 processAgentEvent 归约(消息/思考/工具卡片与主会话同款逻辑)。
 * chapter 模式的事件负载与本次改动前逐字节一致;book 模式的会话另带 `conversation`
 * 字段(见 setEventSink),前端据它过滤到具体对话。
 *
 * **经典模式(2026-09-18,classicMode = 单 agent)**:同一个会话宿主换成
 * 「写作 agent」装配——系统提示取 prompts/writer-main.md(buildWriterSystemPrompt,
 * 与 TUI/主会话同款),工具集配全(read/write/edit/grep/find/ls +
 * word_count/world_update/world_find + MCP;bash 在 web 一律禁用),且不再限制
 * 只能写当前章节草稿(要能写 outline.md / memory.md / notes/)。界面上只有编辑页,
 * 没有编剧/导演/演员之分。切换模式时已建会话全部释放,新工具集在下次对话时生效。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getBookSessionsDir, initChapterFile, loadBook } from "../book-manager.ts";
import { getAgentDir, getBookDir, resolveSkillReadOnlyDirs } from "../config.ts";
import { createSessionRuntimeFactory } from "../session-factory.ts";
import { buildSessionTree, type SessionBranchInfo, type SessionTreeInfo, type SessionTreeSource, type SessionVersionInfo } from "../session-tree.ts";
import {
	collectThinkingSummary,
	extractMessagesFromManager,
	refreshModelsOfHosts,
	type ModelRefreshSummary,
	type SessionCompactionResult,
	type SessionContextUsage,
	type SessionStateSnapshot,
	type SessionUsageStats,
	type ThinkingSummary,
} from "./session-host.ts";
import {
	parseSkillBlock,
	openSession,
	readSessionFile,
	type AgentMessage,
	type AgentSessionEvent,
	type ExtensionAPI,
	type RuntimeFactoryHandle,
	type SessionEntry,
	type ThinkingLevel,
	type ToolDefinition,
} from "../pi-adapter/index.ts";
import { ensureWorld, newId } from "../world-data.ts";
import { buildStorylineView, constraintTargetMatches, NOTICE_INJECT_LIMIT } from "../world-context.ts";
import { buildEditorSystemPrompt, buildWriterSystemPrompt, writerShellLine } from "../prompt.ts";
import type { ShellDialect } from "../shell-kind.ts";
import type { ConversationScope } from "../writer-settings.ts";
import { readChapterTool, readStyleTool, styleUpdateTool, wordCountTool, worldFindTool, worldUpdateTool } from "../tools.ts";
import { createAskUserTool, settleDanglingAskParts } from "../ask-user.ts";

/**
 * 提问卡片工具(ask_user)。闸门是进程级单例,所以工具本身可以复用一个实例 ——
 * 它是无状态的薄壳,状态都在 `askUserGate` 里。
 */
const askUserTool = createAskUserTool();

/**
 * 常驻编剧 / 经典模式写作 agent 的自定义工具清单 —— **权限边界唯一真相源**。
 *
 * 非经典(舞台形态)下编剧只有:`world_find`(只读检索世界书)+ `style_update`
 * (只写写作约束 / 文风采样 / 世界观概述的窄通道)。人物 / 关系 / 时间线 / 大纲 /
 * 发展线 / Notice 一律改不了——那是导演的活,这条边界是刻意的。
 * 经典模式换成单一写作 agent,才补上 `world_update` 与 `word_count`(完整写作工具集)。
 *
 * 抽成纯函数是为了让单测直接钉住这条边界:`style_update` 是 2026-10-01 才补的——
 * 此前编剧连「以后别用破折号」都只能写 advice.md 等导演下次开会话落盘,
 * 用户看到的是"说了没生效"。
 */
export function writerToolset(opts: { classicMode: boolean; mcpTools: ToolDefinition[] }): ToolDefinition[] {
	// read_chapter(2026-10-04)两种形态都给:它是**只读**的,不触碰世界书/人物/关系,
	// 因此不破坏上面这条边界。反过来,编剧写剧本、审校、提意见时**必须**能读到整章
	// 正文——而内置 read 会在 2000 行/50KB 处静默截断,恰好在长章节上失效。
	// read_style(2026-10-05)同理:只读回文风采样。以前它是常驻在稳定块里的,而按
	// 提示词纪律「每写一章就可能换一次采样」—— 采样一变稳定块的指纹就变、就重注一份,
	// 成了版本堆叠的第二大来源。改成按需取,顺手把那条触发也拆了。
	return opts.classicMode
		? [wordCountTool, worldUpdateTool, worldFindTool, readChapterTool, readStyleTool, askUserTool, ...opts.mcpTools]
		: [worldFindTool, styleUpdateTool, readChapterTool, readStyleTool, askUserTool, ...opts.mcpTools];
}
import { SessionHost } from "./session-host.ts";
import { formatStageLines } from "../stage/assembler.ts";
import { countStage } from "../stage/counters.ts";
import { readStage } from "../stage/stage-store.ts";

/**
 * 某个 writer 宿主该按哪一套「对话范围」叙述提示词 —— **纯函数,单测钉住**。
 *
 * 判据与会话身份同源(见 resolveRef):key 是章节文件名形态(`<id>.jsonl`)才算
 * 「绑在一章上」。
 * - chapter 模式:key 即章节名;兜底键 `default`(还没声明章节)沿用绑定章节的
 *   叙述 —— 与解耦前逐字一致。
 * - 分离模式:自由对话的键是不透明 id(`c-xxxx`)或 `default` → 按分离叙述;唯一
 *   按章节键建宿主的是**收幕成文**(chatAndWait 永远按章节键取宿主),那一次就是要
 *   把舞台记录落成某一章的正文,必须按绑定章节叙述,否则提示词会告诉它「正文不锁
 *   在某一章」。
 */
export function hostPromptScope(conversationScope: ConversationScope, key: string): ConversationScope {
	if (conversationScope === "chapter" && key === DEFAULT_CONVERSATION_ID) return "chapter";
	return key.endsWith(".jsonl") ? "chapter" : "book";
}

/** 经典模式(单 agent)的内置工具:web 无 bash,其余全量(与 webActiveTools 同集)。 */
const CLASSIC_ACTIVE_TOOLS = ["read", "write", "edit", "grep", "find", "ls"];

/** 注入块长度上限(草稿/世界书正文截断,防上下文膨胀)。 */
const DRAFT_LIMIT = 4000;
const WORLD_LIMIT = 3000;
// 2026-10-05:原名 STYLE_LIMIT —— 那时它管的是常驻的文风采样块。采样改由 `read_style`
// 按需取之后,采样本身不再有「注入截断」这回事,这个上限只剩世界观概述在用,名字跟着改。
const SUMMARY_LIMIT = 800;

/**
 * 稳定上下文条目的识别标记(见 `countStableContextInLeaf`)。
 *
 * 用标题里的固定字样而不是 customType:`world-context` 是所有注入共用的类型,
 * 切成章背景包 / 压缩补偿都会用到它;稳定上下文有自己的文案前缀,按它数才准。
 */
const STABLE_CONTEXT_MARKER = "稳定上下文";
const STAGE_LIMIT = 8000;

/** 无章节/无对话时的兜底对话 id:会话文件 writer-default.jsonl(与改动前一致)。 */
const DEFAULT_CONVERSATION_ID = "default";

/**
 * 手动压缩的缺省摘要指令(2026-10-05 失忆修复)。
 *
 * vendor 的摘要模板(Goal/Progress/Next Steps/File Operations)是为**编码场景**
 * 设计的,且更新版明确允许「不再相关可删除」—— 对小说对话,人物设定、用户
 * 指示、伏笔很容易被"concise"掉。用户没写附加要求时,把写作场景的保留要求
 * 注入进去(customInstructions 会以 "Additional focus: ..." 追加到摘要 prompt)。
 */
const WRITER_COMPACT_INSTRUCTIONS = [
	"这是小说创作会话,不是编码会话。",
	"摘要必须保留:①用户直接给出的设定、纠正、偏好与长期指示(逐条,不改写);②人物的关键特征与当前状态;③已埋伏笔与未回收线索;④时间线/因果上的关键事实;⑤尚未确认写入 world.json 的建议清单。",
	"禁止以\u201c不再相关\u201d为由删除上述内容;不确定就保留。",
].join("\n");

/** 空对话的中性标题(没有任何用户消息可派生时用;前端列表据此显示)。 */
export const DEFAULT_CONVERSATION_TITLE = "新对话";

/** 标题长度上限(取第一条用户消息的前若干字)。 */
const TITLE_LIMIT = 24;

/**
 * 会话 id(章节文件名 / 对话 id)与书 slug 的安全性判定 —— **唯一实现**。
 *
 * 两者都被拼进 `sessions/<slug>/writer-<id>.jsonl` 这类路径,而值来自 HTTP 参数
 * (query/body/路径段,已解码),必须挡路径穿越。这里只拒绝真正危险的形状
 * (路径分隔符、. / ..),不限制 CJK:导入的书可能带非 ASCII 章节文件名。
 */
export function isSafeSessionId(value: string): boolean {
	if (value.length === 0 || value.length > 128) return false;
	if (value === "." || value === "..") return false;
	return !/[\\/\u0000]/.test(value);
}

/** 规范化 HTTP 参数里的 id(空/空白 → null;不安全 → 抛错,由 server 映射为 400)。 */
function normalizeId(value: string | null | undefined, label: string): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (!isSafeSessionId(trimmed)) throw new Error(`非法${label}: ${trimmed}`);
	return trimmed;
}

/**
 * 正文写入白名单(write 工具的 ALS draftFile)—— **唯一判定点**。
 *
 * 非经典模式(舞台形态的编剧)只允许写当前章节的正文文件:否则 agent 自创文件名会把
 * 正文写到前端读不到的路径(2026-08-11 编剧乱写 draft/第一章.md 的根因)。
 * 两种形态**不设**白名单:
 * - 经典模式:单一写作 agent 要能写 memory.md / notes/ 等中间产物;
 * - book 模式:对话与章节分离,对话里的 AI 要能编辑**任意章节**(需求原话)。
 *
 * 抽成纯函数是为了让单测直接钉住这条边界:createHost 的 toolGuard 与 roleFactory 的
 * runtime 装配必须传同一个值,两处都调这里(真正生效的是工具里的 ALS 上下文,
 * 少传一处就是「换了形态却还被拦住写别的章节」)。
 */
export function writerDraftFile(opts: {
	classicMode: boolean;
	conversationScope: ConversationScope;
	chapter: string | null;
}): string | undefined {
	if (opts.classicMode || opts.conversationScope !== "chapter" || !opts.chapter) return undefined;
	return opts.chapter.replace(/\.jsonl$/, ".md");
}

export interface WriterHostOptions {
	/** --model 模式串(传给 createSessionRuntimeFactory 解析)。 */
	model?: string;
	/** --thinking 档位。 */
	thinkingLevel?: string;
	/** MCP 外部工具惰性获取(web 注入,编剧会话可用;导演同款,2026-08-11)。 */
	getMcpTools?: () => ToolDefinition[];
	/** 经典模式(单 agent):会话装配换成全量工具的写作 agent;缺省 false。 */
	classicMode?: boolean;
	/**
	 * 对话与章节的关系(与设置项 conversationScope 同源);缺省 `"chapter"`
	 * (现状:一段对话绑一章)。切换走 setConversationScope(释放已建会话)。
	 */
	conversationScope?: ConversationScope;
	/**
	 * 外部命令(bash):把 bash 从禁用名单里放出来并激活;缺省 false。
	 * 与设置项 enableShell 同源——放开后命令以服务进程权限运行,路径守卫对它无效,
	 * 靠"命令与输出实时可见"来约束(见 web/src/store.ts 的 tool_execution_update)。
	 */
	enableShell?: boolean;
	/**
	 * shell 方言(enableShell 打开时实际执行哪种 shell;见 src/shell-kind.ts)。
	 * 缺省 "none" = 按无 shell 装配(提示词不会宣称有 shell)。
	 */
	shellDialect?: ShellDialect;
	/** 显式 shell 可执行文件路径(string = 写进 vendor settings;null = 清空走 bash 探测链)。 */
	shellPath?: string | null;
	/**
	 * 图片生成(实验,0.1.0):为 true 时给会话注册 `image_generate` 工具。
	 * 与设置项 enableImageGen 同源;切换时释放全部会话,否则关掉开关工具还在。
	 */
	enableImageGen?: boolean;
	/** 测试注入:自定义宿主工厂(缺省创建真实会话)。 */
	createHost?: (slug: string) => Promise<SessionHost>;
}

/** 前端可消费的编剧会话状态(纯读,不创建会话)。 */
export interface WriterState {
	bookSlug: string;
	/** 最近一次对话声明的章节会话文件 basename(无则 null);book 模式下是「用户正在看的章节」。 */
	chapterFile: string | null;
	/** 会话文件是否已创建(未对话过的书无会话)。 */
	exists: boolean;
	isStreaming: boolean;
	/**
	 * 沿 leaf 链的消息(与 SessionStateSnapshot 同一形状:content 有序块、
	 * firstEntryId 组首段 entry —— 前端水合与版本切换都要用,别在这里写窄类型
	 * 把它抹掉)。
	 */
	messages: SessionStateSnapshot["messages"];
}

/**
 * 一段对话的清单条目(GET /api/conversations)。
 * **不落元数据文件**:标题从会话内容派生(第一条用户消息前若干字,空对话给中性默认名),
 * 时间取会话文件 mtime —— 会话文件本身是唯一真相源。
 */
export interface ConversationSummary {
	/**
	 * 对话 id。章节对话就是**章节文件名**(`ch01.jsonl`,与既有前端传的 chapterFile 同形);
	 * book 模式新建的对话是不透明 id(`c-xxxxxx`)。两者都直接当 writer 端点的
	 * `conversation` 参数用。
	 */
	id: string;
	/** 从会话内容派生的标题(第一条用户消息;无内容时为 DEFAULT_CONVERSATION_TITLE)。 */
	title: string;
	/** 会话文件 mtime(ms);列表按它倒序。 */
	updatedAt: number;
	/** 是否是「当前对话」(writer 端点缺省会定位到的那条)。 */
	isCurrent: boolean;
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
	/**
	 * 当前模型(--model 模式串,形如 "provider/id")与思考档位。
	 * **可变**:换模型后既在这里更新(新会话按新值装配),也即时应用到已建会话
	 * (见 setModel)。此前直接读 `options.model`,而 options 是构造时快照,
	 * 于是换模型只对「下一个会话」生效(2026-10-01 修)。
	 */
	private model?: string;
	private thinkingLevel?: string;
	/** 会话键 = `${slug}:${对话键}`(章节模式下对话键就是章节文件;book 模式是不透明 id)。
	 *  编剧对话按会话键隔离——切章/切对话后各段独立历史与上下文(2026-08-10 起按章)。 */
	private readonly hosts = new Map<string, SessionHost>();
	/**
	 * 创建中的会话(hostKey → Promise);2026-10 审计 BUG-021。
	 *
	 * 此前 getOrCreate 在 map miss 后先 `await createHost`、完成后才 `hosts.set`,于是同一
	 * (书, 对话) 的并发首条请求会各自创建并各自 `SessionManager.open` 同一个
	 * `writer-<id>.jsonl` —— 两个 SessionManager 同时写同一份 append-only JSONL 会交错/覆盖。
	 * 现在同一 hostKey 的创建合并成一个 Promise,所有调用拿到同一个实例。
	 */
	private readonly creating = new Map<string, Promise<SessionHost>>();
	/**
	 * 每 hostKey 的世代号:dispose / 切模式 / 删对话时递增。
	 * 创建跨越多个 await,期间宿主可能已被释放;创建完成后比对世代,不一致就自我释放、
	 * 不写回 hosts(否则「释放后迟到的创建」会把已删会话重新登记)。
	 */
	private readonly hostEpoch = new Map<string, number>();
	/** 每书最近一次对话声明的章节文件(chapter 模式:章节即会话;端点缺省兜底定位)。 */
	private readonly currentChapter = new Map<string, string | null>();
	/** 每书「当前对话」(book 模式:列表 isCurrent / 端点缺省定位;chapter 模式也记账,
	 *  供列表标出最近用过的那条)。 */
	private readonly currentConversation = new Map<string, string>();
	/**
	 * 每书「用户正在看的章节」(book 模式专用,2026-10-03)。
	 *
	 * book 模式下 chapterFile 不再决定会话身份,但它仍是**易变上下文**:AI 得看得到
	 * 用户当前正在读/改的正文。所以登记在这里,由 editorContext **在调用时**现读
	 * (而不是创建会话时闭包捕获),setViewChapter 与带 chapterFile 的 writer 调用都会更新它。
	 */
	private readonly viewChapter = new Map<string, string | null>();
	/** 已注入会话的稳定块指纹(键 = 会话键):内容不变不重注入;服务重启后为空,
	 *  由 sessionLeafHasFingerprint 扫当前分支补记账。 */
	private readonly stableInjected = new Map<string, string>();
	/** 事件转发(server 构造时注入 → broadcast 为 writer_event);注入前静默丢弃。
	 *  chapterFile 随事件透传(编剧会话按章节隔离,前端据此过滤,2026-08-13);
	 *  conversation 只在 book 模式的会话上给(章节模式保持负载逐字节不变)。 */
	private eventSink: (slug: string, chapterFile: string | null, event: AgentSessionEvent, conversation?: string) => void = () => {};
	/** 经典模式(单 agent):影响系统提示与工具集;切换时释放全部会话。 */
	private classicMode: boolean;
	/** 对话与章节的关系(见 WriterHostOptions.conversationScope);切换时释放全部会话。 */
	private conversationScope: ConversationScope;
	/** 外部命令(bash)是否放开;切换时同样释放全部会话。 */
	private shellEnabled: boolean;
	/** shell 方言(提示词按它叙述;enableShell 关闭时为 "none")。 */
	private shellDialect: ShellDialect;
	/** 显式 shell 路径(string = 写进 vendor settings;null = 清空)。 */
	private shellPath: string | null;
	/** 图片生成(实验,0.1.0)是否启用:决定 `image_generate` 工具存不存在。 */
	private imageGen: boolean;

	constructor(options: WriterHostOptions) {
		this.options = options;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel;
		this.classicMode = options.classicMode ?? false;
		this.conversationScope = options.conversationScope ?? "chapter";
		this.shellEnabled = options.enableShell ?? false;
		this.shellDialect = options.shellDialect ?? "none";
		this.shellPath = options.shellPath ?? null;
		this.imageGen = options.enableImageGen ?? false;
	}

	/**
	 * 切换经典模式。变化时释放全部已建会话——系统提示与工具集在会话创建时装配,
	 * 复用旧会话意味着新工具集不生效(切了开关却还是受限编剧)。下次对话惰性重建。
	 */
	async setClassicMode(enabled: boolean): Promise<void> {
		if (this.classicMode === enabled) return;
		this.classicMode = enabled;
		await this.disposeAll();
	}

	/**
	 * 切换「对话与章节的关系」。变化时释放全部已建会话:两种形态的会话身份规则与
	 * 上下文注入方式都不同(chapter 模式章节即会话、book 模式章节只是易变上下文),
	 * 复用旧会话会把旧规则的装配带过去(与 classicMode 切换同款)。
	 */
	async setConversationScope(scope: ConversationScope): Promise<void> {
		if (this.conversationScope === scope) return;
		this.conversationScope = scope;
		// 「当前对话」在两种形态下语义不同,别把另一模式的选中项带过去
		this.currentConversation.clear();
		await this.disposeAll();
	}

	/**
	 * 登记「用户正在看的章节」(book 模式:chapterFile 不再决定会话身份,但仍要作为
	 * 易变上下文注入,否则 AI 看不到用户正在读的正文)。null = 没有正在查看的章节
	 * (不注入正文块)。chapter 模式下这个登记不参与会话身份,只是记账。
	 */
	setViewChapter(slug: string, chapterFile: string | null): void {
		if (chapterFile !== null && !isSafeSessionId(chapterFile)) {
			throw new Error(`非法章节文件名: ${chapterFile}`);
		}
		this.viewChapter.set(slug, chapterFile);
	}

	/**
	 * 开关图片生成(实验,0.1.0)。变化时释放全部会话 —— 这个开关决定 `image_generate`
	 * 工具**存不存在**,而工具集在会话创建时装配。不释放的话,那句「关闭时图片
	 * 相关工具对 AI 不可见」就不成立(旧会话还揣着那个工具)。
	 */
	async setImageGen(enabled: boolean): Promise<void> {
		if (this.imageGen === enabled) return;
		this.imageGen = enabled;
		await this.disposeAll();
	}

	/**
	 * 开关外部命令(bash)并设置 shell 方言。任一变化都释放全部会话:shell 的有无
	 * 改变工具集,tool 的方言改变系统提示(shell 行按方言注入),旧会话带的是老装配。
	 *
	 * @param next.enabled - 是否放开外部命令。
	 * @param next.dialect - 实际生效的方言("none" = 按无 shell 装配)。
	 * @param next.path - 显式 shell 路径;null = 清空(切回 bash 时必须清,否则
	 *   vendor 还留着上次的 pwsh 路径:提示词说 bash、实际跑 pwsh)。
	 */
	async setShell(next: { enabled: boolean; dialect: ShellDialect; path: string | null }): Promise<void> {
		const changed = this.shellEnabled !== next.enabled || this.shellDialect !== next.dialect || this.shellPath !== next.path;
		if (!changed) return;
		this.shellEnabled = next.enabled;
		this.shellDialect = next.dialect;
		this.shellPath = next.path;
		await this.disposeAll();
	}

	/** server 构造时注入事件转发(WriterHost 在 web.ts 先于 server 创建)。
	 *  `conversation` 只在 book 模式(与章节无关的对话)上给:chapter 模式的实际负载
	 *  与本次改动前逐字节一致,book 模式多一个 `conversation` 字段供前端过滤。 */
	setEventSink(sink: (slug: string, chapterFile: string | null, event: AgentSessionEvent, conversation?: string) => void): void {
		this.eventSink = sink;
	}

	/**
	 * 换模型(--model 模式串,形如 "provider/id")：更新未来会话的装配值,并即时应用到
	 * **已经开着的**编剧会话。
	 *
	 * 2026-10-01 修:此前 POST /api/model 只打主会话宿主,而编辑页的对话走的是编剧会话
	 * (WritePage → client.writerChat)——模型在会话创建时就绑死了(vendor sdk.ts 的
	 * `defaultModelId: settingsManager.getDefaultModel()`),于是「同一个对话窗口里换
	 * 模型」要等换章或重启才生效;设置页读到的「当前模型」来自主会话,看起来还切成功了。
	 *
	 * 逐个会话尝试后再报错:某个会话临时没有 runtime 不该让其余的也跟着不动。
	 */
	async setModel(model: string): Promise<void> {
		this.model = model;
		await this.forEachResidentHost("模型", (host) => host.setModel(model));
	}

	/**
	 * 换思考档位：未来会话按新值装配 + 已建会话即时生效。
	 *
	 * 返回**宿主级结果**(每个会话实际生效的档位):各会话的模型能力不同,可能被 clamp 到
	 * 不同档位,不能拿主会话的值冒充所有窗口(2026-10 审计 BUG-013)。单个会话失败记进
	 * `failed` 而不是抛错,由调用方分宿主报告。
	 */
	async setThinkingLevel(level: string): Promise<ThinkingSummary> {
		this.thinkingLevel = level;
		return collectThinkingSummary(this.hosts.values(), level);
	}

	/**
	 * models.json 变更后让已建编剧会话跟上最新模型目录;其中「一个模型都没选到」的
	 * 空壳会话直接释放(下次对话按最新目录重新装配,见 refreshModelsOfHosts)。
	 *
	 * `allowNetwork` 透传:设置页「刷新模型列表 / 测试连接」必须让编剧会话也真去拉一次
	 * 远程目录(2026-10 审计 BUG-005:此前联网刷新只打主会话)。
	 */
	async refreshModels(options?: { allowNetwork?: boolean }): Promise<ModelRefreshSummary> {
		const { stale, sessions, errors } = await refreshModelsOfHosts(this.hosts, options);
		const released: string[] = [];
		for (const key of stale) {
			this.bumpEpoch(key);
			const host = this.hosts.get(key);
			if (!host) continue;
			this.hosts.delete(key);
			await host.dispose().catch(() => undefined);
			released.push(key);
		}
		return { errors, modelCount: null, sessions, released };
	}

	/** 把一次会话级设置应用到全部已建编剧会话(逐个尝试,收集首个错误后重抛)。 */
	private async forEachResidentHost(
		action: string,
		apply: (host: SessionHost) => Promise<void> | void,
	): Promise<void> {
		const failed: string[] = [];
		for (const host of this.hosts.values()) {
			try {
				await apply(host);
			} catch (err) {
				failed.push(err instanceof Error ? err.message : String(err));
			}
		}
		if (failed.length > 0) throw new Error(`${action}未在所有会话生效: ${failed.join("; ")}`);
	}

	/** 会话键:书 + 对话键(chapter 模式下对话键 = 章节文件;无则 "default")。 */
	private static key(slug: string, conversationId: string | null | undefined): string {
		return `${slug}:${conversationId ?? DEFAULT_CONVERSATION_ID}`;
	}

	/**
	 * 解析 writer 端点要定位到哪段对话 —— **身份规则唯一实现**。
	 *
	 * 输入是端点上的两个可选参数(都与既有 chapterFile 并存):
	 * - `conversation`:对话 id(book 模式的用法);chapter 模式下 id 就是章节文件名;
	 * - `chapterFile`:章节文件名(chapter 模式的用法 = 身份;book 模式 = 只看不绑)。
	 *
	 * 规则:
	 * - book 模式:`chapterFile` 只登记「正在看的章节」,**不影响会话身份**;
	 *   身份 = conversation ?? 当前对话 ?? "default"(沿用今天的回落规则)。
	 *   chapterFile 不设正文白名单——对话里的 AI 可自由编辑任意章节(需求原话)。
	 * - chapter 模式(与今天逐字一致):身份 = conversation ?? chapterFile ?? 最近声明的章节
	 *   ?? "default"。
	 *
	 * `record` 控制要不要把这次声明的章节记进「最近声明的章节」—— **只有 chat/chatAndWait
	 * 这类"开口说话"的操作会记账**(与改动前一致);读端点(state/tree/context/stats)
	 * 一律不写,否则一次 GET 就会改掉后续缺省定位。「显式点名的对话」(conversation)
	 * 与 book 模式「正在看的章节」是 UI 选中态,任何请求都会登记(它们不影响 chapter
	 * 模式的定位规则)。
	 *
	 * `chapterFile` 三态:`undefined` = 没传(保留上次登记);`null` = 显式清空
	 * (book 模式 = 用户没有正在看的章节,不注入正文块);字符串 = 正在看这一章。
	 *
	 * 返回值 `chapter` 是这次调用的章节语义(用于创建宿主时的正文白名单与注入,
	 * 也用作 state() 回显的 chapterFile)。**只有章节文件名形态(`<id>.jsonl`)才认**:
	 * book 模式建的自由对话被切回 chapter 模式复用时,那个不透明 id 不能当章节 ——
	 * 否则正文白名单会算成 `c-xxxxxx.md`,AI 被静默拦着写不了任何章节。
	 */
	private resolveRef(
		slug: string,
		chapterFile?: string | null,
		conversation?: string | null,
		record = false,
	): { key: string; chapter: string | null } {
		const conv = normalizeId(conversation, "对话 id");
		const chapter = chapterFile === undefined ? null : normalizeId(chapterFile, "章节文件名");
		if (conv) this.currentConversation.set(slug, conv);
		if (this.conversationScope === "book") {
			// 「用户正在看的章节」:登记后由 editorContext 在调用时现读(不绑会话身份);
			// 传了(哪怕是空值)就按传的来 —— 空值表示"没在看任何章节"
			if (chapterFile !== undefined) this.viewChapter.set(slug, chapter);
			const key = conv ?? this.currentConversation.get(slug) ?? DEFAULT_CONVERSATION_ID;
			return { key, chapter: this.viewChapter.get(slug) ?? null };
		}
		// chapter 模式:章节即会话(沿用今天的回落链)
		if (record) {
			const declared = chapter ?? conv;
			if (declared) this.currentChapter.set(slug, declared);
		}
		const key = conv ?? chapter ?? this.currentChapter.get(slug) ?? DEFAULT_CONVERSATION_ID;
		// 只有章节文件形态的 key 才是"这一章的对话";不透明 id(自由对话)在 chapter 模式下
		// 不设正文白名单 —— 否则白名单会算成 c-xxxxxx.md,AI 静默写不了任何章节
		return { key, chapter: key.endsWith(".jsonl") ? key : null };
	}

	/**
	 * 取(或惰性创建并启动)某书某段对话的常驻编剧会话。
	 *
	 * 互斥(BUG-021):同 hostKey 的并发调用共享同一个创建 Promise;只有创建成功、
	 * 订阅完成且世代未变时,实例才发布到 hosts。创建失败会清掉 in-flight,下次可重试。
	 */
	private async getOrCreate(slug: string, key: string, chapter: string | null): Promise<SessionHost> {
		const hostKey = WriterHost.key(slug, key);
		const existing = this.hosts.get(hostKey);
		if (existing) return existing;
		// 创建中的同一个会话:复用同一个 Promise,不再开第二个 SessionManager
		const inflight = this.creating.get(hostKey);
		if (inflight) return inflight;
		const task = this.createAndPublish(hostKey, slug, key, chapter);
		this.creating.set(hostKey, task);
		try {
			return await task;
		} finally {
			// 只清理自己那一条:期间若有更新的创建顶上来,不要误删
			if (this.creating.get(hostKey) === task) this.creating.delete(hostKey);
		}
	}

	/** 创建宿主 → 订阅事件 → 世代校验后发布到 hosts(失败不登记,交由调用方重试)。 */
	private async createAndPublish(hostKey: string, slug: string, key: string, chapter: string | null): Promise<SessionHost> {
		const epoch = this.epochOf(hostKey);
		const host = this.options.createHost ? await this.options.createHost(`${hostKey}`) : await this.createHost(slug, key, chapter);
		host.subscribe((event) => this.eventSink(slug, this.eventChapterFile(key), event, this.eventConversation(key)));
		// 创建期间被 dispose / 切模式 / 删对话:这个实例已经不属于当前世代,自我释放并报错
		if (this.epochOf(hostKey) !== epoch) {
			await host.dispose().catch(() => undefined);
			throw new Error(`会话已释放(创建期间被关闭): ${hostKey}`);
		}
		// 已有实例(理论上不会,双保险):不覆盖别人,释放自己
		const raced = this.hosts.get(hostKey);
		if (raced && raced !== host) {
			await host.dispose().catch(() => undefined);
			return raced;
		}
		this.hosts.set(hostKey, host);
		return host;
	}

	/** 取 hostKey 当前世代号(缺省 0)。 */
	private epochOf(hostKey: string): number {
		return this.hostEpoch.get(hostKey) ?? 0;
	}

	/** 使某 hostKey 的在建创建失效(dispose / 切模式 / 删对话时调用)。 */
	private bumpEpoch(hostKey: string): void {
		this.hostEpoch.set(hostKey, this.epochOf(hostKey) + 1);
	}

	/** 等待某 hostKey 的在建创建结束(可能已被上面 bumpEpoch 判废)。 */
	private async settleCreating(hostKey: string): Promise<void> {
		const inflight = this.creating.get(hostKey);
		if (inflight) await inflight.catch(() => undefined);
	}

	/** 事件负载里的 chapterFile:chapter 模式的会话仍是章节名;book 模式的会话不绑章节(传 null)。 */
	private eventChapterFile(key: string): string | null {
		return this.conversationScope === "chapter" ? (key === DEFAULT_CONVERSATION_ID ? null : key) : null;
	}

	/** 事件负载里的 conversation:只有 book 模式的会话给(章节模式保持负载逐字节不变)。 */
	private eventConversation(key: string): string | undefined {
		return this.conversationScope === "book" ? key : undefined;
	}

	/** 装配常驻编剧会话(复用 createSessionRuntimeFactory;工具 = write/read,无 bash)。
	 *  会话文件按对话 id 隔离(sessions/<slug>/writer-<id>.jsonl;chapter 模式下 id 即章节)。
	 *  经典模式(单 agent)同款宿主,但工具集与提示词由 roleFactory 换成写作 agent。 */
	private async createHost(slug: string, key: string, chapter: string | null): Promise<SessionHost> {
		const agentDir = getAgentDir();
		const bookDir = getBookDir(slug);
		const sessionsDir = getBookSessionsDir(slug);
		await mkdir(sessionsDir, { recursive: true });
		const abs = join(sessionsDir, writerSessionFile(key));
		await initChapterFile(abs, bookDir);
		const runtimeFactory = this.roleFactory(slug, key, chapter);
		const sessionManager = openSession(abs, sessionsDir, bookDir);
		// 正文白名单必须与 roleFactory 一致(两处都走 writerDraftFile):工具的 ALS
		// 上下文(draftFile)优先于 installToolPathGuard 的兜底值,这里不清掉的话
		// 经典模式/book 模式仍会被拦住写别的文件(换了模式却写不了)。
		const draftFile = writerDraftFile({ classicMode: this.classicMode, conversationScope: this.conversationScope, chapter });
		const host = new SessionHost({
			// 2026-10-04(T7 批 2):roleFactory 现返回工厂句柄,无需再包一层
			createRuntime: runtimeFactory,
			cwd: bookDir,
			agentDir,
			sessionManager,
			toolGuard: { readOnlyDirs: resolveSkillReadOnlyDirs(), draftFile },
		});
		await host.start();
		return host;
	}

	/**
	 * 常驻编剧的系统提示:prompts/writer-editor.md 按**对话范围**渲染(见
	 * buildEditorSystemPrompt / hostPromptScope),因为正文落点规则两种范围下不同。
	 * 放开外部命令后编剧**也**拿得到 shell 工具——不说清方言它会写 bash 语法,
	 * 所以启用了 shell 就在文末追加同一行方言说明(与写作 agent 用的是同一份文案)。
	 */
	private editorSystemPrompt(scope: ConversationScope): string {
		const base = buildEditorSystemPrompt(scope);
		if (!this.shellEnabled || this.shellDialect === "none") return base;
		return `${base}\n\n# 外部命令\n\n${writerShellLine(this.shellDialect)}`;
	}

	/** 会话装配工厂(与 stage 角色同款样板;context 钩子注入本会话章节/世界书/写作约束;
	 *  文风采样不再注入,由 `read_style` 按需取 —— 见 stableContext 的注释)。
	 *  经典模式走「写作 agent」装配(全量工具 + writer-main 提示,见类注释)。
	 *
	 *  @param key - 对话键(会话文件/事件归属);chapter 模式下它就是章节文件名。
	 *  @param chapter - 创建时的章节语义(chapter 模式的正文白名单与注入依据);
	 *    book 模式下忽略它,注入的章节每次调用现读 viewChapter。
	 */
	private roleFactory(slug: string, key: string, chapter: string | null): RuntimeFactoryHandle {
		const agentDir = getAgentDir();
		// 模型/思考档位用 getter 而不是值:createSessionRuntimeFactory 在**每次**
		// 装配(含 reloadRuntime)时读 opts.model —— 传值会把构造时的 --model
		// 固定进闭包,换模型后重建会话又退回旧值(2026-10-01)。
		const self = this;
		const bookScope = this.conversationScope === "book";
		// 系统提示按这个宿主**是否绑在一章上**叙述(分离模式下自由对话与收幕成文
		// 落在同一个 WriterHost 里,两者不能共用一套措辞;判据见 hostPromptScope)。
		const promptScope = hostPromptScope(this.conversationScope, key);
		// book 模式的章节是**易变上下文**(用户正在看哪一章),必须在调用时现读 ——
		// 闭包捕获创建时的章节会让「切换正在看的章节」对已建会话失效。
		const inject = (messages: AgentMessage[]): Promise<AgentMessage[] | undefined> =>
			this.editorContext(slug, bookScope ? this.viewChapter.get(slug) ?? null : chapter, messages);
		// 正文文件白名单(与 createHost 的 toolGuard 同源,见 writerDraftFile 的注释):
		// 非经典 + chapter 模式只允许写当前章节;经典模式与 book 模式都不设。
		const draftFile = writerDraftFile({ classicMode: this.classicMode, conversationScope: this.conversationScope, chapter });
		const mcpTools = this.options.getMcpTools?.() ?? [];
		return createSessionRuntimeFactory({
			agentDir,
			// skills 目录只读放行(与 web.ts 同款):模型经 read 工具加载 skill 文件时不被守卫误拦
			readOnlyDirs: resolveSkillReadOnlyDirs(),
			draftFile,
			systemPromptOverride: this.classicMode
				? () =>
						buildWriterSystemPrompt(
							mcpTools.map((t) => ({ name: t.name, description: t.description })),
							this.shellEnabled ? this.shellDialect : "none",
							promptScope,
						)
				: () => this.editorSystemPrompt(promptScope),
			extensionFactories: [
				{
					name: `writer-resident-${slug}-${writerSessionFile(key)}`,
					factory: (pi: ExtensionAPI) => {
						pi.on("context", async (event) => {
							const result = await inject(event.messages);
							return result ? { messages: result } : undefined;
						});
					},
				},
			],
			// getter 见上方注释:换模型后重建的会话也按最新值装配
			get model() {
				return self.model;
			},
			get thinkingLevel() {
				return self.thinkingLevel as ThinkingLevel | undefined;
			},
			// bash:web 默认禁用(web 子集语义,见 web.ts webExcludeTools);设置里
			// 放开「外部命令」后不再禁用,并在下面补进激活名单。
			// 方言选 pwsh 而本机没装时 shellDialect = none:此时不放行 bash(否则模型
			// 会去调一个必然报错的工具),提示词同样按无 shell 叙述。
			excludeTools: this.shellEnabled && this.shellDialect !== "none" ? [] : ["bash"],
			initialActiveToolNames: [
				...(this.classicMode ? CLASSIC_ACTIVE_TOOLS : ["write", "read"]),
				...(this.shellEnabled && this.shellDialect !== "none" ? ["bash"] : []),
			],
			// shell 方言路径(见 session-factory 的 shellPath):pwsh → 写 vendor settings;
			// null → 清空让 vendor 走 bash 探测链
			shellPath: this.shellPath,
			// 编剧:world_find(只读) + style_update(写作风格窄通道);经典模式才是全量
			// ——边界与理由见 writerToolset 的注释。
			customTools: writerToolset({ classicMode: this.classicMode, mcpTools }),
		});
	}

	/** 上下文注入(易变块,每次调用追加在消息尾部):当前章节草稿 + 发展线 +
	 *  Notice 备忘录 + 最近一幕舞台转录。
	 *  稳定块(世界观概述/世界书条目/文风采样/写作约束)不在这里逐轮注入——
	 *  它们变化很少,逐轮注入等于每轮都付一笔全价未缓存输入;改为
	 *  syncStableContext 按「指纹」持久化进会话(chat/chatAndWait 前调用),
	 *  内容变化才重注入。chapter 模式下章节随会话固定(切章后新会话注入新章,
	 *  旧会话不再被使用);book 模式下 chapterFile 由调用方在每次调用前现读 viewChapter
	 *  (见 roleFactory 的 inject)。 */
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
			// 发展线视图(当前目标 + 已完成列表)——编剧成文/讨论时不重复推进已完成
			// 目标(借鉴 AI-Novel completedMilestones 守卫,2026-08-12)
			const view = buildStorylineView(world);
			if (view) {
				const lines: string[] = [];
				if (view.currentTitle) lines.push(`当前位置: ${view.currentTitle}`);
				if (view.completed.length > 0) lines.push(`已完成(禁止重复追求/推进): ${view.completed.join("、")}`);
				if (lines.length > 0) blocks.push(`【发展线】\n${lines.join("\n")}`);
			}
			// 全局备忘录(Notice 待办,未完成项)——编剧要遵守/续写埋伏笔(2026-08-12 回到初衷)
			const noticeOpen = world.notice.items.filter((i) => !i.done).slice(0, NOTICE_INJECT_LIMIT);
			if (world.notice.enabled && noticeOpen.length > 0) {
				blocks.push(`【Notice·备忘录】\n${noticeOpen.map((i) => `- [ ] ${i.text}`).join("\n")}`);
			}
		} catch {
			/* 世界书缺失:跳过注入,不阻断对话 */
		}
		// 最近一幕舞台转录(评戏与 advice.md 的依据;收幕委托回合消息内已含【舞台转录】,
		// 此处会重复注入同源内容——截断上限兜底,可接受)。
		// 经典模式无舞台(页面隐藏、不会有新一幕),不注入:省 token,也避免单 agent
		// 上下文里出现它无从操作的概念。
		const transcript = this.classicMode ? null : await latestStageTranscript(getBookDir(slug));
		if (transcript) blocks.push(`【最近一幕舞台转录】\n${transcript}`);
		if (blocks.length === 0) return undefined;
		return [...messages, { role: "user", content: blocks.join("\n\n"), timestamp: Date.now() }];
	}

	/** 稳定块上下文(世界观概述/世界书角色条目/写作约束;截断保护同易变块)。
	 *  **文风采样已不在其中**(2026-10-05):改由 `read_style` 按需读取,见下方注释。
	 *  与易变块分离:syncStableContext 按指纹持久化进会话,内容不变不重注入,
	 *  省掉每轮数 k token 的全价未缓存输入(2026-08-22 缓存命中优化)。 */
	private async stableContext(slug: string): Promise<string> {
		const blocks: string[] = [];
		try {
			const world = await ensureWorld(getBookDir(slug));
			// 简要世界观概述(常驻,与写作会话同款语义;为空跳过,超长截断)
			const summary = world.worldSummary?.trim();
			if (summary && summary.length > 0) {
				const body = summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}\n…(截断)` : summary;
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
			// 文风采样**刻意不在这里**(2026-10-05):它是 `read_style` 的按需读取对象,
			// 不再常驻。两个原因 —— ① 按提示词纪律「明显变化则换新,从当前章草稿选
			// 300–500 字」,采样每写一章就可能换一次,而它一变稳定块指纹就变、就要重注
			// 一份(见 countStableContextInLeaf),它是版本堆叠的第二大来源;
			// ② 讨论轮根本不动笔,用不上采样,却照样为它付了 token。
			// 写作约束(按 target 过滤:编剧收 writer/main——酒馆式规则包,2026-08-12;
			// 经典模式是单一写作 agent,writer 与 main 两类目标的约束都该生效)
			const editorConstraints = world.constraints.filter(
				(c) => c.enabled && (constraintTargetMatches(c.target, "writer") || (this.classicMode && constraintTargetMatches(c.target, "main"))),
			);
			if (editorConstraints.length > 0) {
				blocks.push(`【写作约束】\n${editorConstraints.map((c) => `- ${c.name}: ${c.text}`).join("\n")}`);
			}
		} catch {
			/* 世界书缺失:跳过注入 */
		}
		return blocks.join("\n\n");
	}

	/**
	 * 同步稳定块上下文:指纹与会话内已注入的一致则跳过;不一致(首次/世界书或
	 * 文风等变更后)经 injectContext 以 nextTurn custom 消息持久化——随下个用户
	 * prompt 进入上下文并落盘,之后成为可缓存前缀的一部分,不再每轮重付。
	 * 指纹扫描沿当前 leaf 分支:压缩(compaction 把旧历史移出 leaf 链)或切分支后
	 * 稳定块不在上下文里时会被重新发现并补注入。
	 */
	private async syncStableContext(slug: string, conversationId: string, host: SessionHost): Promise<void> {
		const stable = await this.stableContext(slug);
		if (stable.length === 0) return;
		const fp = stableFingerprint(stable);
		const key = WriterHost.key(slug, conversationId);
		if (this.stableInjected.get(key) === fp) return;
		if (!this.stableInjected.has(key) && sessionLeafHasFingerprint(slug, conversationId, fp)) {
			// 服务重启后内存为空,但当前分支已含同指纹注入:只补记账,不重注入
			this.stableInjected.set(key, fp);
			return;
		}
		// 版本号 = 已有份数 + 1:已经注入过的那些不会消失,新版本必须能盖过它们。
		const version = countStableContextInLeaf(slug, conversationId) + 1;
		await host.injectContext(renderStableContext(this.classicMode, stable, version));
		this.stableInjected.set(key, fp);
	}

	/** 编剧会话状态快照(纯读;未对话过的对话返回空态,不创建会话)。
	 *  chapter 模式:chapterFile 即身份,缺省用该书最近一次对话声明的章节;
	 *  book 模式:conversation 定位身份,chapterFile 只登记「正在看的章节」。 */
	async state(slug: string, chapterFile?: string | null, conversation?: string | null): Promise<WriterState> {
		const { key, chapter } = this.resolveRef(slug, chapterFile, conversation);
		const host = this.hosts.get(WriterHost.key(slug, key));
		if (!host) {
			// 服务重启后 hosts 内存为空:从磁盘会话文件恢复分支视图——否则前端对齐
			// 拿到空态,编剧对话「看起来全丢」(与舞台导演同源问题,2026-08-10);
			// SessionManager.open 只读解析,只显示当前 leaf 的消息(撤回的旧分支不混入)
			const fromDisk = readSessionFromDisk(slug, key);
			if (fromDisk) {
				return {
					bookSlug: slug,
					chapterFile: chapter,
					exists: fromDisk.messages.length > 0,
					isStreaming: false,
					messages: fromDisk.messages,
				};
			}
			return { bookSlug: slug, chapterFile: chapter, exists: false, isStreaming: false, messages: [] };
		}
		const st = host.getState();
		return {
			bookSlug: slug,
			chapterFile: chapter,
			exists: true,
			isStreaming: st.isStreaming,
			messages: st.messages,
		};
	}

	/**
	 * 取某书某段对话的编剧会话宿主。
	 * 默认**纯读**:只认内存里已存在的宿主(不建会话)。
	 * `warm: true` 时多一步:磁盘上已有该对话会话文件、而内存里还没宿主(比如服务刚重启),
	 * 就把宿主带起来 —— 否则打开页面拿不到占用/用量数据,输入条上的上下文圆环要等用户
	 * 在这段对话说第一句话才出现(2026-09-23)。没有会话文件的对话不建(没数据可算)。
	 */
	private async resolveHost(slug: string, chapterFile?: string | null, warm?: boolean, conversation?: string | null): Promise<SessionHost | null> {
		const { key, chapter } = this.resolveRef(slug, chapterFile, conversation);
		const existing = this.hosts.get(WriterHost.key(slug, key));
		if (existing) return existing;
		if (!warm) return null;
		if (!readSessionFromDisk(slug, key)) return null;
		return await this.getOrCreate(slug, key, chapter);
	}

	/** 编剧会话上下文占用(见 resolveHost 对 warm 的说明)。 */
	async contextUsage(
		slug: string,
		chapterFile?: string | null,
		opts?: { warm?: boolean; conversation?: string | null },
	): Promise<SessionContextUsage | null> {
		const host = await this.resolveHost(slug, chapterFile, opts?.warm, opts?.conversation);
		return host?.getContextUsage() ?? null;
	}

	/** 编剧会话用量统计(累计 token / 成本 / 按模型拆分;口径见 SessionUsageStats)。 */
	async sessionStats(
		slug: string,
		chapterFile?: string | null,
		opts?: { warm?: boolean; conversation?: string | null },
	): Promise<SessionUsageStats | null> {
		const host = await this.resolveHost(slug, chapterFile, opts?.warm, opts?.conversation);
		return host?.getSessionStats() ?? null;
	}

	/** 手动压缩编剧会话上下文(惰性建会话后执行;失败抛出由 server 映射为错误体)。
	 *  无 instructions 时注入写作场景的缺省摘要指令(见 WRITER_COMPACT_INSTRUCTIONS)。 */
	async compact(
		slug: string,
		chapterFile?: string | null,
		instructions?: string,
		conversation?: string | null,
	): Promise<SessionCompactionResult> {
		const { key, chapter } = this.resolveRef(slug, chapterFile, conversation);
		const host = await this.getOrCreate(slug, key, chapter);
		return await host.compact(instructions ?? WRITER_COMPACT_INSTRUCTIONS);
	}

	/** 发消息给编剧(惰性建会话;失败抛出,由 server 广播 chat_error)。
	 *  chapterFile 声明会话归属章节(无则用最近声明,再无则 default);
	 *  conversation 显式指定对话 id(book 模式的用法;chapter 模式下等同于章节文件名)。
	 *  这是「开口说话」的操作:声明的章节会记进「最近声明的章节」(与改动前一致)。
	 *  chapterFile 传 null = 显式声明"没在看任何章节"(book 模式清掉正文注入)。 */
	async chat(slug: string, text: string, chapterFile?: string | null, conversation?: string): Promise<void> {
		const { key, chapter } = this.resolveRef(slug, chapterFile, conversation, true);
		const host = await this.getOrCreate(slug, key, chapter);
		await this.syncStableContext(slug, key, host);
		await host.sendMessage(text);
	}

	/**
	 * 发消息给编剧并**等待回合完成**(收幕委托专用——编排器需在正文落盘后才
	 * 继续 emit「编剧已完成」)。与编排器 runTurn 同款语义:sendMessage 完成
	 * 即回合完成(agent_settled 在 prompt() 返回前已发出,勿再订阅),超时返回
	 * false 由调用方优雅降级;模型错误直接 throw 上抛。
	 *
	 * **不受 conversationScope 影响**:永远按**章节键**取宿主。收幕成文天然要落在
	 * 某一章的正文上,book 模式下「当前对话」可能是一段与章节无关的自由对话,
	 * 委托进去正文就没有落点(测试里有这条护栏)。同一 (书, 章节) 会话在 book 模式下
	 * 若已被列表选中过,这里复用同一个宿主(一个会话文件只能有一个宿主,
	 * 否则两个 SessionManager 同时追加会写坏 jsonl)。
	 */
	async chatAndWait(slug: string, text: string, chapterFile: string | null | undefined, timeoutMs = 600_000): Promise<boolean> {
		const chapter = normalizeId(chapterFile, "章节文件名");
		if (chapter) this.currentChapter.set(slug, chapter);
		const key = chapter ?? this.currentChapter.get(slug) ?? DEFAULT_CONVERSATION_ID;
		const host = await this.getOrCreate(slug, key, key === DEFAULT_CONVERSATION_ID ? null : key);
		await this.syncStableContext(slug, key, host);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		try {
			const result = await Promise.race([host.sendMessage(text).then(() => "sent" as const), timeout]);
			return result === "sent";
		} finally {
			clearTimeout(timer);
		}
	}

	/** 中止编剧当前生成(无会话时静默)。conversation 缺省中止该书**全部**对话的生成
	 *  (端点不带对话参数;生成中的那个中止即可)。 */
	async abort(slug: string, conversation?: string | null): Promise<void> {
		const target = conversation ? WriterHost.key(slug, normalizeId(conversation, "对话 id")) : null;
		for (const [key, host] of this.hosts) {
			if (!key.startsWith(`${slug}:`)) continue;
			if (target !== null && key !== target) continue;
			await host.abort();
		}
	}

	/** 编剧会话「编辑重发」:撤回最新用户消息(及之后),replacement 非空时撤回后重发。
	 *  内存无会话时从磁盘恢复再操作(服务重启后浏览器历史仍在,retract 不能因内存空而失败)。 */
	async retractMessage(
		slug: string,
		entryId: string,
		replacement?: string,
		chapterFile?: string | null,
		conversation?: string | null,
	): Promise<void> {
		const { key, chapter } = this.resolveRef(slug, chapterFile, conversation);
		const host = await this.getOrCreate(slug, key, chapter);
		await host.retractMessage(entryId);
		if (replacement !== undefined && replacement.trim().length > 0) {
			void host.sendMessage(replacement).catch((err) => {
				process.stderr.write(`[writer] 编辑重发失败: ${err instanceof Error ? err.message : String(err)}\n`);
			});
		}
	}

	/** 编剧会话分支树(分支栏 + 消息版本;切换 UI 数据):纯读,无会话时从磁盘恢复(不创建运行时)。 */
	async getSessionTree(slug: string, chapterFile?: string | null, conversation?: string | null): Promise<SessionTreeInfo> {
		const { key } = this.resolveRef(slug, chapterFile, conversation);
		const host = this.hosts.get(WriterHost.key(slug, key));
		if (!host) {
			const fromDisk = readSessionFromDisk(slug, key);
			return fromDisk
				? { currentLeafId: fromDisk.currentLeafId, branches: fromDisk.branches, versions: fromDisk.versions }
				: { currentLeafId: null, branches: [], versions: {} };
		}
		return host.getSessionTree();
	}

	/** 编剧会话分支切换:leaf 移到指定 entry(分支栏切换);前端经 messages_retracted 对齐。 */
	async navigate(slug: string, entryId: string, chapterFile?: string | null, conversation?: string | null): Promise<void> {
		const { key, chapter } = this.resolveRef(slug, chapterFile, conversation);
		const host = await this.getOrCreate(slug, key, chapter);
		await host.navigateTo(entryId);
	}

	// ---- 对话管理(book 模式:对话与章节分离) ----

	/**
	 * 列出该书的对话。**不落元数据文件**:会话文件 (`sessions/<slug>/writer-*.jsonl`)
	 * 本身就是唯一真相源 —— 标题从会话内容派生(第一条用户消息前若干字,空对话给中性
	 * 默认名),时间取文件 mtime,排序按 mtime 倒序。
	 *
	 * id 的形态:能对上 book.json 里章节文件名的会话返回**章节文件名**(`ch01.jsonl`,
	 * 与前端既有的 chapterFile 同形),其余返回裸 id(`c-xxxxxx`)。两者都能直接当
	 * writer 端点的 `conversation` 参数(会话文件命名函数会剥掉 .jsonl 后缀,
	 * 所以两种形态都落到同一个 writer-<x>.jsonl,不会出现两个宿主读同一文件)。
	 */
	async listConversations(slug: string): Promise<ConversationSummary[]> {
		if (!isSafeSessionId(slug)) throw new Error(`非法书 slug: ${slug}`);
		const sessionsDir = getBookSessionsDir(slug);
		let names: string[];
		try {
			names = await readdir(sessionsDir);
		} catch {
			return [];
		}
		const book = await loadBook(slug);
		const chapterFiles = new Set((book?.chapters ?? []).map((c) => c.file));
		const entries: Array<{ id: string; updatedAt: number }> = [];
		for (const name of names) {
			const base = sessionFileBase(name);
			if (base === null) continue;
			let mtimeMs: number;
			try {
				mtimeMs = (await stat(join(sessionsDir, name))).mtimeMs;
			} catch {
				continue; // 列出期间被删掉:跳过
			}
			entries.push({ id: chapterFiles.has(`${base}.jsonl`) ? `${base}.jsonl` : base, updatedAt: mtimeMs });
		}
		entries.sort((a, b) => b.updatedAt - a.updatedAt);
		const current = this.currentConversationId(slug, entries.map((e) => e.id));
		return entries.map((e) => ({ ...e, title: conversationTitle(slug, e.id), isCurrent: e.id === current }));
	}

	/**
	 * 当前对话 id(列表 isCurrent / 端点缺省定位):
	 * 本进程登记过的会话优先(chapter 模式回落到「最近一次声明的章节」);
	 * 什么都没登记(服务刚重启)或登记的那条已被删除 → 取 mtime 最近的一条 ——
	 * 前端首屏总要有个选中的对话。没有任何会话 → null。
	 */
	private currentConversationId(slug: string, ids: string[]): string | null {
		const tracked =
			this.currentConversation.get(slug) ?? (this.conversationScope === "chapter" ? this.currentChapter.get(slug) ?? null : null);
		if (tracked && ids.includes(tracked)) return tracked;
		return ids[0] ?? null;
	}

	/**
	 * 新建一段与章节无关的对话(book 模式的用法):生成文件名安全的不透明 id,
	 * 用 initChapterFile 写合法的 pi session 头(与章节会话同款,**不手写 jsonl 头**),
	 * 成为当前对话。宿主仍惰性创建 —— 第一次对话才起 agent。
	 */
	async createConversation(slug: string): Promise<ConversationSummary> {
		if (!isSafeSessionId(slug)) throw new Error(`非法书 slug: ${slug}`);
		const sessionsDir = getBookSessionsDir(slug);
		await mkdir(sessionsDir, { recursive: true });
		let id = "";
		for (let i = 0; i < 20 && id.length === 0; i++) {
			const candidate = newId("c");
			if (!existsSync(join(sessionsDir, writerSessionFile(candidate)))) id = candidate;
		}
		if (id.length === 0) throw new Error("无法生成新的对话 id(重名太多)");
		const abs = join(sessionsDir, writerSessionFile(id));
		await initChapterFile(abs, getBookDir(slug));
		this.currentConversation.set(slug, id);
		const updatedAt = (await stat(abs)).mtimeMs;
		return { id, title: DEFAULT_CONVERSATION_TITLE, updatedAt, isCurrent: true };
	}

	/**
	 * 删除一段对话:释放并移除宿主 + 删会话文件 + 清掉「当前对话/最近章节」登记。
	 *
	 * 会话文件对应的预览卡片文件 (`<id>.cards.json`) **不动** —— 卡片按章节存储
	 * (见 server 的 resolveChapterSideFile),删一段对话不该把那一章的卡片也带走。
	 * 返回是否真的删掉了什么(前端据此 404)。
	 */
	async deleteConversation(slug: string, id: string): Promise<boolean> {
		if (!isSafeSessionId(slug)) throw new Error(`非法书 slug: ${slug}`);
		const safeId = normalizeId(id, "对话 id");
		if (safeId === null) throw new Error("缺少对话 id");
		const key = WriterHost.key(slug, safeId);
		// 先判废并等在建创建结束(BUG-021):否则「创建中的宿主」会在我们删掉 JSONL
		// 之后才登记回来,文件被复活、实例与磁盘不一致
		this.bumpEpoch(key);
		await this.settleCreating(key);
		const host = this.hosts.get(key);
		if (host) {
			this.hosts.delete(key);
			await host.dispose();
		}
		this.stableInjected.delete(key);
		if (this.currentConversation.get(slug) === safeId) this.currentConversation.delete(slug);
		if (this.currentChapter.get(slug) === safeId) this.currentChapter.delete(slug);
		if (this.viewChapter.get(slug) === safeId) this.viewChapter.set(slug, null);
		try {
			await unlink(join(getBookSessionsDir(slug), writerSessionFile(safeId)));
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return host !== undefined;
			throw err;
		}
	}

	/** 全部会话释放(server stop 时调用)。 */
	async disposeAll(): Promise<void> {
		// 判废所有在建创建(BUG-021):它们完成后自我释放,不会把已清空的 hosts 重新填上
		for (const key of this.creating.keys()) this.bumpEpoch(key);
		const all = [...this.hosts.values()];
		this.hosts.clear();
		this.currentChapter.clear();
		await Promise.allSettled(all.map((h) => h.dispose()));
	}

	/** 释放某本书的全部对话编剧会话(删除书前调用;无会话时静默)。
	 *  不释放则删除后会话仍在内存,AI 继续写 draft/writer 文件,文件复活。 */
	async dispose(slug: string): Promise<void> {
		const prefix = `${slug}:`;
		for (const key of this.creating.keys()) {
			if (key.startsWith(prefix)) this.bumpEpoch(key);
		}
		const all: SessionHost[] = [];
		for (const [key, host] of this.hosts) {
			if (key.startsWith(prefix)) all.push(host);
		}
		for (const key of [...this.hosts.keys()]) {
			if (key.startsWith(prefix)) this.hosts.delete(key);
		}
		this.currentChapter.delete(slug);
		this.currentConversation.delete(slug);
		this.viewChapter.delete(slug);
		await Promise.allSettled(all.map((h) => h.dispose()));
	}
}

/**
 * 从磁盘编剧会话文件恢复会话视图——服务重启后 hosts 内存为空,
 * state()/getSessionTree() 仍能给出与内存一致的分支视图(当前 leaf 消息 + 分支树,
 * 撤回/编辑重发产生的旧分支也在),前端对齐不丢记录、分支栏可切换。
 * SessionManager.open 只读加载,不启动 agent 运行时;解析失败返回 null。
 */
function readSessionFromDisk(slug: string, conversationId: string | null): {
	messages: WriterState["messages"];
	currentLeafId: string | null;
	branches: SessionBranchInfo[];
	versions: Record<string, SessionVersionInfo>;
} | null {
	try {
		const sessionsDir = getBookSessionsDir(slug);
		const abs = join(sessionsDir, writerSessionFile(conversationId));
		if (!existsSync(abs)) return null;
		// 2026-10-04(T7 批 2):openSession 收口到 adapter;这里拿的是**只读读取器**,
		// 不是 vendor 实体 —— 下方两个消费者都只要 getBranch/getTree,读取器足够。
		const sm = readSessionFile(abs, sessionsDir, getBookDir(slug));
		if (!sm) return null;
		const messages = extractMessagesFromManager(sm);
		// 纯读路径没有运行时:上一进程留下的未答提问永远等不到回答,标成「未回答」,
		// 避免前端水合后弹出一张点不动的死卡(写盘那条走 SessionHost 构造里的清扫)。
		settleDanglingAskParts(messages);
		// 分支视图(分支栏 + 消息版本):与 SessionHost.getSessionTree 同一份实现。
		// 造型:reader 只承诺 `unknown[]`,而 buildSessionTree 要精确的 entry 形状
		// (见 session-tree.ts 的 SessionTreeSource 注释)。
		const tree = buildSessionTree(sm as SessionTreeSource);
		return { messages, currentLeafId: tree.currentLeafId, branches: tree.branches, versions: tree.versions };
	} catch {
		return null;
	}
}

/** 会话文件 basename:`writer-<对话 id>.jsonl`(chapter 模式下 id 就是章节文件名,
 *  `ch01.jsonl` → `writer-ch01.jsonl`,与改动前逐字节一致;无 id → default)。
 *  模块级(state/readSessionFromDisk/sessionLeafHasFingerprint/对话管理共用)。 */
function writerSessionFile(conversationId: string | null | undefined): string {
	const id = (conversationId ?? DEFAULT_CONVERSATION_ID).replace(/\.jsonl$/, "") || DEFAULT_CONVERSATION_ID;
	return `writer-${id}.jsonl`;
}

/**
 * 从会话文件名反解裸 id(`writer-ch01.jsonl` → `ch01`);不是本宿主的会话文件返回 null。
 * 列表再按 book.json 判断它是不是章节对话,决定返回 `ch01` 还是 `ch01.jsonl`。
 */
function sessionFileBase(fileName: string): string | null {
	if (!fileName.startsWith("writer-") || !fileName.endsWith(".jsonl")) return null;
	const base = fileName.slice("writer-".length, -".jsonl".length);
	return base.length > 0 && isSafeSessionId(base) ? base : null;
}

/**
 * 对话标题:第一条用户消息的前若干字(压平空白);空对话给中性默认名。
 * 内容来源是会话文件本身(唯一真相源),经 readSessionFromDisk 复用既有解析。
 *
 * **技能调用单独处理**:`/skill:<name>` 在发送时被 vendor 展开成整份 SKILL.md 写进
 * 消息(见 web/src/skill-invocation.ts),照原文截前 24 字会得到
 * `<skill name="critique" loc` 这种前缀垃圾。这里用 vendor 的 parseSkillBlock 拆开,
 * 标题取「技能名 · 你自己说的话」。
 */
function conversationTitle(slug: string, id: string): string {
	const fromDisk = readSessionFromDisk(slug, id);
	const first = fromDisk?.messages.find((m) => m.role === "user" && m.text.trim().length > 0);
	if (!first) return DEFAULT_CONVERSATION_TITLE;
	return conversationTitleText(first.text);
}

/**
 * 标题取值口径(纯函数,便于单测):技能调用取「技能名 · 你自己说的话」,其余取原文;
 * 压平空白后截到 {@link TITLE_LIMIT} 字。
 */
export function conversationTitleText(text: string): string {
	const skill = parseSkillBlock(text);
	const source = skill ? [skill.name, skill.userMessage ?? ""].filter((s) => s.length > 0).join(" · ") : text;
	const flat = source.replace(/\s+/g, " ").trim();
	return flat.length > TITLE_LIMIT ? flat.slice(0, TITLE_LIMIT) : flat;
}

/**
 * 渲染稳定上下文的注入文本(纯函数,单测直接钉)。
 *
 * 三个必须同在这条标题里的东西,少一个都会出事:
 * - **指纹**:`sessionLeafHasFingerprint` 靠 `指纹 ${fp}` 认出「已经注入过这一版」,
 *   服务重启后能只补记账不重注入。去掉它,每次重启都白付一次全价未缓存输入。
 * - **版本号**:见 {@link countStableContextInLeaf},旧版本不会消失,必须有可比的序号。
 * - **取代声明**:只给版本号不给作废语义的话,模型看到多份「长期有效」仍会自己挑。
 *
 * @param classicMode true = 写作 agent,false = 编剧(两者的稳定块内容口径不同)
 */
export function renderStableContext(classicMode: boolean, stable: string, version: number): string {
	const role = classicMode ? "写作" : "编剧";
	return [
		`【${role}稳定上下文 · 第 ${version} 版 · 取代此前所有同名条目】`,
		"以下是世界观与写作基准,长期有效。",
		"",
		"**这份是当前唯一有效的版本。** 本书设定每次改动我都会重新整理一份注入到这里,而更早的那些条目**不会消失**,它们是被改动之前的旧快照 —— 名字一样、内容可能已经不同。多条内容冲突时,只以**版本号最大**的这一条为准,其余一律作废。",
		"",
		stable,
	].join("\n");
}

/**
 * 当前 leaf 分支上已有的稳定上下文版本数(0 = 还没注入过)。
 *
 * 为什么需要它:只要世界书改一次,`stableContext` 的内容就变、指纹就变,于是
 * **又注入一份**。旧的那份留在该 leaf 链上没人删 —— 真实会话
 * `writer-c-v05ij1` 里堆到 **16 份**(760 → 3885 字),每一份都自称「长期有效」,
 * 可第 1 份和第 16 份对同一个人的写法已经不同了。用户抱怨「我不是曾经介绍过
 * 本我侵蚀吗」「笔记里不都有吗」,就是因为模型对着十几份互相打架的设定不知道
 * 该信哪一份 —— **这是「背景包堆叠」真正的代价,不是占了多少 token。**
 *
 * 为什么不去删旧条目:custom 消息已经落进会话树并被 ack,parentId 链不能断。
 * 于是退一步 —— 在新版本上标清楚自己是第几版、旧的是废的。移不掉就挂牌子。
 */
export function countStableContextInLeaf(slug: string, conversationId: string | null): number {
	try {
		const sessionsDir = getBookSessionsDir(slug);
		const abs = join(sessionsDir, writerSessionFile(conversationId));
		if (!existsSync(abs)) return 0;
		// 只读读取器(与 sessionLeafHasFingerprint 同一套,见那里的注释)
		const sm = readSessionFile(abs, sessionsDir, getBookDir(slug));
		if (!sm) return 0;
		const leafId = sm.getLeafId();
		if (!leafId) return 0;
		let n = 0;
		for (const e of sm.getBranch(leafId) as SessionEntry[]) {
			if (e.type !== "custom_message") continue;
			if (JSON.stringify(e).includes(STABLE_CONTEXT_MARKER)) n++;
		}
		return n;
	} catch {
		return 0;
	}
}

/** FNV-1a 8 位十六进制指纹(稳定块内容);不引 crypto,防碰撞能力对「内容变没变」判断足够。 */
export function stableFingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 当前 leaf 分支是否已含该指纹的稳定块注入(只读打开会话文件)。
 * 沿 leaf 链扫描:压缩/切分支后旧注入移出当前上下文 → 返回 false → syncStableContext 允许补注入。
 * 文件不存在/解析失败返回 false(视为未注入)。
 */
function sessionLeafHasFingerprint(slug: string, conversationId: string | null, fp: string): boolean {
	try {
		const sessionsDir = getBookSessionsDir(slug);
		const abs = join(sessionsDir, writerSessionFile(conversationId));
		if (!existsSync(abs)) return false;
		// 2026-10-04(T7 批 2):只读读取器(见 readSessionFromDisk 同处注释)
		const sm = readSessionFile(abs, sessionsDir, getBookDir(slug));
		if (!sm) return false;
		const leafId = sm.getLeafId();
		if (!leafId) return false;
		const marker = `指纹 ${fp}`;
		for (const e of sm.getBranch(leafId) as SessionEntry[]) {
			if (e.type !== "custom_message") continue;
			if (JSON.stringify(e).includes(marker)) return true;
		}
		return false;
	} catch {
		return false;
	}
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
