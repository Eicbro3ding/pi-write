import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "./pi-adapter/index.ts";
import { Type, type TSchema } from "typebox";
import { cjkCount } from "./cjk.ts";
import { ensureWorld, newId, saveWorld, shortId, validateWorld, writeWorldEditRecord, WorldValidationError, type ConstraintTarget, type EntryStatus, type EntryType, type NoticeItem, type RelationArrow, type StoryNode, type StoryNodeStatus, type WorldData, type WorldEntry } from "./world-data.ts";
import { toolGuardContext } from "./tool-guard.ts";
import { withWorldLock } from "./world-lock.ts";
import { classifyBookFileKind, MAX_READ_BYTES, readWorkspaceText } from "./book-files.ts";

/**
 * 把「判别联合」(Type.Union of Type.Object,以 op 字面量区分)压平成**单一对象** schema:
 * 合并所有分支的字段,非 op 字段一律 optional,op 收成枚举。
 *
 * 为什么:world_update / style_update 原本把 op 联合直接当工具参数暴露,JSON Schema 是一段
 * 约 7KB 的 anyOf。pi 运行时用 typebox 校验工具入参,"第一个分支"的 required 会成为模型的
 * 心智负担——实机表现为「op 常量与字段不符」以及「关系操作被 upsert_entry 的 title/type 卡住」
 * (2026-10-02 用户反馈)。压平后模型看到的是普通对象,必填性改由 narrowOp 按 op 在运行时兜底,
 * 报错信息也直接回给模型自我纠正(比 typebox 的英文 anyOf 报错更有指导性)。
 */
function flattenOpUnion(union: TSchema): TSchema {
	const members = (union as { anyOf?: TSchema[] }).anyOf ?? [];
	const props: Record<string, TSchema> = {};
	const ops: string[] = [];
	for (const m of members) {
		const member = m as { properties?: Record<string, TSchema> };
		for (const [key, schema] of Object.entries(member.properties ?? {})) {
			if (key === "op") {
				const c = (schema as { const?: unknown }).const;
				if (typeof c === "string") ops.push(c);
			} else if (!(key in props)) {
				props[key] = Type.Optional(schema);
			}
		}
	}
	return Type.Object({ op: Type.String({ enum: ops, description: "操作类型(见工具说明)" }), ...props });
}

/** 从判别联合提取「每个 op 的必填字段」,让运行时校验复用 schema 这唯一真相源。 */
function requiredFieldsByOp(union: TSchema): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const m of (union as { anyOf?: TSchema[] }).anyOf ?? []) {
		const member = m as { required?: string[]; properties?: Record<string, TSchema> };
		const op = (member.properties?.op as { const?: unknown } | undefined)?.const;
		if (typeof op === "string") out[op] = member.required ?? [];
	}
	return out;
}

/**
 * 按 op 收窄工具入参:压平 schema 丢掉了「哪个字段属于哪个 op」的必填约束,这里补回来。
 * 缺字段/未知 op 抛 WorldValidationError(报错原样进模型上下文,让它下一轮自我纠正,
 * 而不是写坏数据或静默无操作)。
 */
function narrowOp<T>(raw: unknown, required: Record<string, string[]>, label: string): T {
	if (typeof raw !== "object" || raw === null) throw new WorldValidationError(`${label} 的 update 必须是对象`);
	const op = (raw as { op?: unknown }).op;
	const names = Object.keys(required).join(" / ");
	if (typeof op !== "string" || op.length === 0) {
		throw new WorldValidationError(`${label} 缺少 op;可用操作: ${names}`);
	}
	const fields = required[op];
	if (!fields) throw new WorldValidationError(`${label} 不支持的 op: ${op};可用操作: ${names}`);
	const missing = fields.filter((f) => f !== "op" && (raw as Record<string, unknown>)[f] === undefined);
	if (missing.length > 0) throw new WorldValidationError(`${label} 的 ${op} 缺少必填参数: ${missing.join(" / ")}`);
	return raw as T;
}

/**
 * 工具解析相对路径的基准目录。会话创建时由 createRuntime 工厂注入
 * (cli.ts / web.ts 的 cwd = 书目录),避免误用服务进程的 process.cwd()
 * (web 模式服务从项目根启动,相对路径会解析到错误位置)。
 */
let wordCountCwd: string | null = null;

/** 设置工具路径基准(会话书目录);null 回退 process.cwd()。 */
export function setWordCountCwd(dir: string | null): void {
	wordCountCwd = dir;
}

/** 当前路径基准:SessionHost 的 ALS 上下文优先,其次工厂注入值,最后进程 cwd(与旧行为一致)。 */
function cwdBase(): string {
	return toolGuardContext.getStore()?.bookDir ?? wordCountCwd ?? process.cwd();
}

const COUNT_METRICS = ["cn_chars", "en_words", "sentences", "paragraphs"] as const;
type CountMetric = (typeof COUNT_METRICS)[number];

// 用 string + enum 而不是 Type.Union([Type.Literal...]):后者渲染成 anyOf,
// 受限解码 / 只读首分支的 provider 会把它塌成 "cn_chars" 一种(与 world_update 同源问题)。
const CountModeEnum = Type.String({ enum: [...COUNT_METRICS, "all"] });

interface FileCounts {
	cnChars: number;
	enWords: number;
	sentences: number;
	paragraphs: number;
}

/** 英文词字符:ASCII 字母/数字 + Latin-1 补充 + Latin Extended-A。 */
function isWordChar(code: number): boolean {
	return (
		(code >= 0x41 && code <= 0x5a) || // A-Z
		(code >= 0x61 && code <= 0x7a) || // a-z
		(code >= 0x30 && code <= 0x39) || // 0-9
		(code >= 0xc0 && code <= 0xff) || // Latin-1 补充(é ü ñ 等)
		(code >= 0x100 && code <= 0x17f) // Latin Extended-A(ā ō 等)
	);
}

/**
 * 英文词计数:连续词字符为词;词内撇号(' 或 ')后跟词字符时不视为分隔
 * (don't、l'école)。手写扫描而非 `\p{L}` 正则:Android(nodejs-mobile)
 * 无 full ICU,`\p{` 正则禁用(2026-08-10 修复)。希腊/西里尔等字母未覆盖
 * (中文写作场景英文词基本为 ASCII)。
 */
function countEnglishWords(text: string): number {
	let words = 0;
	let inWord = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (isWordChar(code)) {
			inWord = true;
			continue;
		}
		if (inWord && (code === 0x27 || code === 0x2019) && isWordChar(text.charCodeAt(i + 1))) {
			continue;
		}
		if (inWord) {
			words++;
			inWord = false;
		}
	}
	if (inWord) words++;
	return words;
}

/**
 * 统计一段文本的字/词/句/段。
 *
 * 导出原因(2026-10-04):`tool_result` 钩子要在每次 write/edit 之后把字数
 * 附在工具返回值里(见 write-rails-extension.ts),需要复用同一套
 * 计数口径 —— 两处口径一旦分叉,AI 看到的字数与实际落盘内容会对不上。
 */
