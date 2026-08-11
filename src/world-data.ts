import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { getBookDir } from "./config.ts";

export type EntryType = "character" | "world" | "timeline" | "outline";
export type EntryStatus = "alive" | "dead" | "unknown" | "active" | "archived" | "draft";
export type StoryNodeStatus = "pending" | "in-progress" | "done" | "shelved";
/** 关系箭头方向:none 无箭头 / single 单向(from→to)/ double 双向。 */
export type RelationArrow = "none" | "single" | "double";

export interface WorldEntry { id: string; type: EntryType; title: string; keys: string[]; chapters: string[]; status: EntryStatus; active: boolean; parent: string | null; tags: string[]; body: string; avatar: string | null; images: string[]; updatedAt: number; }
export interface WorldRelation { id: string; from: string; to: string; type: string; label: string; emphasized: boolean; arrow: RelationArrow; }
export interface WorldConstraint { id: string; name: string; text: string; enabled: boolean; }
export interface StyleSample { text: string; source: string; updatedAt: number; }
export interface NoticeData { text: string; enabled: boolean; updatedAt: number; }
export interface StoryNode { id: string; title: string; status: StoryNodeStatus; goal: string; next: string | null; }
export interface StorylineData { enabled: boolean; nodes: StoryNode[]; }
export interface TimelineEvent { id: string; chapter: string; text: string; }
export interface WorldData { version: 1; entries: WorldEntry[]; relations: WorldRelation[]; constraints: WorldConstraint[]; styleSample: StyleSample | null; worldSummary: string; notice: NoticeData; storyline: StorylineData; timeline: TimelineEvent[]; }

export class WorldValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorldValidationError";
	}
}

const ENTRY_TYPES = ["character", "world", "timeline", "outline"] as const;
const ENTRY_STATUSES = ["alive", "dead", "unknown", "active", "archived", "draft"] as const;
const STORY_STATUSES = ["pending", "in-progress", "done", "shelved"] as const;
const RELATION_ARROWS = ["none", "single", "double"] as const;
const NOTICE_LIMIT = 1000;
/** 简要世界观概述的字数上限。 */
const SUMMARY_LIMIT = 600;
const CONSTRAINT_LIMIT = 800;
const SAMPLE_LIMIT = 500;
const MAX_ENTRY_IMAGES = 9;
/** 图片引用格式:images/ 下单文件名(禁绝对路径/子目录/`.`/`..`)。 */
const IMAGE_REF_RE = /^images\/(?!\.{1,2}$)[^\\/]+$/;

const WORLD_FILE = "world.json";

/**
 * 世界书文件的类型 → 相对路径(唯一真相源:迁移/视图渲染/树解析共用,
 * world-tree.ts 从这里取)。加文件类型只改这一处。
 */
export const WORLD_FILES: ReadonlyArray<{ type: EntryType; rel: string }> = [
	{ type: "character", rel: ".writer/characters.md" },
	{ type: "world", rel: ".writer/world.md" },
	{ type: "timeline", rel: ".writer/timeline.md" },
	{ type: "outline", rel: "outline.md" },
];

/** 视图文件渲染标题(`# <标题>`;键与 WORLD_FILES 的 type 对齐)。 */
export const WORLD_FILE_TITLES: Record<EntryType, string> = {
	character: "人物档案",
	world: "世界设定",
	timeline: "时间线",
	outline: "大纲",
};

export function createEmptyWorld(): WorldData {
	return {
		version: 1,
		entries: [],
		relations: [],
		constraints: [],
		styleSample: null,
		worldSummary: "",
		notice: { text: "", enabled: true, updatedAt: 0 },
		storyline: { enabled: true, nodes: [] },
		timeline: [],
	};
}

/** `${prefix}-` + 6 位随机小写字母数字。 */
export function newId(prefix: string): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
	return `${prefix}-${s}`;
}

/**
 * 书目录解析：绝对路径直接使用（测试与调用方传 getBookDir(slug) 的结果）；
 * 相对值按 slug 经 getBookDir 解析。
 */
function resolveBookDir(bookDir: string): string {
	return isAbsolute(bookDir) ? bookDir : getBookDir(bookDir);
}

/** 字符串数组去重,保持首次出现顺序。 */
function dedupe(arr: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of arr) { if (!seen.has(s)) { seen.add(s); out.push(s); } }
	return out;
}

