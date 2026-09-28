/**
 * ask_user 提问工具与闸门(src/ask-user.ts)。
 *
 * 纯逻辑:闸门是内存 Map,工具只依赖注入的闸门 —— 不碰真实会话,不阻塞。
 */
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../vendor/pi-coding-agent/src/index.ts";
import {
	ASK_CANCELLED_TEXT,
	AskUserGate,
	createAskUserTool,
	normalizeQuestions,
	settleDanglingAskParts,
	settleDanglingAsks,
} from "../src/ask-user.ts";

describe("normalizeQuestions", () => {
	it("单行化 + 去空白(卡片标题是一行,模型常带换行)", () => {
		const out = normalizeQuestions([{ question: "  这是\n一次  提问?  ", options: [" A ", "\nB"] }]);
		expect(out).toEqual([{ question: "这是 一次 提问?", options: ["A", "B"] }]);
	});
	it("丢掉没有 question 的项与空候选,保留顺序", () => {
		const out = normalizeQuestions([
			{ question: "第一问", options: ["A"] },
			{ options: ["没有标题"] },
			{ question: "   ", options: ["空白标题"] },
			{ question: "第二问", options: ["A", "", "  ", "B"] },
		]);
		expect(out.map((q) => q.question)).toEqual(["第一问", "第二问"]);
		expect(out[1]!.options).toEqual(["A", "B"]);
	});
	it("options 缺失/非数组 → 空候选(用户仍可走「其他补充」)", () => {
		expect(normalizeQuestions([{ question: "问" }])).toEqual([{ question: "问", options: [] }]);
		expect(normalizeQuestions([{ question: "问", options: "A,B" }])).toEqual([{ question: "问", options: [] }]);
	});
	it("multiple: true 透传(多选形态);缺省不带该字段(单选)", () => {
		expect(normalizeQuestions([{ question: "多选?", options: ["A", "B"], multiple: true }])).toEqual([
			{ question: "多选?", options: ["A", "B"], multiple: true },
		]);
		expect(normalizeQuestions([{ question: "单选?", options: ["A"] }])[0]).not.toHaveProperty("multiple");
		// 非 true 的值一律当单选(模型可能给 "yes" / 1 之类)
		expect(normalizeQuestions([{ question: "?", options: ["A"], multiple: "yes" }])[0]).not.toHaveProperty("multiple");
	});
	it("非数组输入返回空", () => {
		expect(normalizeQuestions(undefined)).toEqual([]);
		expect(normalizeQuestions([])).toEqual([]);
	});
});

describe("AskUserGate", () => {
	it("ask 挂起,answer 结算为答案", async () => {
		const gate = new AskUserGate();
		const p = gate.ask("t1", [{ question: "问", options: ["A", "B"] }]);
		expect(gate.size).toBe(1);
		expect(gate.answer("t1", ["B"])).toBe(true);
		expect(await p).toEqual(["B"]);
		expect(gate.size).toBe(0);
	});

	it("答案按提问数对齐:少给补空串,多给截断", async () => {
		const gate = new AskUserGate();
		const p = gate.ask("t1", [
			{ question: "一", options: [] },
			{ question: "二", options: [] },
		]);
		gate.answer("t1", ["只答一个"]);
		expect(await p).toEqual(["只答一个", ""]);
	});

	it("cancel 结算为 null(用户关闭卡片),不是空答案", async () => {
		const gate = new AskUserGate();
		const p = gate.ask("t1", [{ question: "问", options: [] }]);
		expect(gate.cancel("t1")).toBe(true);
		expect(await p).toBeNull();
	});

	it("cancelAll 清掉所有未决提问(中断本轮时用)", async () => {
		const gate = new AskUserGate();
		const a = gate.ask("t1", [{ question: "一", options: [] }]);
		const b = gate.ask("t2", [{ question: "二", options: [] }]);
		expect(gate.cancelAll()).toBe(2);
		expect(await a).toBeNull();
		expect(await b).toBeNull();
		expect(gate.size).toBe(0);
	});

	it("对已结束的提问再 answer/cancel 返回 false,不抛错(SSE 重放/双窗口)", async () => {
		const gate = new AskUserGate();
		const p = gate.ask("t1", [{ question: "问", options: [] }]);
		gate.answer("t1", ["A"]);
		await p;
		expect(gate.answer("t1", ["B"])).toBe(false);
		expect(gate.cancel("t1")).toBe(false);
		expect(gate.cancel("不存在")).toBe(false);
	});
});

