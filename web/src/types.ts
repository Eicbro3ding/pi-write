/**
 * 前端 DTO 类型定义 —— 字段与后端 book-manager / session-host / world-tree 对齐。
 * 仅类型(erasable TS),无运行时依赖。
 */

/** 书列表条目(后端 BookListEntry)。 */
export interface BookMeta {
	slug: string;
	title: string;
	chapters: number;
	updatedAt: number;
}

/** 章节引用(后端 ChapterRef 的投影:前端只关心展示所需字段)。 */
export interface ChapterRef {
	/** 稳定 id,如 "ch01"。 */
	id: string;
	/** 会话文件 basename。 */
	file: string;
	/** 章节标题。 */
	title: string;
	/** 可选标记,如 "草稿" / "完成" / "搁置"。 */
	label: string | null;
	/** 会话文件当前是否存在于磁盘。 */
	exists: boolean;
}

/** 书详情(后端 BookIndex)。 */
export interface BookDetail {
	slug: string;
	title: string;
	/** 当前打开章节的会话文件 basename(或 null)。 */
	currentChapterFile: string | null;
	chapters: ChapterRef[];
}

/**
 * 会话历史里的一个有序内容块(与后端 src/session-text.ts 的 ChatContentPart 对齐)。
 * 工具块**内联执行结果** —— 工具结果在磁盘上本来是独立的 toolResult entry,
 * 服务端配对回填后挂在调用块上,前端水合不必再合成事件对。
 */
export type ChatContentPartDto =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: string; result?: string | null; isError?: boolean };

/** 服务端下发的会话历史消息(兼容投影 text/thinking + 渲染依据 content)。 */
export interface SessionMessageDto {
	role: "user" | "assistant";
	text: string;
	thinking?: string;
	/** 有序内容块;缺省(旧形状)时按 text/thinking 兜底。 */
	content?: ChatContentPartDto[];
	timestamp?: string;
	/** 组内首末 entry 时间(ms);「已工作 X 分 Y 秒」的还原依据。 */
	startedAt?: number;
	endedAt?: number;
	id?: string;
}

/** 会话状态快照(后端 session-host getState())。 */
export interface SessionState {
	bookSlug: string | null;
	chapterFile: string | null;
	isStreaming: boolean;
	/**
	 * 会话历史,用于前端聊天水合(openBook / SSE onopen 对齐)。
	 * id 是会话 entry 稳定 id(编辑/分支定位依据);timestamp 同 entry。
	 */
	messages: SessionMessageDto[];
	diagnostics: Array<{ type: string; message: string }>;
}

/** 会话分支树概览(分支栏数据;与 session-host getSessionTree 对齐)。 */
export interface SessionBranchInfo {
	leafId: string;
	isCurrent: boolean;
	/** 该分支路径上的消息数。 */
	count: number;
	/** 分支起点摘要(路径上第一条 user 消息,前 24 字)。 */
	summary: string;
	/** 分支结尾摘要(最后一条消息,前 24 字)。 */
	tail: string;
}

export interface SessionTreeDto {
	currentLeafId: string | null;
	branches: SessionBranchInfo[];
}

/** 世界书节点(后端 WorldNode)。 */
export interface WorldNodeDto {
	/** 稳定 id:`<fileRel>:<title>`。 */
	id: string;
	/** 标题文本(不含 # 前缀)。 */
	title: string;
	/** 来源文件类别:character | world | timeline | outline。 */
	kind: string;
	/** 父节点标题,文件根为 null。 */
	parent: string | null;
	/** 标题下的正文。 */
	body: string;
	/** 仓库相对路径,如 `.writer/characters.md`。 */
	fileRel: string;
	/** 子节点。 */
	children: WorldNodeDto[];
}

// —— 世界书数据(world.json;与后端 world-data 对齐)——

/** 世界书条目(后端 world-data WorldEntry 投影)。 */
export interface WorldEntryDto {
	id: string;
	type: "character" | "world" | "timeline" | "outline";
	title: string;
	keys: string[];
	chapters: string[];
	status: string;
	active: boolean;
	parent: string | null;
	tags: string[];
	body: string;
	avatar: string | null;
	images: string[];
	updatedAt: number;
}

