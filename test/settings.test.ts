import { afterEach, describe, expect, it, vi } from "vitest";
import {
	autoExpandThinkingEnabled,
	parseAutoExpandThinking,
	parseSimplifiedTools,
	setAutoExpandThinking,
	setSimplifiedTools,
	simplifiedToolsEnabled,
} from "../web/src/settings.ts";

const STORAGE_KEY = "pi-writer-simplified-tools";
const AUTO_EXPAND_KEY = "pi-writer-auto-expand-thinking";

function stubStorage(init: Record<string, string> = {}) {
	const store = new Map(Object.entries(init));
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
	});
	return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("简化输出设置", () => {
	it("缺省开启(未存储任何值时简化输出为 true)", () => {
		stubStorage();
		expect(simplifiedToolsEnabled()).toBe(true);
	});
	it("显式关闭('0')后为 false,重新开启('1')为 true", () => {
		stubStorage();
		setSimplifiedTools(false);
		expect(simplifiedToolsEnabled()).toBe(false);
		setSimplifiedTools(true);
		expect(simplifiedToolsEnabled()).toBe(true);
	});
	it("持久化到 localStorage 键", () => {
		const store = stubStorage();
		setSimplifiedTools(false);
		expect(store.get(STORAGE_KEY)).toBe("0");
		setSimplifiedTools(true);
		expect(store.get(STORAGE_KEY)).toBe("1");
	});
	it("parseSimplifiedTools:缺省/非法值回退开启,仅 '0' 关闭", () => {
		expect(parseSimplifiedTools(null)).toBe(true);
		expect(parseSimplifiedTools(undefined)).toBe(true);
		expect(parseSimplifiedTools("0")).toBe(false);
		expect(parseSimplifiedTools("1")).toBe(true);
		expect(parseSimplifiedTools("junk")).toBe(true);
	});
});

describe("自动展开思考设置", () => {
	it("缺省开启(未存储任何值时自动展开为 true)", () => {
		stubStorage();
		expect(autoExpandThinkingEnabled()).toBe(true);
	});
	it("显式关闭('0')后为 false,重新开启('1')为 true", () => {
		stubStorage();
		setAutoExpandThinking(false);
		expect(autoExpandThinkingEnabled()).toBe(false);
		setAutoExpandThinking(true);
		expect(autoExpandThinkingEnabled()).toBe(true);
	});
	it("持久化到 localStorage 键", () => {
		const store = stubStorage();
		setAutoExpandThinking(false);
		expect(store.get(AUTO_EXPAND_KEY)).toBe("0");
		setAutoExpandThinking(true);
		expect(store.get(AUTO_EXPAND_KEY)).toBe("1");
	});
	it("parseAutoExpandThinking:缺省/非法值回退开启,仅 '0' 关闭", () => {
		expect(parseAutoExpandThinking(null)).toBe(true);
		expect(parseAutoExpandThinking(undefined)).toBe(true);
		expect(parseAutoExpandThinking("0")).toBe(false);
		expect(parseAutoExpandThinking("1")).toBe(true);
		expect(parseAutoExpandThinking("junk")).toBe(true);
	});
});
