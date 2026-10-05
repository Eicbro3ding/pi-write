/**
 * 工具护栏:把「只写在提示词里拦不住」的几条硬规则下沉到工具层。
 *
 * 为什么需要(2026-10-01 会话 writer-c-v05ij1 复盘):提示词里明明写着
 * 「`write` 会整体替换文件,优先用 `edit`」和「一眼只读一次」,模型照样
 *   1. 用**空内容** `write` 把 2824 字的第二章草稿清零(L118 计到 2824 字,
 *      L121 用户说「我还没叫你开始写」,L123 就 write 了 0 字节);
 *   2. 用 `read` 带 offset 把同一章翻了 91 次,翻到
 *      `Offset 180 is beyond end of file (179 lines total)` 还在翻。
 *
 * 教训:**提示词能约束愿意遵守的模型,工具层才能约束不愿意遵守的模型。**
 * 护栏因此不替代提示词 —— 提示词仍在 `prompts/writer-main.md`,这里只拦
 * 「一旦发生就是事故」的两类动作,而且每条拦截都必须给出**出路**(该用哪个
 * 工具、该怎么做),否则模型只会换个 offset 继续绕。
 *
 * 与 `tool-guard.ts` 的分工:那边管**路径**(书目录边界、世界书禁直写、
 * 正文文件名白名单),这边管**动作**(空内容覆盖、读取循环)。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathWithinRoot } from "./tool-guard.ts";

/** 同一文件在一轮内的 read 次数上限;超过就强制改用 read_chapter。 */
export const READ_FILE_LIMIT = 6;

/**
 * 一轮内的 read 记账。
 * 用模块级变量而不是会话状态:护栏要的是「这一轮内有没有重复」,跨轮累积
 * 会让长会话后期什么都读不了。每轮由 `before_agent_start` 调 resetReadRails 清零。
 */
interface ReadRailsState {
	/** 已执行过的精确调用(rel + offset + limit),第二次起拦截。 */
	exact: Set<string>;
	/** 每个文件本轮已读次数。 */
	byFile: Map<string, number>;
}

function freshState(): ReadRailsState {
	return { exact: new Set<string>(), byFile: new Map<string, number>() };
}

let rails: ReadRailsState = freshState();

/** 每轮开始清零(由 `before_agent_start` 钩子调用)。 */
export function resetReadRails(): void {
	rails = freshState();
}

/** 归一化工具入参里的路径:相对书目录的取 rel,书目录外的返回 null(交给路径守卫)。 */
function toRel(raw: unknown, bookDir: string): string | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	const abs = isAbsolute(raw) ? raw : resolve(bookDir, raw);
	if (!pathWithinRoot(abs, bookDir)) return null;
	return relative(bookDir, abs);
}

/**
 * `write` 护栏:拦空内容覆盖。
 *
 * 只拦这一条,不拦「覆盖已有文件」——后者是 `write` 的正常语义,用户明确
 * 要求整体重写时合法(提示词也允许),硬拦会把正常的整章重写堵死。真正
 * 的事故是**静默清空**:模型传了空 content,文件就没了,而工具还回
 * 「Successfully wrote 0 bytes」,看起来像成功。
 *
 * @returns 拦截理由(给模型看,必须含出路);放行返回 null。
 */
export function guardWrite(input: { path?: unknown; content?: unknown } | undefined, bookDir: string): string | null {
	const rel = toRel(input?.path, bookDir);
	if (!rel) return null;
	const content = typeof input?.content === "string" ? input.content : "";
	// 纯空白也算空:换行/空格不构成正文,落盘同样是清空
	if (content.trim().length > 0) return null;
	return [
		`已拦截:write 会整体替换文件,你传的内容是空的 —— 这会把 ${rel} 直接清空,且工具仍会返回"写入成功",你不会收到任何警告。`,
		`出路:①要修订已有正文,用 edit(只改那一处,不会碰别的内容);`,
		`②要整体重写,把完整新内容一次性写进 content;`,
		`③如果只是还没想好写什么,先回复用户,不要写文件。`,
	].join("\n");
}