/** 校验并规范化;任何非法返回错误消息,合法返回 null。 */
function worldErrors(value: unknown): string | null {
	if (Array.isArray(value) || typeof value !== "object" || value === null) return "world.json 不是合法对象";
	const raw = value as Partial<WorldData>;
	// 必填小节:notice/storyline 缺失(或为 null)视为非法,避免下游空指针
	if (raw.notice === undefined || raw.notice === null) return "world.json 缺少 notice";
	if (raw.storyline === undefined || raw.storyline === null) return "world.json 缺少 storyline";
	// 简要世界观:缺失/显式 null 放行(规范化时补空),存在则必须是字符串且限长
	if (raw.worldSummary !== undefined && raw.worldSummary !== null) {
		if (typeof raw.worldSummary !== "string") return "worldSummary 必须是字符串";
		if (raw.worldSummary.length > SUMMARY_LIMIT) return `worldSummary 超过 ${SUMMARY_LIMIT} 字上限`;
	}
	const entries = Array.isArray(raw.entries) ? raw.entries : [];
	const seenIds = new Set<string>();
	for (const e of entries) {
		if (typeof e !== "object" || e === null) return "条目必须是对象";
		if (typeof e.id !== "string" || e.id.length === 0) return "条目缺少 id";
		if (seenIds.has(e.id)) return `条目 id 重复: ${e.id}`;
		seenIds.add(e.id);
		if (!ENTRY_TYPES.includes(e.type as EntryType)) return `条目 ${e.id} 的 type 非法: ${String(e.type)}(合法值: ${ENTRY_TYPES.join(" / ")})`;
		if (!ENTRY_STATUSES.includes(e.status as EntryStatus)) return `条目 ${e.id} 的 status 非法: ${String(e.status)}(合法值: ${ENTRY_STATUSES.join(" / ")})`;
		if (e.parent !== null && e.parent !== undefined && !seenIds.has(e.parent) && !entries.some((x) => x.id === e.parent)) {
			return `条目 ${e.id} 的 parent 指向不存在的条目: ${e.parent}`;
		}
		if (e.parent === e.id) return `条目 ${e.id} 不能以自己为 parent`;
		if (e.avatar !== undefined && e.avatar !== null && typeof e.avatar !== "string") return `条目 ${e.id} 的 avatar 必须是字符串或 null`;
		if (typeof e.avatar === "string" && !IMAGE_REF_RE.test(e.avatar)) return `条目 ${e.id} 的 avatar 引用非法: ${e.avatar}`;
		if (e.images !== undefined && !Array.isArray(e.images)) return `条目 ${e.id} 的 images 必须是数组`;
		const imgs = Array.isArray(e.images) ? e.images : [];
		if (imgs.some((x) => typeof x !== "string" || !IMAGE_REF_RE.test(x))) return `条目 ${e.id} 的图片引用非法`;
		if (imgs.length > MAX_ENTRY_IMAGES) return `条目 ${e.id} 图片数量超过上限(${MAX_ENTRY_IMAGES})`;
		// 规范化会把 avatar 补入 images(不在其中时 unshift):已满 9 张再补主图会超上限,
		// 校验必须覆盖规范化之后的形态(先校验后规范化,这里预判)
		if (imgs.length >= MAX_ENTRY_IMAGES && typeof e.avatar === "string" && !imgs.includes(e.avatar)) {
			return `条目 ${e.id} 图片数量超过上限(${MAX_ENTRY_IMAGES})`;
		}
	}
	const relations = Array.isArray(raw.relations) ? raw.relations : [];
	const relSeen = new Set<string>();
	for (const r of relations) {
		if (typeof r !== "object" || r === null) return "关系必须是对象";
		if (typeof r.id !== "string" || r.id.length === 0) return "关系缺少 id";
		if (relSeen.has(r.id)) return `关系 id 重复: ${r.id}`;
		relSeen.add(r.id);
		if (!seenIds.has(r.from)) return `关系 (relation) ${r.id} 的 from 指向不存在的条目: ${r.from}`;
		if (!seenIds.has(r.to)) return `关系 (relation) ${r.id} 的 to 指向不存在的条目: ${r.to}`;
		if (r.from === r.to) return `关系 ${r.id} 不能自环`;
		// arrow 可选(旧数据无该字段,规范化时补默认);存在则必须合法枚举
		if (r.arrow !== undefined && r.arrow !== null && !RELATION_ARROWS.includes(r.arrow as RelationArrow)) {
			return `关系 ${r.id} 的 arrow 非法: ${String(r.arrow)}(合法值: ${RELATION_ARROWS.join(" / ")})`;
		}
	}
	const constraints = Array.isArray(raw.constraints) ? raw.constraints : [];
	const cstSeen = new Set<string>();
	for (const c of constraints) {
		if (typeof c !== "object" || c === null) return "约束必须是对象";
		if (typeof c.id !== "string" || c.id.length === 0) return "约束缺少 id";
		if (cstSeen.has(c.id)) return `约束 id 重复: ${c.id}`;
		cstSeen.add(c.id);
		if (typeof c.text !== "string" || c.text.length > CONSTRAINT_LIMIT) {
			return `约束 ${c.id} 超过 ${CONSTRAINT_LIMIT} 字上限`;
		}
	}
	const sample = raw.styleSample ?? null;
	if (sample !== null && (typeof sample.text !== "string" || sample.text.length > SAMPLE_LIMIT)) {
		return `采样超过 ${SAMPLE_LIMIT} 字上限`;
	}
	const notice = raw.notice as Partial<NoticeData>;
	if (typeof notice.text !== "string" || notice.text.length > NOTICE_LIMIT) {
		return `Notice 超过 ${NOTICE_LIMIT} 字上限`;
	}
	const nodes = Array.isArray(raw.storyline.nodes) ? raw.storyline.nodes : [];
	const nodeSeen = new Set<string>();
	let inProgress = 0;
	for (const n of nodes) {
		if (typeof n !== "object" || n === null) return "发展线节点必须是对象";
		if (typeof n.id !== "string" || n.id.length === 0) return "发展线节点缺少 id";
		if (nodeSeen.has(n.id)) return `发展线节点 id 重复: ${n.id}`;
		nodeSeen.add(n.id);
		if (!STORY_STATUSES.includes(n.status as StoryNodeStatus)) return `发展线节点 ${n.id} 的 status 非法: ${n.status}(合法值: ${STORY_STATUSES.join(" / ")})`;
		if (n.status === "in-progress") inProgress++;
	}
	if (inProgress > 1) return "发展线至多一个 in-progress 节点";
	return null;
}

