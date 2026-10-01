import { afterEach, describe, expect, it, vi } from "vitest";
import {
	autoExpandThinkingEnabled,
	classicModeEnabled,
	debugModeEnabled,
	debugUnlocked,
	disableDebugMode,
	enableDebugMode,
	enterBehavior,
	setEnterBehavior,
	parseAutoExpandThinking,
	parseClassicMode,
	parseDebugMode,
	parseEnterBehavior,
	setAutoExpandThinking,
	setClassicMode,
	setDebugMode,
	parseConversationScope,
	conversationScope,
	setConversationScope,
} from "../web/src/settings.ts";
// 跨模块比对「两处默认值」:服务端默认(权威)与浏览器首帧缓存必须一致
import { defaultWriterSettings } from "../src/writer-settings.ts";

const DEBUG_KEY = "pi-writer-debug-mode";
const DEBUG_UNLOCK_KEY = "pi-writer-debug-unlocked";
const DEBUG_MIGRATED_KEY = "pi-writer-debug-migrated";
const LEGACY_KEY = "pi-writer-simplified-tools";
const AUTO_EXPAND_KEY = "pi-writer-auto-expand-thinking";
const CLASSIC_MODE_KEY = "pi-writer-classic-mode";
const CONVERSATION_SCOPE_KEY = "pi-writer-conversation-scope";

