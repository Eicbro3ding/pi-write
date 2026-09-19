import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUBBLE_CHAT_KEY,
	STAGE_PANEL_COLLAPSED_KEY,
	conversationStyle,
	panelCollapsed,
	parseBubbleChat,
	parsePanelCollapsed,
	setConversationStyle,
	setPanelCollapsed,
} from "../web/src/stage-preferences.ts";

function stubStorage(init: Record<string, string> = {}) {
	const store = new Map(Object.entries(init));
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
	});
	return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("舞台对话形态偏好(设计稿 04/05)", () => {
	it("缺省为文档流(未存储任何值时)", () => {
		stubStorage();
		expect(conversationStyle()).toBe("doc");
	});
	it("切到气泡 / 切回文档流往返一致", () => {
		stubStorage();
		setConversationStyle("bubble");
		expect(conversationStyle()).toBe("bubble");
		setConversationStyle("doc");
		expect(conversationStyle()).toBe("doc");
	});
	it("持久化到 localStorage 键", () => {
		const store = stubStorage();
		setConversationStyle("bubble");
		expect(store.get(BUBBLE_CHAT_KEY)).toBe("1");
		setConversationStyle("doc");
		expect(store.get(BUBBLE_CHAT_KEY)).toBe("0");
	});
	it("parseBubbleChat:仅 '1' 开启,缺省/非法值回退文档流", () => {
		expect(parseBubbleChat(null)).toBe(false);
		expect(parseBubbleChat(undefined)).toBe(false);
		expect(parseBubbleChat("0")).toBe(false);
		expect(parseBubbleChat("junk")).toBe(false);
		expect(parseBubbleChat("1")).toBe(true);
	});
});

describe("舞台右栏收起态", () => {
	it("缺省展开", () => {
		stubStorage();
		expect(panelCollapsed()).toBe(false);
	});
	it("收起 / 展开往返一致并持久化", () => {
		const store = stubStorage();
		setPanelCollapsed(true);
		expect(panelCollapsed()).toBe(true);
		expect(store.get(STAGE_PANEL_COLLAPSED_KEY)).toBe("1");
		setPanelCollapsed(false);
		expect(panelCollapsed()).toBe(false);
		expect(store.get(STAGE_PANEL_COLLAPSED_KEY)).toBe("0");
	});
	it("parsePanelCollapsed:仅 '1' 收起", () => {
		expect(parsePanelCollapsed(null)).toBe(false);
		expect(parsePanelCollapsed("0")).toBe(false);
		expect(parsePanelCollapsed("junk")).toBe(false);
		expect(parsePanelCollapsed("1")).toBe(true);
	});
	it("localStorage 抛错(隐私模式)时读回退展开、写静默不抛", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		});
		expect(panelCollapsed()).toBe(false);
		expect(() => setPanelCollapsed(true)).not.toThrow();
	});
});
