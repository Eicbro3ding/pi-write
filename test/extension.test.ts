import { describe, expect, it } from "vitest";
import {
	chapterIdFromFile,
	disambiguateSelectItems,
	idSuffixOf,
	isReadonlyPath,
	recentUserMessagesFromSessionText,
	worldContextMessage,
} from "../src/extension.ts";

describe("idSuffixOf", () => {
	it("extracts the trailing parenthesized id from chapter items", () => {
		expect(idSuffixOf("★  1. 第一章  (ch01)")).toBe("ch01");
		expect(idSuffixOf("   2. 第二章 [标签]  (ch02)")).toBe("ch02");
	});

	it("extracts the trailing parenthesized slug from book items", () => {
		expect(idSuffixOf("我的小说  (my-novel)")).toBe("my-novel");
	});

	it("handles ids containing parentheses-like content only at the end", () => {
		expect(idSuffixOf("标题（带括号）  (ch03)")).toBe("ch03");
	});

	it("returns undefined when no trailing parenthesized id exists", () => {
		expect(idSuffixOf("no id here")).toBeUndefined();
		expect(idSuffixOf("")).toBeUndefined();
	});
});

describe("world context helpers", () => {
	it("chapterIdFromFile 去 .jsonl 后缀", () => {
		expect(chapterIdFromFile("ch04.jsonl")).toBe("ch04");
	});
	it("isReadonlyPath 标记 .writer/ 与 outline.md", () => {
		expect(isReadonlyPath(".writer/characters.md")).toBe(true);
		expect(isReadonlyPath("outline.md")).toBe(true);
		expect(isReadonlyPath("draft/ch01.md")).toBe(false);
		expect(isReadonlyPath(".writer\\characters.md")).toBe(true);
		expect(isReadonlyPath("\\outline.md")).toBe(true);
		expect(isReadonlyPath("draft\\ch01.md")).toBe(false);
	});
	it("isReadonlyPath 归一化前导 ./ 与混合分隔符", () => {
		expect(isReadonlyPath("./outline.md")).toBe(true);
		expect(isReadonlyPath("./.writer/characters.md")).toBe(true);
		expect(isReadonlyPath("././outline.md")).toBe(true);
		expect(isReadonlyPath("./draft/ch01.md")).toBe(false);
		expect(isReadonlyPath(".\\outline.md")).toBe(true);
		expect(isReadonlyPath("\\outline.md")).toBe(true);
	});
	it("worldContextMessage 组装 custom 消息", () => {
		const msg = worldContextMessage("背景包文本");
		expect(msg.customType).toBe("world-context");
		expect(msg.content[0]?.text).toBe("背景包文本");
	});
});

describe("recentUserMessagesFromSessionText", () => {
	const header = JSON.stringify({ type: "session", version: 3, id: "h", timestamp: "t", cwd: "/books/x" });
	const user = (text: string): string =>
		JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "t", message: { role: "user", content: text } });
	const assistant = (text: string): string =>
		JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text }] } });
	/** 背景包注入的 custom_message 没有 message 字段,不应混入 recent。 */
	const customMessage = JSON.stringify({ type: "custom_message", id: "c", parentId: null, timestamp: "t", customType: "world-context", content: "【世界书】…", display: true });

	it("提取最近的用户消息(最多 count 条,新→旧)", () => {
		const text = [header, user("第一章开场"), assistant("好的。"), user("多写点海雾"), user("再写一段雨"), assistant("完成了。")].join("\n");
		expect(recentUserMessagesFromSessionText(text)).toEqual(["多写点海雾", "再写一段雨"]);
		expect(recentUserMessagesFromSessionText(text, 3)).toEqual(["第一章开场", "多写点海雾", "再写一段雨"]);
	});

	it("排除 assistant 消息、custom_message 注入与损坏行", () => {
		const text = [header, customMessage, "这不是 JSON", user("唯一一条用户消息"), assistant("回复")].join("\n");
		expect(recentUserMessagesFromSessionText(text)).toEqual(["唯一一条用户消息"]);
	});

	it("空内容/空文件返回空数组", () => {
		expect(recentUserMessagesFromSessionText("")).toEqual([]);
		expect(recentUserMessagesFromSessionText(header)).toEqual([]);
	});
});

describe("disambiguateSelectItems", () => {
	it("唯一显示行原样保留", () => {
		const labels = ["📖 林婉", "└─ 阿七", "🌍 雾港"];
		expect(disambiguateSelectItems(labels, ["e1", "e2", "e3"])).toEqual(labels);
	});
	it("重复显示行(同名条目)追加 (id),items.indexOf 可精确定位", () => {
		const labels = ["📖 林婉", "📖 林婉", "└─ 阿七", "└─ 阿七"];
		const items = disambiguateSelectItems(labels, ["entry-a", "entry-b", "entry-c", "entry-d"]);
		expect(items).toEqual(["📖 林婉  (entry-a)", "📖 林婉  (entry-b)", "└─ 阿七  (entry-c)", "└─ 阿七  (entry-d)"]);
		expect(items.indexOf(items[1]!)).toBe(1);
		expect(items.indexOf(items[3]!)).toBe(3);
	});
});