/** 校验并返回规范化后的 WorldData;非法抛 WorldValidationError。 */
export function validateWorld(value: unknown): WorldData {
	const error = worldErrors(value);
	if (error !== null) throw new WorldValidationError(error);
	const raw = value as WorldData;
	// 规范化:旧数据的关系无 arrow 字段,补默认 double(向后兼容)
	const needsArrow = raw.relations.some((r) => (r as { arrow?: RelationArrow }).arrow === undefined);
	// 规范化:旧数据条目缺 avatar/images;images 去重;avatar 不在 images 则补入
	const needsImages = raw.entries.some((e) => {
		const avatar = e.avatar ?? null;
		const imgs = dedupe(e.images ?? []);
		return e.avatar === undefined || e.images === undefined || imgs.length !== e.images.length || (avatar !== null && !imgs.includes(avatar));
	});
	// 规范化:旧数据缺 worldSummary 字段(或显式 null),补空
	const needsSummary = raw.worldSummary === undefined || raw.worldSummary === null;
	if (!needsArrow && !needsImages && !needsSummary) return raw;
	return {
		...raw,
		worldSummary: needsSummary ? "" : raw.worldSummary,
		relations: needsArrow
			? raw.relations.map((r) => ({ ...r, arrow: (r as { arrow?: RelationArrow }).arrow ?? "double" }))
			: raw.relations,
		entries: needsImages
			? raw.entries.map((e) => {
					const images = dedupe(e.images ?? []);
					const avatar = e.avatar ?? null;
					if (avatar !== null && !images.includes(avatar)) images.unshift(avatar);
					return { ...e, avatar, images };
				})
			: raw.entries,
	};
}

/** 读取并校验;文件不存在返回 null。 */
async function readWorld(bookDir: string): Promise<WorldData | null> {
	const file = join(resolveBookDir(bookDir), WORLD_FILE);
	if (!existsSync(file)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(file, "utf-8")) as unknown;
	} catch {
		throw new WorldValidationError("world.json 不是合法 JSON");
	}
	return validateWorld(raw);
}