export function countText(text: string): FileCounts {
	// CJK 计数统一在 cjk.ts(码点范围含 Ext A/Compat,不用 \p{ 正则)
	const cnChars = cjkCount(text);
	let enWords = 0;
	let sentences = 0;
	let paragraphs = 0;

	const paras = text
		.split(/\r?\n\s*\r?\n/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	paragraphs = paras.length;

	const sentenceRuns = text.match(/[.。!！?？]+/g);
	sentences = sentenceRuns ? sentenceRuns.length : 0;

	enWords = countEnglishWords(text);

	return { cnChars, enWords, sentences, paragraphs };
}

/** 读文件并计数(供 read_chapter 头部与 write/edit 后的字数钩子共用)。 */
export async function readCountsForFile(filePath: string): Promise<FileCounts> {
	const content = await readFile(filePath, "utf-8");
	return countText(content);
}

export type WorldUpdateOp =
	| { op: "upsert_entry"; id?: string; type: EntryType; title: string; keys?: string[]; chapters?: string[]; status?: EntryStatus; parent?: string | null; body?: string; avatar?: string | null; images?: string[] }
	| { op: "delete_entry"; id: string }
	| { op: "set_status"; id: string; status: EntryStatus }
	| { op: "append_timeline"; chapter?: string; text: string }
	| { op: "update_timeline"; id: string; chapter?: string; text?: string }
	| { op: "delete_timeline"; id: string }
	| { op: "update_notice"; enabled?: boolean }
	| { op: "notice_append"; text: string }
	| { op: "notice_update"; id: string; text?: string }
	| { op: "notice_set_done"; id: string; done: boolean }
	| { op: "notice_delete"; id: string }
	| { op: "advance_storyline"; id: string; status: StoryNodeStatus; next?: string | null }
	| { op: "upsert_storyline_node"; id?: string; title: string; status?: StoryNodeStatus; goal?: string; next?: string | null }
	| { op: "delete_storyline_node"; id: string }
	| { op: "upsert_constraint"; id?: string; name: string; text: string; enabled?: boolean; target?: ConstraintTarget }
	| { op: "delete_constraint"; id: string }
	| { op: "update_style_sample"; text: string; source?: string }
	| { op: "set_world_summary"; text: string }
	| { op: "upsert_relation"; id?: string; from: string; to: string; type?: string; label?: string; emphasized?: boolean; arrow?: RelationArrow }
	| { op: "delete_relation"; id: string };

/** world_update 的操作联合(schema 唯一真相源;对外暴露的是压平版 WORLD_UPDATE_FLAT)。 */
const WORLD_UPDATE_UNION = Type.Union([
	Type.Object({ op: Type.Literal("upsert_entry"), id: Type.Optional(Type.String()), type: Type.String(), title: Type.String(), keys: Type.Optional(Type.Array(Type.String())), chapters: Type.Optional(Type.Array(Type.String())), status: Type.Optional(Type.String()), parent: Type.Optional(Type.Union([Type.String(), Type.Null()])), body: Type.Optional(Type.String()), avatar: Type.Optional(Type.Union([Type.String(), Type.Null()])), images: Type.Optional(Type.Array(Type.String())) }),
	Type.Object({ op: Type.Literal("delete_entry"), id: Type.String() }),
	Type.Object({ op: Type.Literal("set_status"), id: Type.String(), status: Type.String() }),
	Type.Object({ op: Type.Literal("append_timeline"), chapter: Type.Optional(Type.String()), text: Type.String() }),
	Type.Object({ op: Type.Literal("update_timeline"), id: Type.String(), chapter: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
	Type.Object({ op: Type.Literal("delete_timeline"), id: Type.String() }),
	Type.Object({ op: Type.Literal("update_notice"), enabled: Type.Optional(Type.Boolean()) }),
	Type.Object({ op: Type.Literal("notice_append"), text: Type.String() }),
	Type.Object({ op: Type.Literal("notice_update"), id: Type.String(), text: Type.Optional(Type.String()) }),
	Type.Object({ op: Type.Literal("notice_set_done"), id: Type.String(), done: Type.Boolean() }),
	Type.Object({ op: Type.Literal("notice_delete"), id: Type.String() }),
	Type.Object({ op: Type.Literal("advance_storyline"), id: Type.String(), status: Type.String(), next: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
	Type.Object({ op: Type.Literal("upsert_storyline_node"), id: Type.Optional(Type.String()), title: Type.String(), status: Type.Optional(Type.String()), goal: Type.Optional(Type.String()), next: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
	Type.Object({ op: Type.Literal("delete_storyline_node"), id: Type.String() }),
	Type.Object({ op: Type.Literal("upsert_constraint"), id: Type.Optional(Type.String()), name: Type.String(), text: Type.String(), enabled: Type.Optional(Type.Boolean()), target: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("director"), Type.Literal("writer"), Type.Literal("all")])) }),
	Type.Object({ op: Type.Literal("delete_constraint"), id: Type.String() }),
	Type.Object({ op: Type.Literal("update_style_sample"), text: Type.String(), source: Type.Optional(Type.String()) }),
	Type.Object({ op: Type.Literal("set_world_summary"), text: Type.String() }),
	Type.Object({ op: Type.Literal("upsert_relation"), id: Type.Optional(Type.String()), from: Type.String(), to: Type.String(), type: Type.Optional(Type.String()), label: Type.Optional(Type.String()), emphasized: Type.Optional(Type.Boolean()), arrow: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("single"), Type.Literal("double")])) }),
	Type.Object({ op: Type.Literal("delete_relation"), id: Type.String() }),
]);

/** 送给 LLM 的 world_update.update 参数 schema(压平,无 anyOf)。 */
const WORLD_UPDATE_FLAT = flattenOpUnion(WORLD_UPDATE_UNION);

/** op → 必填字段,从 WORLD_UPDATE_UNION 派生,避免两处手写漂移。 */
const WORLD_UPDATE_REQUIRED = requiredFieldsByOp(WORLD_UPDATE_UNION);

/** 校验并收窄 world_update 入参;缺字段/未知 op 抛 WorldValidationError。 */
export function normalizeWorldUpdate(raw: unknown): WorldUpdateOp {
	return narrowOp<WorldUpdateOp>(raw, WORLD_UPDATE_REQUIRED, "world_update");
}

/**
 * `style_update`(编剧窄工具)的操作集:**只碰写作风格三件套**
 * (写作约束 / 文风采样 / 世界观概述),碰不到条目、关系、时间线、大纲、发展线、Notice。
 *
 * 为什么存在:常驻编剧(`writer-editor.md`)只有只读的 world_find,世界书归导演维护。
 * 结果是用户在编辑页说「以后别用破折号」时,编剧只能把结论写进 advice.md 等导演下次开会话
 * 才落盘——一个"设了但不生效"的体验(2026-10-01)。给它一条**窄通道**而不是放开
 * `world_update` 全量权限:风格是编剧的本职,人物/关系/时间线仍然只有导演能改。
 *
 * 两处与 world_update 不同的语义:
 * 1. **新建的约束写 target="writer"**——编剧只约束自己(成文与编辑页对话),不替导演立规;
 *    要约束导演得用户直接对导演讲(它有全量 world_update)。**但既有约束保留原 target**:
 *    2026-10-11 修的 bug —— 此前一律写 writer,于是编剧重述一条 `target: all` 的规矩,
 *    会把它**静默缩窄**成只管编剧,导演与主会话从此看不到(用户看到的症状是
 *    「这规矩怎么时灵时不灵」)。
 * 2. **按名字 upsert / 删除**——注入给编剧的【写作约束】块只有 `名字: 正文`,没有 id,
 *    所以不能要求模型先查 id;同名即更新,避免重复立规矩。
 */
export type StyleUpdateOp =
	| { op: "upsert_constraint"; name: string; text: string; enabled?: boolean }
	| { op: "set_constraint_enabled"; name: string; enabled: boolean }
	| { op: "delete_constraint"; name: string }
	| { op: "update_style_sample"; text: string; source?: string }
	| { op: "set_world_summary"; text: string };

/** style_update 的操作联合(schema 唯一真相源;对外暴露的是压平版 STYLE_UPDATE_FLAT)。 */
const STYLE_UPDATE_UNION = Type.Union([
	Type.Object({ op: Type.Literal("upsert_constraint"), name: Type.String(), text: Type.String(), enabled: Type.Optional(Type.Boolean()) }),
	Type.Object({ op: Type.Literal("set_constraint_enabled"), name: Type.String(), enabled: Type.Boolean() }),
	Type.Object({ op: Type.Literal("delete_constraint"), name: Type.String() }),
	Type.Object({ op: Type.Literal("update_style_sample"), text: Type.String(), source: Type.Optional(Type.String()) }),
	Type.Object({ op: Type.Literal("set_world_summary"), text: Type.String() }),
]);

/** 送给 LLM 的 style_update.update 参数 schema(压平,无 anyOf)。 */
const STYLE_UPDATE_FLAT = flattenOpUnion(STYLE_UPDATE_UNION);

const STYLE_UPDATE_REQUIRED = requiredFieldsByOp(STYLE_UPDATE_UNION);

/** 校验并收窄 style_update 入参;缺字段/未知 op 抛 WorldValidationError。 */
export function normalizeStyleUpdate(raw: unknown): StyleUpdateOp {
	return narrowOp<StyleUpdateOp>(raw, STYLE_UPDATE_REQUIRED, "style_update");
}

/**
 * 应用一次写作风格更新(纯函数,复用 applyWorldUpdate 的引擎与校验)。
 * 名字未命中删除目标时抛 WorldValidationError,并提示模型去看注入的约束块。
 */
export function applyStyleUpdate(data: WorldData, update: StyleUpdateOp): WorldData {
	switch (update.op) {
		case "upsert_constraint": {
			const existing = data.constraints.find((c) => c.name === update.name);
			return applyWorldUpdate(data, {
				op: "upsert_constraint",
				...(existing ? { id: existing.id } : {}),
				name: update.name,
				text: update.text,
				// 用户重述一条已有规矩 = 它现在生效;缺省置 true(界面上手动停用的会被重新启用)
				enabled: update.enabled ?? true,
				// 作用域:既有约束**保留原 target**(见 StyleUpdateOp 的注释 —— 一律写
				// writer 会把用户的 all/director 规矩静默缩窄);只有新建才默认 writer。
				// 注意 target 传 undefined 时 applyWorldUpdate 不动该字段,正是这里要的语义。
				...(existing ? {} : { target: "writer" as const }),
			});
		}
		case "set_constraint_enabled": {
			// 单独切开关(2026-10-11 补):此前唯一入口是 upsert_constraint,而它**必填 text**
			// —— 模型想「先停用这条规矩」就得把正文再抄一遍,抄错就把规矩改了。
			// 这里只动 enabled,正文与作用域原样带回去。
			const existing = data.constraints.find((c) => c.name === update.name);
			if (!existing) {
				throw new WorldValidationError(
					`没有名为「${update.name}」的写作约束。现有约束见上下文【写作约束】块,按那里的名字改。`,
				);
			}
			return applyWorldUpdate(data, {
				op: "upsert_constraint",
				id: existing.id,
				name: existing.name,
				text: existing.text,
				enabled: update.enabled,
			});
		}
		case "delete_constraint": {
			const existing = data.constraints.find((c) => c.name === update.name);
			if (!existing) {
				throw new WorldValidationError(
					`没有名为「${update.name}」的写作约束。现有约束见上下文【写作约束】块,按那里的名字删。`,
				);
			}
			return applyWorldUpdate(data, { op: "delete_constraint", id: existing.id });
		}
		case "update_style_sample":
			// 空采样一律拒绝(2026-10-05)。采样是**作者文风基准**,是本产品最核心的
			// 用户资产之一,而这条 op 是它唯一的写入路径、且刻意不写编辑记录(见
			// world_update 的 last-world-edit 说明)—— 前端连预览卡都不弹。模型一旦
			// 传空(常见于它以为自己拿到了内容、实际拼出空串),采样就静默归零,
			// 用户要过很久才发现「AI 写得不像我了」。
			//
			// 注意这不是「禁止清空」:要清空采样是合法意图,但那应当由用户明确要求,
			// 而不是模型一次参数失误的副作用 —— 真有此需求让用户直接改 world.json。
			// 读侧(read_style)已为「没有采样」写了护栏,这里把写侧补上,两侧对称。
			if (update.text.trim().length === 0) {
				throw new WorldValidationError(
					"update_style_sample 的 text 是空的 —— 文风采样是作者文风基准,空值会把它清掉,而这条写入不产生编辑记录。若你确实没有采样内容:①向用户要一段他写的文字(300–500 字)再存;②用户说「先按你判断的写」时照你已掌握的调性写,并在回复里说明语感是你暂定的。不要用空串占位。",
				);
			}
			return applyWorldUpdate(data, { op: "update_style_sample", text: update.text, source: update.source });
		case "set_world_summary":
			return applyWorldUpdate(data, { op: "set_world_summary", text: update.text });
	}
}

/** 按传入字段更新条目(仅覆盖显式提供的字段,其余保留);更新 updatedAt。 */function updateEntryFields(e: WorldEntry, update: Extract<WorldUpdateOp, { op: "upsert_entry" }>, now: number): void {
	if (update.title !== undefined) e.title = update.title;
	if (update.type !== undefined) e.type = update.type;
	if (update.keys !== undefined) e.keys = update.keys;
	if (update.chapters !== undefined) e.chapters = update.chapters;
	if (update.status !== undefined) e.status = update.status;
	if (update.parent !== undefined) e.parent = update.parent;
	if (update.body !== undefined) e.body = update.body;
	if (update.avatar !== undefined) e.avatar = update.avatar;
	if (update.images !== undefined) e.images = update.images;
	e.updatedAt = now;
}

/**
 * next 若填的是已有节点 id,自动替换为该节点标题再落库(填 id 是直觉,
 * 但落库统一存标题,避免提示词里反复警告「不要填 id」)。
 */
function resolveNextTitle(data: WorldData, next: string | null): string | null {
	if (!next) return next;
	const node = data.storyline.nodes.find((n) => n.id === next);
	return node ? node.title : next;
}

/** 关系目标解析结果:id 为落库用的条目 id,title 供成功回显(教学回路)。 */
export interface RelationTargetResolved {
	id: string;
	title: string;
}

/**
 * 解析关系 from/to 目标:优先按条目 id 精确匹配,未命中再按标题精确匹配
 * (与 upsert_entry 的标题定位语义一致)。容错规则(格式宽容、歧义严格):
 * - 命中唯一 → 用
 * - 标题命中多个 → 报错列出全部候选 id,要求用 id 消歧(静默取首个 =
 *   写错关系不吭声,LLM 场景最贵的失败)
 * - 零命中 → 报错明确说明「id 与标题均未命中」,提示检查拼写/用 world_find
 *   查 id——不把参数错误伪装成条目缺失
 */
function resolveRelationTarget(data: WorldData, value: string, field: "from" | "to"): RelationTargetResolved {
	const byId = data.entries.find((e) => e.id === value);
	if (byId) return { id: byId.id, title: byId.title };
	const byTitle = data.entries.filter((e) => e.title === value);
	if (byTitle.length === 1) return { id: byTitle[0]!.id, title: byTitle[0]!.title };
	if (byTitle.length > 1) {
		throw new WorldValidationError(
			`${field} 标题「${value}」匹配到 ${byTitle.length} 个条目(${byTitle.map((e) => e.id).join("/")}),请用 world_find 查询后用 id 消歧`,
		);
	}
	throw new WorldValidationError(
		`${field} 未匹配到条目: ${value}(既不是任何条目的 id,标题也未命中——请检查拼写,或用 world_find 查询 id 后传入)`,
	);
}

/** 纯函数应用一次更新;返回新 WorldData,非法抛 WorldValidationError。 */
export function applyWorldUpdate(data: WorldData, update: WorldUpdateOp): WorldData {
	const next: WorldData = structuredClone(data);
	const now = Date.now();
	switch (update.op) {
		case "upsert_entry": {
			// 真 upsert 语义:带 id 时查不到就用该 id 创建;不带 id 时按 (type, title)
			// 匹配已有条目(存在则更新、保留原 id),都不命中才新建。
			if (update.id) {
				const e = next.entries.find((x) => x.id === update.id);
				if (e) {
					updateEntryFields(e, update, now);
				} else {
					next.entries.push({
						id: update.id,
						type: update.type,
						title: update.title,
						keys: update.keys ?? [],
						chapters: update.chapters ?? [],
						status: update.status ?? "active",
						active: true,
						parent: update.parent ?? null,
						tags: [],
						body: update.body ?? "",
						avatar: update.avatar ?? null,
						images: update.images ?? [],
						updatedAt: now,
					});
				}
			} else {
				const byTitle = next.entries.find((x) => x.type === update.type && x.title === update.title);
				if (byTitle) {
					updateEntryFields(byTitle, update, now);
				} else {
					next.entries.push({
						id: newId("entry"),
						type: update.type,
						title: update.title,
						keys: update.keys ?? [],
						chapters: update.chapters ?? [],
						status: update.status ?? "active",
						active: true,
						parent: update.parent ?? null,
						tags: [],
						body: update.body ?? "",
						avatar: update.avatar ?? null,
						images: update.images ?? [],
						updatedAt: now,
					});
				}
			}
			break;
		}
		case "delete_entry": {
			const e = next.entries.find((x) => x.id === update.id);
			if (!e) throw new WorldValidationError(`条目不存在: ${update.id}`);
			if (next.relations.some((r) => r.from === update.id || r.to === update.id)) {
				throw new WorldValidationError(`条目 ${update.id} 仍被关系引用,请先删除相关关系`);
			}
			next.entries = next.entries.filter((x) => x.id !== update.id);
			next.entries.forEach((x) => { if (x.parent === update.id) x.parent = null; });
			break;
		}
		case "set_status": {
			const e = next.entries.find((x) => x.id === update.id);
			if (!e) throw new WorldValidationError(`条目不存在: ${update.id}`);
			e.status = update.status;
			e.updatedAt = now;
			break;
		}
		case "append_timeline":
			next.timeline.push({ id: newId("evt"), chapter: update.chapter ?? "", text: update.text });
			break;
		case "update_timeline": {
			const ev = next.timeline.find((x) => x.id === update.id);
			if (!ev) throw new WorldValidationError(`时间线事件不存在: ${update.id}`);
			// 只传 id 是空操作:明确报错,提示至少提供一个可改字段
			if (update.text === undefined && update.chapter === undefined) {
				throw new WorldValidationError(`时间线事件 ${update.id} 至少要提供 text 或 chapter 之一(只传 id 没有可更新内容)`);
			}
			if (update.chapter !== undefined) ev.chapter = update.chapter;
			if (update.text !== undefined) ev.text = update.text;
			break;
		}
		case "delete_timeline": {
			const idx = next.timeline.findIndex((x) => x.id === update.id);
			if (idx === -1) throw new WorldValidationError(`时间线事件不存在: ${update.id}`);
			next.timeline.splice(idx, 1);
			break;
		}
		case "update_notice":
			// 开关(备忘录整体注入开关;待办条目走 notice_* 系列)
			if (update.enabled !== undefined) next.notice.enabled = update.enabled;
			break;
		case "notice_append":
			// 追加一条未完成待办(备忘录)
			next.notice.items.push({ id: newId("ntc"), text: update.text, done: false, updatedAt: now });
			break;
		case "notice_update": {
			const it = next.notice.items.find((x) => x.id === update.id);
			if (!it) throw new WorldValidationError(`Notice 待办不存在: ${update.id}`);
			if (update.text !== undefined) it.text = update.text;
			it.updatedAt = now;
			break;
		}
		case "notice_set_done": {
			const it = next.notice.items.find((x) => x.id === update.id);
			if (!it) throw new WorldValidationError(`Notice 待办不存在: ${update.id}`);
			it.done = update.done;
			it.updatedAt = now;
			break;
		}
		case "notice_delete": {
			// 存在性校验(2026-10-05):原先直接 filter,传错 id 是**静默无操作** ——
			// 工具回「已更新世界书」,模型以为删掉了、用户还看见那条待办。
			// 与 notice_update / notice_set_done 的口径对齐,也符合本文件的
			// 「不静默无操作,报错原样进上下文让模型自我纠正」(见 narrowOp 注释)。
			const it = next.notice.items.find((x) => x.id === update.id);
			if (!it) throw new WorldValidationError(`Notice 待办不存在: ${update.id}(未删除任何内容)`);
			next.notice.items = next.notice.items.filter((x) => x.id !== update.id);
			break;
		}
		case "advance_storyline": {
			// 指认口径与 storyline_update.advance 统一(2026-10-13):完整 id / 短编号 /
			// 唯一前缀 / 节点标题都认(见下方 resolveByIdOrName),解析不到**一律报错**。
			//
			// **不再「查不到就按该 id 新建节点」** —— 那是 2026-08-10 起的老语义(注释原文
			// 「以 id 为标题兜底」),当时没有 upsert_storyline_node,advance 兼着建节点的活。
			// 如今建节点有专门通道,而这套兜底与 2026-10-11 起的注入块相撞:注入块把节点写成
			// 短编号(`[9f2k1x] 初入旧城`),模型抄下来调 advance 就成了「幽灵节点(id = "9f2k1x")
			// 诞生 + 真节点纹丝不动」的静默污染 —— 正是同文件 delete_storyline_node /
			// notice_delete 特意防的那件事(传错 id 不许静默无操作)。要新建节点请用
			// upsert_storyline_node。
			//
			// 注:STORY_NODE_REF / resolveByIdOrName 定义在文件后半(编剧窄通道一处),
			// 运行时模块已求值完,无 TDZ 问题;共享定义是为了口径不分叉。
			const n = resolveByIdOrName(next.storyline.nodes, update.id, STORY_NODE_REF);
			n.status = update.status;
			if (update.next !== undefined) n.next = resolveNextTitle(next, update.next);
			break;
		}
		case "upsert_storyline_node": {
			// 无 id 创建新节点;带 id 更新已有节点(不存在则创建)
			if (update.id) {
				const n = next.storyline.nodes.find((x) => x.id === update.id);
				if (n) {
					if (update.title !== undefined) n.title = update.title;
					if (update.status !== undefined) n.status = update.status;
					if (update.goal !== undefined) n.goal = update.goal;
					if (update.next !== undefined) n.next = resolveNextTitle(next, update.next);
				} else {
					next.storyline.nodes.push({ id: update.id, title: update.title, status: update.status ?? "pending", goal: update.goal ?? "", next: update.next === undefined ? null : resolveNextTitle(next, update.next) });
				}
			} else {
				next.storyline.nodes.push({ id: newId("story"), title: update.title, status: update.status ?? "pending", goal: update.goal ?? "", next: update.next === undefined ? null : resolveNextTitle(next, update.next) });
			}
			break;
		}
		case "delete_storyline_node": {
			// 与 notice_delete / delete_constraint 同口径:传错 id 不许静默无操作
			// (模型会据此以为「已删除」继续推理)。2026-10-11 补:此前发展线只能增改不能删,
			// 一个建错的节点只能让用户去界面上删。
			const n = next.storyline.nodes.find((x) => x.id === update.id);
			if (!n) throw new WorldValidationError(`发展线节点不存在: ${update.id}(未删除任何内容)`);
			next.storyline.nodes = next.storyline.nodes.filter((x) => x.id !== update.id);
			// 有其他节点的 next 指向它时留原文(那只是描述文本,悬空无害)——与删除条目的
			// 悬空关系校验不同,这里的 next 不参与结构校验,故不做级联。
			break;
		}
		case "upsert_constraint": {
			if (update.id) {
				const c = next.constraints.find((x) => x.id === update.id);
				if (!c) throw new WorldValidationError(`约束不存在: ${update.id}`);
				c.name = update.name;
				c.text = update.text;
				if (update.enabled !== undefined) c.enabled = update.enabled;
				if (update.target !== undefined) c.target = update.target;
			} else {
				next.constraints.push({ id: newId("cst"), name: update.name, text: update.text, enabled: update.enabled ?? true, ...(update.target !== undefined ? { target: update.target } : {}) });
			}
			break;
		}
		case "delete_constraint": {
			// 同 notice_delete:原先 filter 掉一个不存在的 id 也不吭声,
			// 模型据此以为「约束已删除」继续推理,而用户那边规矩还在。
			const c = next.constraints.find((x) => x.id === update.id);
			if (!c) throw new WorldValidationError(`约束不存在: ${update.id}(未删除任何内容)`);
			next.constraints = next.constraints.filter((x) => x.id !== update.id);
			break;
		}
		case "update_style_sample":
			next.styleSample = { text: update.text, source: update.source ?? "", updatedAt: now };
			break;
		case "set_world_summary":
			// 简要世界观概述:覆盖写(限长由 validateWorld 兜底)
			next.worldSummary = update.text;
			break;
		case "upsert_relation": {
			// from/to 容错:接受条目 id 或标题——先按 id 精确匹配,未命中按标题
			// 精确匹配;标题命中多个条目时报错要求用 id 消歧(不静默取首个)。
			// 落库统一存解析后的 id(validateWorld 的悬空引用/自环校验照常生效)。
			const from = resolveRelationTarget(next, update.from, "from");
			const to = resolveRelationTarget(next, update.to, "to");
			if (update.id) {
				const r = next.relations.find((x) => x.id === update.id);
				if (!r) throw new WorldValidationError(`关系不存在: ${update.id}`);
				r.from = from.id;
				r.to = to.id;
				if (update.type !== undefined) r.type = update.type;
				if (update.label !== undefined) r.label = update.label;
				if (update.emphasized !== undefined) r.emphasized = update.emphasized;
				if (update.arrow !== undefined) r.arrow = update.arrow;
			} else {
				// 语义冲突:已存在方向相反的同一条关系(from/to 互换)时,不静默新建
				// 第二条——提示 LLM 决定(带 id 更新现有,或先删除再显式新建)
				const reversed = next.relations.find((r) => r.from === to.id && r.to === from.id);
				if (reversed) {
					throw new WorldValidationError(
						`已存在方向相反的关系 ${reversed.id}(${from.title} ← ${to.title});如需更新请带 id=${reversed.id} 调用 upsert_relation,确需新建请先 delete_relation 删除该关系`,
					);
				}
				next.relations.push({
					id: newId("rel"), from: from.id, to: to.id,
					type: update.type ?? "", label: update.label ?? "",
					emphasized: update.emphasized ?? false,
					arrow: update.arrow ?? "double",
				});
			}
			break;
		}
		case "delete_relation": {
			// 同 delete_constraint / notice_delete:原先 filter 掉一个不存在的 id 也不吭声,
			// 模型据此以为「关系已删除」继续推理,而用户那边关系还在。
			const rel = next.relations.find((x) => x.id === update.id);
			if (!rel) throw new WorldValidationError(`关系不存在: ${update.id}(未删除任何内容)`);
			next.relations = next.relations.filter((x) => x.id !== update.id);
			break;
		}
	}
	return validateWorld(next);
}

/** world_update 工具执行所需的书目录基准(仿 setWordCountCwd)。 */
let worldUpdateBookDir: string | null = null;
export function setWorldUpdateBookDir(dir: string | null): void { worldUpdateBookDir = dir; }

/** 当前会话的书目录:SessionHost ALS 上下文优先,其次工厂注入值(见 session-factory)。 */
export function bookDirBase(): string | null {
	return toolGuardContext.getStore()?.bookDir ?? worldUpdateBookDir;
}

/**
 * world_find —— 只读检索世界书条目(不改数据)。三种用法共用一个入口:
 *
 *  1. **定位**(默认,`detail: "brief"`):按标题/类型/触发词/子串过滤,回 id —— 供
 *     `world_update` 的 id 类操作(delete_entry/set_status/关系、约束等)定位。LLM 列不出 id,
 *     以前只能 read 整个 world.json 自己翻。
 *  2. **阅读**(`detail: "full"`):同上过滤,但**附带条目正文**。此前没有任何工具能给到条目
 *     正文(world_find 不给、read_style 只给采样),要正文就得把整本世界书读进上下文。
 *  3. **核对**(`scan: "<一段正文>"`):把写好的正文递进来,工具扫出其中**被提及**的条目
 *     (按各条自己的标题/触发词做子串命中),回正文 + 命中词,供模型核对「文里写的」与
 *     「设定里的」有没有出入。
 *
 * 为什么核对要做成工具、而不是让模型自己抽词:模型会漏掉次要人物与地名。工具做的是
 * **确定性穷举** —— 凡是登记过标题或触发词、又出现在这段文字里的条目,一条都跑不掉。
 * 但工具只负责**捞候选 + 给命中依据**(命中了哪个词),相关性判断仍归模型。
 *
 * 扫描只认「标题 / 触发词」两种提法(不扫条目正文 —— 正文子串匹配噪声太大),且短于
 * MIN_SCAN_TERM_LEN 的词不参与(单字会满篇乱撞)。
 */
const MIN_SCAN_TERM_LEN = 2;
/** scan / detail:full 单条正文的截断上限(够核对用,避免一次撑爆上下文)。 */
const FIND_BODY_LIMIT = 2000;
/** scan 模式最多回报的条目数(再多就不像「一段正文里的提及」了)。 */
const SCAN_HIT_LIMIT = 20;

/** 结果里单条目的摘要行(定位用)。 */
function entryHeadline(e: WorldEntry): string {
	return `- ${e.id} [${e.type}] ${e.title}${e.status !== "active" ? ` (${e.status})` : ""}`;
}

/** 正文截断:带明示,别让模型把读到的半截当成全文。 */
function clipEntryBody(body: string): string {
	const t = body.trim();
	if (t.length <= FIND_BODY_LIMIT) return t;
	return `${t.slice(0, FIND_BODY_LIMIT)}…(已截断,全文 ${t.length} 字)`;
}

/** 一条目的扫描词表:标题 + 触发词;去重,过短的不参与(见 MIN_SCAN_TERM_LEN)。 */
function scanTermsOf(e: WorldEntry): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of [e.title, ...e.keys]) {
		const t = raw.trim();
		if (t.length < MIN_SCAN_TERM_LEN || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

/**
 * world_find 的 details 形状。两个返回分支**必须同形** —— 否则返回类型会被推断成互斥
 * 联合,过不了 ToolDefinition 的 details 参数(与 read_style 两分支同形是同一个理由)。
 */
interface WorldFindDetails {
	mode: string;
	detail: string;
	count: number;
	found: Array<{ id: string; type: string; title: string; status: string; terms: string[] }>;
}

export const worldFindTool: ToolDefinition = defineTool({
	name: "world_find",
	label: "World Find",
	description: [
		"只读检索世界书条目(不改数据),三种用法:",
		"①定位(默认)——按 title(精确)/type/keys(精确)/query(子串)过滤,回 id/type/title/status,供 world_update 的 id 类操作(delete_entry、set_status、关系、约束等)定位;type 枚举 character/world/timeline/outline。",
		'②阅读——加 detail:"full",同上再回条目正文(此前没有任何工具能读到条目正文,要正文只能整本读 world.json)。',
		'③核对——加 scan:"<一段正文>",工具扫出这段文字里被提及的条目(按各条的标题/触发词命中,英文不区分大小写),回它们的正文与命中词。写完一章正文后用它核对设定有无出入,比凭记忆靠谱。给了 scan 时其余过滤参数忽略。',
	].join(" "),
	parameters: Type.Object({
		title: Type.Optional(Type.String({ description: "按标题精确匹配(省略则不过滤)" })),
		type: Type.Optional(Type.String({ description: "按类型过滤(character/world/timeline/outline)" })),
		keys: Type.Optional(Type.Array(Type.String(), { description: "按触发关键词精确匹配(任一命中即匹配)" })),
		query: Type.Optional(Type.String({ description: "子串模糊匹配:标题或触发词里含该串即命中(英文不区分大小写);与 title/type/keys 是「与」关系" })),
		detail: Type.Optional(Type.String({ enum: ["brief", "full"], description: "brief(默认)只回元信息;full 附带条目正文" })),
		scan: Type.Optional(Type.String({ description: "一致性核对:传一段正文,扫出其中被提及的条目并回其正文与命中词;给了它则忽略其它过滤参数" })),
		limit: Type.Optional(Type.Number({ description: "返回条数上限(1-100,默认 20)" })),
	}),
	async execute(_callId, params) {
		const dir = bookDirBase();
		if (!dir) throw new Error("world_find 未配置书目录");
		const world = await ensureWorld(dir);
		const limit = Math.max(1, Math.min(100, params.limit ?? 20));

		// —— 核对模式:传进来一段文本,扫出其中被提及的条目 ——
		const scanText = typeof params.scan === "string" ? params.scan : "";
		if (scanText.trim().length > 0) {
			// 大小写不敏感(2026-10-13 修):与 query 分支同口径 —— 英文条目名在正文里
			// 大小写一变(Alice / alice)就扫不到,而那本是同一件事。中文无大小写,
			// toLowerCase 对它是恒等变换。
			const haystack = scanText.toLowerCase();
			const hits = world.entries
				.map((e) => ({ entry: e, terms: scanTermsOf(e).filter((t) => haystack.includes(t.toLowerCase())) }))
				.filter((h) => h.terms.length > 0);
			const shown = hits.slice(0, Math.min(limit, SCAN_HIT_LIMIT));
			const blocks = shown.map((h) => {
				const body = clipEntryBody(h.entry.body);
				return `${entryHeadline(h.entry)}\n  命中:「${h.terms.join("」「")}」\n  正文: ${body || "(该条目没有正文)"}`;
			});
			// 零命中也要给出去路(护栏的一贯做法):光回一个「无」会让模型把「没扫到」
			// 当成「一致」——那是两回事,不说清就会静默放过。
			const header = hits.length > 0
				? `这段文字里提及 ${hits.length} 条世界书条目${hits.length > shown.length ? `(只回前 ${shown.length} 条)` : ""} —— 请逐条核对:文中的描写与下面设定是否一致(身份、状态、关系、时间线、外貌);有出入就说明并按需用 world_update 更正。`
				: "没有扫到任何已登记条目 —— 这不等于「一致」,只说明这段文字里没出现任何条目的标题或触发词(短于 2 字的标题不参与扫描)。若觉得该有,可再用 query 或标题片段复查一次。";
			const details: WorldFindDetails = {
				mode: "scan",
				detail: "full",
				count: hits.length,
				found: shown.map((h) => ({ id: h.entry.id, type: h.entry.type, title: h.entry.title, status: h.entry.status, terms: h.terms })),
			};
			return { content: [{ type: "text", text: `${header}\n${blocks.join("\n")}` }], details };
		}

		// —— 过滤模式:定位(detail=brief)/ 阅读(detail=full) ——
		const full = params.detail === "full";
		let entries = world.entries;
		if (params.title !== undefined && params.title.length > 0) {
			entries = entries.filter((e) => e.title === params.title);
		}
		if (params.type !== undefined && params.type.length > 0) {
			entries = entries.filter((e) => e.type === params.type);
		}
		const keys = (params.keys ?? []).filter((k) => k.length > 0);
		if (keys.length > 0) {
			entries = entries.filter((e) => keys.some((k) => e.keys.includes(k)));
		}
		const query = (params.query ?? "").trim().toLowerCase();
		if (query.length > 0) {
			entries = entries.filter(
				(e) => e.title.toLowerCase().includes(query) || e.keys.some((k) => k.toLowerCase().includes(query)),
			);
		}
		const found = entries.slice(0, limit);
		const lines = found.map((e) =>
			full ? `${entryHeadline(e)}\n  正文: ${clipEntryBody(e.body) || "(无)"}` : entryHeadline(e),
		);
		const details: WorldFindDetails = {
			mode: "filter",
			detail: full ? "full" : "brief",
			count: entries.length,
			found: found.map((e) => ({ id: e.id, type: e.type, title: e.title, status: e.status, terms: [] })),
		};
		return {
			content: [
				{
					type: "text",
					text: `匹配 ${entries.length} 条${entries.length > found.length ? `,显示前 ${found.length}` : ""}:\n${lines.join("\n") || "(无)"}`,
				},
			],
			details,
		};
	},
});

/**
 * read_chapter —— 一次读完整个正文文件(内置 read 做不到这件事)。
 *
 * 为什么需要(2026-10-04):pi 内置 `read` 的默认上限是 2000 行 / 50KB,超限
 * 即截断,并在描述里写明「需要全文就带 offset 继续读」。这个假设来自代码库
 * 场景(一个文件通常只看片段),在写作场景里是反的 —— 一章 8000 字的正文正好
 * 卡在截断线上,模型读到的半章里如果恰好没有它要找的细节,它会(1) 以为自己
 * 看到了全文,或 (2) 干脆放弃改去猜。两种情况都直接伤害写作质量,而且故障是
 * 静默的:模型不会报告"我没读完",它只是基于残缺文本开始动笔。
 *
 * 本工具不做分片:一次给全文(上限 MAX_READ_BYTES = 512KB,远超任何单章)。
 * 真触到 512KB 说明这已经是「一本书塞进一个文件」,那种情况下**显式告知已
 * 截断**比悄悄给半截强 —— 用户和模型都能据此判断该怎么办。
 *
 * 与字数钩子的分工:字数回答「多长」(由 write/edit 的返回值与本章头部自带),
 * read_chapter 回答「写了什么」。
 */
const readChapterParameters = Type.Object({
	path: Type.String({
		description:
			'正文章节文件路径,相对书目录,例如 "draft/ch01.md"。也接受 "ch01",会自动补成 draft/ch01.md。',
	}),
});

/** 把 "ch01" / "draft/ch01" / "draft/ch01.md" 统一成书目录下的相对路径。 */
function normalizeChapterPath(raw: string): string {
	let p = raw.trim().replace(/\\/g, "/");
	if (p.length === 0) return p;
	if (!p.startsWith("draft/")) p = `draft/${p}`;
	if (!p.endsWith(".md")) p = `${p}.md`;
	return p;
}

export const readChapterTool: ToolDefinition = defineTool({
	name: "read_chapter",
	label: "Read Chapter",
	description:
		"读取一整章正文的**全部内容**,一次返回,不会像内置 read 那样在 2000 行处静默截断。改写、续写、审校前应当用这个工具而不是 read。参数 path 相对书目录(如 draft/ch01.md,或直接写 ch01)。返回值开头是文件路径与字数,末尾在超限时明确标注已截断。",
	parameters: readChapterParameters,
	async execute(_callId, params) {
		const dir = bookDirBase();
		if (!dir) throw new Error("read_chapter 未配置书目录");
		const rel = normalizeChapterPath(params.path);
		if (rel.length === 0) throw new Error("read_chapter 需要 path 参数");

		// 路径守卫:只允许读工作区范围内的文本文件(隐藏文件、jsonl、世界书生成物
		// 等一律拒绝,与工作区清单同源 —— 详见 book-files.isWorkspaceFile)
		if (classifyBookFileKind(rel) !== "text") {
			throw new Error(`read_chapter 只读文本文件:${rel}`);
		}
		const file = await readWorkspaceText(dir, rel);
		if (!file) {
			throw new Error(`找不到文件(或不在工作区可读范围内): ${rel}`);
		}

		const counts = countText(file.text);
		// 头部元信息:模型拿到全文后仍需要知道「这是哪个文件、多长」——
		// 尤其续写时要据字数判断节奏,不必再另起一次调用去数。
		const head = `# ${file.path}(${counts.cnChars} 字${counts.paragraphs > 0 ? ` · ${counts.paragraphs} 段` : ""}${file.truncated ? ` · 文件共 ${Math.ceil(file.bytes / 1024)}KB` : ""})`;
		const lines = [head, ""];
		if (file.truncated) {
			// 截断必须显式、必须可操作:告诉模型拿到的是前多少字节,以及为什么被截
			lines.push(
				`> ⚠️ 文件超过 ${Math.round(MAX_READ_BYTES / 1024)}KB 读取上限,以下仅为前 ${Math.round(MAX_READ_BYTES / 1024)}KB(全文 ${Math.ceil(file.bytes / 1024)}KB)。`,
				"",
			);
		}
		lines.push(file.text);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				path: file.path,
				bytes: file.bytes,
				truncated: file.truncated,
				...counts,
			},
		};
	},
});

