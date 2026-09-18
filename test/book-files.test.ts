/**
 * 书目录文件清单测试(临时磁盘目录,真实读写):
 * 覆盖语义分组、只读标记、章节标题映射、实现细节/机器数据的排除、
 * 深度上限与符号链接不跟随。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BOOK_FILE_GROUPS,
	MAX_READ_BYTES,
	classifyBookFileGroup,
	classifyBookFileKind,
	isGeneratedView,
	isWorkspaceFile,
	listBookFiles,
	readWorkspaceText,
	statWorkspaceFile,
} from "../src/book-files.ts";

let dir: string;

/** 写文件(父目录自动创建);返回书目录相对路径。 */
function put(rel: string, content = "x"): string {
	const abs = join(dir, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
	return rel;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "piw-files-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("classifyBookFileGroup / kind", () => {
	it("草稿 / 资料与笔记 / 图片 / 其他", () => {
		expect(classifyBookFileGroup("draft/ch01.md")).toBe("draft");
		expect(classifyBookFileGroup("memory.md")).toBe("notes");
		expect(classifyBookFileGroup("notes/资料/参考.md")).toBe("notes");
		expect(classifyBookFileGroup("images/cover.png")).toBe("image");
		expect(classifyBookFileGroup("advice.md")).toBe("other");
	});

	it("生成物判定(世界书导出的镜像,清单与读取都排除)", () => {
		expect(isGeneratedView("outline.md")).toBe(true);
		expect(isGeneratedView(".writer/characters.md")).toBe(true);
		expect(isGeneratedView(".writer/timeline.md")).toBe(true);
		expect(isGeneratedView("draft/ch01.md")).toBe(false);
		expect(isGeneratedView("notes/资料.md")).toBe(false);
		// 生成物在调用方已被排除,分组函数对它只剩兜底语义
		expect(classifyBookFileGroup("outline.md")).toBe("other");
	});

	it("类型判据:文本 / 图片 / 其他二进制", () => {
		expect(classifyBookFileKind("draft/ch01.md")).toBe("text");
		expect(classifyBookFileKind("images/cover.PNG")).toBe("image");
		expect(classifyBookFileKind("notes/ref.docx")).toBe("binary");
		expect(classifyBookFileKind("notes/data.csv")).toBe("text");
	});
});

