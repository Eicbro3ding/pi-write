import { afterEach, describe, expect, it, vi } from "vitest";
import {
	autoExpandThinkingEnabled,
	classicModeEnabled,
	parseAutoExpandThinking,
	parseClassicMode,
	parseSimplifiedTools,
	setAutoExpandThinking,
	setClassicMode,
	setSimplifiedTools,
	simplifiedToolsEnabled,
} from "../web/src/settings.ts";

const STORAGE_KEY = "pi-writer-simplified-tools";
const AUTO_EXPAND_KEY = "pi-writer-auto-expand-thinking";
const CLASSIC_MODE_KEY = "pi-writer-classic-mode";

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
	it("缺省关闭(未存储任何值时思考块默认收起——设计稿 04/06)", () => {
		stubStorage();
		expect(autoExpandThinkingEnabled()).toBe(false);
	});
	it("显式开启('1')后为 true,关闭('0')为 false", () => {
		stubStorage();
		setAutoExpandThinking(true);
		expect(autoExpandThinkingEnabled()).toBe(true);
		setAutoExpandThinking(false);
		expect(autoExpandThinkingEnabled()).toBe(false);
	});
	it("持久化到 localStorage 键", () => {
		const store = stubStorage();
		setAutoExpandThinking(false);
		expect(store.get(AUTO_EXPAND_KEY)).toBe("0");
		setAutoExpandThinking(true);
		expect(store.get(AUTO_EXPAND_KEY)).toBe("1");
	});
	it("parseAutoExpandThinking:仅 '1' 开启,缺省/非法值一律收起", () => {
		expect(parseAutoExpandThinking(null)).toBe(false);
		expect(parseAutoExpandThinking(undefined)).toBe(false);
		expect(parseAutoExpandThinking("0")).toBe(false);
		expect(parseAutoExpandThinking("1")).toBe(true);
		expect(parseAutoExpandThinking("junk")).toBe(false);
	});
});

describe("经典模式本地缓存", () => {
	it("缺省关闭(未存储任何值时不是经典模式)", () => {
		stubStorage();
		expect(classicModeEnabled()).toBe(false);
	});
	it("开启('1')/关闭('0')往返一致", () => {
		stubStorage();
		setClassicMode(true);
		expect(classicModeEnabled()).toBe(true);
		setClassicMode(false);
		expect(classicModeEnabled()).toBe(false);
	});
	it("持久化到 localStorage 键", () => {
		const store = stubStorage();
		setClassicMode(true);
		expect(store.get(CLASSIC_MODE_KEY)).toBe("1");
		setClassicMode(false);
		expect(store.get(CLASSIC_MODE_KEY)).toBe("0");
	});
	it("parseClassicMode:缺省/非法值回退关闭,仅 '1' 开启", () => {
		expect(parseClassicMode(null)).toBe(false);
		expect(parseClassicMode(undefined)).toBe(false);
		expect(parseClassicMode("0")).toBe(false);
		expect(parseClassicMode("junk")).toBe(false);
		expect(parseClassicMode("1")).toBe(true);
	});
});
