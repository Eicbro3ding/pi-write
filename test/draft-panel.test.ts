import { describe, expect, it } from "vitest";
import { autoSaveConflicts, cursorBlockColumn } from "../src/draft-panel.ts";

describe("cursorBlockColumn", () => {
	it("光标块列 = 段内视觉列,无额外缩进偏移(回归:曾右偏 2 列)", () => {
		expect(cursorBlockColumn(3, 20)).toBe(3);
		expect(cursorBlockColumn(0, 20)).toBe(0);
	});

	it("clamp 到 body 宽度内,至少 1 个字符可反显", () => {
		expect(cursorBlockColumn(19, 20)).toBe(19);
		expect(cursorBlockColumn(25, 20)).toBe(19);
		expect(cursorBlockColumn(0, 1)).toBe(0);
		expect(cursorBlockColumn(3, 0)).toBe(0);
	});
});

describe("autoSaveConflicts", () => {
	it("文件内容与基线不一致 → 冲突(外部修改,自动保存应拒绝)", () => {
		expect(autoSaveConflicts("AI 写入的新正文", "用户上次保存的正文")).toBe(true);
	});

	it("文件内容与基线一致 → 无冲突", () => {
		expect(autoSaveConflicts("正文", "正文")).toBe(false);
	});

	it("文件不存在(null)→ 无冲突(首次保存)", () => {
		expect(autoSaveConflicts(null, "")).toBe(false);
		expect(autoSaveConflicts(null, "旧正文")).toBe(false);
	});
});