function stubStorage(init: Record<string, string> = {}) {
	const store = new Map(Object.entries(init));
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("调试模式设置(原「简化输出」)", () => {
	it("缺省关闭 —— 与旧开关的默认值相反(方向跟名字对齐)", () => {
		stubStorage();
		expect(debugModeEnabled()).toBe(false);
	});
	it("未解锁时恒为关闭:即使存储里写着开启也不认(界面藏起来了,状态就不该生效)", () => {
		stubStorage({ [DEBUG_KEY]: "1" });
		expect(debugUnlocked()).toBe(false);
		expect(debugModeEnabled()).toBe(false);
	});
	it("解锁后按存储值生效", () => {
		const store = stubStorage({ [DEBUG_UNLOCK_KEY]: "1", [DEBUG_MIGRATED_KEY]: "1" });
		setDebugMode(true);
		expect(debugModeEnabled()).toBe(true);
		setDebugMode(false);
		expect(debugModeEnabled()).toBe(false);
		expect(store.get(DEBUG_KEY)).toBe("0");
	});
	it("控制台入口:enableDebugMode 解锁并打开,disableDebugMode 关闭并重新隐藏", () => {
		const store = stubStorage();
		enableDebugMode();
		expect(debugUnlocked()).toBe(true);
		expect(debugModeEnabled()).toBe(true);
		disableDebugMode();
		expect(debugUnlocked()).toBe(false);
		expect(debugModeEnabled()).toBe(false);
		expect(store.get(DEBUG_KEY)).toBe("0");
	});
	it("parseDebugMode:仅 '1' 开启,缺省/非法值一律关闭", () => {
		expect(parseDebugMode(null)).toBe(false);
		expect(parseDebugMode(undefined)).toBe(false);
		expect(parseDebugMode("0")).toBe(false);
		expect(parseDebugMode("1")).toBe(true);
		expect(parseDebugMode("junk")).toBe(false);
	});
});

describe("旧「简化输出」键的一次性迁移", () => {
	it("旧键不存在 → 什么都不做(默认非调试)", () => {
		const store = stubStorage();
		expect(debugModeEnabled()).toBe(false);
		expect(debugUnlocked()).toBe(false);
		expect(store.get(LEGACY_KEY)).toBeUndefined();
	});
	it("旧键为 '1'(简化开着 = 当时没在看详细)→ 调试关闭", () => {
		stubStorage({ [LEGACY_KEY]: "1" });
		expect(debugModeEnabled()).toBe(false);
		expect(debugUnlocked()).toBe(false);
	});
	it("旧键为 '0'(他当时关掉了简化 = 在看详细)→ 迁移为调试开启 + 解锁,观感不变", () => {
		const store = stubStorage({ [LEGACY_KEY]: "0" });
		expect(debugModeEnabled()).toBe(true);
		// 同时解锁:否则界面里没有这一项、没有开关可关,他会以为设置丢了
		expect(debugUnlocked()).toBe(true);
		expect(store.get(LEGACY_KEY)).toBeUndefined(); // 旧键清理
	});
	it("迁移只跑一次:之后手改旧键不再影响", () => {
		const store = stubStorage({ [LEGACY_KEY]: "0" });
		expect(debugModeEnabled()).toBe(true);
		store.set(LEGACY_KEY, "1");
		disableDebugMode();
		expect(debugModeEnabled()).toBe(false);
	});
});

describe("回车行为设置", () => {
	it("缺省 newline:这是后加的开关,不替老用户改键位(回车仍是换行)", () => {
		stubStorage();
		expect(enterBehavior()).toBe("newline");
	});
	it("设成 send 后持久化并读回", () => {
		const store = stubStorage();
		setEnterBehavior("send");
		expect(store.get("pi-writer-enter-behavior")).toBe("send");
		expect(enterBehavior()).toBe("send");
		setEnterBehavior("newline");
		expect(enterBehavior()).toBe("newline");
	});
	it("parseEnterBehavior:仅 'send' 表示回车即发送,缺省/非法值一律换行", () => {
		expect(parseEnterBehavior("send")).toBe("send");
		expect(parseEnterBehavior(null)).toBe("newline");
		expect(parseEnterBehavior(undefined)).toBe("newline");
		expect(parseEnterBehavior("newline")).toBe("newline");
		expect(parseEnterBehavior("junk")).toBe("newline");
	});
});

describe("自动展开思考设置", () => {
	it("缺省关闭", () => {
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
	it("缺省开启(未存储任何值 = 默认单 Agent)", () => {
		stubStorage();
		expect(classicModeEnabled()).toBe(true);
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
	it("parseClassicMode:缺省/非法值回退开启,仅显式 '0' 关闭", () => {
		expect(parseClassicMode(null)).toBe(true);
		expect(parseClassicMode(undefined)).toBe(true);
		expect(parseClassicMode("junk")).toBe(true);
		expect(parseClassicMode("1")).toBe(true);
		expect(parseClassicMode("0")).toBe(false);
	});
	/**
	 * 缺省值在前后端各有一份(服务端 settings.json 的默认 / 浏览器首帧缓存)。
	 * 只改一处 → 顶栏先按旧默认画出舞台入口,对账后再收回(视觉抖动 + 用户困惑)。
	 * 这条护栏不检查两处实现,只比对**两处的默认结论**。
	 */
	it("本地缺省与服务端缺省一致(两份默认值必须同步翻转)", () => {
		expect(parseClassicMode(null)).toBe(defaultWriterSettings().classicMode);
	});
});

describe("对话与章节关系(conversationScope)首帧缓存", () => {
	it("parseConversationScope:仅显式 'book' 分离,其余(含缺省)一律绑定章节", () => {
		expect(parseConversationScope("book")).toBe("book");
		expect(parseConversationScope("chapter")).toBe("chapter");
		expect(parseConversationScope(null)).toBe("chapter");
		expect(parseConversationScope(undefined)).toBe("chapter");
		expect(parseConversationScope("junk")).toBe("chapter");
	});
	it("开启/关闭往返一致并持久化到 localStorage 键", () => {
		const store = stubStorage();
		expect(conversationScope()).toBe("chapter");
		setConversationScope("book");
		expect(conversationScope()).toBe("book");
		expect(store.get(CONVERSATION_SCOPE_KEY)).toBe("book");
		setConversationScope("chapter");
		expect(conversationScope()).toBe("chapter");
		expect(store.get(CONVERSATION_SCOPE_KEY)).toBe("chapter");
	});
	/**
	 * 与经典模式那条护栏同源:缺省值在前后端各有一份(服务端 settings.json 的默认 /
	 * 浏览器首帧缓存)。只改一处 → 首帧按旧模式渲染再跳(切换器闪一下)。
	 */
	it("本地缺省与服务端缺省一致(两份默认值必须同步翻转)", () => {
		expect(parseConversationScope(null)).toBe(defaultWriterSettings().conversationScope);
	});
});
