import { describe, expect, it } from "vitest";
import { classifyToolCall, parseToolArgs, pathFromArgs } from "../web/src/preview.ts";

describe("classifyToolCall", () => {
	it("write/edit 到 draft/*.md → draft", () => {
		expect(classifyToolCall("write", "draft/ch01.md")).toBe("draft");
		expect(classifyToolCall("edit", "draft/ch02.md")).toBe("draft");
	});
	it("world_update → world(无 path)", () => {
		expect(classifyToolCall("world_update", undefined)).toBe("world");
	});
	it("write/edit 直写 world.json → world", () => {
		expect(classifyToolCall("write", "world.json")).toBe("world");
	});
	it("write 到 .writer/*.md 等其他文件 → null", () => {
		expect(classifyToolCall("write", ".writer/characters.md")).toBeNull();
	});
	it("非编辑工具 → null", () => {
		expect(classifyToolCall("read", "draft/ch01.md")).toBeNull();
		expect(classifyToolCall("edit", undefined)).toBeNull();
		expect(classifyToolCall("word_count", undefined)).toBeNull();
	});
});

describe("parseToolArgs / pathFromArgs", () => {
	it("字符串 JSON 解析为对象", () => {
		expect(parseToolArgs('{"path":"draft/ch01.md","content":"x"}')).toEqual({
			path: "draft/ch01.md",
			content: "x",
		});
	});
	it("对象原样返回", () => {
		const o = { path: "draft/ch01.md" };
		expect(parseToolArgs(o)).toBe(o);
	});
	it("非法输入 → null", () => {
		expect(parseToolArgs("not json")).toBeNull();
		expect(parseToolArgs(42)).toBeNull();
		expect(parseToolArgs(null)).toBeNull();
		expect(parseToolArgs(["a"])).toBeNull();
	});
	it("pathFromArgs 取 path 字段", () => {
		expect(pathFromArgs({ path: "draft/ch01.md" })).toBe("draft/ch01.md");
		expect(pathFromArgs({})).toBeUndefined();
		expect(pathFromArgs({ path: 42 })).toBeUndefined();
	});
});

import { buildDraftDiff } from "../web/src/preview.ts";

describe("buildDraftDiff", () => {
	it("中间插入行:上下文 + 新增", () => {
		expect(buildDraftDiff("a\nb", "a\nc\nb")).toEqual([
			{ kind: "context", text: "a" },
			{ kind: "add", text: "c" },
			{ kind: "context", text: "b" },
		]);
	});
	it("空 before(新建文件)→ 全部为新增", () => {
		expect(buildDraftDiff("", "x\ny")).toEqual([
			{ kind: "add", text: "x" },
			{ kind: "add", text: "y" },
		]);
	});
	it("空 after(清空文件)→ 全部为删除", () => {
		expect(buildDraftDiff("x\ny", "")).toEqual([
			{ kind: "remove", text: "x" },
			{ kind: "remove", text: "y" },
		]);
	});
	it("全量重写 → 删旧增新", () => {
		const d = buildDraftDiff("old", "new");
		expect(d.some((l) => l.kind === "remove" && l.text === "old")).toBe(true);
		expect(d.some((l) => l.kind === "add" && l.text === "new")).toBe(true);
	});
	it("空 both → 空数组", () => {
		expect(buildDraftDiff("", "")).toEqual([]);
	});
	it("尾部换行不产生空行条目", () => {
		expect(buildDraftDiff("a\n", "a\nb\n")).toEqual([
			{ kind: "context", text: "a" },
			{ kind: "add", text: "b" },
		]);
	});
});

import { buildWorldDiff, entryChanged, relationChanged } from "../web/src/preview.ts";
import type { WorldDataDto, WorldEntryDto, WorldRelationDto } from "../web/src/types.ts";

function entry(id: string, patch: Partial<WorldEntryDto> = {}): WorldEntryDto {
	return {
		id,
		type: "character",
		title: id,
		keys: [],
		chapters: [],
		status: "active",
		active: true,
		parent: null,
		tags: [],
		body: "",
		avatar: null,
		images: [],
		updatedAt: 0,
		...patch,
	};
}

function rel(id: string, from: string, to: string, patch: Partial<WorldRelationDto> = {}): WorldRelationDto {
	return { id, from, to, type: "盟友", label: "", emphasized: false, arrow: "double", ...patch };
}

