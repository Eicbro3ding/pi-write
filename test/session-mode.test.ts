/**
 * 会话模式(2026-10-05):每轮先判定「用户这一轮要不要我动笔」。
 *
 * 治的是真实会话 `writer-c-v05ij1` 里的 A2 类事故 —— 用户 5 次喊停,模型 5 次照跑,
 * 其中一次把 2824 字的第二章写成了 0 字节。这里是 P1-1 的纯函数部分,`prompts/` 与
 * `extension.ts` 的记忆锚都靠它。
 */

import { describe, expect, it } from "vitest";
import { detectSessionMode, modeAnchorLine, modeLabel } from "../src/session-mode.ts";

describe("detectSessionMode(这一轮用户到底要不要我动笔)", () => {
	it("喊停信号一律判讨论态(优先级最高)", () => {
		// 这五句全部是复盘会话里用户的原话。
		for (const prompt of [
			"我还没叫你开始写",
			"先不急着写,我们先把设定完善",
			"这一章先放一放",
			"先暂停一下,我想先跟你聊聊走向",
			"别动草稿,我们讨论个事情",
		]) {
			expect(detectSessionMode(prompt), prompt).toBe("discussing");
		}
	});

	it("征询意见/聊方向 → 讨论态", () => {
		for (const prompt of ["你觉得这个开头怎么样?", "人物为什么要这样设定?", "我们先讨论下世界观"]) {
			expect(detectSessionMode(prompt), prompt).toBe("discussing");
		}
	});

	it("明确要写 → 写作态", () => {
		for (const prompt of ["开始写第二章", "继续写下一幕", "接着往下写", "把这段场景写出来"]) {
			expect(detectSessionMode(prompt), prompt).toBe("writing");
		}
	});

	it("要改已有正文 → 修订态", () => {
		for (const prompt of ["重写这一段", "这段太 AI 味了,改一下", "把第三节精简一下", "润色一下这句对话"]) {
			expect(detectSessionMode(prompt), prompt).toBe("revising");
		}
	});

	it("「重写」优先于「写」—— 不会被当成起新稿", () => {
		// 两个信号表里都有「写」,但修订是"改已有的",写作是"产新的",不能混。
		expect(detectSessionMode("这里重写一下")).toBe("revising");
	});

	it("「先别写,我们先讨论剧情」→ 讨论态(喊停压过写作词)", () => {
		expect(detectSessionMode("先别写,我们先讨论剧情走向")).toBe("discussing");
	});

	it("空消息与判不出来的话 → 讨论态(默认保守)", () => {
		expect(detectSessionMode("")).toBe("discussing");
		expect(detectSessionMode("   ")).toBe("discussing");
		// 「嗯」「继续」这类没有信号词的话,不该被当成写作指令
		expect(detectSessionMode("嗯")).toBe("discussing");
	});

	it("大小写与换行不影响判定", () => {
		expect(detectSessionMode("继续写\n下一幕")).toBe("writing");
	});
});

describe("modeAnchorLine(进记忆锚的那句话必须带约束)", () => {
	it("讨论态明写「不要写文件」—— 光一个词不携带约束", () => {
		const line = modeAnchorLine("discussing");
		expect(line).toContain("讨论态");
		expect(line).toContain("不要创建、写入、清空或覆盖任何文件");
		expect(line).toContain("world_update"); // 给出路:结论还是可以落盘的
	});

	it("写作态指向场景节奏(read_chapter → write/edit)", () => {
		const line = modeAnchorLine("writing");
		expect(line).toContain("写作态");
		expect(line).toContain("read_chapter");
		expect(line).toContain("一轮一个场景");
	});

	it("修订态约束到「只改点到的问题」", () => {
		const line = modeAnchorLine("revising");
		expect(line).toContain("修订态");
		expect(line).toContain("read_chapter");
		expect(line).toContain("未提及的段落");
	});

	it("三个模式的中文名不同(记忆锚要能一眼区分)", () => {
		const labels = new Set((["discussing", "writing", "revising"] as const).map(modeLabel));
		expect(labels.size).toBe(3);
	});
});