export const worldUpdateTool: ToolDefinition = defineTool({
	name: "world_update",
	label: "World Update",
	description:
		"更新世界书(world.json):增删改条目、关系、约束、Notice、发展线、采样、简要世界观与时间线。这是修改世界设定的唯一通道;结构性约束(重复 id、悬空引用、多个 in-progress 等)由程序校验。upsert_entry 是真 upsert:带 id 时查不到就按该 id 新建;不带 id 时按 (type, title) 匹配已有条目(存在则更新、保留原 id),都不命中才新建——更新已有条目通常不需要先查 id。关系的 from/to 接受条目 id 或标题(标题自动解析为条目 id;标题匹配到多个条目时返回报错并列出候选 id,请用 world_find 查 id 消歧;成功时返回会回显解析结果 from id(标题) → to id(标题))。枚举只接受英文:type=character/world/timeline/outline;status=alive/dead/unknown/active/archived/draft;关系 arrow=none/single/double;发展线 status=pending/in-progress/done/shelved。注意 status 是条目状态,与条目是否参与上下文注入(active 字段,界面「注入上下文」开关)无关,world_update 不改 active。发展线:节点按数组顺序推进。upsert_storyline_node 创建/更新节点(带 id 时按该 id 更新、查不到则按该 id 新建——id 要写完整,别拿注入块里的短编号当新 id,那会多出一个节点);advance_storyline 推进已有节点的状态,其 id 可填完整 id / 上下文【发展线】块里的短编号 / 节点标题,**查不到一律报错、不再兜底新建**(要建节点用 upsert_storyline_node);delete_storyline_node 删除节点。节点的 next 字段 = 该节点完成后的下一步内容(填标题或描述;也接受已有节点 id,会自动转为该节点标题)。查找条目 id 用 world_find 工具。set_world_summary 覆盖简要世界观概述(常驻注入,每次会话都会读到;建议 1-2 段,≤600 字)。新建条目后若与现有条目存在剧情关联,建议一并创建关系(upsert_relation)。约束的删除(delete_constraint)不可逆:拿不准就 upsert_constraint 带 enabled:false 停用;删用户的规矩只在用户明确要求时做。",
	parameters: Type.Object({
		update: WORLD_UPDATE_FLAT,
	}),
	async execute(_callId, params) {
		const dir = bookDirBase();
		if (!dir) throw new Error("world_update 未配置书目录");
		// 读-改-写整体持锁:并行 world_update(agent 多工具调用)串行执行,
		// 消除丢失更新与共享 tmp 竞态(saveWorld 另以唯一 tmp + 备份兜底)
		return withWorldLock(dir, async () => {
			// 压平 schema 丢掉了「哪个 op 必填哪些字段」,这里按 op 收窄并给出可读报错
			const update = normalizeWorldUpdate(params.update);
			const world = await ensureWorld(dir);
			// 关系回显:解析结果带条目 id 与标题,形成教学回路——LLM 看到
			// 解析后的 id,后续自然改用 id(与 applyWorldUpdate 内同一解析逻辑,
			// 纯函数幂等;歧义/未命中/反向冲突在 applyWorldUpdate 内抛错兜底)
			let echo = "";
			if (update.op === "upsert_relation") {
				const from = resolveRelationTarget(world, update.from, "from");
				const to = resolveRelationTarget(world, update.to, "to");
				echo = `:from ${from.id}(${from.title}) → to ${to.id}(${to.title})`;
			}
			const next = applyWorldUpdate(world, update);
			await saveWorld(dir, next);
			// 世界书编辑记录(内容 tmp、文件不 tmp):before/after 快照落盘,前端
			// 回合结束据此渲染预览卡——diff 在此刻算好,无 before/after 抓取竞态
			try {
				await writeWorldEditRecord(dir, { op: update.op, before: world, after: next, timestamp: Date.now() });
			} catch {
				/* 记录写失败不影响世界书更新(卡片只是展示,world.json 已落盘) */
			}
			// 条目正文被清空时附一行提示(2026-10-05)。
			//
			// 与 writeDeltaLine 同一个思路:**不阻止,但让损失可见**。「把条目正文清空」
			// 本身可能是合法意图(占位条目、废弃设定),硬拦会挡住正常操作;但
			// 非空 → 空 这个跃迁最常见的成因是模型漏带内容 —— 它以为自己写了小传,
			// 实际传了空串,而工具只回「已更新世界书」,看起来完全正常。
			const emptied = emptiedEntryBodies(world, next);
			const notice = emptied.length > 0
				? `\n⚠️ 本次把 ${emptied.map((t) => `「${t}」`).join("、")} 的正文清空了(原非空 → 现为空)。如果这是有意为之就忽略本条;如果不是,你多半漏带了 body —— 用 world_find 复查后再 upsert_entry 补回。`
				: "";
			return {
				content: [{ type: "text", text: `已更新世界书(${update.op})${echo}。${notice}` }],
				details: { op: update.op },
			};
		});
	},
});

