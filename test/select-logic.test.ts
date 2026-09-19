import { describe, expect, it } from "vitest";
import {
	filterSelectRows,
	firstSelectableRow,
	flattenSelectRows,
	searchableByDefault,
	type SelectRow,
	selectPopupPlacement,
	selectedRowIndex,
	stepSelectRow,
} from "../web/src/select-logic.ts";

const OPT = (value: string, label = value, hint?: string, disabled?: boolean) => ({ value, label, hint, disabled });

describe("统一下拉 · 扁平化(03-组件规范/01)", () => {
	it("平铺选项直接成行;分组插入标题行且空组不出现", () => {
		const rows = flattenSelectRows([OPT("a"), OPT("b")], [
			{ label: "deepseek", options: [OPT("d1")] },
			{ label: "空组", options: [] },
		]);
		expect(rows.map((r) => (r.kind === "group" ? `#${r.label}` : r.option.value))).toEqual(["a", "b", "#deepseek", "d1"]);
	});
	it("空值选项保留(筛选类下拉用「」表示「全部」)", () => {
		const rows = flattenSelectRows([OPT(""), OPT("a")], []);
		expect(rows).toHaveLength(2);
	});
});

describe("统一下拉 · 搜索过滤", () => {
	const rows = flattenSelectRows([], [
		{ label: "deepseek", options: [OPT("deepseek-flash", "deepseek-flash", "deepseek"), OPT("deepseek-reasoner", "deepseek-reasoner", "deepseek")] },
		{ label: "anthropic", options: [OPT("claude-sonnet-4.5", "claude-sonnet-4.5", "anthropic")] },
	]);
	it("空查询原样返回", () => {
		expect(filterSelectRows(rows, "   ")).toEqual(rows);
	});
	it("命中 label/value/hint;无命中的组标题一并省略", () => {
		const hit = filterSelectRows(rows, "reasoner");
		expect(hit.map((r) => (r.kind === "group" ? `#${r.label}` : r.option.value))).toEqual(["#deepseek", "deepseek-reasoner"]);
		expect(filterSelectRows(rows, "anthropic").map((r) => (r.kind === "group" ? `#${r.label}` : r.option.value))).toEqual([
			"#anthropic",
			"claude-sonnet-4.5",
		]);
		expect(filterSelectRows(rows, "zzz")).toEqual([]);
	});
	it("大小写不敏感", () => {
		expect(filterSelectRows(rows, "CLAUDE")).toHaveLength(2); // 组标题 + 一项
	});
});

describe("统一下拉 · 键盘导航", () => {
	const rows: SelectRow[] = flattenSelectRows([OPT("a"), OPT("b", "b", undefined, true)], [{ label: "g", options: [OPT("c")] }]);
	it("跳过禁用项与分组标题,并循环", () => {
		expect(stepSelectRow(rows, -1, 1)).toBe(0); // a
		expect(stepSelectRow(rows, 0, 1)).toBe(3); // 跳过禁用 b 与标题 g → c
		expect(stepSelectRow(rows, 3, 1)).toBe(0); // 回卷
		expect(stepSelectRow(rows, 0, -1)).toBe(3); // 反向回卷
	});
	it("全不可选返回 -1", () => {
		expect(stepSelectRow(flattenSelectRows([OPT("x", "x", undefined, true)], []), -1, 1)).toBe(-1);
		expect(firstSelectableRow([])).toBe(-1);
	});
	it("selectedRowIndex:命中可选行,禁用/缺失返回 -1", () => {
		expect(selectedRowIndex(rows, "c")).toBe(3);
		expect(selectedRowIndex(rows, "b")).toBe(-1);
		expect(selectedRowIndex(rows, "zz")).toBe(-1);
	});
});

describe("统一下拉 · 弹层定位", () => {
	const vp = { width: 1440, height: 900 };
	it("默认向下偏移 6,与触发器等宽", () => {
		const p = selectPopupPlacement({ top: 100, left: 40, width: 240, height: 38 }, 260, vp);
		expect(p).toEqual({ top: 144, left: 40, width: 240, flip: false });
	});
	it("下方空间不足时向上翻转", () => {
		const p = selectPopupPlacement({ top: 800, left: 40, width: 240, height: 38 }, 260, vp);
		expect(p.flip).toBe(true);
		expect(p.top).toBe(800 - 6 - 260);
	});
	it("上下都不够时留在下方并贴边", () => {
		const p = selectPopupPlacement({ top: 300, left: 40, width: 240, height: 38 }, 880, vp);
		expect(p.flip).toBe(false);
		expect(p.top).toBe(344);
	});
	it("左右越界收敛到 8px 边距", () => {
		expect(selectPopupPlacement({ top: 10, left: -30, width: 240, height: 38 }, 100, vp).left).toBe(8);
		expect(selectPopupPlacement({ top: 10, left: 1400, width: 240, height: 38 }, 100, vp).left).toBe(1440 - 240 - 8);
	});
});

describe("统一下拉 · 搜索框出现条件", () => {
	it("选项够多才给搜索框", () => {
		expect(searchableByDefault(13)).toBe(true);
		expect(searchableByDefault(12)).toBe(false);
	});
});
