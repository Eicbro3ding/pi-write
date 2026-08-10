import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uuidv7 } from "../vendor/pi-ai/src/index.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { getBookDir, getBooksDir, getWriterDir, slugify } from "./config.ts";
import { createEmptyWorld, saveWorld } from "./world-data.ts";

/** Session header version, matches pi's CURRENT_SESSION_VERSION. */
const SESSION_VERSION = 3;

/**
 * Book manager — pure filesystem operations on the writer book index.
 *
 * A "book" is a workspace directory under ~/.pi/writer/books/<slug>/ that
 * contains the durable writing material: outline.md, draft/, .writer/.
 * Each chapter is an independent pi session transcript stored OUTSIDE the
 * book workspace (~/.pi/writer/sessions/<slug>/<id>.jsonl) so prose grep
 * does not trip over transcript JSONL.
 */

const INDEX_VERSION = 1;
const BOOK_INDEX_FILE = "book.json";

export interface ChapterRef {
	/** Stable id, e.g. "ch01". */
	id: string;
	/** Basename of the session file inside the book's session dir. */
	file: string;
	/** Human chapter title. */
	title: string;
	/** Optional label/marker, e.g. "草稿" / "完成" / "搁置". */
	label: string | null;
	createdAt: number;
	updatedAt: number;
	/** True if the session file currently exists on disk. */
	exists: boolean;
}

export interface BookIndex {
	version: number;
	slug: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** Basename of the session file currently open (or null). */
	currentChapterFile: string | null;
	chapters: ChapterRef[];
}

/** Directory under ~/.pi/writer that holds all book session transcripts. */
export function getSessionsRoot(): string {
	return join(getWriterDir(), "sessions");
}

/** Directory holding one book's chapter sessions: ~/.pi/writer/sessions/<slug>/. */
export function getBookSessionsDir(slug: string): string {
	return join(getSessionsRoot(), slug);
}

/** Absolute path of a chapter's session file. */
export function getChapterSessionsPath(slug: string, file: string): string {
	return join(getBookSessionsDir(slug), file);
}

function nextChapterId(index: BookIndex): string {
	const n = index.chapters.length + 1;
	return `ch${n.toString().padStart(2, "0")}`;
}

