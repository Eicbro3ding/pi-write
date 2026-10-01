/**
 * 「对话与章节的关系」(conversationScope)前端纯逻辑单测。
 *
 * 这里钉的是 WritePage 装配层最容易写错、又最难在浏览器里复现的几条:
 * ① SSE 帧归属过滤(book 模式事件 chapterFile 为 null,照旧判定会丢掉全部事件);
 * ② writer 请求的定位参数(chapter 模式必须与改动前逐字节一致:不带 conversation);
 * ③ 对齐键(book 模式切章节不重拉对话);
 * ④ 删除对话框的落点(不许留下「选中一条已删除对话」的死状态)。
 */
import { describe, expect, it } from "vitest";
import type { ConversationDto } from "../web/src/types.ts";
import {
	acceptsWriterEvent,
	currentConversationId,
	formatConversationTime,
	nextConversationAfterDelete,
	writerAlignKey,
	writerTarget,
} from "../web/src/writer-scope.ts";

function conv(id: string, isCurrent = false, updatedAt = 0): ConversationDto {
	return { id, title: id, updatedAt, isCurrent };
}

describe("acceptsWriterEvent:事件归属过滤", () => {
	it("chapter 模式(帧里没有 conversation):沿用 chapterFile 判定", () => {
		expect(acceptsWriterEvent({ chapterFile: "ch01.jsonl" }, "ch01.jsonl", "ch01.jsonl")).toBe(true);
		expect(acceptsWriterEvent({ chapterFile: "ch02.jsonl" }, "ch01.jsonl", "ch01.jsonl")).toBe(false);
		// 两边都没章节(兜底 default 会话):仍算当前
		expect(acceptsWriterEvent({ chapterFile: null }, "ch01.jsonl", null)).toBe(true);
		expect(acceptsWriterEvent({ chapterFile: null }, "ch01.jsonl", "ch01.jsonl")).toBe(false);
	});

	it("book 模式(帧里带 conversation):按当前选中对话过滤,chapterFile 为 null 也照收", () => {
		const frame = { chapterFile: null, conversation: "c-abc123" };
		expect(acceptsWriterEvent(frame, "c-abc123", "ch01.jsonl")).toBe(true);
		expect(acceptsWriterEvent(frame, "c-abc123", null)).toBe(true);
		// 切到另一段对话:上一段的事件不再串进本页
		expect(acceptsWriterEvent(frame, "c-zzzzzz", "ch01.jsonl")).toBe(false);
		// chapterFile 完全不参与 book 模式的判定(切章节不丢事件)
		expect(acceptsWriterEvent({ chapterFile: null, conversation: "c-abc123" }, "c-abc123", "ch09.jsonl")).toBe(true);
	});

	it("book 模式但选中还没就位(列表首帧):不拦帧(宁可多显示,不要静默吞)", () => {
		expect(acceptsWriterEvent({ chapterFile: null, conversation: "default" }, null, "ch01.jsonl")).toBe(true);
	});

	it("chapter 模式的帧带 chapterFile 时不看 conversation(服务端不回显该字段)", () => {
		// 防御性:真出现带 conversation 的 chapter 帧,也按 conversation 判定(与 book 同)
		expect(acceptsWriterEvent({ chapterFile: "ch01.jsonl", conversation: "ch01.jsonl" }, "ch02.jsonl", "ch01.jsonl")).toBe(false);
	});
});

describe("writerTarget:请求定位参数", () => {
	it("chapter 模式只传 chapterFile(身份),绝不带 conversation —— 与改动前一致", () => {
		expect(writerTarget("chapter", "ch01.jsonl", "c-abc123")).toEqual({ chapterFile: "ch01.jsonl" });
		expect(writerTarget("chapter", null, null)).toEqual({ chapterFile: null });
	});

	it("book 模式带 conversation(身份),chapterFile 仍照传(决定注入哪章正文)", () => {
		expect(writerTarget("book", "ch01.jsonl", "c-abc123")).toEqual({ chapterFile: "ch01.jsonl", conversation: "c-abc123" });
		// 选中对话未就位:conversation 交给服务端按当前对话回落
		expect(writerTarget("book", null, null)).toEqual({ chapterFile: null, conversation: undefined });
	});
});

describe("writerAlignKey:对齐键", () => {
	it("chapter 模式 = slug:章节文件(与改动前同形,切章必须重拉)", () => {
		expect(writerAlignKey("chapter", "fog-harbor", "ch01.jsonl", null)).toBe("fog-harbor:ch01.jsonl");
		expect(writerAlignKey("chapter", "fog-harbor", null, null)).toBe("fog-harbor:");
	});

	it("book 模式 = slug:conv:对话 id —— 切章节不改键(对话不跟着章节走)", () => {
		expect(writerAlignKey("book", "fog-harbor", "ch01.jsonl", "c-abc123")).toBe("fog-harbor:conv:c-abc123");
		expect(writerAlignKey("book", "fog-harbor", "ch09.jsonl", "c-abc123")).toBe("fog-harbor:conv:c-abc123");
		expect(writerAlignKey("book", "fog-harbor", "ch01.jsonl", "c-zzzzzz")).toBe("fog-harbor:conv:c-zzzzzz");
	});
});

describe("对话选择与删除落点", () => {
	it("currentConversationId:优先 isCurrent,否则列表第一条,空列表 null", () => {
		expect(currentConversationId([conv("a"), conv("b", true)])).toBe("b");
		expect(currentConversationId([conv("a"), conv("b")])).toBe("a");
		expect(currentConversationId([])).toBeNull();
	});

	it("nextConversationAfterDelete:落到剩下的一条,删空返回 null(调用方自动新建)", () => {
		const list = [conv("c-2"), conv("c-1"), conv("default")];
		expect(nextConversationAfterDelete(list, "c-2")).toBe("c-1");
		expect(nextConversationAfterDelete([conv("c-2")], "c-2")).toBeNull();
		// 列表里已没有这一段(服务端已删):仍给出第一条作为落点
		expect(nextConversationAfterDelete(list, "gone")).toBe("c-2");
	});
});

describe("formatConversationTime:相对时间", () => {
	const now = 1_700_000_000_000;
	it("分档正确,未来时间不显示", () => {
		expect(formatConversationTime(now - 5_000, now)).toBe("刚刚");
		expect(formatConversationTime(now - 5 * 60_000, now)).toBe("5 分钟前");
		expect(formatConversationTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
		expect(formatConversationTime(now - 2 * 86_400_000, now)).toBe("2 天前");
		expect(formatConversationTime(now - 60 * 86_400_000, now)).toBe("2 个月前");
		expect(formatConversationTime(now - 400 * 86_400_000, now)).toBe("1 年前");
		expect(formatConversationTime(now + 10_000, now)).toBe("");
	});
});
