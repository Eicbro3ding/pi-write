/**
 * memory 工具(2026-10-13,Phase 3):让 AI 自主维护两份长期记忆。
 *
 * - `target: "memory"` → 当前书的 `memory.md`(这本书发生了什么:人物状态变化、
 *   用户当场给的细节与纠正)。
 * - `target: "user"`   → 全局 `user.md`(**跨书共用**:这位作者的语气/文体/禁忌、
 *   怎么跟他讲话)。落在 `~/.pi/writer/user.md`(见 {@link getUserProfilePath})。
 *
 * 设计直接借自 Hermes 的 `memory` 工具(见 docs/agent-memory-research-2026-10-13.md):
 *
 * 1. **条目 = 一行**。add 追加一行,replace/remove 用 old_text 子串定位**某一行**。
 * 2. **命中多条不静默取首个**:报错并列候选(与 `resolveByIdOrName` 同一条纪律)。
 * 3. **容量即协商**:超预算时不写,而是把现有条目回给模型 + 一句「现在整合」——
 *    写提示词的人只写正常情况,异常指引由工具在当刻生成(带上真实条目与用量)。
 * 4. **成功响应是终态的**:只回一句「已记下」+ 用量,**不回显全量条目** —— 回声会
 *    诱导模型「再找点毛病修修」,实测过正确写入后跟一串冗余重复。条目只在超限路径回。
 * 5. 预算用 **token**(`estimateTokens`),与 pi-write 的注入预算体系同口径。
 *
 * 落盘:原子写({@link atomicWriteFile})+ 按文件路径 `withWorldLock` 串行化。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { atomicWriteFile } from "./atomic-write.ts";
import { getUserProfilePath } from "./config.ts";
import { defineTool, type ToolDefinition } from "./pi-adapter/index.ts";
import { bookDirBase } from "./tools.ts";
import { withWorldLock } from "./world-lock.ts";
import { DEFAULT_USER_PROFILE_BUDGET, estimateTokens } from "./world-context.ts";
import { readWriterSettings } from "./writer-settings.ts";

export type MemoryTarget = "memory" | "user";

export interface MemoryOp {
	readonly action: "add" | "replace" | "remove";
	readonly content?: string;
	readonly old_text?: string;
}

/** 条目 = 一行(去空白后非空)。 */
export function parseMemoryEntries(raw: string): string[] {
	return raw
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
}

/** 渲染回文件文本(带尾换行;空 → 空串)。 */
export function renderMemoryEntries(entries: readonly string[]): string {
	return entries.length > 0 ? `${entries.join("\n")}\n` : "";
}

/** 用量:token / 预算 + 百分比。 */
function usageOf(text: string, budget: number): { tokens: number; budget: number; pct: number } {
	const tokens = estimateTokens(text);
	const pct = budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0;
	return { tokens, budget, pct };
}

/**
 * 把一组操作应用到条目上。**全有或全无**:任一操作畸形/零命中/多命中,抛错,
 * 调用方据此整批放弃。返回新条目数组(不改入参)。
 */
export function applyMemoryOps(entries: readonly string[], ops: readonly MemoryOp[]): string[] {
	const working = [...entries];
	for (let i = 0; i < ops.length; i += 1) {
		const op = ops[i]!;
		const pos = ops.length > 1 ? `第 ${i + 1} 个操作` : "操作";
		if (op.action === "add") {
			const content = (op.content ?? "").trim();
			if (!content) throw new Error(`${pos}:add 需要 content。`);
			working.push(content);
			continue;
		}
		const needle = (op.old_text ?? "").trim();
		if (!needle) throw new Error(`${pos}:${op.action} 需要 old_text(定位哪一条)。`);
		const hits = working.filter((e) => e.includes(needle));
		if (hits.length === 0) {
			throw new Error(
				`${pos}:没有条目包含「${needle}」。现有条目:\n${working.map((e) => `- ${e}`).join("\n") || "(无)"}\n请照抄要改的那条里的原文片段作为 old_text。`,
			);
		}
		if (new Set(hits).size > 1) {
			throw new Error(`${pos}:「${needle}」命中多条,请写得更具体:\n${[...new Set(hits)].map((e) => `- ${e}`).join("\n")}`);
		}
		const target = hits[0]!;
		const idx = working.indexOf(target);
		if (op.action === "remove") {
			working.splice(idx, 1);
		} else {
			const content = (op.content ?? "").trim();
			if (!content) throw new Error(`${pos}:replace 需要 content(要 remove 请用 action='remove')。`);
			working[idx] = content;
		}
	}
	return working;
}

