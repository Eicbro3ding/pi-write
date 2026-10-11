/**
 * 槽位表核心(web/src/slots.ts)的单测 —— 纯逻辑,无 DOM / 无 React。
 *
 * 这个文件守四件事:
 * 1. **声明 = 授权**:往未声明槽位注册抛 UnknownSlotError(错拼槽名不许静默消失)。
 * 2. **四形态组合**:single 独占、list 按 order、keyed 按 key、chain 按 priority 举手。
 * 3. **回收**:unregisterEntry 按 id、unregisterOwner 按来源批量。
 * 4. **幂等与冲突**:重复声明同义幂等,不同义抛错;条目 id / key 冲突抛错。
 *
 * 每条用例开头 resetSlots() —— 注册表是模块级单例,不重置会跨用例串味。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	ROOT_SLOT,
	UnknownSlotError,
	getSlot,
	listEntries,
	listSlots,
	pickKeyed,
	registerEntry,
	registerSlot,
	resetSlots,
	resolve,
	slotStats,
	unregisterEntry,
	unregisterOwner,
} from "../web/src/slots.ts";

/** 造一个最简条目。 */
const e = (id: string, owner = "core", extra: Record<string, unknown> = {}) => ({
	id,
	owner,
	render: `render:${id}`,
	...extra,
});

beforeEach(() => resetSlots());

describe("种子与声明", () => {
	it("初始只有 root 一个槽位,且是 single/app", () => {
		const all = listSlots();
		expect(all.map((s) => s.name)).toEqual([ROOT_SLOT]);
		expect(getSlot(ROOT_SLOT)?.kind).toBe("single");
		expect(getSlot(ROOT_SLOT)?.scope).toBe("app");
	});

	it("registerSlot 声明后 listSlots 按名排序可见", () => {
		registerSlot({ name: "view.edit", kind: "single", scope: "view" });
		registerSlot({ name: "app.chrome", kind: "list" });
		expect(listSlots().map((s) => s.name)).toEqual(["app.chrome", "root", "view.edit"]);
	});

	it("声明父槽时一并播下子槽(UI 从 root 往下长)", () => {
		registerSlot({
			name: "app.chrome",
			kind: "single",
			children: [
				{ name: "app.chrome.nav", kind: "list" },
				{ name: "app.chrome.status", kind: "single" },
			],
		});
		expect(getSlot("app.chrome.nav")?.kind).toBe("list");
		expect(getSlot("app.chrome.status")?.kind).toBe("single");
	});

	it("子槽缺省继承父槽 scope", () => {
		registerSlot({ name: "book.rail", kind: "single", scope: "book", children: [{ name: "book.rail.foot", kind: "list" }] });
		expect(getSlot("book.rail.foot")?.scope).toBe("book");
	});

	it("同义重复声明是幂等的(允许模块被重复求值)", () => {
		registerSlot({ name: "overlay", kind: "list" });
		expect(() => registerSlot({ name: "overlay", kind: "list" })).not.toThrow();
		expect(listSlots().filter((s) => s.name === "overlay")).toHaveLength(1);
	});

	it("同名不同义声明抛错(不让后来者静默覆盖)", () => {
		registerSlot({ name: "overlay", kind: "list" });
		expect(() => registerSlot({ name: "overlay", kind: "single" })).toThrow(/重复声明且定义不一致/);
	});
});

describe("声明 = 授权(未声明即抛错)", () => {
	it("往未声明槽位注册抛 UnknownSlotError", () => {
		expect(() => registerEntry("view.nope", e("a"))).toThrow(UnknownSlotError);
	});

	it("错误信息带上已声明槽位,便于排查错拼", () => {
		registerSlot({ name: "sidebar", kind: "list" });
		try {
			registerEntry("sidebr", e("a"));
			throw new Error("应当抛错");
		} catch (err) {
			expect(err).toBeInstanceOf(UnknownSlotError);
			expect((err as Error).message).toContain("sidebr");
			expect((err as Error).message).toContain("sidebar");
		}
	});

	it("root 是预声明的,可以直接注册", () => {
		expect(() => registerEntry(ROOT_SLOT, e("app"))).not.toThrow();
		expect(listEntries(ROOT_SLOT)).toHaveLength(1);
	});
});

describe("single 形态", () => {
	it("只坐一个", () => {
		registerSlot({ name: "s", kind: "single" });
		registerEntry("s", e("first"));
		expect(resolve("s").items.map((i) => i.id)).toEqual(["first"]);
	});

	it("第二个条目抛错(不静默覆盖)", () => {
		registerSlot({ name: "s", kind: "single" });
		registerEntry("s", e("first"));
		expect(() => registerEntry("s", e("second"))).toThrow(/single 形态/);
	});

	it("先摘掉再注册是允许的(替换靠显式回收)", () => {
		registerSlot({ name: "s", kind: "single" });
		registerEntry("s", e("first"));
		unregisterEntry("s", "first");
		expect(() => registerEntry("s", e("second"))).not.toThrow();
		expect(resolve("s").items[0].id).toBe("second");
	});
});