/** 关系箭头方向:none 无箭头 / single 单向(from→to)/ double 双向。 */
export type RelationArrowDto = "none" | "single" | "double";
export interface WorldRelationDto { id: string; from: string; to: string; type: string; label: string; emphasized: boolean; arrow: RelationArrowDto; }
export interface WorldConstraintDto { id: string; name: string; text: string; enabled: boolean; target?: "main" | "director" | "writer" | "all"; }
export interface StyleSampleDto { text: string; source: string; updatedAt: number; }
/** Notice 待办条目(备忘录):done=false 未完成(注入上下文)/ true 已完成(仅板子可见)。 */
export interface NoticeItemDto { id: string; text: string; done: boolean; updatedAt?: number; }
/** Notice = 全局备忘录/待办清单(2026-08-12 回到初衷)。 */
export interface NoticeDto { enabled: boolean; items: NoticeItemDto[]; }
export interface StoryNodeDto { id: string; title: string; status: "pending" | "in-progress" | "done" | "shelved"; goal: string; next: string | null; }
export interface StorylineDto { enabled: boolean; nodes: StoryNodeDto[]; }
export interface TimelineEventDto { id: string; chapter: string; text: string; }
export interface WorldDataDto {
	version: 1;
	entries: WorldEntryDto[];
	relations: WorldRelationDto[];
	constraints: WorldConstraintDto[];
	styleSample: StyleSampleDto | null;
	worldSummary: string;
	notice: NoticeDto;
	storyline: StorylineDto;
	timeline: TimelineEventDto[];
}

/**
 * 消息内的一个有序块。**顺序即到达顺序**(2026-09-19)。
 *
 * 改造前 ChatMessage 是 `{text, thinking, toolCalls}` 三个平铺字段,一个回合里
 * 多段「思考 → 工具 → 思考 → 工具 → 正文」被 reducer 用 `\n\n` 拼成「全部思考 +
 * 全部正文 + 全部工具」,顺序在归约那一刻就丢了。现在顺序本身就是数据:
 * 块按事件到达次序追加,渲染原样遍历。
 */
export type MessageBlock =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; call: ToolCallInfo };

/** 会话视图中的一条聊天消息。 */
export interface ChatMessage {
	id: string;
	/** 会话 entry 稳定 id(服务端下发的编辑/分支定位依据;实时消息在 message_end 时补上)。 */
	entryId?: string;
	role: "user" | "assistant";
	/** 有序块序列(思考 / 正文 / 工具调用按到达顺序穿插)。 */
	blocks: MessageBlock[];
	/** 消息是否已结束(收到 message_end)。 */
	done: boolean;
	/**
	 * 回合计时(ms 时间戳):该 assistant 气泡的首个事件到达时为 startedAt,
	 * agent_settled / 历史水合的最后一条 entry 时间为 endedAt。
	 * 供「已工作 X 分 Y 秒」折叠头显示;两者都有才是有效时长。
	 */
	startedAt?: number;
	endedAt?: number;
}

/** 工具调用卡片。 */
export interface ToolCallInfo {
	id: string;
	name: string;
	/** 序列化后的调用参数(字符串原样,对象 JSON.stringify)。 */
	args: string;
	/** 执行结果文本;未结束为 null。 */
	result: string | null;
	/**
	 * 运行中的**流式输出快照**(tool_execution_update;bash 的 stdout/stderr)。
	 * 是快照不是增量——每次事件直接替换(完整当前输出),结束时清空。
	 */
	stream?: string | null;
	/** 是否执行出错。 */
	isError: boolean;
}

/** 上下文占用(vendor AgentSession.getContextUsage 投影)。 */
export interface ContextUsageDto {
	/** 估算 token 数;压缩后尚无新的模型响应时为 null。 */
	tokens: number | null;
	contextWindow: number;
	/** 占用百分比(0-100);tokens 为 null 时也为 null。 */
	percent: number | null;
}

/** 最近一轮 assistant 消息的提示词缓存命中(usage.cacheRead 投影;2026-08-22)。 */
export interface CacheHitInfo {
	/** 命中率 0..1(cacheRead / 全部提示词 token)。 */
	rate: number;
	/** 本轮全部提示词 token(input + cacheRead + cacheWrite)。 */
	promptTokens: number;
	/** 命中(cacheRead)token。 */
	cachedTokens: number;
}

