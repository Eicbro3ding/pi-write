/**
 * 提问卡片的前端数据层(web/src/ask-user.ts)。
 *
 * 两条路径都要覆盖:实时(result 是 vendor 的 {content,details} 被 JSON.stringify 后的
 * 字符串)与历史水合(toolResult 只有文本)。刷新后卡片变成空白是这里最容易出的错。
 */
import { describe, expect, it } from "vitest";
import { ASK_USER_TOOL, askAnswersOf, askWasCancelled, findPendingAsk, nextUnsettled, parseAskQuestions } from "../web/src/ask-user.ts";
import type { ChatMessage, MessageBlock } from "../web/src/types.ts";

/** 造一条 assistant 消息,只带若干工具块。 */
function msgWithTools(calls: Array<{ id: string; name: string; args: string; result: string | null }>): ChatMessage {
	const blocks: MessageBlock[] = calls.map((c) => ({
		kind: "tool",
		call: { id: c.id, name: c.name, args: c.args, result: c.result, isError: false },
	}));
	return { id: `m-${calls[0]?.id ?? "x"}`, role: "assistant", blocks, done: true };
}

const ARGS = JSON.stringify({ questions: [{ question: "往哪走?", options: ["山里", "城里"] }] });

describe("parseAskQuestions", () => {
	it("解析工具块 args 的提问与候选", () => {
		expect(parseAskQuestions(ARGS)).toEqual([{ question: "往哪走?", options: ["山里", "城里"] }]);
	});
	it("multiple: true 透传(决定渲染编号还是复选框)", () => {
		const args = JSON.stringify({ questions: [{ question: "多选题?", options: ["A", "B"], multiple: true }] });
		expect(parseAskQuestions(args)).toEqual([{ question: "多选题?", options: ["A", "B"], multiple: true }]);
		expect(parseAskQuestions(ARGS)[0]).not.toHaveProperty("multiple");
	});
	it("非 JSON / 形状不符 / 无有效提问 → 空数组(调用方据此不渲染卡片)", () => {
		expect(parseAskQuestions("not json")).toEqual([]);
		expect(parseAskQuestions("{}")).toEqual([]);
		expect(parseAskQuestions('{"questions":[]}')).toEqual([]);
		expect(parseAskQuestions('{"questions":[{"options":["A"]}]}')).toEqual([]);
	});
});

describe("askAnswersOf", () => {
	const n = 1;

	it("多选答案原样带出(前端不再拆「、」,记录里就显示用户勾的那几项)", () => {
		const result = JSON.stringify({ details: { answers: [{ question: "哪些?", answer: "A、C" }] } });
		expect(askAnswersOf(result, 1)).toEqual(["A、C"]);
	});

	it("实时路径:从 details.answers 取(结构化,最可靠)", () => {
		const result = JSON.stringify({
			content: [{ type: "text", text: "1. 往哪走?\n   → 城里" }],
			details: { answers: [{ question: "往哪走?", answer: "城里" }] },
		});
		expect(askAnswersOf(result, n)).toEqual(["城里"]);
	});

	it("历史水合路径:details 没了,退化为解析结果文本的「→」行", () => {
		expect(askAnswersOf("1. 往哪走?\n   → 山里", n)).toEqual(["山里"]);
	});

	it("details 里 cancelled → null(用户关了卡片,不是答了空)", () => {
		const result = JSON.stringify({ content: [{ type: "text", text: "用户关闭了提问卡片,没有回答。" }], details: { cancelled: true } });
		expect(askAnswersOf(result, n)).toBeNull();
		expect(askWasCancelled(result, n)).toBe(true);
	});

	it("result 为 null(还在等) → null,且不算取消", () => {
		expect(askAnswersOf(null, n)).toBeNull();
		expect(askWasCancelled(null, n)).toBe(false);
	});

	it("答案数按提问数对齐:少补空串,多则截断", () => {
		const two = JSON.stringify({ details: { answers: [{ answer: "A" }] } });
		expect(askAnswersOf(two, 2)).toEqual(["A", ""]);
		const three = JSON.stringify({ details: { answers: [{ answer: "A" }, { answer: "B" }, { answer: "C" }] } });
		expect(askAnswersOf(three, 2)).toEqual(["A", "B"]);
	});

	it("认不出来的结果 → null(渲染成「未回答」,不炸)", () => {
		expect(askAnswersOf("完全不是答案的一段话", n)).toBeNull();
	});
});

describe("findPendingAsk", () => {
	it("找出 result 为 null 的 ask_user 块(这就是浮层的挂载条件)", () => {
		const m = msgWithTools([
			{ id: "c1", name: "read", args: "{}", result: "ok" },
			{ id: "c2", name: ASK_USER_TOOL, args: ARGS, result: null },
		]);
		expect(findPendingAsk([m])).toEqual({ toolCallId: "c2", questions: [{ question: "往哪走?", options: ["山里", "城里"] }] });
	});

	it("已有结果的不算未决(历史里答过的提问不会把浮层重新弹出来)", () => {
		const m = msgWithTools([{ id: "c1", name: ASK_USER_TOOL, args: ARGS, result: "1. 往哪走?\n   → 山里" }]);
		expect(findPendingAsk([m])).toBeNull();
	});

	it("同名多个时取最后一个(前面的都是历史)", () => {
		const a = msgWithTools([{ id: "c1", name: ASK_USER_TOOL, args: ARGS, result: "…→ 山里" }]);
		const b = msgWithTools([{ id: "c2", name: ASK_USER_TOOL, args: ARGS, result: null }]);
		expect(findPendingAsk([a, b])?.toolCallId).toBe("c2");
	});

	it("其它工具未答不会误判(只有 ask_user 才算提问)", () => {
		const m = msgWithTools([{ id: "c1", name: "bash", args: "{}", result: null }]);
		expect(findPendingAsk([m])).toBeNull();
	});

	it("参数坏掉的未决块跳过(渲染不出卡片,不如当作没有)", () => {
		const m = msgWithTools([{ id: "c1", name: ASK_USER_TOOL, args: "{坏的", result: null }]);
		expect(findPendingAsk([m])).toBeNull();
	});
});

describe("nextUnsettled:跳题规则(唯一出过 bug 的地方)", () => {
	it("从当前题往后找第一道未决题,环形回绕", () => {
		expect(nextUnsettled(0, 3, [true, false, false])).toBe(1);
		expect(nextUnsettled(0, 3, [true, true, false])).toBe(2);
		// 后半段都结算了 → 回绕到前面
		expect(nextUnsettled(1, 3, [false, true, true])).toBe(0);
	});

	it("从当前题**之后**开始找:跳过自己", () => {
		// 自己还没结算,但也要往后走(否则「跳过」会停在原地 —— 就是这个 bug)
		expect(nextUnsettled(1, 3, [true, false, false])).toBe(2);
	});

	it("全部结算 → null(该提交了)", () => {
		expect(nextUnsettled(0, 3, [true, true, true])).toBeNull();
		expect(nextUnsettled(2, 3, [true, true, true])).toBeNull();
	});

	it("单题卡片:自己结算后就没有下一题了", () => {
		expect(nextUnsettled(0, 1, [false])).toBeNull();
		expect(nextUnsettled(0, 1, [true])).toBeNull();
	});

	it("空卡片不炸", () => {
		expect(nextUnsettled(0, 0, [])).toBeNull();
	});
});
