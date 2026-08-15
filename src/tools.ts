import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "../vendor/pi-coding-agent/src/index.ts";
import { Type } from "typebox";
import { cjkCount } from "./cjk.ts";
import { ensureWorld, newId, saveWorld, validateWorld, writeWorldEditRecord, WorldValidationError, type ConstraintTarget, type EntryStatus, type EntryType, type RelationArrow, type StoryNodeStatus, type WorldData, type WorldEntry } from "./world-data.ts";
import { pathWithinRoot, toolGuardContext } from "./tool-guard.ts";
import { withWorldLock } from "./world-lock.ts";

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

const CountModeEnum = Type.Union([
	Type.Literal("cn_chars"),
	Type.Literal("en_words"),
	Type.Literal("sentences"),
	Type.Literal("paragraphs"),
	Type.Literal("all"),
]);

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

function countText(text: string): FileCounts {
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

async function readCountsForFile(filePath: string): Promise<FileCounts> {
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

/** 按传入字段更新条目(仅覆盖显式提供的字段,其余保留);更新 updatedAt。 */
function updateEntryFields(e: WorldEntry, update: Extract<WorldUpdateOp, { op: "upsert_entry" }>, now: number): void {
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
		case "notice_delete":
			next.notice.items = next.notice.items.filter((x) => x.id !== update.id);
			break;
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
		case "delete_constraint":
			next.constraints = next.constraints.filter((x) => x.id !== update.id);
			break;
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

/** 当前 world_update/world_find 的书目录:SessionHost ALS 上下文优先,其次工厂注入值。 */
function worldBookDir(): string | null {
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
		const dir = worldBookDir();
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

export const worldUpdateTool: ToolDefinition = defineTool({
	name: "world_update",
	label: "World Update",
	description:
		"更新世界书(world.json):增删改条目、关系、约束、Notice、发展线、采样、简要世界观与时间线。这是修改世界设定的唯一通道;结构性约束(重复 id、悬空引用、多个 in-progress 等)由程序校验。upsert_entry 是真 upsert:带 id 时查不到就按该 id 新建;不带 id 时按 (type, title) 匹配已有条目(存在则更新、保留原 id),都不命中才新建——更新已有条目通常不需要先查 id。关系的 from/to 接受条目 id 或标题(标题自动解析为条目 id;标题匹配到多个条目时返回报错并列出候选 id,请用 world_find 查 id 消歧;成功时返回会回显解析结果 from id(标题) → to id(标题))。枚举只接受英文:type=character/world/timeline/outline;status=alive/dead/unknown/active/archived/draft;关系 arrow=none/single/double;发展线 status=pending/in-progress/done/shelved。注意 status 是条目状态,与条目是否参与上下文注入(active 字段,界面「注入上下文」开关)无关,world_update 不改 active。发展线:节点按数组顺序推进,upsert_storyline_node 创建/更新节点,advance_storyline 推进状态;节点的 next 字段 = 该节点完成后的下一步内容(填标题或描述;也接受已有节点 id,会自动转为该节点标题)。查找条目 id 用 world_find 工具。set_world_summary 覆盖简要世界观概述(常驻注入,每次会话都会读到;建议 1-2 段,≤600 字)。新建条目后若与现有条目存在剧情关联,建议一并创建关系(upsert_relation)。",
	parameters: Type.Object({
		update: Type.Union([
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
		]),
	}),
	async execute(_callId, params) {
		const dir = worldBookDir();
		if (!dir) throw new Error("world_update 未配置书目录");
		// 读-改-写整体持锁:并行 world_update(agent 多工具调用)串行执行,
		// 消除丢失更新与共享 tmp 竞态(saveWorld 另以唯一 tmp + 备份兜底)
		return withWorldLock(dir, async () => {
			const world = await ensureWorld(dir);
			// 关系回显:解析结果带条目 id 与标题,形成教学回路——LLM 看到
			// 解析后的 id,后续自然改用 id(与 applyWorldUpdate 内同一解析逻辑,
			// 纯函数幂等;歧义/未命中/反向冲突在 applyWorldUpdate 内抛错兜底)
			let echo = "";
			if (params.update.op === "upsert_relation") {
				const u = params.update as WorldUpdateOp & { op: "upsert_relation" };
				const from = resolveRelationTarget(world, u.from, "from");
				const to = resolveRelationTarget(world, u.to, "to");
				echo = `:from ${from.id}(${from.title}) → to ${to.id}(${to.title})`;
			}
			const next = applyWorldUpdate(world, params.update as WorldUpdateOp);
			await saveWorld(dir, next);
			// 世界书编辑记录(内容 tmp、文件不 tmp):before/after 快照落盘,前端
			// 回合结束据此渲染预览卡——diff 在此刻算好,无 before/after 抓取竞态
			try {
				await writeWorldEditRecord(dir, { op: params.update.op, before: world, after: next, timestamp: Date.now() });
			} catch {
				/* 记录写失败不影响世界书更新(卡片只是展示,world.json 已落盘) */
			}
			return {
				content: [{ type: "text", text: `已更新世界书(${params.update.op})${echo}。` }],
				details: { op: params.update.op },
			};
		});
	},
});
