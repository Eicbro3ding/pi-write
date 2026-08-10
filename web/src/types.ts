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

/** 会话状态快照(后端 session-host getState())。 */
export interface SessionState {
	bookSlug: string | null;
	chapterFile: string | null;
	isStreaming: boolean;
	/**
	 * 会话历史,用于前端聊天水合(openBook / SSE onopen 对齐)。
	 * id 是会话 entry 稳定 id(编辑/分支定位依据);timestamp 同 entry。
	 */
	messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: string; id?: string }>;
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
export interface WorldConstraintDto { id: string; name: string; text: string; enabled: boolean; }
export interface StyleSampleDto { text: string; source: string; updatedAt: number; }
export interface NoticeDto { text: string; enabled: boolean; updatedAt: number; }
export interface StoryNodeDto { id: string; title: string; status: "pending" | "in-progress" | "done" | "shelved"; goal: string; next: string | null; }
export interface StorylineDto { enabled: boolean; nodes: StoryNodeDto[]; }
export interface TimelineEventDto { id: string; chapter: string; text: string; }
export interface WorldDataDto {
	version: 1;
	entries: WorldEntryDto[];
	relations: WorldRelationDto[];
	constraints: WorldConstraintDto[];
	styleSample: StyleSampleDto | null;
	notice: NoticeDto;
	storyline: StorylineDto;
	timeline: TimelineEventDto[];
}

/** 会话视图中的一条聊天消息。 */
export interface ChatMessage {
	id: string;
	/** 会话 entry 稳定 id(服务端下发的编辑/分支定位依据;实时消息在 message_end 时补上)。 */
	entryId?: string;
	role: "user" | "assistant";
	/** 已累积的文本内容。 */
	text: string;
	/** 已累积的思考内容(assistant 的 thinking 块/thinking_delta;无则空串)。 */
	thinking: string;
	/** 消息是否已结束(收到 message_end)。 */
	done: boolean;
	/** 该消息触发的工具调用卡片。 */
	toolCalls: ToolCallInfo[];
}

/** 工具调用卡片。 */
export interface ToolCallInfo {
	id: string;
	name: string;
	/** 序列化后的调用参数(字符串原样,对象 JSON.stringify)。 */
	args: string;
	/** 执行结果文本;未结束为 null。 */
	result: string | null;
	/** 是否执行出错。 */
	isError: boolean;
}

/** 会话视图状态(由 SSE 事件 reducer 纯函数维护)。 */
export interface SessionViewState {
	messages: ChatMessage[];
	isStreaming: boolean;
	/** 上下文压缩中(自动/手动触发):对话末尾显示「正在压缩上下文」提示。 */
	compacting: boolean;
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
	| { type: "message_start"; message: { role: string; content?: unknown }; entryId?: string }
	| {
			type: "message_update";
			message: Record<string, unknown>;
			assistantMessageEvent?: { type: string; delta?: string; contentIndex?: number };
	  }
	| { type: "message_end"; message: Record<string, unknown>; entryId?: string }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
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
	// 舞台区事件(server 广播,字段与 src/web/stage-host.ts 的 StageHostEvent 对齐)
	| { type: "stage_entry"; slug: string; entry: StageEntryDto }
	| { type: "stage_system"; slug: string; text: string }
	| { type: "stage_done"; slug: string; cmd: string; ok: boolean; text?: string; thinking?: string }
	// 导演工具调用(预览卡:world_update/write/edit 的 start/end,前端捕获 before/after)
	| { type: "stage_tool_start"; slug: string; toolCallId: string; toolName: string; args?: unknown }
	| { type: "stage_tool_end"; slug: string; toolCallId: string; toolName: string; isError?: boolean }
	// 导演回复流式(完整文本):前端以完整文本替换流式导演气泡,stage_done 定稿
	| { type: "stage_director_text"; slug: string; text: string }
	// 常驻编剧事件(server 广播 writer_event,内层是主会话同款会话事件——
	// 前端复用 processAgentEvent 归约,消息/思考/工具卡片零新逻辑)
	| { type: "writer_event"; slug: string; event: WriterSessionEventDto };

/** 常驻编剧会话事件(主会话事件的子集,全部可被 processAgentEvent 处理)。 */
export type WriterSessionEventDto =
	| Extract<AgentEventDto, { type: "message_start" }>
	| Extract<AgentEventDto, { type: "message_update" }>
	| Extract<AgentEventDto, { type: "message_end" }>
	| Extract<AgentEventDto, { type: "tool_execution_start" }>
	| Extract<AgentEventDto, { type: "tool_execution_end" }>
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
export interface StageSnapshotDto {
	slug: string;
	sceneId: string | null;
	phase: StagePhaseDto;
	status: StageStatusDto;
	mode: StageModeDto;
	script: StageScriptDto | null;
	cast: CastConfigDto;
	transcript: StageEntryDto[];
	counts: StageCountsDto;
	directorLast: string | undefined;
	/** 导演讨论历史(用户/导演消息对,assistant 带思考链;快照对齐时恢复对话气泡,刷新页面不丢)。 */
	directorChat: Array<{ role: "user" | "assistant"; text: string; thinking?: string }>;
	/** 角色名 → 世界书条目头像文件(无头像角色前端走首字+角色色兜底)。 */
	avatars: Record<string, string>;
}

/** 常驻编剧会话状态(与后端 src/web/writer-host.ts 的 WriterState 对齐)。 */
export interface WriterStateDto {
	bookSlug: string;
	/** 最近一次对话声明的章节会话文件 basename(无则 null)。 */
	chapterFile: string | null;
	/** 会话文件是否已创建(未对话过的书无会话)。 */
	exists: boolean;
	isStreaming: boolean;
	messages: Array<{ role: "user" | "assistant"; text: string; thinking?: string; timestamp?: string; id?: string }>;
}

// —— 专注写作台 workspace 类型(前端本地模型,不与后端字段对齐)——

/** CodeMirror 选区快照:编剧「选中文本自动填入」与正文安全编辑所需的纯文本信息。 */
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

/** 一次已应用(或待撤回)的文本编辑记录。 */
export interface AppliedEdit {
	/** 编辑所在的正文文件。 */
	file: string;
	/** 编辑所在的章节会话文件。 */
	chapterFile: string;
	/** 编辑前的完整文档。 */
	beforeText: string;
	/** 编辑后的完整文档。 */
	afterText: string;
	/** 编辑区间起点。 */
	from: number;
	/** 编辑区间终点(insert 模式等于 from)。 */
	to: number;
	/** 被替换的原文(insert 模式为空串)。 */
	replacedText: string;
	/** 插入的文本。 */
	insertedText: string;
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