/**
 * 找出「正文从非空变成空」的条目(返回标题,供 world_update 附提示行)。
 *
 * 为什么只报「非空 → 空」而不报「本来就空」:前者是**损失**,后者无变化。
 * 为什么用标题而不是 id:提示行是给模型看的,标题是它认识的名字(与 read_chapter
 * 的拦截理由写法一致)。
 */
export function emptiedEntryBodies(before: WorldData, after: WorldData): string[] {
	const byId = new Map(before.entries.map((e) => [e.id, e]));
	const out: string[] = [];
	for (const e of after.entries) {
		const prev = byId.get(e.id);
		if (prev && prev.body.trim().length > 0 && e.body.trim().length === 0) out.push(e.title);
	}
	return out;
}

/**
 * read_style —— 读回文风采样(`style_update` 的**读**对偶)。
 *
 * 为什么需要(2026-10-05):
 *
 *   1. **此前没有任何工具能读到它。** `world_find` 只返回 id/type/title/status
 *      (连条目 body 都不给);采样是 world.json 的**顶层字段**而不是条目,导出视图
 *      `.writer/` 只有 characters / world / timeline 三份 —— 所有「检索条目」的通路
 *      全都够不着它。剩下唯一办法是 `read world.json`,可那会把整本世界书倒进上下文,
 *      比常驻还亏。**又一个 read_chapter 式处境**:东西在数据里,可模型手上没有把柄。
 *
 *   2. **它原先常驻在稳定块里,是版本堆叠的第二大来源。** 稳定块内容一变就重注一份
 *      (见 `writer-host.ts` 的 `countStableContextInLeaf`),而按提示词纪律「采样:
 *      明显变化则换新,从当前章草稿选 300–500 字」—— 也就是**每写一章就可能换一次**,
 *      每换一次多一份。挪出去等于直接削掉一类重注入触发。
 *
 * 与 `style_update` 的分工:那边**写**(也是编剧唯一能改世界书的通道),这边**读**。
 * 两个工具都不碰条目 / 关系 / 时间线,权限边界一致。
 *
 * **没有采样时必须给出去路**(护栏的一贯做法):光回一个「空」的话,模型会以为自己
 * 可以随手起调子,文风就这么飘走了,而且很静默。所以这里把两条出路写死。
 */
