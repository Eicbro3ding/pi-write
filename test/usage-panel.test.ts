/**
 * 会话用量卡的格式化(web/src/components/UsagePanel.tsx)。
 *
 * 这两个函数是卡片的**唯一数字出口**,坏数据(NaN / 负数 / 供应商不上报 cost)
 * 必须落成「—」而不是渲染成 NaN 或 $0.0000 —— 所以单独测。
 */
import { describe, expect, it } from "vitest";
import { formatCost, formatCount } from "../web/src/components/UsagePanel.tsx";

describe("formatCount", () => {
	it("千分位分组", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(8826)).toBe("8,826");
		expect(formatCount(128000)).toBe("128,000");
	});
	it("非有限数 → 「—」(不渲染成 NaN)", () => {
		expect(formatCount(Number.NaN)).toBe("—");
		expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
	});
});

describe("formatCost", () => {
	it("0 / 负数 → 「—」(不少供应商不上报 cost,别显示 $0.00)", () => {
		expect(formatCost(0)).toBe("—");
		expect(formatCost(-1)).toBe("—");
	});
	it("非有限数 → 「—」", () => {
		expect(formatCost(Number.NaN)).toBe("—");
	});
	it("小于 1 给四位(小额场景下两位全是 0)", () => {
		expect(formatCost(0.0034)).toBe("$0.0034");
		expect(formatCost(0.5)).toBe("$0.5000");
	});
	it("大于等于 1 给两位", () => {
		expect(formatCost(3.14159)).toBe("$3.14");
		expect(formatCost(120)).toBe("$120.00");
	});
});
