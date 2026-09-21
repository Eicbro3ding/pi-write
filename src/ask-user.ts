/**
 * ask_user —— 让 AI 在对话中向用户提问的工具(2026-09-21)。
 *
 * 为什么需要一个「闸门」而不是直接返回:
 * 这个工具的语义是**阻塞**的 —— AI 提出问题后停下,拿到用户的回答再继续。所以
 * `execute` 返回的 Promise 不会立刻 settle,而是挂进 `AskUserGate`;用户在卡片上
 * 提交答案时,HTTP 端点调 `gate.answer(toolCallId, ...)` 把它 resolve 掉。
 * 工具结果 = 用户的选择,模型在同一个回合里直接接着往下写,不额外多一轮往返。
 *
 * 前端为什么不需要新事件类型:
 * `tool_execution_start` 已经把工具块的参数(args = 提问 JSON)送到了前端,而
 * `tool_execution_end` 之前 `result` 恒为 null —— 「有个 ask_user 块没结果」这件事
 * 本身就等于「正等待用户回答」。所以卡片直接以工具块为宿主:未回答时弹浮层,
 * 回答后原地变成折叠的问答记录(2026-09-19 的块渲染表正好支持这个形态)。
 *
 * 取消的三种来源,都走 `cancel`,**不抛错**:
 * 用户点关闭 / 用户中断本轮对话 / 会话被释放。抛错会让模型把「用户没选」当成
 * 工具故障去重试;这里改成返回一段说明,让它自己决定(取最合理的一项并说明)。
 *
 * ⚠️ 闸门是进程级单例(见 askUserGate):多个会话共享一张 pending 表。
 * 实际上同时只会有一次提问在等回答(用户一次只能答一张卡),所以按 toolCallId
 * 索引就够;真要并行多会话,得再按会话分桶。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../vendor/pi-coding-agent/src/index.ts";

/** 一个提问:标题 + 候选项(用户还可以选「其他补充」自己写)。 */
export interface AskQuestion {
	question: string;
	options: string[];
	/** true = 多选(勾选形态,答案以「、」连接);缺省单选。 */
	multiple?: boolean;
}

/** 一次待回答的提问(前端浮层渲染用;与工具参数同形状)。 */
/**
 * 工具结果的 details。两支都得上报同一个类型:vendor 按第一次返回推断泛型,
 * 形状分叉会让第二支不可赋值(踩过)。
 */
export interface AskUserDetails {
	cancelled?: boolean;
	answers?: Array<{ question: string; answer: string }>;
}

/** 一次待回答的提问(前端浮层渲染用;与工具参数同形状)。 */
export interface PendingAskView {
	toolCallId: string;
	questions: AskQuestion[];
}

interface PendingEntry {
	questions: AskQuestion[];
	resolve: (answers: string[] | null) => void;
}

/** 提问归一:单行化 + 去空白 + 去掉空候选项。 */
export function normalizeQuestions(raw: ReadonlyArray<{ question?: unknown; options?: unknown; multiple?: unknown }> | undefined): AskQuestion[] {
	if (!Array.isArray(raw)) return [];
	const out: AskQuestion[] = [];
	for (const q of raw) {
		if (typeof q?.question !== "string") continue;
		// 标题单行化:卡片是一行标题,换行会把它撑破(模型经常带换行)
		const question = q.question.replace(/\s+/g, " ").trim();
		if (question.length === 0) continue;
		const multiple = (q as { multiple?: unknown }).multiple === true;
		const rawOptions: unknown[] = Array.isArray(q.options) ? q.options : [];
		const options = rawOptions
			.filter((o): o is string => typeof o === "string")
			.map((o) => o.replace(/\s+/g, " ").trim())
			.filter((o) => o.length > 0);
		out.push({ question, options, ...(multiple ? { multiple: true } : {}) });
	}
	return out;
}

/**
 * 待回答提问的闸门。`ask` 挂起 → `answer`/`cancel` 结算。
 * 纯内存状态,不落盘:提问跨进程重启没有意义(重启后模型那边也断了)。
 */
export class AskUserGate {
	private readonly pending = new Map<string, PendingEntry>();

	/** 未决提问数(诊断/测试)。 */
	get size(): number {
		return this.pending.size;
	}

	/** 当前未决提问的 toolCallId(诊断用)。 */
	ids(): string[] {
		return [...this.pending.keys()];
	}