describe("listBookFiles", () => {
	it("目录不存在 → 空数组(不抛错)", async () => {
		await expect(listBookFiles(join(dir, "no-such-book"))).resolves.toEqual([]);
	});

	it("按语义分组,排除实现文件、机器数据与世界书生成物", async () => {
		put("book.json", "{}");
		put("world.json", "{}");
		put("cast.json", "{}");
		put("advice.md");
		put("outline.md");
		put("memory.md");
		put("draft/ch01.md");
		put("notes/资料/参考.md");
		put("images/cover.png");
		put(".writer/characters.md");
		put(".writer/timeline.md");
		put("stage/last-world-edit.json", "{}");
		put("stage/scene1.jsonl");
		put("sessions/ch01.jsonl");
		put("agent/auth.json", "{}");
		put("node_modules/dep/index.js");
		put(".hidden.md");
		put("log.jsonl");

		const files = await listBookFiles(dir);
		const paths = files.map((f) => f.path).sort();

		expect(paths).toEqual([
			"advice.md",
			"draft/ch01.md",
			"images/cover.png",
			"memory.md",
			"notes/资料/参考.md",
		]);
		// 实现细节、机器数据、生成物一个都不该出现
		for (const hidden of [
			"book.json", "world.json", "cast.json",
			"sessions/ch01.jsonl", "agent/auth.json", "log.jsonl", ".hidden.md",
			"outline.md", ".writer/characters.md", ".writer/timeline.md",
		]) {
			expect(paths).not.toContain(hidden);
		}
		expect(paths.some((p) => p.startsWith("stage/") || p.startsWith("node_modules/"))).toBe(false);
		// advice.md 是人可读的中间产物(编剧给导演的建议):保留,归「其他」
		expect(files.find((f) => f.path === "advice.md")?.group).toBe("other");
	});

	it("世界书生成物不进清单(时间线/人物档案/大纲在世界书页看才是权威视图)", async () => {
		put("outline.md", "# 大纲\n\n- 由世界书导出");
		put(".writer/timeline.md", "# 时间线");
		put(".writer/characters.md", "# 人物档案");
		put(".writer/world.md", "# 世界设定");
		put("notes/AI 收的资料.md");
		const files = await listBookFiles(dir);
		expect(files.map((f) => f.path)).toEqual(["notes/AI 收的资料.md"]);
	});

	it("分组、章节标题、类型齐全", async () => {
		put("draft/ch01.md", "正文一");
		put("draft/ch02.md", "正文二");
		put("images/a.png");
		put("notes/ref.docx");
		const files = await listBookFiles(dir, [
			{ id: "ch01", title: "第一章 · 夜航船" },
			{ id: "ch02", title: "第二章 · 雾港" },
		]);
		const byPath = new Map(files.map((f) => [f.path, f]));

		const ch1 = byPath.get("draft/ch01.md")!;
		expect(ch1).toMatchObject({
			group: "draft",
			kind: "text",
			chapterId: "ch01",
			chapterTitle: "第一章 · 夜航船",
			name: "ch01.md",
		});
		expect(ch1.bytes).toBeGreaterThan(0);
		expect(ch1.mtime).toBeGreaterThan(0);

		// 未登记的草稿:标题回退章节 id,不丢条目
		put("draft/ch99.md");
		const withExtra = await listBookFiles(dir, [{ id: "ch01", title: "第一章 · 夜航船" }]);
		expect(withExtra.find((f) => f.path === "draft/ch99.md")).toMatchObject({
			group: "draft",
			chapterId: "ch99",
			chapterTitle: "ch99",
		});

		expect(byPath.get("images/a.png")).toMatchObject({ group: "image", kind: "image", title: "a.png" });
		expect(byPath.get("notes/ref.docx")).toMatchObject({ group: "notes", kind: "binary", title: "ref.docx" });
	});

	it("展示名:草稿用章节标题,其余用文件名", async () => {
		put("draft/ch01.md");
		put("notes/AI 收的资料.md");
		put("advice.md");
		const files = await listBookFiles(dir, [{ id: "ch01", title: "第一章 · 夜航船" }]);
		const byPath = new Map(files.map((f) => [f.path, f.title]));
		expect(byPath.get("draft/ch01.md")).toBe("第一章 · 夜航船");
		expect(byPath.get("notes/AI 收的资料.md")).toBe("AI 收的资料.md");
		expect(byPath.get("advice.md")).toBe("advice.md");
	});

	it("排序:分组顺序 → 草稿按章节顺序 → 组内 mtime 倒序", async () => {
		put("draft/ch02.md");
		put("draft/ch01.md");
		put("images/old.png");
		put("images/new.png");
		put("notes/b.md");
		put("notes/a.md");
		const files = await listBookFiles(dir, [
			{ id: "ch01", title: "一" },
			{ id: "ch02", title: "二" },
		]);
		expect(files.slice(0, 2).map((f) => f.path)).toEqual(["draft/ch01.md", "draft/ch02.md"]);
		// 分组顺序严格按 BOOK_FILE_GROUPS 声明序
		const order = BOOK_FILE_GROUPS.map((g) => g.id);
		const seen = files.map((f) => order.indexOf(f.group));
		expect([...seen]).toEqual([...seen].sort((a, b) => a - b));
	});

	it("符号链接不跟随(链接可指向书目录外)", async () => {
		put("draft/ch01.md");
		const outside = mkdtempSync(join(tmpdir(), "piw-outside-"));
		writeFileSync(join(outside, "secret.md"), "不该被书目录看到", "utf8");
		try {
			symlinkSync(outside, join(dir, "linked"), "dir");
			symlinkSync(join(outside, "secret.md"), join(dir, "leak.md"), "file");
			const files = await listBookFiles(dir);
			expect(files.map((f) => f.path)).toEqual(["draft/ch01.md"]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("深度上限:过深的目录不再下探,同层文件仍收录", async () => {
		put("notes/d1/d2/d3/keep.md");
		put("notes/d1/d2/d3/d4/skip.md");
		const files = await listBookFiles(dir);
		const paths = files.map((f) => f.path);
		expect(paths).toContain("notes/d1/d2/d3/keep.md");
		expect(paths).not.toContain("notes/d1/d2/d3/d4/skip.md");
	});

	it("清单里列得出来的,isWorkspaceFile 一律放行(两侧规则同源)", async () => {
		put("draft/ch01.md");
		put("notes/资料/a.md");
		put("images/a.png");
		put(".writer/characters.md");
		put("outline.md");
		put("advice.md");
		put("cast.json");
		put("draft/no.txt", "纯文本");
		put("notes/图.svg");
		const files = await listBookFiles(dir);
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) expect(isWorkspaceFile(f.path)).toBe(true);
		expect(isWorkspaceFile("cast.json")).toBe(false);
		expect(isWorkspaceFile("outline.md")).toBe(false);
	});
});

describe("isWorkspaceFile(读取端路径校验)", () => {
	it("拒绝越界与非法形态", () => {
		for (const bad of [
			"",
			"../secrets.md",
			"draft/../../secrets.md",
			"notes/./a.md",
			"notes//a.md",
			"/etc/passwd",
			"C:/windows/system32/config",
			"a\0b.md",
		]) {
			expect(isWorkspaceFile(bad), bad).toBe(false);
		}
	});

	it("拒绝隐藏文件/目录、jsonl、根级机器数据与世界书生成物", () => {
		expect(isWorkspaceFile(".hidden.md")).toBe(false);
		expect(isWorkspaceFile(".git/config")).toBe(false);
		expect(isWorkspaceFile("notes/.cache/x.md")).toBe(false);
		expect(isWorkspaceFile("logs/ch01.jsonl")).toBe(false);
		expect(isWorkspaceFile("world.json")).toBe(false);
		expect(isWorkspaceFile("book.json")).toBe(false);
		expect(isWorkspaceFile("cast.json")).toBe(false);
		expect(isWorkspaceFile("stage/scene.md")).toBe(false);
		// 生成物:清单里没有,读取端点也不该放行(两侧同源)
		expect(isWorkspaceFile(".writer/characters.md")).toBe(false);
		expect(isWorkspaceFile("outline.md")).toBe(false);
	});

	it("放行正常工作区文件(嵌套 world.json / outline 名不误伤)", () => {
		expect(isWorkspaceFile("draft/ch01.md")).toBe(true);
		expect(isWorkspaceFile("notes/资料/参考.md")).toBe(true);
		expect(isWorkspaceFile("notes/world.json")).toBe(true);
		expect(isWorkspaceFile("notes/outline.md")).toBe(true);
		expect(isWorkspaceFile("notes/图.svg")).toBe(true);
	});
});

describe("statWorkspaceFile / readWorkspaceText", () => {
	it("非法路径与不存在都返回 null", async () => {
		await expect(statWorkspaceFile(dir, "../x.md")).resolves.toBeNull();
		await expect(statWorkspaceFile(dir, "notes/none.md")).resolves.toBeNull();
		await expect(readWorkspaceText(dir, "../x.md")).resolves.toBeNull();
	});

	it("目录与符号链接都不是可读文件", async () => {
		put("draft/ch01.md");
		mkdirSync(join(dir, "notes"), { recursive: true });
		const outside = mkdtempSync(join(tmpdir(), "piw-out-"));
		writeFileSync(join(outside, "secret.md"), "外部内容", "utf8");
		try {
			symlinkSync(join(outside, "secret.md"), join(dir, "leak.md"), "file");
			symlinkSync(outside, join(dir, "notes", "linked"), "dir");
			await expect(statWorkspaceFile(dir, "leak.md")).resolves.toBeNull();
			await expect(readWorkspaceText(dir, "leak.md")).resolves.toBeNull();
			await expect(readWorkspaceText(dir, "notes/linked/secret.md")).resolves.toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("读文本:内容与元信息正确;二进制与图片返回 null", async () => {
		put("draft/ch01.md", "# 第一章\n\n正文。");
		const got = await readWorkspaceText(dir, "draft/ch01.md");
		expect(got).toMatchObject({ path: "draft/ch01.md", kind: "text", truncated: false });
		expect(got?.text).toBe("# 第一章\n\n正文。");
		expect(got?.bytes).toBeGreaterThan(0);
		expect(got?.mtime).toBeGreaterThan(0);
		put("notes/ref.docx", "假装是二进制");
		await expect(readWorkspaceText(dir, "notes/ref.docx")).resolves.toBeNull();
		put("images/a.png", "假装是图");
		await expect(readWorkspaceText(dir, "images/a.png")).resolves.toBeNull();
	});

	it("超过上限时截断并标记(不抛错)", async () => {
		put("notes/big.md", "x".repeat(MAX_READ_BYTES + 100));
		const got = await readWorkspaceText(dir, "notes/big.md");
		expect(got?.truncated).toBe(true);
		expect(got?.text.length).toBe(MAX_READ_BYTES);
		expect(got?.bytes).toBe(MAX_READ_BYTES + 100); // 元信息报真实大小
	});
});