export const readStyleTool: ToolDefinition = defineTool({
	name: "read_style",
	label: "Read Style",
	description:
		"读回这本书的**文风采样**(作者文风基准)全文:一段 300–500 字的代表性样本及其标注来源。**动笔写正文前先用这个工具取一次**,照它的语感与句式写;这是你校准风格的唯一依据。与 `style_update` 成对:那边写,这边读。",
	parameters: Type.Object({}),
	async execute(_callId) {
		const dir = bookDirBase();
		if (!dir) throw new Error("read_style 未配置书目录");
		const world = await ensureWorld(dir);
		const sample = world.styleSample;
		const source = sample?.source?.trim() || "";
		// 空采样也要回得像个工具结果 —— 见上方注释「没有采样时必须给出去路」。
		// 两条分支的 details 形状保持一致(source 缺省为空串),否则返回类型会被
		// 推断成互斥的联合、过不了 ToolDefinition 的 details 参数。
		const text = sample && sample.text.trim().length > 0
			? [
					`【文风采样】(来源: ${source || "未标注来源"}${styleSampleAt(sample.updatedAt)}；只模仿语感与句式，不抄写、不复用原文)`,
					sample.text,
				].join("\n")
			: [
					"这本书还没有文风采样 —— 也就没有「作者的语感」可以模仿。两条出路:",
					"①向用户要一段他自己写的文字(300–500 字)当样本,拿到后用 style_update 的 update_style_sample 存下来;",
					"②用户说「先按你判断的写」时,照你已掌握的本书调性写,但要在回复里说明「还没有采样,语感是我暂定的」。",
					"**不要自己编一段、然后声称那是用户写的采样。**",
				].join("\n");
		return {
			content: [{ type: "text", text }],
			details: { hasSample: Boolean(sample && sample.text.trim().length > 0), source },
		};
	},
});

