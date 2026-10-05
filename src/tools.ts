import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "./pi-adapter/index.ts";
import { Type, type TSchema } from "typebox";
import { cjkCount } from "./cjk.ts";
import { ensureWorld, newId, saveWorld, validateWorld, writeWorldEditRecord, WorldValidationError, type ConstraintTarget, type EntryStatus, type EntryType, type RelationArrow, type StoryNodeStatus, type WorldData, type WorldEntry } from "./world-data.ts";
import { pathWithinRoot, toolGuardContext } from "./tool-guard.ts";
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
 * word_count tool — accurate length metrics for writer drafts.
 *
 * The model is reliably bad at counting; this tool gives it a deterministic
 * fallback rather than letting it hallucinate chapter length.
 */

/**
 * 工具解析相对路径的基准目录。会话创建时由 createRuntime 工厂注入
 * (cli.ts / web.ts 的 cwd = 书目录),避免误用服务进程的 process.cwd()
 * (web 模式服务从项目根启动,相对路径会解析到错误位置)。
 */
let wordCountCwd: string | null = null;

/** 设置 word_count 的路径基准(会话书目录);null 回退 process.cwd()。 */
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

const wordCountParameters = Type.Object({
	path: Type.String({
		description:
			"File or directory to count. Relative to the book working directory. Directories are walked for *.md recursively.",
	}),
	modes: Type.Optional(
		Type.Array(CountModeEnum, {
			description:
				'Which metrics to include. Defaults to ["all"]. "cn_chars" counts CJK ideographs; "en_words" counts Latin/number words; "sentences" counts terminal punctuation runs; "paragraphs" counts blank-line separated paragraphs.',
		}),
	),
	target: Type.Optional(
		Type.Number({
			description:
				"Optional target for the primary metric (cn_chars when present, otherwise en_words). Reports absolute and percentage delta.",
		}),
	),
});

interface FileCounts {
	cnChars: number;
	enWords: number;
	sentences: number;
	paragraphs: number;
}

const EMPTY: FileCounts = { cnChars: 0, enWords: 0, sentences: 0, paragraphs: 0 };

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
 * 无 full ICU,`\p{` 正则禁用——word_count 在 web 工具集内,Android 上会执行
 * (2026-08-10 修复)。希腊/西里尔等字母未覆盖(中文写作场景英文词基本为 ASCII)。
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
 * 附在工具返回值里(见 extension.ts 的 countAfterWriteHook),需要复用同一套
 * 计数口径 —— 两处口径一旦分叉,AI 看到的字数与 word_count 报的会对不上。
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

/** 读文件并计数(供 word_count 与 write/edit 后的字数钩子共用)。 */
export async function readCountsForFile(filePath: string): Promise<FileCounts> {
	const content = await readFile(filePath, "utf-8");
	return countText(content);
}

async function listMarkdownFiles(dir: string, acc: string[]): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await listMarkdownFiles(full, acc);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			acc.push(full);
		}
	}
}

function pickPrimaryMetric(counts: FileCounts): { name: string; value: number } {
	if (counts.cnChars > 0) return { name: "cn_chars", value: counts.cnChars };
	return { name: "en_words", value: counts.enWords };
}

function perFileLine(fileRel: string, c: FileCounts, wanted: ReadonlySet<CountMetric>): string {
	const parts: string[] = [];
	if (wanted.has("cn_chars")) parts.push(`${c.cnChars} cn`);
	if (wanted.has("en_words")) parts.push(`${c.enWords} en`);
	if (wanted.has("sentences")) parts.push(`${c.sentences} 句`);
	if (wanted.has("paragraphs")) parts.push(`${c.paragraphs} 段`);
	return `  ${fileRel.split(sep).join("/")}: ${parts.join(" | ")}`;
}

function totalBlock(c: FileCounts, wanted: ReadonlySet<CountMetric>): string[] {
	const out: string[] = [];
	if (wanted.has("cn_chars")) out.push(`  cn_chars: ${c.cnChars}`);
	if (wanted.has("en_words")) out.push(`  en_words: ${c.enWords}`);
	if (wanted.has("sentences")) out.push(`  sentences: ${c.sentences}`);
	if (wanted.has("paragraphs")) out.push(`  paragraphs: ${c.paragraphs}`);
	return out;
}