/**
 * `read` 护栏:拦读取循环。
 *
 * 两级:①同一区间(offset+limit 完全相同)读第二次 —— 结果一模一样,纯浪费;
 * ②同一文件本轮读够 READ_FILE_LIMIT 次 —— 说明在用 read 分页翻整章,而这正是
 * `read_chapter` 存在的原因(内置 read 在 2000 行/50KB 处截断,翻页翻不完)。
 */
export function guardRead(
	input: { path?: unknown; offset?: unknown; limit?: unknown } | undefined,
	bookDir: string,
): string | null {
	const rel = toRel(input?.path, bookDir);
	if (!rel) return null;
	const offset = typeof input?.offset === "number" ? input.offset : undefined;
	const limit = typeof input?.limit === "number" ? input.limit : undefined;

	// ①精确重复
	const key = `${rel}|${offset ?? ""}|${limit ?? ""}`;
	if (rails.exact.has(key)) {
		const where = offset !== undefined ? `的这一段(offset=${offset}${limit !== undefined ? `, limit=${limit}` : ""})` : "";
		return [
			`已拦截:你刚才已经读过 ${rel}${where},返回值就在上面的工具结果里,再读一次得到的完全一样。`,
			`出路:①要通读整章,用 read_chapter(一次返回全文,不会截断);`,
			`②上面那段不够用,换一个你还没读过的区间;`,
			`③已经读够了,就基于已读内容回答,或先回复用户澄清。`,
		].join("\n");
	}
	rails.exact.add(key);

	// ②同文件累计
	const n = (rails.byFile.get(rel) ?? 0) + 1;
	rails.byFile.set(rel, n);
	if (n > READ_FILE_LIMIT) {
		return [
			`已拦截:${rel} 这一轮你已经读了 ${n} 次 —— 你在用 read 带 offset 一页页翻整章,而 read 会在 2000 行/50KB 处截断,这么翻永远翻不完。`,
			`出路:用 read_chapter(${rel.replace(/^draft\//, "").replace(/\.md$/, "")}) 一次拿到全文,然后基于全文继续;`,
			`或停下来先回复用户。`,
		].join("\n");
	}
	return null;
}

/**
 * 写入后的字数对比文本(追加到 tool_result)。
 *
 * 不拦「覆盖已有文件」,但要让**内容损失可见**:模型传了半截内容把 2824 字
 * 写成 200 字时,工具本来只会回「Successfully wrote 200 bytes」—— 看起来
 * 像成功。这里把写入前后的字数并排摆出来,静默事故变成显性告警。
 *
 * @param before 写入前的字数(写入前采样)
 */
export function writeDeltaLine(rel: string, before: number, after: number): string | null {
	if (before <= 0 || after >= before) return null;
	const lost = before - after;
	// 掉了一半以上才报:正常的段落级修订不该被噪音打扰
	if (lost < before * 0.5) return null;
	return `⚠️ 本次写入把 ${rel} 从 ${before} 字改成了 ${after} 字(减少 ${lost} 字)。如果这是整体重写就忽略本条;如果不是,你多半漏带了内容 —— 用 read_chapter 重读全文确认,必要时用 edit 补回。`;
}

/** 书目录下的相对路径(供扩展层做写入前采样)。 */
export function relOf(raw: unknown, bookDir: string): string | null {
	return toRel(raw, bookDir);
}

/** 绝对路径归一化(供扩展层做写入前采样)。 */
export function absOf(raw: unknown, bookDir: string): string | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	return isAbsolute(raw) ? raw : resolve(bookDir, raw);
}

/** draft/ 前缀判定(只有正文才做字数对比,notes 等中间产物不需要)。 */
export function isDraftRel(rel: string): boolean {
	return rel.startsWith(`draft${sep}`);
}