function styleSampleAt(updatedAt: unknown): string {
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) return "";
	return `，更新于 ${new Date(updatedAt).toISOString().slice(0, 10)}`;
}

/**
 * 编剧的写作风格窄通道(见 StyleUpdateOp 的注释:为什么给窄工具而不是放开 world_update)。
 *
 * **不写世界书编辑记录**(`stage/last-world-edit.json`):那个记录只有**舞台页**在消费
 * (StagePage 在舞台流里遇到 world_update 才置 pending),编辑页不读它。编剧写它既没有消费方,
 * 又会在「舞台 pending 已置、编辑页恰好此刻改了风格」的窄窗口里串成一张舞台预览卡。
 * 风格改完的可见反馈走工具结果 + 编剧的一句话确认,够用。
 */
export const styleUpdateTool: ToolDefinition = defineTool({
	name: "style_update",
	label: "Style Update",
	description:
		"更新**写作风格**设定:写作约束(你与成文要遵守的硬规矩)、文风采样(作者文风基准)、简要世界观概述。人物/关系/时间线/大纲你改不了(那些归导演);发展线与 Notice 走 `storyline_update` / `notice_update`。语义:① 约束按**名字** upsert——同名即更新(不会重复立规矩),所以重述一条已有规矩不需要先查 id;**改已有约束会保留它原来的作用域**(只在新建时默认 writer = 只管你自己),要约束导演得用户直接对导演讲。② `set_constraint_enabled` 单独切开关:停用/启用一条规矩而**不动它的正文**,别为了停用而把正文重抄一遍(抄错就把规矩改了)。③ 删除按名字,名字见上下文【写作约束】块(那里没有 id,别去找 id);**删除不可逆,而停用可逆** —— 一条规矩看起来不适用(这一章不需要、与当下写法冲突)时,默认改用「停用」把它留下,只有用户明确说「这条不要了」才删。约束是用户立的规矩,不是你的草稿。④ 约束要**可判定**(「禁用破折号」「每章 2500 字上下」),不要写「文笔要优美」;条数控制在 8 条以内。⑤ update_style_sample 的 text 是 300–500 字的代表性样本(用户自己写的,或他想靠近的片段),**绝不编造**;set_world_summary 是 1-2 句题材与基调定位(常驻注入,≤600 字)。op 名与 world_update 的同名操作一致,便于对照。",
	parameters: Type.Object({
		update: STYLE_UPDATE_FLAT,
	}),
	async execute(_callId, params) {
		const dir = bookDirBase();
		if (!dir) throw new Error("style_update 未配置书目录");
		// 与 world_update 同一把锁:两个工具可能并行调用(agent 一轮多工具),串行化避免丢失更新
		return withWorldLock(dir, async () => {
			const update = normalizeStyleUpdate(params.update);
			const world = await ensureWorld(dir);
			const next = applyStyleUpdate(world, update);
			await saveWorld(dir, next);
			return {
				content: [{ type: "text", text: `已更新写作风格(${update.op})。` }],
				details: { op: update.op },
			};
		});
	},
});