/** 会话视图状态(由 SSE 事件 reducer 纯函数维护)。 */
export interface SessionViewState {
	messages: ChatMessage[];
	isStreaming: boolean;
	/**
	 * 本轮首个 turn_start 的到达时刻(ms);后续 turn_start(多轮工具调用)不覆盖。
	 * 用于给本轮 assistant 气泡落 startedAt —— 「已工作 X 分 Y 秒」的计时起点,
	 * 从用户发出那一刻算,而不是从第一个 token 算。
	 */
	turnStartedAt?: number;
	/** 上下文压缩中(自动/手动触发):对话末尾显示「正在压缩上下文」提示。 */
	compacting: boolean;
	/** 最近一轮提示词缓存命中(message_end 的 assistant usage);provider 未上报缓存字段或尚无响应为 null。 */
	cacheHit: CacheHitInfo | null;
}

/**
 * 服务端经 SSE 推送的事件最小形状(与 vendor 字段对齐,前端只消费这些)。
 * 本地定义,不 import vendor,避免 web tsc 连带检查 vendor 源文件的既有类型错误。
 *
 * 精确判别联合(2026-08-10 收敛):不再带 `{ type: string; [key: string]: unknown }`
 * 通配成员——此前它让任何收窄失效,store/WritePage/多窗口组件被迫到处 cast。
 * 未知事件(vendor 的 queue_update/auto_retry_* 等)前端一律忽略:运行时由
 * reducer 的 default 分支与各回调的 else 分支兜底,类型上不再表示它们;
 * 服务端/前端新增事件时,这里需要显式补成员(编译期提醒)。
 *
 * 注意:vendor 的 message 对象没有 id 字段(id 在 SessionEntry 层,不进 message),
 * 事件按序发射(message_start → message_update* → message_end),reducer 按顺序匹配,
 * 不依赖 id。entryId 仅两类事件携带:message_end(实时,session-host 从 leaf 链
 * 附加)与 message_start(历史水合 messagesToEvents 手动构造时带)。
 */