describe("list 形态", () => {
	it("按 order 升序,相同 order 按注册先后", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("b", "core", { order: 20 }));
		registerEntry("l", e("a", "core", { order: 10 }));
		registerEntry("l", e("c", "core")); // 缺省 0
		registerEntry("l", e("d", "core")); // 缺省 0,排在 c 后
		expect(resolve("l").items.map((i) => i.id)).toEqual(["c", "d", "a", "b"]);
	});

	it("条目 id 重复抛错", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("x"));
		expect(() => registerEntry("l", e("x"))).toThrow(/id 须唯一/);
	});
});

describe("keyed 形态", () => {
	it("必须给 key,否则抛错", () => {
		registerSlot({ name: "k", kind: "keyed" });
		expect(() => registerEntry("k", e("nokey"))).toThrow(/必须给 key/);
	});

	it("同 key 第二个条目抛错", () => {
		registerSlot({ name: "k", kind: "keyed" });
		registerEntry("k", e("a", "core", { key: "settings" }));
		expect(() => registerEntry("k", e("b", "core", { key: "settings" }))).toThrow(/已被条目/);
	});

	it("pickKeyed 按 key 取", () => {
		registerSlot({ name: "k", kind: "keyed" });
		registerEntry("k", e("a", "core", { key: "settings" }));
		registerEntry("k", e("b", "core", { key: "plugins" }));
		expect(pickKeyed("k", "plugins")?.id).toBe("b");
		expect(pickKeyed("k", "nope")).toBeUndefined();
	});
});

describe("chain 形态(举手参选)", () => {
	it("按 priority 降序,第一个 when 为真的中选,只返回它", () => {
		registerSlot({ name: "c", kind: "chain" });
		registerEntry("c", e("low", "core", { priority: 1, when: () => true }));
		registerEntry("c", e("high", "core", { priority: 10, when: () => true }));
		const r = resolve("c");
		expect(r.items.map((i) => i.id)).toEqual(["high"]);
		expect(r.picked?.id).toBe("high");
	});

	it("高优先级的 when 返回 false 时,顺位给下一个", () => {
		registerSlot({ name: "c", kind: "chain" });
		registerEntry("c", e("high", "core", { priority: 10, when: () => false }));
		registerEntry("c", e("low", "core", { priority: 1, when: () => true }));
		expect(resolve("c").picked?.id).toBe("low");
	});

	it("无人举手时 picked 为 null", () => {
		registerSlot({ name: "c", kind: "chain" });
		registerEntry("c", e("a", "core", { when: () => false }));
		const r = resolve("c");
		expect(r.items).toEqual([]);
		expect(r.picked).toBeNull();
	});

	it("when 抛错按「不参与」处理,不拖垮整个槽位", () => {
		registerSlot({ name: "c", kind: "chain" });
		registerEntry("c", e("boom", "core", { priority: 99, when: () => { throw new Error("x"); } }));
		registerEntry("c", e("ok", "core", { priority: 1, when: () => true }));
		expect(resolve("c").picked?.id).toBe("ok");
	});
});

describe("when 过滤(list/single 通用)", () => {
	it("when 返回 false 的条目被跳过", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("yes", "core", { when: () => true }));
		registerEntry("l", e("no", "core", { when: () => false }));
		expect(resolve("l").items.map((i) => i.id)).toEqual(["yes"]);
	});

	it("无 when 视为恒真", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("a"));
		expect(resolve("l").items).toHaveLength(1);
	});
});

describe("回收", () => {
	it("unregisterEntry 按 id 摘,不存在返回 false", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("a"));
		registerEntry("l", e("b"));
		expect(unregisterEntry("l", "a")).toBe(true);
		expect(unregisterEntry("l", "ghost")).toBe(false);
		expect(resolve("l").items.map((i) => i.id)).toEqual(["b"]);
	});

	it("摘掉后同 id 可以重新注册(ids 索引一并清)", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("a"));
		unregisterEntry("l", "a");
		expect(() => registerEntry("l", e("a"))).not.toThrow();
	});

	it("unregisterOwner 跨槽位批量摘(插件禁用时一次摘干净)", () => {
		registerSlot({ name: "l1", kind: "list" });
		registerSlot({ name: "l2", kind: "list" });
		registerEntry("l1", e("a", "dice"));
		registerEntry("l1", e("b", "core"));
		registerEntry("l2", e("c", "dice", { key: "dice" }));
		expect(unregisterOwner("dice")).toBe(2);
		expect(resolve("l1").items.map((i) => i.id)).toEqual(["b"]);
		expect(listEntries("l2")).toHaveLength(0);
	});

	it("按 owner 摘掉后同 id 也能重注册", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("a", "dice"));
		unregisterOwner("dice");
		expect(() => registerEntry("l", e("a", "dice"))).not.toThrow();
	});
});

describe("渲染期容错", () => {
	it("resolve 未声明槽位返回空,不抛错(插件没加载时宿主照样要能画)", () => {
		const r = resolve("does.not.exist");
		expect(r.items).toEqual([]);
		expect(r.picked).toBeNull();
	});

	it("slotStats 统计槽位与条目数", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("a"));
		registerEntry("l", e("b"));
		registerEntry(ROOT_SLOT, e("r"));
		expect(slotStats()).toEqual({ slots: 2, entries: 3 });
	});

	it("resetSlots 清空后只剩 root", () => {
		registerSlot({ name: "l", kind: "list" });
		registerEntry("l", e("a"));
		resetSlots();
		expect(listSlots().map((s) => s.name)).toEqual([ROOT_SLOT]);
		expect(slotStats().entries).toBe(0);
	});
});
