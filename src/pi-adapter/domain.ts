/**
 * pi-adapter 的**领域类型**(T6,2026-10-04)。
 *
 * 这个文件的立场:**对外 API 必须是写作领域形状,不是 vendor 形状的透传。**
 *
 * 原先这些接口散落在 `src/web/session-host.ts` 里,且其中两处直接写着 vendor 的类型
 * (`SessionManager` / `CreateAgentSessionRuntimeFactory`)。那意味着:vendor 将来把
 * `SessionManager` 换个名字或挪个包,自研侧二十几个 import 点会**同时红** —— 而这跟
 * 「写作」毫无关系。
 *
 * 迁到这里之后:
 * - 自研代码 import 的是 `pi-adapter`,不是 vendor;
 * - vendor 类型被换成**不透明句柄**(见下),自研侧只能把它传回 adapter,不能解构;
 * - vendor 真的换名字时,只改 adapter 内部的 `toHandle` / `fromHandle` 两行。
 *
 * 本文件**不 import 任何 vendor 模块** —— 这是刻意的,保证类型层零耦合。
 * (T7 批 2 新增的 vendor 类型别名放在同目录的 `types.ts`,不污染本文件。)
 */

import type { ChatContentPart } from "../session-text.ts";

// ============================================================================
// 不透明句柄:切断 vendor 类型泄漏
// ============================================================================

/**
 * 会话管理器句柄。
 *
 * 运行时它就是 vendor 的 `SessionManager` 对象本身(零开销造型),但**类型上
 * 看不见它的成员** —— 自研代码拿不到 `.getEntries()` 之类,只能把句柄交回
 * `pi-adapter` 的函数处理。
 *
 * 为什么用 `unique symbol` 品牌而不是 `interface {}`:空接口在结构类型系统里
 * 可以被**任何**对象满足 —— 手滑传了个 `{}` 也能编译过。品牌字段让它在类型上
 * 不可伪造,同时因为只有一个 `readonly` 字段、且从不真去读它,运行期无成本。
 */
declare const sessionManagerBrand: unique symbol;
export type SessionManagerHandle = {
	readonly [sessionManagerBrand]: true;
};

/**
 * 会话运行时工厂句柄。
 *
 * `SessionHostOptions.createRuntime` 原来是 vendor 的
 * `CreateAgentSessionRuntimeFactory`。那是个复杂的函数类型(内部签名含多个
 * vendor 类型),透传出去等于把整条 vendor 类型链拖进自研侧。
 */
declare const runtimeFactoryBrand: unique symbol;
export type RuntimeFactoryHandle = {
	readonly [runtimeFactoryBrand]: true;
};

// ============================================================================
// SessionHost 的对外契约
// ============================================================================

/** SessionHost 构造选项;createRuntime 由调用方注入,SessionHost 不自己构造 services。 */
export interface SessionHostOptions {
	createRuntime: RuntimeFactoryHandle;
	cwd: string; // 书目录
	agentDir: string;
	sessionManager: SessionManagerHandle;
	/** 工具路径守卫所需的会话上下文(readOnlyDirs/draftFile)。
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
	 * thinking / text 是**兼容投影**(整条消息拼接,供 TUI 与分支摘要取文本);
	 * `content` 才是渲染依据:**有序内容块**(思考 / 正文 / 工具调用),
	 * 工具块内联执行结果。缺 content 的旧形状按 text/thinking 兜底。
	 * startedAt / endedAt 是组内首末 entry 时间(ms),供「已工作 X 分 Y 秒」还原。
	 */
	messages: Array<{
		role: "user" | "assistant";
		text: string;
		thinking?: string;
		content?: ChatContentPart[];
		timestamp?: string;
		startedAt?: number;
		endedAt?: number;
		id?: string;
		/**
		 * assistant 组的**首段** entry id(user 消息不设,它的 id 就是首段)。
		 *
		 * 为什么要单独给:一个 assistant 气泡是多段输出合并的,`id` 取组内**最后**
		 * 一段(历史口径),而「这条消息的版本位置」在树上是**首段**决定的
		 * —— `src/session-tree.ts` 的版本地图按首段 entry 建键。前端用
		 * `firstEntryId ?? entryId` 就能在「水合」与「实时」两条路径上取到同一个键
		 * (实时路径 assistant 组的 entryId 本来就被 message_end 落在首段上)。
		 */
		firstEntryId?: string;
		/**
		 * provider 侧报错的原文(vendor 不抛异常,而是给 assistant 消息落
		 * `stopReason: "error"` + `errorMessage`,content 为空)。
		 *
		 * 这类 entry 以前被「无正文无思考即丢弃」的兜底整条丢掉 —— 于是刷新后
		 * 报错凭空消失、只剩一个空气泡。原文要留着(需求 1),所以单独带出来。
		 * provider / model 是出错那一刻的取值(与 vendor 消息字段同源),供前端
		 * 在原文下方补一行「provider: x · model: y」——供应商排查要看这两个。
		 */
		errorMessage?: string;
		provider?: string;
		model?: string;
	}>;
	diagnostics: Array<{ type: "error" | "warning" | "info"; message: string }>;
}