/**
 * 原子写(校验 → 备份 → atomicWriteFile(唯一 tmp + rename 重试)→ 写后校验,
 * 失败回滚)。备份与唯一 tmp 消除并发保存时的文件损坏:并发写不共享同一 tmp
 * 路径(rename 原子替换),写后校验失败可从 .bak 恢复。
 */
export async function saveWorld(bookDir: string, data: WorldData): Promise<void> {
	validateWorld(data);
	const dir = resolveBookDir(bookDir);
	const file = join(dir, WORLD_FILE);
	// 备份现有文件(恢复点;首次保存无旧文件则跳过)
	const bak = `${file}.bak`;
	if (existsSync(file)) await copyFile(file, bak);
	await atomicWriteFile(file, JSON.stringify(data, null, 2));
	// 写后校验:落盘内容必须可解析且合法;异常则从备份恢复并抛错
	try {
		validateWorld(JSON.parse(await readFile(file, "utf-8")) as unknown);
	} catch (err) {
		if (existsSync(bak)) await copyFile(bak, file);
		throw new WorldValidationError(`world.json 写入校验失败,已回滚: ${err instanceof Error ? err.message : String(err)}`);
	}
	await writeWorldViews(bookDir, data);
}

/** 世界书编辑记录文件:内容每次覆盖、路径稳定(「内容 tmp、文件不 tmp」)。
 *  world_update 成功后的 before/after 快照——diff 在应用时刻由工具算好落盘,
 *  前端回合结束据此渲染预览卡(2026-08-11 简化:替代 SSE 工具事件竞态捕获)。 */
export const WORLD_EDIT_RECORD_FILE = "stage/last-world-edit.json";

/** 写世界书编辑记录(工具调;失败不影响世界书更新)。 */
export async function writeWorldEditRecord(
	bookDir: string,
	record: { op: string; before: WorldData; after: WorldData; timestamp: number },
): Promise<void> {
	await atomicWriteFile(join(resolveBookDir(bookDir), WORLD_EDIT_RECORD_FILE), JSON.stringify(record));
}