async function safeReadJson<T>(file: string): Promise<T | null> {
	try {
		const raw = await readFile(file, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function safeWriteJson(file: string, value: unknown): Promise<void> {
	await atomicWriteFile(file, JSON.stringify(value, null, 2));
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export interface BookListEntry {
	slug: string;
	title: string;
	chapters: number;
	updatedAt: number;
}

/** List all books under the writer books dir. */
export async function listBooks(): Promise<BookListEntry[]> {
	const booksDir = getBooksDir();
	if (!existsSync(booksDir)) return [];
	const entries = await readdir(booksDir, { withFileTypes: true });
	const out: BookListEntry[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const indexPath = join(getBookDir(entry.name), BOOK_INDEX_FILE);
		const idx = await safeReadJson<BookIndex>(indexPath);
		if (idx) {
			out.push({
				slug: idx.slug ?? entry.name,
				title: idx.title ?? entry.name,
				chapters: idx.chapters?.length ?? 0,
				updatedAt: idx.updatedAt ?? 0,
			});
		}
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/** Load a book's index, or null if it does not exist. */
export async function loadBook(slug: string): Promise<BookIndex | null> {
	const indexPath = join(getBookDir(slug), BOOK_INDEX_FILE);
	const idx = await safeReadJson<BookIndex>(indexPath);
	if (!idx) return null;
	// Sync existence flags onto current state.
	const enriched = {
		...idx,
		chapters: await Promise.all(
			idx.chapters.map(async (ch) => ({ ...ch, exists: await exists(getChapterSessionsPath(slug, ch.file)) })),
		),
	};
	return enriched;
}

async function writeBook(index: BookIndex): Promise<void> {
	const indexPath = join(getBookDir(index.slug), BOOK_INDEX_FILE);
	index.updatedAt = Date.now();
	await safeWriteJson(indexPath, index);
}

/** Create a new book workspace directory with an empty world (world.json + md views) and a first chapter. */
export async function createBook(title: string): Promise<BookIndex> {
	const slug = slugify(title);
	const baseSlug = slug;
	const booksDir = getBooksDir();
	await mkdir(booksDir, { recursive: true });

	// De-duplicate slug if a directory already exists.
	let unique = baseSlug;
	let i = 2;
	while (await exists(getBookDir(unique))) {
		unique = `${baseSlug}-${i}`;
		i++;
	}

	const bookDir = getBookDir(unique);
	await mkdir(bookDir, { recursive: true });
	await mkdir(join(bookDir, "draft"), { recursive: true });
	await mkdir(join(bookDir, "notes"), { recursive: true });
	await mkdir(join(bookDir, ".writer"), { recursive: true });

	const now = Date.now();
	const chapterId = nextChapterId({
		version: INDEX_VERSION,
		slug: unique,
		title,
		createdAt: now,
		updatedAt: now,
		currentChapterFile: null,
		chapters: [],
	});
	const chapterFile = `${chapterId}.jsonl`;

	const index: BookIndex = {
		version: INDEX_VERSION,
		slug: unique,
		title: title.trim(),
		createdAt: now,
		updatedAt: now,
		currentChapterFile: chapterFile,
		chapters: [
			{
				id: chapterId,
				file: chapterFile,
				title: "第一章",
				label: "草稿",
				createdAt: now,
				updatedAt: now,
				exists: false,
			},
		],
	};

	await mkdir(getBookSessionsDir(unique), { recursive: true });
	// world.json 初始结构 + md 视图(世界书组件化;视图由 saveWorld 自动写出)
	await saveWorld(unique, createEmptyWorld());
	await writeBook(index);
	return index;
}

/** Ensure a book exists for a slug, creating it (titled with the slug) if absent. */
export async function ensureBook(slug: string, displayTitle?: string): Promise<BookIndex> {
	const existing = await loadBook(slug);
	if (existing) return existing;
	return createBook(displayTitle ?? slug);
}

/** Add a new chapter to a book. Returns the new chapter ref. */
export async function addChapter(slug: string, title: string, label: string | null = "草稿"): Promise<ChapterRef> {
	const index = await loadBook(slug);
	if (!index) throw new Error(`Book not found: ${slug}`);
	const chapterId = nextChapterId(index);
	const chapterFile = `${chapterId}.jsonl`;
	const now = Date.now();
	const chapter: ChapterRef = {
		id: chapterId,
		file: chapterFile,
		title: title.trim() || `第 ${index.chapters.length + 1} 章`,
		label,
		createdAt: now,
		updatedAt: now,
		exists: false,
	};
	index.chapters.push(chapter);
	index.currentChapterFile = chapterFile;
	await writeBook(index);
	return chapter;
}

/** Update a chapter's title/label and bump its updatedAt. */
export async function updateChapter(
	slug: string,
	selector: string,
	patch: Partial<Pick<ChapterRef, "title" | "label">>,
): Promise<BookIndex> {
	const index = await loadBook(slug);
	if (!index) throw new Error(`Book not found: ${slug}`);
	const ch = resolveChapter(index, selector);
	if (!ch) throw new Error(`Chapter not found: ${selector}`);
	if (patch.title !== undefined) ch.title = patch.title.trim();
	if (patch.label !== undefined) ch.label = patch.label;
	ch.updatedAt = Date.now();
	await writeBook(index);
	return index;
}

/**
 * Rename a book: re-slugify the title, migrate the book workspace and its
 * session transcripts to the new slug, and rewrite book.json. Chapters keep
 * their files (chNN.jsonl) — only the containing directories move.
 * Returns the renamed book index.
 */
export async function renameBook(slug: string, newTitle: string): Promise<BookIndex> {
	const index = await loadBook(slug);
	if (!index) throw new Error(`Book not found: ${slug}`);
	const title = newTitle.trim();
	if (!title) throw new Error("Book title cannot be empty");
	const newSlug = slugify(title);
	if (newSlug === slug) {
		// 标题变了但 slug 不变:只更新 title
		index.title = title;
		await writeBook(index);
		const reloaded = await loadBook(slug);
		if (!reloaded) throw new Error(`Book index lost after rename: ${slug}`);
		return reloaded;
	}
	// 新 slug 与已有目录冲突(排除自身)时追加 -2/-3 后缀,与 createBook 一致
	let unique = newSlug;
	let i = 2;
	while (await exists(getBookDir(unique))) {
		unique = `${newSlug}-${i}`;
		i++;
	}
	// 迁移工作区与会话目录;world.json/.writer/*.md 随目录整体移动
	const oldBookDir = getBookDir(slug);
	const newBookDir = getBookDir(unique);
	await rename(oldBookDir, newBookDir);
	const oldSessionsDir = getBookSessionsDir(slug);
	const newSessionsDir = getBookSessionsDir(unique);
	if (await exists(oldSessionsDir)) {
		await mkdir(getSessionsRoot(), { recursive: true });
		await rename(oldSessionsDir, newSessionsDir);
	}
	// 重写 book.json 的 slug/title(参考 normalizeImportBookJson 的改写样板)
	index.slug = unique;
	index.title = title;
	await writeBook(index);
	const reloaded = await loadBook(unique);
	if (!reloaded) throw new Error(`Book index lost after rename: ${unique}`);
	return reloaded;
}

/** Mark a chapter as the current chapter (used after a session switch). */
export async function setCurrentChapter(slug: string, file: string): Promise<BookIndex> {
	const index = await loadBook(slug);
	if (!index) throw new Error(`Book not found: ${slug}`);
	if (!index.chapters.some((c) => c.file === file)) {
		throw new Error(`Chapter file not in book index: ${file}`);
	}
	index.currentChapterFile = file;
	await writeBook(index);
	return index;
}

/** Ensure an empty chapter session file exists with a valid pi header. */
export async function initChapterFile(absPath: string, cwd: string): Promise<void> {
	if (existsSync(absPath)) return;
	await mkdir(join(absPath, ".."), { recursive: true });
	const header = {
		type: "session" as const,
		version: SESSION_VERSION,
		id: uuidv7(),
		timestamp: new Date().toISOString(),
		cwd,
	};
	await writeFile(absPath, `${JSON.stringify(header)}\n`, "utf-8");
}

/** Resolve a chapter by 1-based index, id ("ch01"), or file basename. */
export function resolveChapter(index: BookIndex, selector: string): ChapterRef | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const byIndex = Number.parseInt(trimmed, 10);
	if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= index.chapters.length) {
		return index.chapters[byIndex - 1];
	}
	return index.chapters.find((c) => c.id === trimmed || c.file === trimmed || c.file === `${trimmed}.jsonl`);
}
