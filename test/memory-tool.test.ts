/**
 * memory 工具(Phase 3)的条目逻辑测试。
 *
 * 落盘/预算那层走 IO,这里只测纯度最高的部分:条目解析、单发与批量操作、
 * 以及两条硬纪律 —— 零命中报错、多命中列候选(绝不静默取首个)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMemoryOps, parseMemoryEntries, renderMemoryEntries, runMemory } from "../src/memory-tool.ts";

describe("memory:条目解析 / 渲染", () => {
	it("每行一条,忽略空行与纯空白行", () => {
		expect(parseMemoryEntries("- a\n\n   \n- b\n")).toEqual(["- a", "- b"]);
	});
	it("渲染带回尾换行;空数组 → 空串", () => {
		expect(renderMemoryEntries(["- a", "- b"])).toBe("- a\n- b\n");
		expect(renderMemoryEntries([])).toBe("");
	});
});

describe("memory:单发操作", () => {
	it("add 追加一条", () => {
		expect(applyMemoryOps(["- a"], [{ action: "add", content: "- b" }])).toEqual(["- a", "- b"]);
	});
	it("replace 按唯一子串改一条", () => {
		expect(applyMemoryOps(["- 陈锋活着", "- 林婉怕水"], [{ action: "replace", old_text: "陈锋", content: "- 陈锋已坠楼身亡" }])).toEqual([
			"- 陈锋已坠楼身亡",
			"- 林婉怕水",
		]);
	});
	it("remove 按子串删一条", () => {
		expect(applyMemoryOps(["- a", "- b"], [{ action: "remove", old_text: "- b" }])).toEqual(["- a"]);
	});
});

describe("memory:两条硬纪律", () => {
	it("零命中 → 报错并列出候选,不乱改", () => {
		expect(() => applyMemoryOps(["- a"], [{ action: "remove", old_text: "zzz" }])).toThrow(/没有条目包含/);
	});
	it("多命中 → 报错列候选,绝不静默取首个", () => {
		expect(() => applyMemoryOps(["- 陈锋活着", "- 陈锋已死"], [{ action: "remove", old_text: "陈锋" }])).toThrow(/命中多条/);
	});
	it("replace/remove 缺 old_text → 报错", () => {
		expect(() => applyMemoryOps(["- a"], [{ action: "replace", content: "- b" }])).toThrow(/需要 old_text/);
	});
});

describe("memory:批量(原子)", () => {
	it("一次调用里删旧 + 加新(按最终态)", () => {
		const out = applyMemoryOps(["- 旧1", "- 旧2"], [{ action: "remove", old_text: "旧1" }, { action: "add", content: "- 新" }]);
		expect(out).toEqual(["- 旧2", "- 新"]);
	});
	it("任一步失败整批抛错(调用方据此不落盘)", () => {
		expect(() => applyMemoryOps(["- a"], [{ action: "add", content: "- b" }, { action: "remove", old_text: "zzz" }])).toThrow();
	});
	it("不改入参(纯)", () => {
		const src = ["- a"];
		applyMemoryOps(src, [{ action: "add", content: "- b" }]);
		expect(src).toEqual(["- a"]);
	});
});

describe("memory:落盘 + 预算(runMemory)", () => {
	const dirs: string[] = [];
	function tmpFile(): string {
		const dir = mkdtempSync(join(tmpdir(), "piw-mem-"));
		dirs.push(dir);
		return join(dir, "memory.md");
	}
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("成功:写入文件并回终态文案", async () => {
		const file = tmpFile();
		const r = await runMemory(file, 1500, [{ action: "add", content: "- 陈锋已死" }], "跨章记忆(memory.md)");
		expect(r.ok).toBe(true);
		expect(r.text).toContain("已记入");
		expect((await readFile(file, "utf-8")).trim()).toBe("- 陈锋已死");
	});

	it("超预算 → 不写,返回现有条目 + 整合指引", async () => {
		const file = tmpFile();
		await writeFile(file, "- 已有事实\n", "utf-8");
		const r = await runMemory(file, 5, [{ action: "add", content: "- 很长的新事实内容内容内容内容内容内容内容" }], "跨章记忆(memory.md)");
		expect(r.ok).toBe(false);
		expect(r.text).toContain("超了");
		expect(r.text).toContain("已有事实");
		expect(await readFile(file, "utf-8")).toBe("- 已有事实\n"); // 没被写坏
	});

	it("零命中 → 不写,报错文本列出候选", async () => {
		const file = tmpFile();
		await writeFile(file, "- 甲\n", "utf-8");
		const r = await runMemory(file, 1500, [{ action: "remove", old_text: "乙" }], "跨章记忆(memory.md)");
		expect(r.ok).toBe(false);
		expect(r.text).toContain("没有条目包含");
		expect(await readFile(file, "utf-8")).toBe("- 甲\n");
	});
});
