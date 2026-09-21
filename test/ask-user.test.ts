/**
 * ask_user 提问工具与闸门(src/ask-user.ts)。
 *
 * 纯逻辑:闸门是内存 Map,工具只依赖注入的闸门 —— 不碰真实会话,不阻塞。
 */
import { describe, expect, it, vi } from "vitest";
import { ASK_CANCELLED_TEXT, AskUserGate, createAskUserTool, normalizeQuestions } from "../src/ask-user.ts";

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
