import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSkillInvocation, skillCommandText } from "../web/src/skill-invocation.ts";
import { initialSessionState, processAgentEvent, retryTargetForError } from "../web/src/store.ts";
import { conversationTitleText } from "../src/web/writer-host.ts";
import type { AgentEventDto } from "../web/src/types.ts";

/**
 * 技能调用(`/skill:<name>`)的展示形态(2026-10-01)。
 *
 * 为什么需要:vendor 在发送时把 `/skill:critique 帮我看看` 展开成整份 SKILL.md 写进
 * 用户消息,界面此前原样渲染 —— 一整屏方法论灌进气泡(用户 2026-10-01 报的问题)。
 * 现在解析成芯片 + 你自己那句话,正文折在展开里。
 *
 * 两条护栏:
 * ① 展开态的正则与 vendor 的 `parseSkillBlock` 逐字同形(web 包不能 import vendor,
 *    只能各持一份拷贝 —— 用读源码比对把镜像关系钉住,做法同 motion/themes 测试);
 * ② 解析发生在 store 的**用户气泡唯一出生地**(processAgentEvent 的 message_start),
 *    历史水合与实时回显都走这里,所以只测这一处即可覆盖两条路径。
 */

/** 从源码里抠出 `/^<skill name=…/` 这个正则字面量(用于两边比对)。 */
function skillRegexLiteral(src: string): string {
	const start = src.indexOf("/^<skill name=");
	if (start === -1) throw new Error("源码里找不到展开态正则");
	// 扫到第一个**未转义**的 `/`(正则里唯一的斜杠是 `<\/skill>` 的转义斜杠)
	for (let i = start + 1; i < src.length; i++) {
		if (src[i] === "/" && src[i - 1] !== "\\") return src.slice(start, i + 1);
	}
	throw new Error("正则字面量没有闭合");
}

const EXPANDED = (name: string, body: string, words?: string): string =>
	`<skill name="${name}" location="/repo/skills/${name}/SKILL.md">\nReferences are relative to /repo/skills/${name}.\n\n${body}\n</skill>${words ? `\n\n${words}` : ""}`;

describe("parseSkillInvocation:展开态(vendor 写进会话的形态)", () => {
	it("拆出技能名、正文与你自己说的话", () => {
		const parsed = parseSkillInvocation(EXPANDED("critique", "# 批评\n把稿子当别人的读", "第二段再看看。"));
		expect(parsed).not.toBeNull();
		expect(parsed!.name).toBe("critique");
		expect(parsed!.body).toContain("# 批评");
		expect(parsed!.words).toBe("第二段再看看。");
	});

	it("只说技能不带话:words 为空串,正文照样能展开", () => {
		const parsed = parseSkillInvocation(EXPANDED("outline", "# 大纲\n先搭骨架"));
		expect(parsed!.words).toBe("");
		expect(parsed!.body).toContain("# 大纲");
	});

	it("多行话原样保留(去掉首尾空白,不吞换行)", () => {
		const parsed = parseSkillInvocation(EXPANDED("revise", "正文", "第一行\n\n第二行"));
		expect(parsed!.words).toBe("第一行\n\n第二行");
	});

	it("普通消息不是技能调用", () => {
		expect(parseSkillInvocation("帮我看看这段")).toBeNull();
		expect(parseSkillInvocation("")).toBeNull();
		// 只是提到 skill 字样,或块不在消息首位 —— 都不认(与 vendor 的锚定一致)
		expect(parseSkillInvocation("我想用 skill:critique")).toBeNull();
		expect(parseSkillInvocation("前缀\n<skill name=\"critique\" location=\"/x\">\n正文\n</skill>")).toBeNull();
	});
});

describe("parseSkillInvocation:字面态(输入框选中技能后那一下)", () => {
	it("`/skill:<name> 话` 认得出,但没有正文(要等回显)", () => {
		const parsed = parseSkillInvocation("/skill:critique 帮我看看节奏");
		expect(parsed).toEqual({ name: "critique", body: null, words: "帮我看看节奏" });
	});

	it("只打命令不带话", () => {
		expect(parseSkillInvocation("/skill:critique")).toEqual({ name: "critique", body: null, words: "" });
	});

	it("别的斜杠命令不受影响", () => {
		expect(parseSkillInvocation("/chapter ch01")).toBeNull();
		expect(parseSkillInvocation("/compact")).toBeNull();
	});
});

