/**
 * 插件侧槽位 API(web/src/plugin-slots.ts)的回归测试。
 *
 * 这是 trusted 插件前端 JS 唯一的 UI 出口(替代早期 querySelector 猜 DOM 的写法),
 * 所以它守住的两条线必须被测死:
 *  1. 未声明槽位注册 → 抛错(与内核同一条铁律,不给插件开后门);
 *  2. 注册进去的条目形状正确(owner 从前缀推断、render 归一成工厂)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginSlotsApi, hasSlot } from "../web/src/plugin-slots.ts";
import { listEntries, resetSlots } from "../web/src/slots.ts";
import { declareShellSlots } from "../web/src/shell-slots.ts";
import type { PluginDomEntryPayload } from "../web/src/plugin-slots.ts";

/** 一个最小的假 DOM 节点(测试不依赖 jsdom —— 只在纯逻辑层断言)。 */
function fakeNode(label: string): Node {
	return { nodeName: label } as unknown as Node;
}

describe("createPluginSlotsApi", () => {
	beforeEach(() => {
		resetSlots();
		declareShellSlots();
	});
	afterEach(() => resetSlots());

	it("list() 返回宿主已声明的槽位名", () => {
		const api = createPluginSlotsApi();
		const names = api.list();
		expect(names).toContain("root");
		expect(names).toContain("app.chrome.overlay");
		expect(names).toContain("app.view.settings.plugin");
	});

	it("describe() 给出名字/形态/范围三件套", () => {
		const api = createPluginSlotsApi();
		const overlay = api.describe().find((s) => s.name === "app.chrome.overlay");
		expect(overlay).toEqual({ name: "app.chrome.overlay", kind: "list", scope: "app" });
	});

	it("register() 把条目落进指定槽位,render 归一成工厂", () => {
		const api = createPluginSlotsApi();
		const node = fakeNode("DIV");
		api.register("app.chrome.nav", { id: "dice:btn", order: 5, render: () => node });
		const entries = listEntries("app.chrome.nav");
		expect(entries).toHaveLength(1);
		const payload = entries[0].render as PluginDomEntryPayload;
		expect(payload.kind).toBe("plugin-dom");
		expect(payload.owner).toBe("dice"); // 从 id 前缀 "dice:" 推断
		expect(payload.factory()).toBe(node);
	});

	it("register() 接受直接给节点(自动包成工厂)", () => {
		const api = createPluginSlotsApi();
		const node = fakeNode("SPAN");
		api.register("app.chrome.nav", { id: "p:x", render: node });
		const payload = listEntries("app.chrome.nav")[0].render as PluginDomEntryPayload;
		expect(payload.factory()).toBe(node);
	});

	it("往未声明槽位注册 → 抛错(不给插件开后门)", () => {
		const api = createPluginSlotsApi();
		expect(() => api.register("app.nope.typo", { id: "p:x", render: () => fakeNode("DIV") })).toThrow(/未声明/);
	});

	it("id 为空 → 抛错", () => {
		const api = createPluginSlotsApi();
		expect(() => api.register("app.chrome.nav", { id: "", render: () => fakeNode("DIV") })).toThrow(/id 不能为空/);
	});

	it("key 透传(keyed 槽位:不带 key 会被内核拒,带了才落得下)", () => {
		const api = createPluginSlotsApi();
		// keyed 槽位不给 key → 内核抛错
		expect(() => api.register("app.view.settings.plugin", { id: "dice:h", render: () => fakeNode("DIV") })).toThrow(/必须给 key/);
		// 给了 key → 落得下,且 key 存进条目
		api.register("app.view.settings.plugin", { id: "dice:h", key: "dice", render: () => fakeNode("DIV") });
		const e = listEntries("app.view.settings.plugin").find((x) => x.id === "dice:h");
		expect(e?.key).toBe("dice");
	});

	it("unregister() 摘掉自己的条目", () => {		const api = createPluginSlotsApi();
		api.register("app.chrome.nav", { id: "p:a", render: () => fakeNode("DIV") });
		expect(listEntries("app.chrome.nav")).toHaveLength(1);
		api.unregister("app.chrome.nav", "p:a");
		expect(listEntries("app.chrome.nav")).toHaveLength(0);
	});

	it("unregister() 摘不存在的条目:静默(回收是尽力而为)", () => {
		const api = createPluginSlotsApi();
		expect(() => api.unregister("app.chrome.nav", "nope")).not.toThrow();
	});

	it("owner 缺前缀时退为 'plugin'", () => {
		const api = createPluginSlotsApi();
		api.register("app.chrome.nav", { id: "noprefix", render: () => fakeNode("DIV") });
		const payload = listEntries("app.chrome.nav")[0].render as PluginDomEntryPayload;
		expect(payload.owner).toBe("plugin");
	});

	it("when 条件被透传:false 的条目不参与 resolve", () => {
		const api = createPluginSlotsApi();
		api.register("app.chrome.nav", { id: "p:off", when: () => false, render: () => fakeNode("DIV") });
		// listEntries 看得到(在表里),但 resolve 会过滤掉
		expect(listEntries("app.chrome.nav")).toHaveLength(1);
	});
});

describe("hasSlot", () => {
	beforeEach(() => {
		resetSlots();
		declareShellSlots();
	});
	afterEach(() => resetSlots());

	it("已声明 → true;未声明 → false", () => {
		expect(hasSlot("app.chrome.overlay")).toBe(true);
		expect(hasSlot("app.nope")).toBe(false);
	});
});