export const wordCountTool: ToolDefinition = defineTool({
	name: "word_count",
	label: "Word Count",
	description:
		"Accurately count characters, words, sentences, and paragraphs in a draft file or directory. Use this whenever the user asks about length or pacing; never estimate by eye.",
	parameters: wordCountParameters,
	async execute(_callId, params) {
		const modesParam = params.modes;
		const requested = modesParam && modesParam.length > 0 ? modesParam : (["all"] as const);
		const all = requested.includes("all");
		const wanted: Set<CountMetric> = new Set(all ? COUNT_METRICS : (requested as CountMetric[]));

		const base = cwdBase();
		const targetPath = resolve(base, params.path);
		// 路径守卫:注入书目录基准时,word_count 只能统计书目录内的文件
		// (防越界探测 auth.json 等敏感文件);未注入时保持旧行为(进程 cwd 基准)。
		// 生产装配(cli.ts / web.ts 工厂)总是注入,因此实际总是受限。
		if (wordCountCwd !== null && !pathWithinRoot(targetPath, base)) {
			throw new Error("工具路径越界:只能访问书目录内的文件");
		}
		let stats: Stats;
		try {
			stats = await stat(targetPath);
		} catch {
			throw new Error(`Path not found: ${params.path}`);
		}

		const files: string[] = [];
		if (stats.isFile()) {
			files.push(targetPath);
		} else if (stats.isDirectory()) {
			await listMarkdownFiles(targetPath, files);
		}

		if (files.length === 0) {
			return {
				content: [{ type: "text", text: `No .md files under ${params.path}.` }],
				details: { found: 0 },
			};
		}

		const perFile = await Promise.all(
			files.map(async (f) => {
				const counts = await readCountsForFile(f);
				return { file: relative(base, f) || f, counts };
			}),
		);

		const total = perFile.reduce<FileCounts>(
			(acc, item) => {
				acc.cnChars += item.counts.cnChars;
				acc.enWords += item.counts.enWords;
				acc.sentences += item.counts.sentences;
				acc.paragraphs += item.counts.paragraphs;
				return acc;
			},
			{ ...EMPTY },
		);

		const lines: string[] = [`Files: ${perFile.length}`];
		if (perFile.length > 1) {
			for (const item of perFile) lines.push(perFileLine(item.file, item.counts, wanted));
			lines.push("Total:");
		}
		lines.push(...totalBlock(total, wanted));

		const details: Record<string, unknown> = {
			files: perFile.map((f) => ({ file: f.file, ...f.counts })),
			total,
		};

		const target = params.target;
		if (typeof target === "number" && target > 0) {
			const primary = pickPrimaryMetric(total);
			const delta = primary.value - target;
			const pct = target > 0 ? Math.round((primary.value / target) * 100) : 0;
			lines.push(`Target ${target} ${primary.name}: ${delta >= 0 ? "+" : ""}${delta} (${pct}%)`);
			details.target = { metric: primary.name, value: primary.value, target, delta, pct };
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	},
});

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
 * 1. **约束一律写 target="writer"**——编剧只约束自己(成文与编辑页对话),不替导演立规;
 *    要约束导演得用户直接对导演讲(它有全量 world_update)。
 * 2. **按名字 upsert / 删除**——注入给编剧的【写作约束】块只有 `名字: 正文`,没有 id,
 *    所以不能要求模型先查 id;同名即更新,避免重复立规矩。
 */
export type StyleUpdateOp =
	| { op: "upsert_constraint"; name: string; text: string; enabled?: boolean }
	| { op: "delete_constraint"; name: string }
	| { op: "update_style_sample"; text: string; source?: string }
	| { op: "set_world_summary"; text: string };

/** style_update 的操作联合(schema 唯一真相源;对外暴露的是压平版 STYLE_UPDATE_FLAT)。 */
const STYLE_UPDATE_UNION = Type.Union([
	Type.Object({ op: Type.Literal("upsert_constraint"), name: Type.String(), text: Type.String(), enabled: Type.Optional(Type.Boolean()) }),
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
				target: "writer",
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
			const n = next.storyline.nodes.find((x) => x.id === update.id);
			if (!n) {
				// 节点不存在则创建(以 id 为标题兜底)
				next.storyline.nodes.push({ id: update.id, title: update.id, status: update.status, goal: "", next: update.next === undefined ? null : resolveNextTitle(next, update.next) });
			} else {
				n.status = update.status;
				if (update.next !== undefined) n.next = resolveNextTitle(next, update.next);
			}
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
		case "delete_relation":
			next.relations = next.relations.filter((x) => x.id !== update.id);
			break;
	}
	return validateWorld(next);
}

/** world_update 工具执行所需的书目录基准(仿 setWordCountCwd)。 */
let worldUpdateBookDir: string | null = null;
export function setWorldUpdateBookDir(dir: string | null): void { worldUpdateBookDir = dir; }

/** 当前会话的书目录:SessionHost ALS 上下文优先,其次工厂注入值(见 session-factory)。 */
function bookDirBase(): string | null {
	return toolGuardContext.getStore()?.bookDir ?? worldUpdateBookDir;
}

/**
 * world_find —— 只读检索世界书条目(不改数据)。
 *
 * 条目 id 是 world_update 各 id 类操作(delete_entry/set_status/advance_storyline/
 * 关系、约束等)的定位依据,但 LLM 无法直接列出 id——只能 read 整个 world.json
 * 自己找。本工具按标题/类型/触发词检索,返回 id 供后续 world_update 使用。
 */
export const worldFindTool: ToolDefinition = defineTool({
	name: "world_find",
	label: "World Find",
	description:
		"只读检索世界书条目(不修改数据):按标题(精确)/类型/触发关键词过滤,返回条目的 id/type/title/status,供 world_update 的 id 类操作(delete_entry、set_status、关系、约束等)定位用。type 枚举: character/world/timeline/outline。",
	parameters: Type.Object({
		title: Type.Optional(Type.String({ description: "按标题精确匹配(省略则不过滤)" })),
		type: Type.Optional(Type.String({ description: "按类型过滤(character/world/timeline/outline)" })),
		keys: Type.Optional(Type.Array(Type.String(), { description: "按触发关键词过滤(任一命中即匹配)" })),
		limit: Type.Optional(Type.Number({ description: "返回条数上限(1-100,默认 20)" })),
	}),
	async execute(_callId, params) {
		const dir = bookDirBase();
		if (!dir) throw new Error("world_find 未配置书目录");
		const world = await ensureWorld(dir);
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
		const limit = Math.max(1, Math.min(100, params.limit ?? 20));
		const found = entries.slice(0, limit);
		const lines = found.map(
			(e) => `- ${e.id} [${e.type}] ${e.title}${e.status !== "active" ? ` (${e.status})` : ""}`,
		);
		return {
			content: [
				{
					type: "text",
					text: `匹配 ${entries.length} 条${entries.length > found.length ? `,显示前 ${found.length}` : ""}:\n${lines.join("\n") || "(无)"}`,
				},
			],
			details: {
				count: entries.length,
				found: found.map((e) => ({ id: e.id, type: e.type, title: e.title, status: e.status })),
			},
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
 * 与 word_count 的分工:word_count 回答「多长」,read_chapter 回答「写了什么」。
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
		// 尤其续写时要据字数判断节奏,不该再调一次 word_count。
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
		"更新世界书(world.json):增删改条目、关系、约束、Notice、发展线、采样、简要世界观与时间线。这是修改世界设定的唯一通道;结构性约束(重复 id、悬空引用、多个 in-progress 等)由程序校验。upsert_entry 是真 upsert:带 id 时查不到就按该 id 新建;不带 id 时按 (type, title) 匹配已有条目(存在则更新、保留原 id),都不命中才新建——更新已有条目通常不需要先查 id。关系的 from/to 接受条目 id 或标题(标题自动解析为条目 id;标题匹配到多个条目时返回报错并列出候选 id,请用 world_find 查 id 消歧;成功时返回会回显解析结果 from id(标题) → to id(标题))。枚举只接受英文:type=character/world/timeline/outline;status=alive/dead/unknown/active/archived/draft;关系 arrow=none/single/double;发展线 status=pending/in-progress/done/shelved。注意 status 是条目状态,与条目是否参与上下文注入(active 字段,界面「注入上下文」开关)无关,world_update 不改 active。发展线:节点按数组顺序推进,upsert_storyline_node 创建/更新节点,advance_storyline 推进状态;节点的 next 字段 = 该节点完成后的下一步内容(填标题或描述;也接受已有节点 id,会自动转为该节点标题)。查找条目 id 用 world_find 工具。set_world_summary 覆盖简要世界观概述(常驻注入,每次会话都会读到;建议 1-2 段,≤600 字)。新建条目后若与现有条目存在剧情关联,建议一并创建关系(upsert_relation)。",
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
		"更新**写作风格**设定:写作约束(你与成文要遵守的硬规矩)、文风采样(作者文风基准)、简要世界观概述。这是你唯一能改世界书的通道——人物/关系/时间线/大纲/发展线/Notice 你改不了,那些归导演,你的相关建议写 advice.md。语义:① 约束按**名字** upsert——同名即更新(不会重复立规矩),所以重述一条已有规矩不需要先查 id;约束只作用于**你自己**(编辑页对话与收幕成文),要约束导演得用户直接对导演讲。② 删除按名字,名字见上下文【写作约束】块(那里没有 id,别去找 id)。③ 约束要**可判定**(「禁用破折号」「每章 2500 字上下」),不要写「文笔要优美」;条数控制在 8 条以内。④ update_style_sample 的 text 是 300–500 字的代表性样本(用户自己写的,或他想靠近的片段),**绝不编造**;set_world_summary 是 1-2 句题材与基调定位(常驻注入,≤600 字)。op 名与 world_update 的同名操作一致,便于对照。",
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
