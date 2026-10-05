/**
 * 写作运行时护栏扩展 —— 与 UI 无关、**所有会调 write/read 的会话**都必须装的那部分。
 *
 * ## 为什么单独成文件(2026-10-05)
 *
 * 这些钩子原先写在 `extension.ts` 的 `writerFactory` 里,而 `writerFactory` 只被
 * **两处**装配(`cli.ts` 的 TUI 主会话、`web.ts` 的 web 主会话)。可是真正会调
 * `write` 写正文的会话并不是它们:
 *
 *   - `web/writer-host.ts` 的**编剧/编辑 agent**(`initialActiveToolNames` 含 write/read)
 *   - `stage/stage-extension.ts` 的**导演 / 演员 / 收幕编剧**(`activeTools` 含 write)
 *
 * 这两类会话的 `extensionFactories` 里都没有 writerExtension,于是
 * —— 复盘会话 `writer-c-v05ij1` 里那次「空内容把 2824 字第二章清零」的事故,
 * 护栏拦不到;写在 TUI 路径上的修复对真正出事的会话无效。
 *
 * 教训与 `sessionSkillDirs` 那次一模一样(见 `session-factory.ts` 的注释:
 * 「漏传就是静默故障」):**需要每个装配点记得传的东西,迟早会漏**。
 * 因此本扩展不由调用方传入,而是由 `createSessionRuntimeFactory` 统一并入。
 *
 * ## 边界
 *
 * 这里只放与 UI 无关的运行时护栏:
 *   - `tool_call`      —— 拦空内容 write、拦 read 循环
 *   - `tool_result`    —— 写入后附字数、静默丢内容显性化
 *   - `before_agent_start` —— 按轮重置读取护栏
 *
 * **不放** TUI 的 UI 钩子(setTheme / setHeader / footer / refreshWriterUi)——
 * 那些留在 `extension.ts` 的 writerFactory 里,TUI 专属。
 *
 * 记忆锚与 `session_before_compact` 目前**仍只在 TUI 路径**(本轮有意未搬,见
 * CHANGELOG 的范围说明)。
 */

import type { ExtensionAPI, ExtensionContext, InlineExtension, ToolResultEvent } from "./pi-adapter/index.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getBookDir } from "./config.ts";
import { bookSlugFromSessionFile } from "./book-files.ts";
import { readCountsForFile } from "./tools.ts";
import { absOf, guardRead, guardWrite, isDraftRel, relOf, resetReadRails, writeDeltaLine } from "./tool-rails.ts";
import { pathWithinRoot } from "./tool-guard.ts";

/**
 * write 执行**前**采样的字数,按 toolCallId 暂存,供 tool_result 阶段做前后对比。
 * 为什么必须在调用前采样:write 执行完文件已经是新内容,拿不到"写入前多少字",
 * 也就无从判断这一写是正常重写还是把正文写没了。
 */
const writeBefore = new Map<string, { rel: string; cnChars: number }>();

interface DraftCounts {
	rel: string;
	cnChars: number;
	paragraphs: number;
}

/** 读取写入后的字数(仅 draft/ 下的正文;失败/非正文返回 null)。 */
async function countsAfterWrite(ctx: ExtensionContext, event: ToolResultEvent): Promise<DraftCounts | null> {
	const raw = event.input?.path;
	if (typeof raw !== "string" || raw.length === 0) return null;

	// 会话文件 → 书 slug → 书目录(与其余命令的推导方式一致,见 bookSlugFromSessionFile)
	const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
	if (!slug) return null;
	const bookDir = getBookDir(slug);

	// 工具入参可能是相对书目录的路径,也可能是绝对路径;归一化后判断是否落在 draft/
	const abs = isAbsolute(raw) ? raw : resolve(bookDir, raw);
	if (!pathWithinRoot(abs, bookDir)) return null;
	const rel = relative(bookDir, abs);
	if (!rel.startsWith(`draft${sep}`)) return null;

	try {
		const counts = await readCountsForFile(abs);
		return { rel, cnChars: counts.cnChars, paragraphs: counts.paragraphs };
	} catch {
		// 计数失败(文件被并发删掉/读权限等)不阻断写入结果 —— 字数只是附带信息
		return null;
	}
}