/** 在一次调用里跑完并（可能）落盘;返回给模型看的文本。导出供测试直接驱动。 */
export async function runMemory(
	file: string,
	budget: number,
	ops: readonly MemoryOp[],
	label: string,
): Promise<{ text: string; usage: { tokens: number; budget: number; pct: number }; ok: boolean }> {
	return withWorldLock(file, async () => {
		let raw = "";
		try {
			raw = await readFile(file, "utf-8");
		} catch {
			raw = "";
		}
		const entries = parseMemoryEntries(raw);
		let next: string[];
		try {
			next = applyMemoryOps(entries, ops);
		} catch (e) {
			return { text: e instanceof Error ? e.message : String(e), usage: usageOf(renderMemoryEntries(entries), budget), ok: false };
		}
		const rendered = renderMemoryEntries(next);
		const usage = usageOf(rendered, budget);
		if (usage.tokens > budget) {
			const current = renderMemoryEntries(entries);
			return {
				ok: false,
				usage,
				text:
					`${label}已用 ${usage.tokens}/${budget} token(超了)。这次改动没写入。` +
					`请**在同一次调用**里用 operations 批量:先 remove/replace 合并或删掉过时条目腾地方,再加新条目,然后重试。当前条目:\n` +
					(entries.map((e) => `- ${e}`).join("\n") || "(无)"),
			};
		}
		await mkdir(dirname(file), { recursive: true });
		await atomicWriteFile(file, rendered);
		// 终态响应:确认落地即结束,**不回显全量条目**(回声会诱发冗余重复)
		return { ok: true, usage, text: `已记入${label}(${usage.pct}% — ${usage.tokens}/${budget} token)。写完了,不要重复。` };
	});
}

function opsFromParams(params: { action?: unknown; content?: unknown; old_text?: unknown; operations?: unknown }): MemoryOp[] {
	if (Array.isArray(params.operations)) {
		return params.operations.map((raw) => {
			const o = (raw ?? {}) as Record<string, unknown>;
			return {
				action: (o.action as MemoryOp["action"]) ?? "add",
				content: typeof o.content === "string" ? o.content : undefined,
				old_text: typeof o.old_text === "string" ? o.old_text : undefined,
			};
		});
	}
	return [
		{
			action: (params.action as MemoryOp["action"]) ?? "add",
			content: typeof params.content === "string" ? params.content : undefined,
			old_text: typeof params.old_text === "string" ? params.old_text : undefined,
		},
	];
}

export const memoryTool: ToolDefinition = defineTool({
	name: "memory",
	label: "Memory",
	description:
		"维护两份跨会话的长期记忆(它们每轮都进上下文,所以**只记高信噪比、长期成立的事实**)。target:'memory' = 当前书的跨章记忆(人物状态变化、用户当场给的细节与纠正);'user' = 全局作者画像(**跨书共用**:作者的语气/文体/禁忌、怎么跟他讲话)。\n\n" +
		"动作:'add' 追加一条;'replace' / 'remove' 用 old_text(一条唯一子串)定位已有条目——命中多条会报错列候选,不会乱改第一个。一次要改多处就用 'operations' 批量(原子:要么全成、要么全不动,且只按**最终结果**查容量,所以能在一次调用里删旧的腾地方 + 加新的)。\n\n" +
		"写成**陈述事实**,不要写成对自己的命令:「作者偏好电报体」✓,「以后都要用电报体」✗——祈使句在以后的会话里会被当成指令、盖过用户当轮的请求。\n\n" +
		"不要记:任务进度、已完成的工作、临时待办(那些不属于长期记忆);**七天就会过时的东西不要记**。流程性的方法论属于技能,不属于记忆。\n\n" +
		"容量满了会返回现有条目让你**当场精简**(合并/删旧)后重试,别把超限当失败放弃。",
	parameters: Type.Object({
		action: Type.Optional(Type.String({ enum: ["add", "replace", "remove"], description: "单发动作;用 operations 批量时省略" })),
		target: Type.Optional(Type.String({ enum: ["memory", "user"], description: "'memory' = 本书跨章记忆(默认);'user' = 全局作者画像" })),
		content: Type.Optional(Type.String({ description: "条目内容(add / replace 用)" })),
		old_text: Type.Optional(Type.String({ description: "定位已有条目的唯一子串(replace / remove 用)" })),
		operations: Type.Optional(
			Type.Array(
				Type.Object({
					action: Type.String({ enum: ["add", "replace", "remove"] }),
					content: Type.Optional(Type.String()),
					old_text: Type.Optional(Type.String()),
				}),
				{ description: "批量操作,原子应用,按最终结果查容量" },
			),
		),
	}),
	async execute(_callId, params) {
		const target: MemoryTarget = params.target === "user" ? "user" : "memory";
		const ops = opsFromParams(params as Record<string, unknown>);
		if (ops.length === 0) throw new Error("memory:没有要执行的操作。");

		let file: string;
		let budget: number;
		let label: string;
		if (target === "user") {
			file = getUserProfilePath();
			budget = DEFAULT_USER_PROFILE_BUDGET;
			label = "作者画像(user.md)";
		} else {
			const dir = bookDirBase();
			if (!dir) throw new Error("memory 未配置书目录(仅 'user' 目标可在书外使用)。");
			file = join(dir, "memory.md");
			const settings = await readWriterSettings();
			budget = settings.memoryBudget;
			label = "跨章记忆(memory.md)";
		}

		const result = await runMemory(file, budget, ops, label);
		return {
			content: [{ type: "text", text: result.text }],
			details: { ok: result.ok, target, usage: result.usage },
		};
	},
});