describe("skillCommandText:折叠形态可以原样重发", () => {
	it("带话时拼回 `/skill:<name> 话`", () => {
		expect(skillCommandText({ name: "critique", body: "…", words: "看看节奏" })).toBe("/skill:critique 看看节奏");
	});

	it("不带话时就是命令本身(尾随空格会变成空参数,不加)", () => {
		expect(skillCommandText({ name: "outline", body: null, words: "" })).toBe("/skill:outline");
	});
});

describe("与 vendor 的格式约定同源", () => {
	it("展开态正则与 vendor parseSkillBlock 逐字一致", () => {
		const mine = skillRegexLiteral(readFileSync("web/src/skill-invocation.ts", "utf-8"));
		const vendor = skillRegexLiteral(readFileSync("vendor/pi-coding-agent/src/core/agent-session.ts", "utf-8"));
		expect(mine).toBe(vendor);
	});
});

describe("store:用户气泡出生地带上 skill", () => {
	const start = (text: string): AgentEventDto =>
		({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text }] },
		}) as AgentEventDto;

	it("展开态消息 → 气泡带 skill(芯片据此渲染),blocks 仍是全文", () => {
		const text = EXPANDED("critique", "# 批评\n正文若干", "看看节奏");
		const state = processAgentEvent(initialSessionState(), start(text));
		const m = state.messages[0]!;
		// body 就是标签之间的原文 —— 含 vendor 那句 `References are relative to …`
		// (与 TUI / HTML 导出的展开态一致:展示的是模型真正收到的东西)
		expect(m.skill).toEqual({
			name: "critique",
			body: "References are relative to /repo/skills/critique.\n\n# 批评\n正文若干",
			words: "看看节奏",
		});
		// 会话原文不动:撤回/分支/重放仍按全文走
		expect(m.blocks[0]).toEqual({ kind: "text", text });
	});

	it("字面态消息 → 也带 skill(没有正文,回显到达后再补)", () => {
		const state = processAgentEvent(initialSessionState(), start("/skill:critique 看看节奏"));
		expect(state.messages[0]!.skill).toEqual({ name: "critique", body: null, words: "看看节奏" });
	});

	it("普通用户消息不带 skill 字段", () => {
		const state = processAgentEvent(initialSessionState(), start("帮我看看这段"));
		expect(state.messages[0]!.skill).toBeUndefined();
	});

	it("报错卡的重试目标用折叠形态(重发时重新展开,不把全文当普通文本再发)", () => {
		let state = processAgentEvent(initialSessionState(), start(EXPANDED("critique", "# 批评\n正文", "看看节奏")));
		state = processAgentEvent(state, { type: "message_end", entryId: "e1", message: { role: "user" } } as AgentEventDto);
		expect(retryTargetForError(state.messages)).toEqual({ entryId: "e1", text: "/skill:critique 看看节奏" });
	});
});

describe("对话标题:技能消息不把 SKILL.md 当前缀", () => {
	it("技能调用 → 「技能名 · 你自己说的话」", () => {
		expect(conversationTitleText(EXPANDED("critique", "# 批评\n正文若干", "第二段再看看"))).toBe("critique · 第二段再看看");
	});

	it("只说技能不说别的 → 就取技能名", () => {
		expect(conversationTitleText(EXPANDED("outline", "# 大纲"))).toBe("outline");
	});

	it("普通消息照旧取原文前 24 字(压平空白;这一句恰好 24 字,不截断)", () => {
		expect(conversationTitleText("帮我看看这一段的节奏，是不是太快了？后面还有半句")).toBe("帮我看看这一段的节奏，是不是太快了？后面还有半句");
		expect(conversationTitleText("帮我看看这一段的节奏，是不是太快了？后面还有半句多")).toHaveLength(24);
	});
});