export type AgentEventDto =
	| {
			type: "message_start";
			message: { role: string; content?: unknown };
			entryId?: string;
			/** 仅历史水合合成的事件携带(实时 SSE 无此字段):组内首末 entry 时间(ms),
			 *  供 reducer 给气泡落 startedAt/endedAt,「已工作 X 分 Y 秒」刷新后仍在。 */
			startedAt?: number;
			endedAt?: number;
	  }
	| {
			type: "message_update";
			message: Record<string, unknown>;
			assistantMessageEvent?: { type: string; delta?: string; contentIndex?: number };
	  }
	| { type: "message_end"; message: Record<string, unknown>; entryId?: string }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
	// 工具运行中的流式局部结果(bash 的 stdout/stderr 快照;节流后按快照整段发,
	// 不是增量)。前端据此在有命令跑起来时就能看到输出(2026-09-18)。
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "compaction_start"; reason?: "manual" | "threshold" | "overflow" }
	| { type: "compaction_end"; reason?: "manual" | "threshold" | "overflow"; aborted?: boolean }
	| { type: "turn_start" }
	| { type: "agent_settled" }
	// 服务端合成事件(server.ts broadcast,字段与发射点对齐;
	// slug/bookSlug/chapterFile 可为 null——MCP reload 等路径无守卫直接取会话状态,
	// 无会话时为 null;前端消费点均按可空处理)
	| { type: "chat_error"; message: string }
	| { type: "session_changed"; bookSlug: string | null; chapterFile: string | null }
	| { type: "world_changed"; slug: string; mtime: number }
	| { type: "draft_changed"; slug: string | null; file: string; mtime: number }
	| { type: "messages_retracted" }
	// 舞台区事件(server 广播,字段与 src/web/stage-host.ts 的 StageHostEvent 对齐;
	// chapterFile 标记归属章节——舞台按章节隔离,前端按 slug+chapter 过滤)
	| { type: "stage_entry"; slug: string; chapterFile: string | null; entry: StageEntryDto }
	| { type: "stage_system"; slug: string; chapterFile: string | null; text: string }
	| { type: "stage_done"; slug: string; chapterFile: string | null; cmd: string; ok: boolean; text?: string; thinking?: string }
	// 导演会话事件全量透传(与 writer_event 同款,内层是主会话同款会话事件):
	// 前端复用 processAgentEvent 归约 + MessageList 渲染(2026-08-11 统一重构)
	| { type: "stage_director_event"; slug: string; chapterFile: string | null; event: WriterSessionEventDto }
	// 舞台阶段变化(开演/收幕):前端收到后自动刷新快照
	| { type: "stage_phase"; slug: string; chapterFile: string | null; phase: string }
	// 剧本确认门(2026-08-11):导演 script_confirm 提交剧本 → 前端卡片确认后才可开演
	| { type: "stage_script_confirm"; slug: string; chapterFile: string | null; sceneId: string; script: StageScriptDto }
	// 世界书编辑信号(2026-08-11):world_update 工具已写记录文件,前端回合结束
	// (agent_settled)读 GET /api/stage/:slug/last-world-edit 渲染预览卡
	| { type: "stage_world_edit"; slug: string; chapterFile: string | null }
	// 收幕导演整理回合结束(2026-08-11):前端撤「导演正在编辑消息」提示条
	| { type: "stage_director_done"; slug: string; chapterFile: string | null }
	// 常驻编剧事件(server 广播 writer_event,内层是主会话同款会话事件——
	// 前端复用 processAgentEvent 归约,消息/思考/工具卡片零新逻辑)。
	// chapterFile 标记归属章节:编剧会话按章节隔离(WriterHost 键 = 书+章节),
	// 前端必须按 slug+chapterFile 过滤,否则切章后其他章节编剧的流式会串进本页(2026-08-13)。
	| { type: "writer_event"; slug: string; chapterFile: string | null; event: WriterSessionEventDto }
	// 服务端设置变更(PUT /api/settings 后广播):其他窗口据此同步导航与开关
	// (经典模式切换会改变可用页面与 agent 装配,不能各窗口各说各话)
	| { type: "settings_changed"; settings: WriterSettingsDto };

/** 服务端全局设置(~/.pi/writer/settings.json;与 src/writer-settings.ts 对齐)。 */
export interface WriterSettingsDto {
	version: number;
	/** 经典模式:单 agent(只有编辑页),写作 agent 带全量工具。 */
	classicMode: boolean;
	/**
	 * 外部命令(shell):允许 agent 在书目录外执行 shell 命令;缺省关闭。
	 * 打开后命令以服务进程权限运行(路径守卫对它无效),靠命令与输出实时可见来约束。
	 */
	enableShell: boolean;
	/** shell 方言(bash 缺省 / pwsh):实际换可执行文件,提示词按方言叙述工具用法。 */
	shellKind: ShellKindDto;
	/** 显式 shell 可执行文件路径;空 = 自动探测(见 src/shell-kind.ts)。 */
	shellPath: string;
}

/** 用户可选的 shell 类型;auto(缺省)= 按平台自动识别(Windows 优先 PowerShell)。 */
export type ShellKindDto = "auto" | "bash" | "pwsh";

/** 实际解析出的 shell 方言("none" = 声明了 shell 但本机没找到可用的)。 */
export type ShellDialectDto = "none" | "bash" | "pwsh" | "powershell";

/** 服务端对当前设置的 shell 解析结果(GET/PUT /api/settings 的 `shell` 字段)。 */
export interface ResolvedShellDto {
	dialect: ShellDialectDto;
	/** 实际使用的可执行文件路径(bash 交给 vendor 探测时为 undefined)。 */
	path?: string;
	/** 非致命提示(只找到 PowerShell 5.1、找不到指定 shell 等)。 */
	warning?: string;
}