/** 会话上下文占用(与 vendor AgentSession.getContextUsage 对齐;前端 /compact 提示用)。 */
export interface SessionContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/**
 * 会话用量统计(与 vendor AgentSession.getSessionStats 对齐 + 按模型拆成本)。
 * 口径是**整个会话文件**(含被压缩掉的历史),即"花了多少",不是"现在上下文多大"。
 */
export interface SessionUsageStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/** 累计成本(供应商侧计价,单位随供应商;DeepSeek 等按美元)。 */
	cost: number;
	/** 当前上下文占用(与 /context 同一个值,顺便带出来省一次请求)。 */
	contextUsage: SessionContextUsage | null;
	/** 按 provider/model 拆的成本与 token(含 "Tools/summaries" 这一桶);按 cost 倒序。 */
	breakdown: Array<{ key: string; cost: number; tokens: number }>;
}

/** 手动压缩返回摘要(与 vendor CompactionResult 对齐)。 */
export interface SessionCompactionResult {
	summary: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

/** 单会话思考档位设置结果。 */
export interface ThinkingLevelResult {
	/** 实际生效的档位(null = 该会话拿不到状态,如最小 fake)。 */
	level: string | null;
	/** 实际档位 ≠ 请求档位 —— 被模型能力回落(clamp)。 */
	clamped: boolean;
}

/**
 * **宿主级**思考档位设置结果:一个宿主可能带多个会话(编剧按对话、舞台按角色),
 * 每个会话的模型能力不同,可能被 clamp 到**不同**档位。逐个回报,不拿主会话的值
 * 冒充所有窗口(2026-10 审计 BUG-013)。
 */
export interface ThinkingSummary {
	/** 处理到的会话数。 */
	sessions: number;
	/** 各会话实际生效的档位(去重、保序)。 */
	levels: string[];
	/** 至少一个会话被回落。 */
	clamped: boolean;
	/** 失败的会话(消息原文;不抛错,由调用方分宿主报告)。 */
	failed: string[];
	/**
	 * **故意**没跟随全局档位的会话数(舞台演员:思考档位属于角色设计,§10.6)。
	 * 用来把「这里本来就该跳过」与「改失败了」分开,免得调用方以为漏刷了。
	 */
	actorsOmitted?: number;
}

/**
 * 模型目录刷新的**宿主级结果**(2026-10 审计 BUG-005)。
 *
 * 「刷新模型列表」现在要覆盖主会话 + 常驻编剧 + 舞台三处宿主:每个会话宿主在装配时
 * 各建一份 ModelRuntime,只刷主会话时已建的编剧/舞台会话仍是旧目录。逐个宿主收集
 * 结果,是为了让部分成功**不被伪装成**全成功(响应里能列出到底谁没刷上)。
 */
export interface ModelRefreshSummary {
	/** 目录刷新期间 provider 报出的错误(provider id → 原文;主会话的联网刷新才有)。 */
	errors: Array<{ provider: string; message: string }>;
	/** 目录里可用的模型数(null = 该宿主拿不到目录统计)。 */
	modelCount: number | null;
	/** 本宿主处理的已建会话数。 */
	sessions: number;
	/** 因「还没选到模型」被释放的会话键(下次装配按最新目录重新解析)。 */
	released: string[];
}
