import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flattenWorldTree, parseWorldBook, renderWorldTree, renderWorldTreeFromData } from "../src/world-tree.ts";
import type { WorldEntry } from "../src/world-data.ts";

let tmp: string;
let bookDir: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-test-"));
	bookDir = join(tmp, "book");
	mkdirSync(join(bookDir, ".writer"), { recursive: true });
	writeFileSync(
		join(bookDir, ".writer", "characters.md"),
		[
			"# 人物档案",
			"",
			"## 林婉",
			"- 身份: 主角",
			"",
			"### 女儿",
			"parent: 林婉",
			"- 身份: 配角",
			"",
			"## 陈默",
			"",
		].join("\n"),
		"utf-8",
	);
	writeFileSync(join(bookDir, ".writer", "world.md"), "# 世界设定\n\n## 临江城\n", "utf-8");
	writeFileSync(join(bookDir, "outline.md"), "# 大纲\n\n## 第一章\n", "utf-8");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("parseWorldBook", () => {
	it("parses files, kinds, and missing files", async () => {
		const nodes = await parseWorldBook(bookDir);
		expect(nodes.map((n) => n.kind).sort()).toEqual([
			"character",
			"character",
			"character",
			"character",
			"outline",
			"outline",
			"world",
			"world",
		]);
		expect(nodes.some((n) => n.title === "临江城")).toBe(true);
	});

	it("links explicit parent headings", async () => {
		const nodes = await parseWorldBook(bookDir);
		const linWan = nodes.find((n) => n.title === "林婉");
		expect(linWan).toBeDefined();
		expect(linWan?.children.map((c) => c.title)).toEqual(["女儿"]);
		expect(nodes.find((n) => n.title === "女儿")?.parent).toBe("林婉");
	});

	it("returns an empty list for a missing world book", async () => {
		const nodes = await parseWorldBook(join(tmp, "empty"));
		expect(nodes).toEqual([]);
	});
});

describe("renderWorldTree", () => {
	it("flattens and renders roots with connectors", async () => {
		const nodes = await parseWorldBook(bookDir);
		const flat = flattenWorldTree(nodes);
		expect(flat[0]?.title).toBe("人物档案");
		expect(flat[0]?.children.map((c) => c.title)).toContain("林婉");

		const lines = renderWorldTree(nodes);
		expect(lines[0]).toBe("📖 人物档案");
		expect(lines.some((l) => l.includes("└─ 林婉") || l.includes("├─ 林婉"))).toBe(true);
		expect(lines.some((l) => l.includes("女儿"))).toBe(true);
	});
});

describe("renderWorldTreeFromData", () => {
	it("parent 引用转 children 树", () => {
		const entries: WorldEntry[] = [
			{ id: "a", type: "character", title: "林婉", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0 },
			{ id: "b", type: "character", title: "林父", keys: [], chapters: [], status: "alive", active: true, parent: "a", tags: [], body: "", updatedAt: 0 },
		];
		const tree = renderWorldTreeFromData(entries);
		expect(tree.find((n) => n.id === "a")?.children.map((c) => c.title)).toEqual(["林父"]);
	});
	it("parent 悬空条目降级为根", () => {
		const entries: WorldEntry[] = [
			{ id: "a", type: "character", title: "孤", keys: [], chapters: [], status: "alive", active: true, parent: "ghost", tags: [], body: "", updatedAt: 0 },
		];
		const tree = renderWorldTreeFromData(entries);
		expect(tree[0]?.parent).toBeNull();
	});
});