/** 读世界书编辑记录(前端回合结束渲染预览卡;无记录/损坏 → null)。 */
export async function readWorldEditRecord(
	bookDir: string,
): Promise<{ op: string; before: WorldData; after: WorldData; timestamp: number } | null> {
	try {
		const raw = await readFile(join(resolveBookDir(bookDir), WORLD_EDIT_RECORD_FILE), "utf-8");
		const parsed = JSON.parse(raw) as { op: string; before: WorldData; after: WorldData; timestamp: number };
		if (typeof parsed.op !== "string" || !parsed.before || !parsed.after) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** 存在 → 读+校验;不存在 → 迁移旧 md(无则空世界)并落盘。 */
export async function ensureWorld(bookDir: string): Promise<WorldData> {
	const existing = await readWorld(bookDir);
	if (existing) return existing;
	// 无 world.json:尝试迁移旧 md;无旧文件则空世界(saveWorld 内部已写 md 视图)
	const migrated = await migrateFromMarkdown(bookDir);
	await saveWorld(bookDir, migrated);
	return migrated;
}

/** 旧 .writer/*.md + outline.md → 条目;无旧文件返回空世界。 */
export async function migrateFromMarkdown(bookDir: string): Promise<WorldData> {
	const world = createEmptyWorld();
	const dir = resolveBookDir(bookDir);
	for (const { rel, type } of WORLD_FILES) {
		let content: string;
		try {
			content = await readFile(join(dir, rel), "utf-8");
		} catch {
			continue; // 文件不存在:跳过
		}
		parseLegacyMarkdown(world, content, type);
	}
	return world;
}

/** 解析旧 md:第一个 `#` 是文件标题(容器,跳过);其余 `#`/`##`/`###` 是条目;`parent:` 元数据行转 parent 字段。 */
function parseLegacyMarkdown(world: WorldData, content: string, type: EntryType): void {
	interface Raw { title: string; bodyLines: string[]; }
	const raws: Raw[] = [];
	let current: Raw | null = null;
	let sawFileTitle = false;
	for (const line of content.split(/\r?\n/)) {
		const h1 = /^#\s+(.+?)\s*$/.exec(line);
		const h2 = /^##\s+(.+?)\s*$/.exec(line);
		const h3 = /^###\s+(.+?)\s*$/.exec(line);
		if (h1 || h2 || h3) {
			if (current) raws.push(current);
			if (h1 && !sawFileTitle) {
				sawFileTitle = true;
				current = null; // 仅第一个 H1 是文件标题(容器,跳过)
			} else {
				current = { title: (h1 ?? h2 ?? h3)![1]!.trim(), bodyLines: [] };
			}
		} else if (current) {
			current.bodyLines.push(line);
		}
	}
	if (current) raws.push(current);

	// parent/avatar/images: 元数据行 → 字段(从正文剔除)
	const parentByTitle = new Map<string, string | null>();
	const avatarByTitle = new Map<string, string | null>();
	const imagesByTitle = new Map<string, string[]>();
	for (const raw of raws) {
		let parentTitle: string | null = null;
		let avatar: string | null = null;
		let images: string[] = [];
		const body: string[] = [];
		for (const line of raw.bodyLines) {
			const m = /^\s*-?\s*parent:\s*(.+?)\s*$/.exec(line);
			const am = /^\s*-?\s*avatar:\s*(.+?)\s*$/.exec(line);
			const im = /^\s*-?\s*images:\s*(.+?)\s*$/.exec(line);
			if (m && parentTitle === null) parentTitle = m[1]!.trim();
			else if (am && avatar === null) avatar = am[1]!.trim();
			else if (im && images.length === 0) images = im[1]!.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
			else body.push(line);
		}
		parentByTitle.set(raw.title, parentTitle);
		avatarByTitle.set(raw.title, avatar);
		imagesByTitle.set(raw.title, images);
		raw.bodyLines = body;
	}
	// 建条目;parent 用标题映射延迟解析(父条目可能在后)
	const idByTitle = new Map<string, string>();
	for (const raw of raws) {
		const entry: WorldEntry = {
			id: newId("entry"), type, title: raw.title,
			keys: [], chapters: [], status: "active", active: true,
			parent: null, tags: [], body: raw.bodyLines.join("\n").trim(),
			avatar: avatarByTitle.get(raw.title) ?? null, images: imagesByTitle.get(raw.title) ?? [], updatedAt: Date.now(),
		};
		idByTitle.set(raw.title, entry.id);
		world.entries.push(entry);
	}
	for (const raw of raws) {
		const parentTitle = parentByTitle.get(raw.title);
		if (parentTitle && parentTitle !== raw.title) {
			const pid = idByTitle.get(parentTitle);
			if (pid) {
				const entry = world.entries.find((e) => e.title === raw.title);
				if (entry) entry.parent = pid;
			}
		}
	}
}

const VIEW_HEADER = "> 此文件为 world.json 的导出视图,编辑请走界面(web 世界书页 / TUI 命令)。\n\n";

/** 按 type 分组渲染 md 视图;返回 [相对路径, 内容] 列表。 */
export function renderWorldMarkdown(data: WorldData): Array<[string, string]> {
	const groups: Record<EntryType, WorldEntry[]> = { character: [], world: [], timeline: [], outline: [] };
	for (const e of data.entries) groups[e.type].push(e);
	return WORLD_FILES.map(({ rel, type }) => {
		let content = `${VIEW_HEADER}# ${WORLD_FILE_TITLES[type]}\n\n`;
		for (const e of groups[type]) {
			content += `## ${e.title}\n`;
			if (e.parent) {
				const p = data.entries.find((x) => x.id === e.parent);
				if (p) content += `- parent: ${p.title}\n`;
			}
			if (e.avatar) content += `- avatar: ${e.avatar}\n`;
			if (e.images.length > 0) content += `- images: ${e.images.join(", ")}\n`;
			if (e.body.length > 0) content += `${e.body}\n`;
			content += "\n";
		}
		return [rel, content] as [string, string];
	});
}

/** 把 md 视图写入磁盘(渲染 → atomicWriteFile,并发安全)。 */
export async function writeWorldViews(bookDir: string, data: WorldData): Promise<void> {
	const dir = resolveBookDir(bookDir);
	for (const [rel, content] of renderWorldMarkdown(data)) {
		await atomicWriteFile(join(dir, rel), content);
	}
}
