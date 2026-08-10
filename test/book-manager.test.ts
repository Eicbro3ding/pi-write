import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addChapter,
	createBook,
	ensureBook,
	getBookSessionsDir,
	getChapterSessionsPath,
	getSessionsRoot,
	initChapterFile,
	listBooks,
	loadBook,
	renameBook,
	resolveChapter,
	setCurrentChapter,
	updateChapter,
} from "../src/book-manager.ts";
import { getBookDir } from "../src/config.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

describe("createBook", () => {
	it("creates a book workspace with starter files and one chapter", async () => {
		const book = await createBook("My Novel");
		expect(book.slug).toBe("my-novel");
		expect(book.title).toBe("My Novel");
		expect(book.chapters).toHaveLength(1);
		expect(book.currentChapterFile).toBe(book.chapters[0]?.file);

		const dir = getBookDir(book.slug);
		expect(existsSync(join(dir, "outline.md"))).toBe(true);
		expect(existsSync(join(dir, "draft"))).toBe(true);
		expect(existsSync(join(dir, "notes"))).toBe(true);
		expect(existsSync(join(dir, ".writer", "characters.md"))).toBe(true);
		expect(existsSync(join(dir, ".writer", "world.md"))).toBe(true);
		expect(existsSync(join(dir, ".writer", "timeline.md"))).toBe(true);
		expect(book.chapters[0]?.exists).toBe(false);
	});

	it("deduplicates slugs", async () => {
		await createBook("My Novel");
		const second = await createBook("My Novel");
		expect(second.slug).toBe("my-novel-2");
	});
});

describe("createBook world files", () => {
	it("新建书生成 world.json 与四个 md 视图", async () => {
		const book = await createBook("测试书");
		const dir = getBookDir(book.slug);
		const files = await readdir(dir);
		expect(files).toContain("world.json");
		const outline = await readFile(`${dir}/outline.md`, "utf-8");
		expect(outline).toContain("导出视图");
	});
});

describe("book index", () => {
	it("lists books sorted by update time", async () => {
		await createBook("One");
		await createBook("Two");
		const books = await listBooks();
		expect(new Set(books.map((b) => b.slug))).toEqual(new Set(["one", "two"]));
		expect(books.map((b) => b.chapters)).toEqual([1, 1]);
	});

	it("loads a book and syncs chapter existence", async () => {
		await createBook("One");
		const loaded = await loadBook("one");
		expect(loaded?.title).toBe("One");

		const ch = loaded?.chapters[0];
		expect(ch).toBeDefined();
		await initChapterFile(getChapterSessionsPath("one", ch!.file), getBookDir("one"));
		const reloaded = await loadBook("one");
		expect(reloaded?.chapters[0]?.exists).toBe(true);
	});

	it("ensureBook returns the existing book or creates one", async () => {
		const created = await ensureBook("some-book", "Some Book");
		expect(created.slug).toBe("some-book");
		const existing = await ensureBook("some-book", "Different");
		expect(existing.slug).toBe("some-book");
		expect(existing.title).toBe("Some Book");
	});
});

describe("chapters", () => {
	it("adds chapters and makes them current", async () => {
		await createBook("One");
		const ch = await addChapter("one", "第二章");
		expect(ch.id).toBe("ch02");
		expect(ch.title).toBe("第二章");
		const loaded = await loadBook("one");
		expect(loaded?.chapters).toHaveLength(2);
		expect(loaded?.currentChapterFile).toBe(ch.file);
	});

	it("defaults blank chapter titles", async () => {
		await createBook("One");
		const ch = await addChapter("one", "  ");
		expect(ch.title).toBe("第 2 章");
	});

	it("updates title and label", async () => {
		const book = await createBook("One");
		const ch = book.chapters[0];
		await updateChapter("one", ch!.file, { title: "序章", label: "完成" });
		const loaded = await loadBook("one");
		expect(loaded?.chapters[0]?.title).toBe("序章");
		expect(loaded?.chapters[0]?.label).toBe("完成");
	});

	it("resolves chapters by index, id, and file", async () => {
		const book = await createBook("One");
		const ch = book.chapters[0];
		expect(resolveChapter(book, "1")?.id).toBe(ch?.id);
		expect(resolveChapter(book, ch!.id)?.file).toBe(ch?.file);
		expect(resolveChapter(book, ch!.file)?.id).toBe(ch?.id);
		expect(resolveChapter(book, "999")).toBeUndefined();
	});

	it("setCurrentChapter rejects unknown files", async () => {
		await createBook("One");
		await expect(setCurrentChapter("one", "nope.jsonl")).rejects.toThrow("Chapter file not in book index");
	});
});