// ——————————————————————————————————————————————————————————————
// 编剧的「发展与备忘」窄通道(2026-10-11)
// ——————————————————————————————————————————————————————————————

/**
 * 解析「编号 / 名称」指认 —— 发展线 / Notice 的**唯一**定位口径。
 *
 * 服务三处:`storyline_update` / `notice_update` 两个窄工具,以及 `world_update`
 * 的 `advance_storyline`(2026-10-13 接入——此前它对查不到的 id 兜底创建节点,
 * 而注入块给的是短编号,模型抄下来推进就长出幽灵节点)。
 *
 * 顺序即优先级(2026-10-11 拍板「编号优先、名字兜底」):
 * ① 完整 id → ② 短编号({@link shortId}) → ③ 唯一前缀 → ④ 精确名称 → ⑤ 唯一子串。
 *
 * 为什么「编号优先」:注入块给的是 `[9f2k1x] 初入旧城`,编号是 id 的一部分 ——
 * **改标题不会让它失效**,而按名字指认有两个陷阱:重名(报错比猜安全)与
 * 「模型只记得大意」(子串恰好命中一条时帮它一把)。
 *
 * **剥方括号**(2026-10-13):注入块把编号写成 `[9f2k1x] 初入旧城`,模型常连方括号
 * 一起抄回来(`[9f2k1x]`)。剥掉再解析,省一轮「报错 → 看候选 → 重发」。
 *
 * 任何一步命中多条都**不静默取首个**,而是报错并列出候选(带短编号)让模型重发 ——
 * 与 resolveRelationTarget 同一条纪律:静默取首个 = 改错对象还不吭声。
 */
function resolveByIdOrName<T>(
	items: readonly T[],
	target: string,
	opts: { idOf: (t: T) => string; nameOf: (t: T) => string; what: string; hint: string },
): T {
	const raw = target.trim();
	// 统一剥掉一层方括号:注入块给的是 `[9f2k1x] 标题`,模型照抄时会带上 `[]`
	const t = raw.length > 2 && raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1).trim() : raw;
	if (t.length === 0) throw new WorldValidationError(`${opts.what}的编号或名称不能为空。${opts.hint}`);
	const label = (x: T): string => `[${shortId(opts.idOf(x))}] ${opts.nameOf(x)}`;

	const byId = items.filter((x) => opts.idOf(x) === t);
	if (byId.length === 1) return byId[0]!;
	const byShort = items.filter((x) => shortId(opts.idOf(x)) === t);
	if (byShort.length === 1) return byShort[0]!;
	// 前缀:模型只抄了编号前几位、或补进完整 id 的前段。只在唯一命中时采纳,
	// 否则继续往下走名称通路(名称那边可能正好是它想找的那条)。
	// **至少 3 位**才认前缀 —— 一个字符的前缀在 6 位短编号上几乎必然命中,
	// 那不是「指认」而是抽签(静默改错对象最贵)。
	const byPrefix = t.length >= 3
		? items.filter((x) => {
				const id = opts.idOf(x);
				return id.startsWith(t) || shortId(id).startsWith(t);
			})
		: [];
	if (byPrefix.length === 1) return byPrefix[0]!;

	const exact = items.filter((x) => opts.nameOf(x) === t);
	if (exact.length === 1) return exact[0]!;
	const pool = exact.length > 1 ? exact : items.filter((x) => opts.nameOf(x).includes(t));
	if (pool.length === 1) return pool[0]!;
	const candidates = (pool.length > 1 ? pool : items).slice(0, 20).map(label);
	throw new WorldValidationError(
		`没有唯一匹配「${t}」的${opts.what}${pool.length > 1 ? `(匹配到 ${pool.length} 条)` : ""}。${opts.hint}` +
			(candidates.length > 0 ? `当前${opts.what}列表: ${candidates.join("、")}` : `当前还没有任何${opts.what}。`),
	);
}

/**
 * `storyline_update` 的操作集:增删改**发展线**节点(写正文前定目标、写完一幕推进它)。
 *
 * 为什么单开一个窄工具而不是放开 `world_update`(2026-10-11):常驻编剧手上只有
 * `style_update`,发展线是**它在写作过程中最常需要动的东西**(写完一幕就该推进目标),
 * 而它此前只能把"下一章该推进到哪"写进 advice.md 等导演开会话 —— 与 2026-10-01
 * 约束那条断链完全同型。放开的仍是**窄**通道:人物/关系/时间线/大纲照旧归导演。
 *
 * `target` 可以是短编号 / 完整 id / 节点标题(见 {@link resolveByIdOrName}),
 * 因为注入的【发展线】块里两者都带着(`[9f2k1x] 初入旧城`)。
 */
export type StorylineUpdateOp =
	| { op: "upsert_node"; target?: string; title?: string; status?: StoryNodeStatus; goal?: string; next?: string | null }
	| { op: "advance"; target: string; status: StoryNodeStatus; next?: string | null }
	| { op: "delete_node"; target: string };