/** 常驻编剧/导演会话事件(主会话事件的子集,全部可被 processAgentEvent 处理)。 */
export type WriterSessionEventDto =
	| Extract<AgentEventDto, { type: "message_start" }>
	| Extract<AgentEventDto, { type: "message_update" }>
	| Extract<AgentEventDto, { type: "message_end" }>
	| Extract<AgentEventDto, { type: "tool_execution_start" }>
	| Extract<AgentEventDto, { type: "tool_execution_update" }>
	| Extract<AgentEventDto, { type: "tool_execution_end" }>
	| Extract<AgentEventDto, { type: "compaction_start" }>
	| Extract<AgentEventDto, { type: "compaction_end" }>
	| Extract<AgentEventDto, { type: "agent_settled" }>
	| Extract<AgentEventDto, { type: "chat_error" }>;

// —— 舞台区(与 src/stage/types.ts + src/web/stage-host.ts StageSnapshot 对齐)——

/** 舞台区单条记录(stage.jsonl 一行)。character 是编剧聚合与导演注入的关键索引。 */
export interface StageEntryDto {
	id: string;
	scene: string;
	turn: number;
	actor: string;
	character: string;
	content: Array<{ type: "text"; text: string }>;
	ts: number;
}

/** 舞台实时计数(编排器确定性计算,零模型调用)。 */
export interface StageCountsDto {
	lines: number;
	perActor: Record<string, number>;
	perCharacter: Record<string, number>;
	cnChars: number;
	turn: number;
}

/** 演员池条目(cast.json)。 */
export interface ActorSpecDto {
	id: string;
	type: "named" | "pool" | "narrator";
	character?: string;
	model?: string;
	thinking?: string;
}

export interface CastConfigDto {
	version: number;
	actors: ActorSpecDto[];
}

/** 剧本共享段:场景意象/本幕任务/节拍/基调/禁区。 */
export interface SharedTextDto {
	setting: string;
	goal: string;
	beats: string[];
	tone: string;
	forbidden: string[];
}

/** 剧本单演员段:任务(斯坦尼式欲望)/状态/关系/说话方式/边界/风格示例。 */
export interface ActorTextDto {
	objective: string;
	state?: string;
	relation?: string;
	voice?: string;
	boundary?: string;
	examples: string[];
}

/** 剧本文字段:shared 全员可见 + perActor 定向演出指令。 */
export interface StageTextDto {
	shared: SharedTextDto;
	perActor: Record<string, ActorTextDto>;
}

/** 剧本(scene.json):定义段(选角/注入/规则)+ 文字段。 */
export interface StageScriptDto {
	scene: string;
	chapter: string;
	version: number;
	definition: {
		cast: Record<string, string[]>;
		inject: Record<string, { characters?: string[]; world?: string[]; budget: number }>;
		rules: { minLines: number; maxLines: number; wrapUpWindow: number; turn: "round-robin" };
	};
	text: StageTextDto;
	previous?: { version: number; text: StageTextDto; rules: { minLines: number; maxLines: number; wrapUpWindow: number }; at: number };
}

/** 剧本修改补丁(/revise:字段级合并,数组字段整体替换;仅含非空字段)。 */
export interface ScriptPatchDto {
	text?: {
		shared?: Partial<SharedTextDto>;
		perActor?: Record<string, Partial<ActorTextDto>>;
	};
	rules?: Partial<Pick<StageScriptDto["definition"]["rules"], "minLines" | "maxLines" | "wrapUpWindow">>;
}

/** 场景阶段(编排器侧状态机)。 */
export type StagePhaseDto = "idle" | "casting" | "running" | "wrapping" | "closed";
/** 舞台状态:normal 正常轮转 / wrapping 收尾提示中 / closed 收幕。 */
export type StageStatusDto = "normal" | "wrapping" | "closed";
/** 导演三模式:讨论(开演前)/ 剧本(写剧本中)/ 导演(演出中)。 */
export type StageModeDto = "discussion" | "scripting" | "directing";

/** GET /api/stage/:slug 快照(与后端 StageSnapshot 对齐,含角色头像表)。 */
/** 世界书编辑记录(world_update 工具写的 before/after 快照;前端回合结束渲染预览卡)。
 *  before/after 为完整世界数据——diff 由前端 buildWorldDiff 计算(与旧捕获链路同款)。 */
export interface StageWorldEditRecordDto {
	op: string;
	before: WorldDataDto;
	after: WorldDataDto;
	timestamp: number;
}