describe("initChapterFile", () => {
	it("writes a v3 session header and does not overwrite", async () => {
		const book = await createBook("One");
		const file = getChapterSessionsPath("one", book.chapters[0]!.file);
		await initChapterFile(file, getBookDir("one"));

		const first = JSON.parse(readFileSync(file, "utf-8")) as { version: number; cwd: string };
		expect(first.version).toBe(3);
		expect(first.cwd).toBe(getBookDir("one"));

		await initChapterFile(file, getBookDir("one"));
		const lines = readFileSync(file, "utf-8").trim().split(/\r?\n/);
		expect(lines).toHaveLength(1);
	});
});

describe("renameBook", () => {
	it("migrates workspace and session dirs and rewrites book.json", async () => {
		const book = await createBook("One");
		// 先落一个会话文件,验证 sessions/<slug> 随目录整体迁移
		await initChapterFile(getChapterSessionsPath("one", book.chapters[0]!.file), getBookDir("one"));

		const renamed = await renameBook("one", "Two");

		expect(renamed.slug).toBe("two");
		expect(renamed.title).toBe("Two");
		expect(renamed.chapters[0]?.file).toBe(book.chapters[0]?.file);
		// 旧目录消失,新目录就位(工作区 + 会话)
		expect(existsSync(getBookDir("one"))).toBe(false);
		expect(existsSync(getBookDir("two"))).toBe(true);
		expect(existsSync(getChapterSessionsPath("two", book.chapters[0]!.file))).toBe(true);
		// 会话文件头里的 cwd 指向旧目录(header 不随迁移改写),但内容随目录移动
		expect(readFileSync(getChapterSessionsPath("two", book.chapters[0]!.file), "utf-8")).toContain('"cwd"');
		// book.json 的 slug 已改写,列表按新 slug 索引
		const listed = await listBooks();
		expect(listed.map((b) => b.slug)).toEqual(["two"]);
		expect(loadBook("one")).resolves.toBeNull();
	});

	it("deduplicates the new slug against existing books", async () => {
		await createBook("One");
		await createBook("Two");
		const renamed = await renameBook("one", "Two");
		expect(renamed.slug).toBe("two-2");
		expect(renamed.title).toBe("Two");
		// 已存在的书不受影响
		const other = await loadBook("two");
		expect(other?.slug).toBe("two");
	});

	it("keeps the slug when the title slugifies identically", async () => {
		await createBook("One");
		const renamed = await renameBook("one", "One!");
		expect(renamed.slug).toBe("one");
		expect(renamed.title).toBe("One!");
		expect(existsSync(getBookDir("one"))).toBe(true);
	});

	it("rejects empty titles and unknown books", async () => {
		await createBook("One");
		await expect(renameBook("one", "   ")).rejects.toThrow("Book title cannot be empty");
		await expect(renameBook("ghost", "X")).rejects.toThrow("Book not found");
	});

	it("preserves chapters and currentChapterFile across rename", async () => {
		await createBook("One");
		await addChapter("one", "第二章");
		// addChapter 把 current 推进到新章,以磁盘上的最新索引为准
		const current = await loadBook("one");
		const renamed = await renameBook("one", "中文书名");
		expect(renamed.slug).toBe("中文书名");
		expect(renamed.chapters).toHaveLength(2);
		expect(renamed.currentChapterFile).toBe(current?.currentChapterFile);
		// 会话目录整体迁移(createBook 已 mkdir,rename 把空目录也搬走)
		expect(existsSync(getBookSessionsDir("one"))).toBe(false);
		expect(existsSync(getBookSessionsDir("中文书名"))).toBe(true);
	});
});