	/**
	 * 挂起一次提问,等用户作答。
	 * @returns 用户提交的答案(与提问等长);用户取消 → null。
	 * 同一个 toolCallId 重复挂起(SSE 重放等)时直接复用已有 Promise,不重复登记。
	 */
	ask(toolCallId: string, questions: AskQuestion[]): Promise<string[] | null> {
		const existing = this.pending.get(toolCallId);
		if (existing) return new Promise((resolve) => this.pending.set(toolCallId, { questions: existing.questions, resolve }));
		return new Promise((resolve) => {
			this.pending.set(toolCallId, { questions, resolve });
		});
	}

	/** 用户提交答案。工具调用 id 不存在(已取消/已过期)返回 false,不抛错。 */
	answer(toolCallId: string, answers: readonly string[]): boolean {
		const entry = this.pending.get(toolCallId);
		if (!entry) return false;
		this.pending.delete(toolCallId);
		entry.resolve(entry.questions.map((_, i) => answers[i] ?? ""));
		return true;
	}

	/** 用户关闭卡片:结算为「未回答」。 */
	cancel(toolCallId: string, _reason?: string): boolean {
		const entry = this.pending.get(toolCallId);
		if (!entry) return false;
		this.pending.delete(toolCallId);
		entry.resolve(null);
		return true;
	}

	/** 中断本轮 / 释放会话:清掉所有未决提问,返回清掉的条数。 */
	cancelAll(): number {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const e of entries) e.resolve(null);
		return entries.length;
	}
}

/** 进程级共享闸门(工具与 HTTP 端点必须指的是同一个)。 */
export const askUserGate = new AskUserGate();

/** 用户取消/未回答时给模型的说明——重点是别让它把「没回答」当成工具故障。 */
export const ASK_CANCELLED_TEXT =
	"用户关闭了提问卡片,没有回答。不要再重复问同一件事;确实需要抉择时自行取最合理的一项,并在回复里说明你替他做了决定。";

/**
 * 造工具。闸门可注入,便于单测(不给默认值就走共享单例)。
 */
export function createAskUserTool(gate: AskUserGate = askUserGate): ToolDefinition {
	const parameters = Type.Object({
		questions: Type.Array(
			Type.Object({
				question: Type.String({
					description: "要问用户的问题,单行、具体。不要用来确认你已经能自己决定的事。",
				}),
				options: Type.Array(Type.String(), {
					description: "2-4 个候选答案,写成用户会直接说出口的短句;最可能的放第一个。用户总能选「其他补充」自己写。",
				}),
				multiple: Type.Optional(
					Type.Boolean({
						description: "true = 这题可以多选(用户可以勾几项)。只在「可以只要一个,也可以几个都要」时才开;互斥的选项保持单选。",
					}),
				),
			}),
			{ description: "1-4 个提问,一次问清;能一次问完就不要分多次调用。" },
		),
	});

	return defineTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"向用户提问并**等待回答**:适合在岔路口让用户选方向(剧情走向、人物取舍、文风偏好),或者一次问清几个只有用户知道的事实。会弹出一张选项卡,用户点选或自己补充。会阻塞当前回合直到用户作答,所以只在真的需要用户决定时才用;能自己判断的不要问,一次能问完的不要拆成多次。",
		parameters,
		async execute(callId, params) {
			const questions = normalizeQuestions(params.questions as Array<{ question?: unknown; options?: unknown }>);
			if (questions.length === 0) throw new Error("ask_user 需要至少一个有效提问(questions 非空,且每项要有 question)");
			const answers = await gate.ask(callId, questions);
			// details 显式标注:两支都得上报同一类型 —— vendor 按第一支推断泛型,
			// 形状分叉会让第二支不可赋值(踩过)
			if (answers === null) {
				const details: AskUserDetails = { cancelled: true };
				return { content: [{ type: "text", text: ASK_CANCELLED_TEXT }], details };
			}
			// 结果文本既是给模型读的,也是前端刷新后还原卡片的依据(见 web/src/ask-user.ts)
			const lines = questions.map((q, i) => {
				const a = answers[i] ?? "";
				// 空答案 = 用户跳过了这题(不是答了空):显式写出来,模型才不会当成"答了空字符串"
				return `${i + 1}. ${q.question}\n   → ${a.length > 0 ? a : "（用户跳过，未作答）"}`;
			});
			const details: AskUserDetails = {
				answers: questions.map((q, i) => ({ question: q.question, answer: answers[i] ?? "" })),
			};
			return { content: [{ type: "text", text: lines.join("\n") }], details };
		},
	});
}
