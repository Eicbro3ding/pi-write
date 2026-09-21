/**
 * ask_user 提问卡片的前端数据层(纯函数,可单测)。
 *
 * 卡片挂在 `ask_user` 工具块上(见 tool-status.ts 的 ToolRenderForm "ask"),
 * 所以数据来源只有两处:
 * - **提问** = 工具块的 args(模型调用时给的 JSON);
 * - **回答** = 工具块的结果(result 为 null 就是「还没答」,即卡片该弹出的时候)。
 *
 * 结果形状有个坑值得记住:`store.ts` 收到 `tool_execution_end` 时,`result` 不是字符串
 * 而是 vendor 的 `{content, details}` 对象,于是被 `JSON.stringify` 存进 ToolCallInfo。
 * 所以能拿到**结构化的 details**(工具自己上报的 answers),这是主路径;
 * 历史水合(toolResult entry 只有文本)拿不到 details,退化为解析结果文本里的「→」行。
 * 两条路都留着:前者精确,后者保证刷新后卡片不会变成空白。
 */

import type { ChatMessage } from "./types.ts";

/** 一个提问(与后端 AskQuestion 同形状)。 */
export interface AskQuestionView {
	question: string;
	options: string[];
	/** true = 多选(勾选形态,答案以「、」连接);缺省单选。 */
	multiple?: boolean;
}

/** 工具名:渲染表与数据层共用同一个常量,避免两处各写一遍字符串。 */
export const ASK_USER_TOOL = "ask_user";

/** 解析工具块 args → 提问列表。形状不符 / 空数组返回 []。 */
export function parseAskQuestions(args: string): AskQuestionView[] {
	let raw: unknown;
	try {
		raw = JSON.parse(args);
	} catch {
		return [];
	}
	const list = (raw as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(list)) return [];
	const out: AskQuestionView[] = [];
	for (const item of list) {
		const q = item as { question?: unknown; options?: unknown; multiple?: unknown };
		if (typeof q?.question !== "string" || q.question.trim().length === 0) continue;
		const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [];
		const multiple = (q as { multiple?: unknown }).multiple === true;
		out.push({ question: q.question, options, ...(multiple ? { multiple: true } : {}) });
	}
	return out;
}

/** 从结果文本里抽「→ 答案」行(历史水合路径;文本由工具的 execute 生成)。 */
function answersFromLines(text: string, count: number): string[] | null {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*→\s*(.*)$/.exec(line);
		if (m) out.push(m[1]!.trim());
	}
	if (out.length === 0) return null;
	// 补齐到提问数(模型可能只答了部分,理论上不会,但别让长度对不上)
	while (out.length < count) out.push("");
	return out.slice(0, count);
}

/**
 * 解析已回答的答案。
 * @returns 与提问等长的答案数组;**null = 没有答案**(还在等 / 用户取消了 / 认不出来)。
 *   null 与 `[""]` 语义不同:前者渲染成「等待回答」或「已跳过」,后者是「答了空」。
 */
export function askAnswersOf(result: string | null, questionCount: number): string[] | null {
	if (result === null || result.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(result);
	} catch {
		// 不是 JSON:当成纯文本(某些路径只留了文本)
		return answersFromLines(result, questionCount);
	}
	const obj = parsed as { details?: { cancelled?: unknown; answers?: unknown }; content?: unknown } | null;
	const details = obj?.details;
	if (details && details.cancelled === true) return null;
	if (details && Array.isArray(details.answers)) {
		const out = details.answers.map((a) => {
			const answer = (a as { answer?: unknown } | null)?.answer;
			return typeof answer === "string" ? answer : "";
		});
		while (out.length < questionCount) out.push("");
		return out.slice(0, questionCount);
	}
	// 有 content 就用 content 的文本;没有就直接拿原字符串试
	const text = contentText(obj?.content);
	return answersFromLines(text ?? result, questionCount);
}

/** 从 vendor 的 content 数组里取文本。 */
function contentText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		const text = (part as { text?: unknown } | null)?.text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/** 卡片上「已跳过」的判定:结果存在但取不出答案(用户关了卡片)。 */
export function askWasCancelled(result: string | null, questionCount: number): boolean {
	return result !== null && askAnswersOf(result, questionCount) === null;
}

/**
 * 下一道未决题的下标(从 from 之后环形查找);都结算了就返回 null —— null 即「该提交了」。
 *
 * 抽成纯函数是因为它是整张卡片的导航规则,也是唯一出过 bug 的地方:早先的实现读完态
 * 数组时用的是上一次渲染的闭包值,同一 tick 内连点会丢步(「跳过」后停在原地)。
 * 规则本身只有这一条 —— 从**下一题**开始环回找未决的;**绕回自己就说明没有别的题了**,
 * 返回 null(该提交了)。单题卡片因此不会把自己当成"下一题"而停在原地。
 */
export function nextUnsettled(from: number, total: number, settled: readonly boolean[]): number | null {
	if (total <= 0) return null;
	for (let step = 1; step <= total; step++) {
		const i = (from + step) % total;
		if (i === from) break; // 绕回自己:没有别的题
		if (!settled[i]) return i;
	}
	return null;
}

/**
 * 找出当前**正在等待回答**的提问:最后一个 result 为 null 的 ask_user 工具块。
 *
 * 这就是「前端不需要新事件类型」的原因 —— 工具在 `execute` 里阻塞着,所以它的块
 * 一直停在 result=null;刷新后从会话文件水合出来的块同样如此(工具还没写结果)。
 * 于是浮层的挂载条件可以纯粹从消息流推出来,不必额外维护一份 pending 状态。
 *
 * 同名工具重复出现时取最后一个(前面的是历史上已答完的,它们的 result 非 null)。
 */
export function findPendingAsk(messages: readonly ChatMessage[]): { toolCallId: string; questions: AskQuestionView[] } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const blocks = messages[i]!.blocks;
		for (let j = blocks.length - 1; j >= 0; j--) {
			const b = blocks[j]!;
			if (b.kind !== "tool" || b.call.name !== ASK_USER_TOOL || b.call.result !== null) continue;
			const questions = parseAskQuestions(b.call.args);
			if (questions.length === 0) continue;
			return { toolCallId: b.call.id, questions };
		}
	}
	return null;
}