function world(entries: WorldEntryDto[], relations: WorldRelationDto[] = []): WorldDataDto {
	return {
		version: 1,
		entries,
		relations,
		constraints: [],
		styleSample: null,
		notice: { text: "", enabled: false, updatedAt: 0 },
		storyline: { enabled: false, nodes: [] },
		timeline: [],
	};
}

describe("buildWorldDiff", () => {
	it("新增/删除/修改条目分别归位", () => {
		const before = world([entry("a"), entry("b"), entry("c")]);
		const after = world([entry("a"), entry("b", { body: "新正文" }), entry("d")]);
		const d = buildWorldDiff(before, after);
		expect(d.addedEntries.map((e) => e.id)).toEqual(["d"]);
		expect(d.removedEntries.map((e) => e.id)).toEqual(["c"]);
		expect(d.modifiedEntries.map((e) => e.id)).toEqual(["b"]);
	});
	it("仅 updatedAt 变化不算修改", () => {
		const before = world([entry("a", { updatedAt: 1 })]);
		const after = world([entry("a", { updatedAt: 2 })]);
		expect(buildWorldDiff(before, after).modifiedEntries).toEqual([]);
	});
	it("关系新增/删除/修改分别归位;条目删除的连带关系归入 removedRelations", () => {
		const before = world([entry("a"), entry("b")], [rel("r1", "a", "b"), rel("r2", "a", "b")]);
		const after = world([entry("a"), entry("b")], [rel("r1", "a", "b"), rel("r3", "b", "a"), rel("r2", "a", "b", { emphasized: true })]);
		const d = buildWorldDiff(before, after);
		expect(d.addedRelations.map((r) => r.id)).toEqual(["r3"]);
		expect(d.removedRelations.map((r) => r.id)).toEqual([]);
		expect(d.modifiedRelations.map((r) => r.id)).toEqual(["r2"]);
		const afterDel = world([entry("a")]);
		const d2 = buildWorldDiff(world([entry("a"), entry("b")], [rel("r4", "a", "b")]), afterDel);
		expect(d2.removedRelations.map((r) => r.id)).toEqual(["r4"]);
	});
});

describe("entryChanged / relationChanged", () => {
	it("body/title/status 变化算修改", () => {
		expect(entryChanged(entry("a"), entry("a", { body: "x" }))).toBe(true);
		expect(entryChanged(entry("a"), entry("a", { title: "改名" }))).toBe(true);
		expect(entryChanged(entry("a"), entry("a", { status: "dead" }))).toBe(true);
		expect(entryChanged(entry("a"), entry("a"))).toBe(false);
	});
	it("关系 emphasized/arrow 变化算修改", () => {
		expect(relationChanged(rel("r1", "a", "b"), rel("r1", "a", "b", { emphasized: true }))).toBe(true);
		expect(relationChanged(rel("r1", "a", "b"), rel("r1", "a", "b", { arrow: "single" }))).toBe(true);
		expect(relationChanged(rel("r1", "a", "b"), rel("r1", "a", "b"))).toBe(false);
	});
});

import { classifyWorldChange } from "../web/src/preview.ts";
import type { WorldDiff } from "../web/src/preview.ts";

const emptyWorldDiff: WorldDiff = {
	addedEntries: [],
	modifiedEntries: [],
	removedEntries: [],
	addedRelations: [],
	removedRelations: [],
	modifiedRelations: [],
};

describe("classifyWorldChange", () => {
	it("新增/删除条目 → graph", () => {
		expect(classifyWorldChange({ ...emptyWorldDiff, addedEntries: [entry("d")] })).toEqual({ mode: "graph" });
		expect(classifyWorldChange({ ...emptyWorldDiff, removedEntries: [entry("c")] })).toEqual({ mode: "graph" });
	});
	it("关系增/删/改 → graph", () => {
		expect(classifyWorldChange({ ...emptyWorldDiff, addedRelations: [rel("r9", "a", "b")] })).toEqual({ mode: "graph" });
		expect(classifyWorldChange({ ...emptyWorldDiff, removedRelations: [rel("r9", "a", "b")] })).toEqual({ mode: "graph" });
		expect(classifyWorldChange({ ...emptyWorldDiff, modifiedRelations: [rel("r9", "a", "b", { emphasized: true })] })).toEqual({ mode: "graph" });
	});
	it("仅词条内容修改 → entry", () => {
		expect(classifyWorldChange({ ...emptyWorldDiff, modifiedEntries: [entry("a", { body: "x" })] })).toEqual({ mode: "entry" });
	});
	it("非词条变更(空 diff)→ null(不弹卡)", () => {
		expect(classifyWorldChange(emptyWorldDiff)).toBeNull();
	});
});