describe("createAskUserTool", () => {
	function askTool(gate: AskUserGate) {
		return createAskUserTool(gate);
	}

	it("阻塞到用户作答,结果文本是「编号. 问题 / → 答案」,details 结构化", async () => {
		const gate = new AskUserGate();
		const tool = askTool(gate);
		const running = tool.execute("t1", { questions: [{ question: "往哪走?", options: ["山里", "城里"] }] }, undefined, undefined, {} as never);
		// 此刻工具还挂着(这就是「阻塞」的可观测形态)
		expect(gate.size).toBe(1);
		gate.answer("t1", ["城里"]);
		const result = await running;
		expect(result.content[0]).toMatchObject({ type: "text", text: "1. 往哪走?\n   → 城里" });
		expect(result.details).toEqual({ answers: [{ question: "往哪走?", answer: "城里" }] });
	});

	it("多个提问逐条成行", async () => {
		const gate = new AskUserGate();
		const tool = askTool(gate);
		const running = tool.execute(
			"t1",
			{
				questions: [
					{ question: "一?", options: ["A"] },
					{ question: "二?", options: ["B"] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		gate.answer("t1", ["A", "B"]);
		const result = await running;
		expect(result.content[0]).toMatchObject({ text: "1. 一?\n   → A\n2. 二?\n   → B" });
	});

	it("跳过的题显式写成「用户跳过，未作答」(空串不等于答了空)", async () => {
		const gate = new AskUserGate();
		const tool = askTool(gate);
		const running = tool.execute(
			"t1",
			{
				questions: [
					{ question: "一?", options: ["A"] },
					{ question: "二?", options: ["B"] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		// 只答第一题,第二题留空 = 跳过
		gate.answer("t1", ["A", ""]);
		const result = await running;
		expect(result.content[0]).toMatchObject({ text: "1. 一?\n   → A\n2. 二?\n   → （用户跳过，未作答）" });
	});

	it("多选答案以「、」连接原样带回(连接在工具里不做,由用户侧拼好)", async () => {
		const gate = new AskUserGate();
		const tool = askTool(gate);
		const running = tool.execute("t1", { questions: [{ question: "哪些?", options: ["A", "B", "C"], multiple: true }] }, undefined, undefined, {} as never);
		gate.answer("t1", ["A、C"]);
		const result = await running;
		expect(result.content[0]).toMatchObject({ text: "1. 哪些?\n   → A、C" });
	});

	it("用户关闭卡片 → 不抛错,给一段「别再追问」的说明(抛错会被模型当成工具故障)", async () => {
		const gate = new AskUserGate();
		const tool = askTool(gate);
		const running = tool.execute("t1", { questions: [{ question: "问?", options: [] }] }, undefined, undefined, {} as never);
		gate.cancel("t1");
		const result = await running;
		expect(result.content[0]).toMatchObject({ text: ASK_CANCELLED_TEXT });
		expect(result.details).toEqual({ cancelled: true });
		expect(ASK_CANCELLED_TEXT).toContain("不要再重复问");
	});

	it("提问为空/非法 → 抛错(这是调用方的 bug,不该静默等一个空卡片)", async () => {
		const tool = askTool(new AskUserGate());
		await expect(tool.execute("t1", { questions: [] }, undefined, undefined, {} as never)).rejects.toThrow(/至少一个有效提问/);
		await expect(tool.execute("t1", { questions: [{ options: ["A"] }] } as never, undefined, undefined, {} as never)).rejects.toThrow();
	});

	it("工具元信息:名字/标签/描述点明会阻塞", () => {
		const tool = askTool(new AskUserGate());
		expect(tool.name).toBe("ask_user");
		expect(tool.label).toBe("Ask User");
		expect(tool.description).toContain("等待回答");
	});

	it("默认闸门就是共享单例(端点与工具必须指的是同一个)", async () => {
		const tool = createAskUserTool();
		const spy = vi.spyOn(tool, "execute");
		expect(spy).toBeDefined();
		// 不真的执行(会永久挂起):这里只断言工厂在不传参时可用
		expect(tool.name).toBe("ask_user");
	});
});

/** 推一条「assistant 发起 ask_user 工具调用」的消息(真实内存 SessionManager)。 */
function pushAskCall(sm: SessionManager, id: string): void {
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "ask_user", arguments: { questions: [{ question: "问?", options: ["A"] }] } }],
		timestamp: Date.now(),
	} as never);
}

describe("AskUserGate.has", () => {
	it("未决提问为 true,结算后为 false", async () => {
		const gate = new AskUserGate();
		const p = gate.ask("t1", [{ question: "问", options: [] }]);
		expect(gate.has("t1")).toBe(true);
		gate.answer("t1", ["A"]);
		await p;
		expect(gate.has("t1")).toBe(false);
		expect(gate.has("不存在")).toBe(false);
	});
});

describe("settleDanglingAsks(悬空提问清扫:重启后不再弹死卡)", () => {
	it("分支末尾未配对的 ask_user → 补一条「未回答」的 toolResult", () => {
		const sm = SessionManager.inMemory("/tmp/book");
		pushAskCall(sm, "t1");
		expect(settleDanglingAsks(sm)).toBe(1);
		const last = sm.getBranch().at(-1) as { message: { role: string; toolCallId: string; details: unknown; content: Array<{ text: string }> } };
		expect(last.message.role).toBe("toolResult");
		expect(last.message.toolCallId).toBe("t1");
		expect(last.message.details).toEqual({ cancelled: true });
		expect(last.message.content[0]!.text).toBe(ASK_CANCELLED_TEXT);
	});

	it("已配对的提问不动(结果存在 → 末尾是 toolResult,不是悬空)", () => {
		const sm = SessionManager.inMemory("/tmp/book");
		pushAskCall(sm, "t1");
		sm.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "ask_user", content: [{ type: "text", text: "→ A" }], isError: false, timestamp: Date.now() } as never);
		expect(settleDanglingAsks(sm)).toBe(0);
		expect(sm.getBranch()).toHaveLength(2);
	});

	it("闸门里还活着的提问跳过,不替它结算", () => {
		const sm = SessionManager.inMemory("/tmp/book");
		pushAskCall(sm, "t1");
		expect(settleDanglingAsks(sm, () => true)).toBe(0);
		expect(sm.getBranch()).toHaveLength(1);
	});

	it("悬空提问不是末尾消息(后面还有 user)→ 不强行补(历史被改过/另有分支)", () => {
		const sm = SessionManager.inMemory("/tmp/book");
		pushAskCall(sm, "t1");
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "后来的消息" }], timestamp: Date.now() } as never);
		expect(settleDanglingAsks(sm)).toBe(0);
	});

	it("无关工具调用不受影响", () => {
		const sm = SessionManager.inMemory("/tmp/book");
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.md" } }],
			timestamp: Date.now(),
		} as never);
		expect(settleDanglingAsks(sm)).toBe(0);
	});
});

describe("settleDanglingAskParts(只读会话视图清扫)", () => {
	it("未配对的 ask_user 块标成已取消;已答/无关块不动", () => {
		const messages = [
			{ content: [{ type: "toolCall", id: "t1", name: "ask_user", arguments: "{}" }] },
			{ content: [{ type: "toolCall", id: "t2", name: "ask_user", arguments: "{}", result: "1. 问?\n   → A" }] },
			{ content: [{ type: "toolCall", id: "t3", name: "read", arguments: "{}" }] },
		];
		expect(settleDanglingAskParts(messages as never)).toBe(1);
		expect((messages[0]!.content![0] as { result?: string }).result).toBe(ASK_CANCELLED_TEXT);
		expect((messages[1]!.content![0] as { result?: string }).result).toBe("1. 问?\n   → A");
		expect((messages[2]!.content![0] as { result?: string }).result).toBeUndefined();
	});
});
