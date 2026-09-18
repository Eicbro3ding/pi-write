/**
 * 工具卡片可见性(visibleToolCalls):「简化输出」默认隐藏工具卡片,
 * 但 bash(外部命令)必须始终可见——命令被藏起来的话,开关就失去了约束意义。
 */
import { describe, expect, it } from "vitest";
import { visibleToolCalls } from "../web/src/components/MessageList.tsx";
import type { ToolCallInfo } from "../web/src/types.ts";

const card = (name: string): ToolCallInfo => ({ id: name, name, args: "{}", result: null, isError: false });

describe("visibleToolCalls", () => {
	it("关闭简化输出:全部可见", () => {
		const tools = [card("read"), card("write"), card("bash")];
		expect(visibleToolCalls(tools, false)).toHaveLength(3);
	});

	it("开启简化输出:只有 bash 可见", () => {
		const tools = [card("read"), card("write"), card("bash"), card("word_count")];
		expect(visibleToolCalls(tools, true).map((t) => t.name)).toEqual(["bash"]);
	});

	it("没有 bash 时开启简化输出 → 一张卡片都不显示", () => {
		expect(visibleToolCalls([card("read"), card("edit")], true)).toEqual([]);
	});
});
