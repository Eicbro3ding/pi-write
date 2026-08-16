/**
 * 上下文占用提示纯逻辑:80% 起提示、90% 升级为错误样式;tokens 未知不提示。
 */
import { describe, expect, it } from "vitest";
import { COMPACT_HINT_PERCENT, contextUsageHint } from "../web/src/context-usage.ts";

describe("contextUsageHint", () => {
	it("低于阈值 / 未知 tokens 不提示", () => {
		expect(contextUsageHint(null)).toBeNull();
		expect(contextUsageHint(undefined)).toBeNull();
		expect(contextUsageHint({ tokens: null, contextWindow: 1000, percent: null })).toBeNull();
		expect(contextUsageHint({ tokens: 700, contextWindow: 1000, percent: 70 })).toBeNull();
	});
	it("80% 提示 warn,90% 提示 err", () => {
		expect(COMPACT_HINT_PERCENT).toBe(0.8);
		const warn = contextUsageHint({ tokens: 1600, contextWindow: 2000, percent: 80 })!;
		expect(warn.tone).toBe("warn");
		expect(warn.text).toContain("/compact");
		const err = contextUsageHint({ tokens: 1800, contextWindow: 2000, percent: 90 })!;
		expect(err.tone).toBe("err");
	});
});