function railsFactory(pi: ExtensionAPI): void {
	// 读取护栏按轮重置(tool-rails):「这一轮内有没有重复读」才是判据,
	// 跨轮累积会让长会话后期什么都读不了。
	//
	// 注意:这里只重置护栏记账,不注入记忆锚 —— 记忆锚仍只在 TUI 路径装配。
	pi.on("before_agent_start", () => {
		resetReadRails();
	});

	// 工具护栏(2026-10-05):把两条「只写在提示词里拦不住」的规则下沉到工具层。
	//
	// 复盘 writer-c-v05ij1:提示词写着「write 会整体替换,优先用 edit」「一眼只读
	// 一次」,模型照样用空内容把 2824 字的第二章清零、用 read 带 offset 把同一章
	// 翻了 91 次。提示词约束的是**愿意遵守**的模型;这两条一旦发生就是事故
	// (静默清空 / 上下文被翻页结果灌爆),必须在工具层兜底。
	//
	// 每条拦截都带**出路**(该换哪个工具),否则模型只会换个 offset 继续绕。
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "read") return;
		const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
		if (!slug) return;
		const bookDir = getBookDir(slug);

		if (event.toolName === "write") {
			const reason = guardWrite(event.input as { path?: unknown; content?: unknown }, bookDir);
			if (reason) return { block: true, reason };
			// 放行前采样字数:draft/ 下已存在且有内容才记,供 tool_result 做前后对比
			const rel = relOf(event.input?.path, bookDir);
			const abs = absOf(event.input?.path, bookDir);
			if (rel && abs && isDraftRel(rel)) {
				try {
					const before = await readCountsForFile(abs);
					if (before.cnChars > 0) writeBefore.set(event.toolCallId, { rel, cnChars: before.cnChars });
				} catch {
					/* 文件不存在/读不了:不采样,对比自然跳过 */
				}
			}
			return;
		}

		const reason = guardRead(event.input as { path?: unknown; offset?: unknown; limit?: unknown }, bookDir);
		if (reason) return { block: true, reason };
		return;
	});

	// 写入正文后把字数附在工具返回值里(2026-10-04)。
	//
	// 为什么用钩子而不是让 AI 调 word_count:字数从来不是用户想问 AI 的问题,
	// 而是 AI 写完一章之后**必须知道**的客观事实。让模型主动去查,等于把「记得
	// 查」的责任推给一个不擅长计数的东西 —— 它经常不查,或者眼估一个数报出来。
	// 挂在 tool_result 上之后,字数与「写入成功」在同一条返回值里,模型下一轮
	// 必然看到,且与实际落盘内容同源(不是模型自己算的)。
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (event.isError) return;
		const counts = await countsAfterWrite(ctx, event);
		if (!counts) return;
		const parts = [`${counts.cnChars} 字`];
		if (counts.paragraphs > 0) parts.push(`${counts.paragraphs} 段`);
		const texts = [`【本章字数】${parts.join(" · ")}`];
		// 写入前后对比:整体重写合法,但**静默丢内容**必须显性化
		const before = writeBefore.get(event.toolCallId);
		if (before) {
			writeBefore.delete(event.toolCallId);
			const delta = writeDeltaLine(before.rel, before.cnChars, counts.cnChars);
			if (delta) texts.push(delta);
		}
		return { content: [...event.content, ...texts.map((text) => ({ type: "text" as const, text }))] };
	});
}

/**
 * 写作运行时护栏扩展。
 *
 * **不要手工把它加进某个装配点的 extensionFactories** —— 它由
 * `createSessionRuntimeFactory` 统一并入(见该函数里紧挨 sessionSkillDirs 的注释)。
 * 手工加会让「统一注入」与「个别补装」两套机制并存,下次又漏在别处。
 */
export const writeRailsExtension: InlineExtension = {
	name: "pi-writer-rails",
	factory: railsFactory,
};