const STORYLINE_UPDATE_UNION = Type.Union([
	Type.Object({ op: Type.Literal("upsert_node"), target: Type.Optional(Type.String()), title: Type.Optional(Type.String()), status: Type.Optional(Type.String()), goal: Type.Optional(Type.String()), next: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
	Type.Object({ op: Type.Literal("advance"), target: Type.String(), status: Type.String(), next: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
	Type.Object({ op: Type.Literal("delete_node"), target: Type.String() }),
]);

const STORYLINE_UPDATE_FLAT = flattenOpUnion(STORYLINE_UPDATE_UNION);
const STORYLINE_UPDATE_REQUIRED = requiredFieldsByOp(STORYLINE_UPDATE_UNION);

/** 校验并收窄 storyline_update 入参;缺字段/未知 op 抛 WorldValidationError。 */
export function normalizeStorylineUpdate(raw: unknown): StorylineUpdateOp {
	return narrowOp<StorylineUpdateOp>(raw, STORYLINE_UPDATE_REQUIRED, "storyline_update");
}

/** 发展线节点的指认口径(两个 op 共用,免得两处各写一遍措辞)。 */
const STORY_NODE_REF = {
	idOf: (n: StoryNode) => n.id,
	nameOf: (n: StoryNode) => n.title,
	what: "发展线节点",
	hint: "编号见上下文【发展线】块里的 [xxxxxx];也可以填节点标题(唯一匹配才生效)。",
};

/** 应用一次发展线更新(纯函数,复用 applyWorldUpdate 的引擎与校验)。 */
export function applyStorylineUpdate(data: WorldData, update: StorylineUpdateOp): WorldData {
	switch (update.op) {
		case "upsert_node": {
			const target = (update.target ?? "").trim();
			if (target.length === 0) {
				// 不给指认 = 新建;此时 title 必填(否则新节点没有名字)
				if (!update.title || update.title.trim().length === 0) {
					throw new WorldValidationError(
						"新增发展线节点必须给 title;要改已有节点就把它的编号填进 target(见上下文【发展线】块)。",
					);
				}
				return applyWorldUpdate(data, {
					op: "upsert_storyline_node",
					title: update.title,
					status: update.status,
					goal: update.goal,
					next: update.next,
				});
			}
			const node = resolveByIdOrName(data.storyline.nodes, target, STORY_NODE_REF);
			// 只指认不修改 = 空操作;报错而不是静默成功(模型会据此以为改写成功了)
			if (update.title === undefined && update.status === undefined && update.goal === undefined && update.next === undefined) {
				throw new WorldValidationError(
					`发展线节点 [${shortId(node.id)}] ${node.title} 至少要给出 title / status / goal / next 之一(只指认节点,没有可改的内容)。`,
				);
			}
			return applyWorldUpdate(data, {
				op: "upsert_storyline_node",
				id: node.id,
				title: update.title ?? node.title,
				status: update.status,
				goal: update.goal,
				next: update.next,
			});
		}
		case "advance": {
			// 推进状态:不需要重抄标题(那正是 upsert_node 的负担所在)
			const node = resolveByIdOrName(data.storyline.nodes, update.target, STORY_NODE_REF);
			return applyWorldUpdate(data, {
				op: "upsert_storyline_node",
				id: node.id,
				title: node.title,
				status: update.status,
				next: update.next,
			});
		}
		case "delete_node": {
			const node = resolveByIdOrName(data.storyline.nodes, update.target, STORY_NODE_REF);
			return applyWorldUpdate(data, { op: "delete_storyline_node", id: node.id });
		}
	}
}

/**
 * `notice_update` 的操作集:增删改**Notice 备忘录**(待办清单:伏笔、待补的细节、
 * 提醒自己别忘的事)。
 *
 * 定位口径与 development 线同款,只是「名称」对 Notice 而言就是它的**文本**
 * (Notice 条目没有标题)。文本匹配同样只在**唯一**命中时生效:待办条目常是
 * 「补写第三章的雨夜」这类长句,模型只记得片段,允许子串命中;但命中两条以上
 * 一律报错列候选,不猜。
 */
export type NoticeUpdateOp =
	| { op: "append"; text: string }
	| { op: "edit"; target: string; text: string }
	| { op: "set_done"; target: string; done: boolean }
	| { op: "delete"; target: string }
	| { op: "set_enabled"; enabled: boolean };

const NOTICE_UPDATE_UNION = Type.Union([
	Type.Object({ op: Type.Literal("append"), text: Type.String() }),
	Type.Object({ op: Type.Literal("edit"), target: Type.String(), text: Type.String() }),
	Type.Object({ op: Type.Literal("set_done"), target: Type.String(), done: Type.Boolean() }),
	Type.Object({ op: Type.Literal("delete"), target: Type.String() }),
	Type.Object({ op: Type.Literal("set_enabled"), enabled: Type.Boolean() }),
]);

const NOTICE_UPDATE_FLAT = flattenOpUnion(NOTICE_UPDATE_UNION);
const NOTICE_UPDATE_REQUIRED = requiredFieldsByOp(NOTICE_UPDATE_UNION);

/** 校验并收窄 notice_update 入参;缺字段/未知 op 抛 WorldValidationError。 */
export function normalizeNoticeUpdate(raw: unknown): NoticeUpdateOp {
	return narrowOp<NoticeUpdateOp>(raw, NOTICE_UPDATE_REQUIRED, "notice_update");
}

/** Notice 条目的指认口径(「名称」= 待办文本)。 */
const NOTICE_ITEM_REF = {
	idOf: (i: NoticeItem) => i.id,
	nameOf: (i: NoticeItem) => i.text,
	what: "Notice 待办",
	hint: "编号见上下文【Notice·备忘录】块里的 [xxxxxx];也可以填待办原文(唯一匹配才生效)。",
};

/** 文本类入参的非空校验:空串一律拒绝,别让「改没了」变成静默损失。 */
function requireNoticeText(text: string, what: string): string {
	if (text.trim().length === 0) {
		throw new WorldValidationError(`${what}的 text 是空的 —— 空文本会把待办内容清掉。若确实要清掉这条,用 delete。`);
	}
	return text;
}

/** 应用一次 Notice 更新(纯函数,复用 applyWorldUpdate 的引擎与校验)。 */
export function applyNoticeUpdate(data: WorldData, update: NoticeUpdateOp): WorldData {
	switch (update.op) {
		case "append":
			return applyWorldUpdate(data, { op: "notice_append", text: requireNoticeText(update.text, "notice_update append") });
		case "edit": {
			const it = resolveByIdOrName(data.notice.items, update.target, NOTICE_ITEM_REF);
			return applyWorldUpdate(data, { op: "notice_update", id: it.id, text: requireNoticeText(update.text, "notice_update edit") });
		}
		case "set_done": {
			const it = resolveByIdOrName(data.notice.items, update.target, NOTICE_ITEM_REF);
			return applyWorldUpdate(data, { op: "notice_set_done", id: it.id, done: update.done });
		}
		case "delete": {
			const it = resolveByIdOrName(data.notice.items, update.target, NOTICE_ITEM_REF);
			return applyWorldUpdate(data, { op: "notice_delete", id: it.id });
		}
		case "set_enabled":
			// 整体开关:关掉后【Notice·备忘录】块不再注入(UI 上那条板子仍在)
			return applyWorldUpdate(data, { op: "update_notice", enabled: update.enabled });
	}
}

/**
 * 两个窄工具共用的执行体:读-改-写持同一把世界锁(与 world_update / style_update 同源,
 * agent 一轮多工具并行调用时不会丢更新)。
 *
 * **不写世界书编辑记录**(`stage/last-world-edit.json`):与 style_update 同一条理由
 * —— 那份记录只有舞台页消费,编辑页不读它,写它只会在窄窗口里串出一张舞台预览卡。
 * 改完的可见反馈走工具结果 + 编剧的一句话确认。
 */
async function runWorldEditTool<TOp extends { op: string }>(
	toolName: string,
	raw: unknown,
	normalize: (raw: unknown) => TOp,
	apply: (world: WorldData, update: TOp) => WorldData,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: { op: string } }> {
	const dir = bookDirBase();
	if (!dir) throw new Error(`${toolName} 未配置书目录`);
	return withWorldLock(dir, async () => {
		const update = normalize(raw);
		const world = await ensureWorld(dir);
		const next = apply(world, update);
		await saveWorld(dir, next);
		return { content: [{ type: "text", text: `已更新世界书(${update.op})。` }], details: { op: update.op } };
	});
}

export const storylineUpdateTool: ToolDefinition = defineTool({
	name: "storyline_update",
	label: "Storyline Update",
	description:
		"增删改**发展线**节点(全书的目标推进表)。这是你在写作过程中推进剧情目标的通道,和写正文是一回事的两面:写完一幕就把对应节点 advance 到 done、把 in-progress 挪到下一个目标。读法:上下文【发展线】块里每条都带短编号,形如 `[9f2k1x] 初入旧城`。操作:① upsert_node —— 给 target(编号/标题)改已有节点的 title/status/goal/next;不给 target 就是新建(此时 title 必填)。② advance —— 只改状态,靶子用编号指定,不必重抄标题。③ delete_node —— 删掉建错的节点。op 名与 world_update 的同名操作一致。status 枚举只接受英文:pending / in-progress / done / shelved;一本书同时**只应有一个 in-progress**。人物/关系/时间线/大纲仍归导演,你改不了。",
	parameters: Type.Object({ update: STORYLINE_UPDATE_FLAT }),
	async execute(_callId, params) {
		return runWorldEditTool("storyline_update", params.update, normalizeStorylineUpdate, applyStorylineUpdate);
	},
});

export const noticeUpdateTool: ToolDefinition = defineTool({
	name: "notice_update",
	label: "Notice Update",
	description:
		"增删改**Notice 备忘录**(待办清单:埋伏笔、待补的细节、记着别忘的事)。上下文里的【Notice·备忘录】块每条都带短编号,形如 `[k3p9wq] 补写第三章的雨夜`。操作:① append —— 追加一条新待办(只给 text)。② edit —— 按 target 改某条的正文。③ set_done —— 勾掉(做完的条目不再注入上下文,但留在板子上);记得在确实写完之后再勾。④ delete —— 删掉一条(建错了才用,日常是 set_done)。⑤ set_enabled —— 整个备忘录的注入开关。target 可以是短编号 / 完整 id / 待办原文(唯一匹配才生效;命中多条会报错列候选)。注意:Notice 是「作者给自己的提醒」,不是剧情目标 —— 剧情往哪走用 storyline_update。",
	parameters: Type.Object({ update: NOTICE_UPDATE_FLAT }),
	async execute(_callId, params) {
		return runWorldEditTool("notice_update", params.update, normalizeNoticeUpdate, applyNoticeUpdate);
	},
});
