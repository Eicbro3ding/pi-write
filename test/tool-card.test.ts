/**
 * 工具块渲染形态(toolRenderForm):每个工具块按「工具名 + 调试模式」决定长什么样。
 *
 * 由旧的 visibleToolCalls(「简化输出下只留 bash」)演化而来 —— 那时所有非 bash
 * 工具挤成一整块动作流,所以只有「显示 / 隐藏」两种选择;块化之后每个工具块各占
 * 自己的位置,渲染形态才有意义(终端块 / 预览卡 / 动作行 / 不显示)。
 */
import { describe, expect, it } from "vitest";
import { toolRenderForm } from "../web/src/tool-status.ts";

describe("toolRenderForm", () => {
	it("bash 恒为终端块:命令与输出必须摊开(唯一能越过书目录边界的工具)", () => {
		expect(toolRenderForm("bash", false)).toBe("terminal");
	});

	it("产出型工具为预览卡形态:write/edit/world_update/script_confirm", () => {
		for (const name of ["write", "edit", "world_update", "script_confirm"]) {
			expect(toolRenderForm(name, false)).toBe("preview");
		}
	});

	it("读取型工具为动作行", () => {
		for (const name of ["read", "grep", "find", "ls"]) {
			expect(toolRenderForm(name, false)).toBe("action");
		}
	});

	it("word_count / world_find 默认不显示:没有编辑动作,也不是值得看一眼的读取", () => {
		expect(toolRenderForm("word_count", false)).toBe("hidden");
		expect(toolRenderForm("world_find", false)).toBe("hidden");
	});

	it("未知工具(MCP 等)退化为动作行,不会消失", () => {
		expect(toolRenderForm("mcp__whatever__do_thing", false)).toBe("action");
	});

	it("调试模式一切退回原始完整卡(排查工具调用要看原始参数与结果)", () => {
		for (const name of ["bash", "write", "read", "word_count", "world_find", "mcp__x"]) {
			expect(toolRenderForm(name, true)).toBe("card");
		}
	});
});
