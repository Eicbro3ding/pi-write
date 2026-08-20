import { Type } from "typebox";

/**
 * Stage（舞台区）数据结构定义。
 *
 * 约定（2026-08-09 缓存讨论定稿）：
 * - 舞台转录（stage.jsonl）追加式，历史行绝不动；
 * - 剧本（scene.json）版本化，`/revise` 生成新版本并把旧版本快照进 `previous`；
 * - 定义段 = 选角 + 上下文注入声明 + 演出规则（阈值/轮转）。
 *
 * 运行时校验用手写守卫（typebox 1.3.7 无 Value.Check）；TypeBox schema 保留
 * 供 stage_script 工具参数复用。
 */

/** 演员类型：named=绑定角色的专属演员；pool=无名槽位（群演，幕内注入角色卡）；narrator=叙述者/场景描写。 */
export type ActorKind = "named" | "pool" | "narrator";

export interface ActorSpec {
	id: string;
	type: ActorKind;
	/** named 演员绑定的角色名（与 characters.md 对应）。 */
	character?: string;
	/** 演员级模型覆盖（缺省用全局 --model/设置默认）。 */
	model?: string;
	/** 演员级思考级别覆盖。 */
	thinking?: string;
	/** 演员级采样温度（0..2）。 */
	temperature?: number;
	/** 演员级核采样概率（0..1）。 */
	topP?: number;
}

/** 演员池编制（cast.json）。池是上限不是常驻：角色没上过场不建会话。 */
export interface CastConfig {
	version: number;
	actors: ActorSpec[];
}

/** 单个角色的上下文注入声明：注入哪些角色卡/世界书条目 + token 预算。 */
export interface InjectRule {
	characters?: string[];
	world?: string[];
	/**
	 * 显式禁止注入的节点（设计预留，未实现——见设计文档 §5.1 后续讨论；
	 * include-only 已天然隔离，没指定=不知道）。
	 */
	exclude?: string[];
	budget: number;
}

/** 演出规则：对话条数阈值 + 收尾窗口 + 轮转方式。 */
export interface SceneRules {
	minLines: number;
	maxLines: number;
	wrapUpWindow: number;
	turn: "round-robin";
}

/** 剧本定义段：选角表（actor id → 该演员饰演的角色，一幕一人一角）+ 注入声明 + 规则。 */
export interface ScriptDefinition {
	cast: Record<string, string[]>;
	inject: Record<string, InjectRule>;
	rules: SceneRules;
}

/** 剧本共享段：场景意象/本幕任务/节拍（事件序列）/基调/禁区。 */
export interface SharedText {
	setting: string;
	goal: string;
	beats: string[];
	tone: string;
	forbidden: string[];
}

/** 剧本单演员段：角色任务（斯坦尼式欲望）/本幕状态/关系/说话方式/边界/风格示例。 */
export interface ActorText {
	objective: string;
	state?: string;
	relation?: string;
	voice?: string;
	boundary?: string;
	/** 风格演示 2-3 轮；禁止与剧情重复、演员禁止复述、不进舞台转录。 */
	examples: string[];
}

/** 剧本文字段：shared 全员可见 + perActor 定向演出指令。 */
export interface ScriptText {
	shared: SharedText;
	perActor: Record<string, ActorText>;
}

/** 剧本（scene.json）。version 每 `/revise` 递增；previous 保留上一版快照以支持回退重演。 */
export interface SceneScript {
	scene: string;
	chapter: string;
	version: number;
	definition: ScriptDefinition;
	text: ScriptText;
	previous?: {
		version: number;
		text: ScriptText;
		rules: SceneRules;
		at: number;
	};
}

/** 舞台区单条记录（stage.jsonl 一行）。character 是编剧聚合与导演注入的关键索引。 */
export interface StageEntry {
	id: string;
	scene: string;
	turn: number;
	actor: string;
	character: string;
	content: Array<{ type: "text"; text: string }>;
	ts: number;
}

/** 舞台状态：normal=正常轮转；wrapping=收尾提示中；closed=收幕。 */
export type StageStatus = "normal" | "wrapping" | "closed";

/** 场景状态机阶段（编排器侧）。 */
export type ScenePhase = "idle" | "casting" | "running" | "wrapping" | "closed";

/** 剧本修改补丁（/revise 语义：字段级合并——改一处不动其余；数组字段整体替换）。 */
export interface ScriptPatch {
	text?: {
		shared?: Partial<SharedText>;
		perActor?: Record<string, Partial<ActorText>>;
	};
	rules?: Partial<Pick<SceneRules, "minLines" | "maxLines" | "wrapUpWindow">>;
}

/** 导演三模式：讨论（开演前）/ 剧本（写剧本中，可主动进入）/ 导演（演出途中与用户讨论）。 */
export type DirectorMode = "discussion" | "scripting" | "directing";

// ---- TypeBox 镜像（供 stage_script 工具参数与未来校验复用） ----

export const ActorSpecSchema = Type.Object({
	id: Type.String(),
	type: Type.Union([Type.Literal("named"), Type.Literal("pool"), Type.Literal("narrator")]),
	character: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	temperature: Type.Optional(Type.Number()),
	topP: Type.Optional(Type.Number()),
});

export const CastConfigSchema = Type.Object({
	version: Type.Integer(),
	actors: Type.Array(ActorSpecSchema),
});

export const SceneRulesSchema = Type.Object({
	minLines: Type.Integer(),
	maxLines: Type.Integer(),
	wrapUpWindow: Type.Integer(),
	turn: Type.Literal("round-robin"),
});

export const SceneScriptSchema = Type.Object({
	scene: Type.String(),
	chapter: Type.String(),
	version: Type.Integer(),
	definition: Type.Object({
		cast: Type.Record(Type.String(), Type.Array(Type.String())),
		inject: Type.Record(
			Type.String(),
			Type.Object({
				characters: Type.Optional(Type.Array(Type.String())),
				world: Type.Optional(Type.Array(Type.String())),
				budget: Type.Integer(),
			}),
		),
		rules: SceneRulesSchema,
	}),
	text: Type.Object({
		shared: Type.Object({
			setting: Type.String(),
			goal: Type.String(),
			beats: Type.Array(Type.String()),
			tone: Type.String(),
			forbidden: Type.Array(Type.String()),
		}),
		perActor: Type.Record(
			Type.String(),
			Type.Object({
				objective: Type.String(),
				state: Type.Optional(Type.String()),
				relation: Type.Optional(Type.String()),
				voice: Type.Optional(Type.String()),
				boundary: Type.Optional(Type.String()),
				examples: Type.Array(Type.String()),
			}),
		),
	}),
});

export const StageEntrySchema = Type.Object({
	id: Type.String(),
	scene: Type.String(),
	turn: Type.Integer(),
	actor: Type.String(),
	character: Type.String(),
	content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
	ts: Type.Integer(),
});