export interface StageSnapshotDto {
	slug: string;
	/** 归属章节(舞台按章节隔离;null = 书级)。 */
	chapterFile: string | null;
	sceneId: string | null;
	phase: StagePhaseDto;
	status: StageStatusDto;
	mode: StageModeDto;
	script: StageScriptDto | null;
	cast: CastConfigDto;
	transcript: StageEntryDto[];
	counts: StageCountsDto;
	directorLast: string | undefined;
	/** 导演讨论历史(用户/导演消息对,assistant 带思考链与有序块;快照对齐时恢复
	 *  对话气泡与工具块,刷新页面不丢)。 */
	directorChat: SessionMessageDto[];
	/** 角色名 → 世界书条目头像文件(无头像角色前端走首字+角色色兜底)。 */
	avatars: Record<string, string>;
	/** 导演会话上下文占用(供「建议 /compact」提示;无活跃会话/未知时为 null)。 */
	directorUsage: ContextUsageDto | null;
	/** 剧本确认门(2026-08-11):导演已提交待确认的剧本;null = 无待确认。
	 *  confirmed: false 待确认 / true 已确认待开演(短暂态,导演 stage_script 后清空)。 */
	pendingScript: { sceneId: string; script: StageScriptDto; confirmed: boolean } | null;
}

/** 常驻编剧会话状态(与后端 src/web/writer-host.ts 的 WriterState 对齐)。 */
export interface WriterStateDto {
	bookSlug: string;
	/** 最近一次对话声明的章节会话文件 basename(无则 null)。 */
	chapterFile: string | null;
	/** 会话文件是否已创建(未对话过的书无会话)。 */
	exists: boolean;
	isStreaming: boolean;
	messages: SessionMessageDto[];
}

/** 用户自定义主题(资产文件:主题目录下的 *.css)。 */
export interface UserThemeInfo {
	/** 文件名(含 .css)。 */
	file: string;
	/** CSS 原文。 */
	css: string;
}

/** 主题清单:内置(web/public|dist/themes 资产,零 ts 注册)与用户(~/.pi/writer/themes)。 */
export interface ThemeManifest {
	user: UserThemeInfo[];
	builtin: UserThemeInfo[];
}

/** 插件列表项(/api/plugins;与服务端 PluginRuntimeInfo 对齐)。 */
export interface PluginInfoDto {
	id: string;
	name: string;
	version: string;
	description?: string;
	/** plugin.json 声明禁用(作者级;用户侧无法启用)。 */
	manifestDisabled: boolean;
	/** 用户级启用(plugin-state.json;缺省 true)。 */
	enabled: boolean;
	/** 用户级完全信任(缺省 false;开启解锁后端路由 + 前端 JS)。 */
	trusted: boolean;
	/** 装载期错误(null = 正常)。 */
	error: string | null;
	/** 入口文件绝对路径(展示/调试用)。 */
	path: string;
	/** 声明式前端贡献(设置菜单 schema / 斜杠命令 / 前端 JS 入口)。 */
	frontend?: {
		slashCommands?: Array<{ trigger: string; hint: string }>;
		ui?: { settingsItems?: PluginSettingsItemDto[] };
		/** 前端 JS 入口(相对插件目录;仅 trusted 加载)。 */
		frontend?: string;
	};
}

/** 设置字段类型白名单(与 src/plugins.ts 对齐)。 */
export type PluginSettingsFieldType = "string" | "number" | "boolean" | "select" | "textarea";

/** 设置字段声明(schema 项)。 */
export interface PluginSettingsFieldDto {
	key: string;
	label: string;
	type: PluginSettingsFieldType;
	desc?: string;
	default?: string | number | boolean;
	options?: Array<{ value: string; label: string }>;
}

/** 设置菜单区块(标题 + 描述 + 字段组)。 */
export interface PluginSettingsItemDto {
	title: string;
	description?: string;
	fields: PluginSettingsFieldDto[];
}

// —— 专注写作台 workspace 类型(前端本地模型,不与后端字段对齐)——

/** CodeMirror 选区快照:编剧「选中文本自动填入」所需的纯文本信息(书/文件/章节归属
 *  用于跨书同名文件区分与过期校验)。 */
export interface TextSelectionSnapshot {
	/** 选区起点(字符偏移,含)。 */
	from: number;
	/** 选区终点(字符偏移,不含);零宽选区等于 from。 */
	to: number;
	/** 选中文本(零宽选区为空串)。 */
	text: string;
	/** 所属书 slug(跨书同名文件必须区分,防旧书选区写入新书)。 */
	slug: string;
	/** 所属正文文件(仓库相对路径,如 draft/ch01.md)。 */
	file: string;
	/** 所属章节会话文件 basename。 */
	chapterFile: string;
}

/** 正文保存状态:加载中 / 已保存 / 未保存 / 保存中 / 保存失败。 */
export type DraftStatus = "loading" | "saved" | "dirty" | "saving" | "save-error";

/** 服务端 /api/providers 返回的 provider 条目(与 server 侧 ProviderListItem 形状对齐)。 */
export interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	authKind: "api_key" | "oauth" | "both" | "ambient";
	source?: string;
	label?: string;
}

/** 模型条目最小形状(vendor Model 字段子集;来源 /api/providers/:id,不按认证过滤)。 */
export interface ModelDto {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

/** /api/providers/:id 详情:基本信息 + 该 provider 全量模型列表。 */
export interface ProviderDetailDto {
	provider: ProviderInfo & { baseUrl?: string };
	models: ModelDto[];
}

/**
 * 首次启动配置向导状态(与 src/setup.ts 的 SetupState 对齐;存服务端
 * ~/.pi/writer/setup.json,跨窗口/跨浏览器一致)。
 */
export interface SetupStateDto {
	version: number;
	/** 完成时间(ISO 8601);null = 未完成。 */
	completedAt: string | null;
	/** 各步骤是否真正走过(跳过向导时全 false)。 */
	steps: {
		intro: boolean;
		provider: boolean;
		model: boolean;
		book: boolean;
		prefs: boolean;
	};
}

/** MCP 服务器配置条目(与 src/mcp/config.ts 的 McpServerConfig 对齐)。 */
export interface McpServerInfo {
	name: string;
	type: "stdio" | "sse" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
}

/** /api/mcp 返回的连接状态(与 src/mcp/manager.ts 的 McpServerStatus 对齐)。 */
export interface McpServerStatus {
	name: string;
	type: "stdio" | "sse" | "http";
	ok: boolean;
	tools: number;
	error?: string;
}

// —— 工作区(书目录文件清单与预览;与 src/book-files.ts 对齐,只读) ——

/** 工作区分组 id(草稿 / 资料与笔记 / 图片 / 其他)。 */
export type BookFileGroupDto = "draft" | "notes" | "image" | "other";

/** 文件可渲染类型:text 走 markdown,image 走 <img>,binary 只给元信息。 */
export type BookFileKindDto = "text" | "image" | "binary";

/** 分组元信息(标签与说明由服务端给,前端只渲染)。 */
export interface BookFileGroupInfoDto {
	id: BookFileGroupDto;
	label: string;
	description: string;
}

/** 一个工作区文件条目。 */
export interface BookFileEntryDto {
	/** 书目录相对路径(posix 分隔符),如 "draft/ch01.md"。 */
	path: string;
	name: string;
	/** 行内展示名(草稿 = 章节标题;服务端给)。 */
	title: string;
	group: BookFileGroupDto;
	kind: BookFileKindDto;
	bytes: number;
	/** 最后修改时间(ms)。 */
	mtime: number;
	/** 草稿组:所属章节 id;其余为 null。 */
	chapterId: string | null;
	/** 草稿组:章节标题(未登记时回退章节 id)。 */
	chapterTitle: string | null;
}

/** GET /api/books/:slug/files 响应。 */
export interface BookFilesDto {
	slug: string;
	groups: BookFileGroupInfoDto[];
	files: BookFileEntryDto[];
}

/** GET /api/books/:slug/file 的文本响应(图片直接回字节流,不走这里)。 */
export interface BookFileTextDto {
	path: string;
	kind: BookFileKindDto;
	bytes: number;
	mtime: number;
	text: string;
	/** 是否因超过上限被截断。 */
	truncated: boolean;
}
