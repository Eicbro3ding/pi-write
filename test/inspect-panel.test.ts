import { describe, expect, it, vi } from "vitest";
import { InspectPanel } from "../src/inspect/panel.ts";
import type { InspectReport } from "../src/inspect/report.ts";
import { buildInspectReport } from "../src/inspect/report.ts";
import type { ChapterContextResult, ContextSection, TrimRecord } from "../src/world-context.ts";
import { defaultWriterSettings } from "../src/writer-settings.ts";
import type { Theme } from "../vendor/pi-coding-agent/src/index.ts";
import type { TUI } from "../vendor/pi-tui/src/index.ts";

/**
 * TUI 面板测试:只验「渲染出的文本对不对」与「键位有没有接上」。
 *
 * 不用真 TUI/Terminal:面板只用到 `terminal.rows` 与 `requestRender()` 两处,
 * 拿真终端跑反而要处理 stdin/raw mode。stub 掉这两个,render() 就是纯函数。
 * theme 也用「原样返回」的假 theme —— 本测试断言的是内容,不是颜色。
 */

/** 原样返回文本的假 theme:颜色断言与内容断言分离,红了容易定位。 */
const PLAIN_THEME = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
} as unknown as Theme;

function makeTui(rows = 40): { tui: TUI; renders: () => number } {
	let count = 0;
	const tui = {
		terminal: { rows, cols: 100 },
		requestRender: () => {
			count++;
		},
	} as unknown as TUI;
	return { tui, renders: () => count };
}

function makeReport(over: Partial<InspectReport> = {}): InspectReport {
	const sections: ContextSection[] = [
		{ id: "entries", label: "世界书·本章相关", tokens: 400, count: 5 },
		{ id: "summary", label: "世界观概述", tokens: 300, count: 1 },
		{ id: "memory", label: "记忆", tokens: 100, count: 1 },
	];
	return buildInspectReport({
		slug: "fog-harbor",
		chapterFile: "ch01.jsonl",
		chapterTitle: "雨夜",
		context: {
			sections,
			trimmed: [] as TrimRecord[],
		} as Pick<ChapterContextResult, "sections" | "trimmed">,
		settings: defaultWriterSettings(),
		...over,
	});
}

function open(rows = 40) {
	const { tui, renders } = makeTui(rows);
	const done = vi.fn();
	const panel = new InspectPanel(tui, PLAIN_THEME, { report: makeReport() }, done);
	return { panel, tui, renders, done, opts: { rows } };
}

describe("InspectPanel（T5 TUI 面板）", () => {
	it("渲染出标题、总量与各段名", () => {
		const { panel } = open();
		const text = panel.render(80).join("\n");
		expect(text).toContain("上下文检视");
		expect(text).toContain("fog-harbor");
		expect(text).toContain("雨夜");
		expect(text).toContain("世界书·本章相关");
		// 2026-10-05:原先这里断言「文风采样」——采样已移出背景包(改由 read_style 按需取)
		expect(text).toContain("世界观概述");
		expect(text).not.toContain("文风采样");
		expect(text).toContain("记忆");
	});

	it("分段标出「常驻 / 可裁」—— 这是用户判断要不要调预算的依据", () => {
		const { panel } = open();
		const text = panel.render(80).join("\n");
		expect(text).toContain("可裁");
		expect(text).toContain("常驻");
	});

	it("每个页签都能渲染,且互不相同", () => {
		const { panel } = open();
		const first = panel.render(88).join("\n");
		panel.handleInput("\t");
		const second = panel.render(88).join("\n");
		panel.handleInput("\t");
		const third = panel.render(88).join("\n");
		expect(second).not.toBe(first);
		expect(third).not.toBe(second);
		expect(first).toContain("分段占用"); // 页签标签 + 该页的小标题
		expect(second).toContain("省略");
		expect(third).toContain("设置");
		// 设置页必须出现字段名 —— 用户要照着去改
		expect(third).toContain("contextBudget");
		expect(third).toContain("activationDepth");
	});

	it("无裁切时明说「没有裁切」,不留白", () => {
		const { panel } = open();
		panel.handleInput("\t");
		const text = panel.render(88).join("\n");
		expect(text).toContain("没有裁切");
	});

	it("有裁切时列出条目标题与后果", () => {
		const { tui } = makeTui();
		const report = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: {
				sections: [],
				trimmed: [
					{ kind: "entry", label: "林婉", tokens: 120 },
					{ kind: "milestones", label: "发展线·已完成", tokens: 60 },
				] as TrimRecord[],
			} as Pick<ChapterContextResult, "sections" | "trimmed">,
			settings: defaultWriterSettings(),
		});
		const panel = new InspectPanel(tui, PLAIN_THEME, { report }, vi.fn());
		panel.handleInput("\t");
		const text = panel.render(100).join("\n");
		expect(text).toContain("林婉");
		expect(text).toContain("发展线·已完成");
		expect(text).toContain("重复"); // 里程碑的后果说明
	});

	it("q / Esc 关闭并回调 done,且只回调一次", () => {
		const { panel, done } = open();
		panel.handleInput("q");
		expect(done).toHaveBeenCalledTimes(1);
		// 关闭后再按键不应重复触发
		panel.handleInput("q");
		panel.handleInput("j");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("scroll 不越界:g/G 顶底,超长内容下多次下滚仍能渲染", () => {
		const { panel } = open(20);
		panel.handleInput("G");
		expect(panel.render(80).length).toBeGreaterThan(0);
		panel.handleInput("g");
		expect(panel.render(80).length).toBeGreaterThan(0);
		for (let i = 0; i < 50; i++) panel.handleInput("j");
		expect(panel.render(80).length).toBeGreaterThan(0);
	});

	it("行宽严格夹在边框内(超宽内容不撑破面板)", () => {
		const { panel } = open(40);
		const report = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: {
				sections: [],
				// 超长标题:验证 sliceByColumn 会不会让行超出 width
				trimmed: [{ kind: "entry", label: "这是一个非常非常非常非常非常非常长的条目标题名", tokens: 9999 }] as TrimRecord[],
			} as Pick<ChapterContextResult, "sections" | "trimmed">,
			settings: defaultWriterSettings(),
		});
		const tui = makeTui().tui;
		const p = new InspectPanel(tui, PLAIN_THEME, { report }, vi.fn());
		p.handleInput("\t");
		const width = 60;
		for (const line of p.render(width)) {
			// 每行含左右边框各 1 列
			expect(line.length).toBeLessThanOrEqual(width + 8); // 容 SGR/宽字符的粗略余量
		}
	});

	it("滚动触发 requestRender(否则画面不会刷新)", () => {
		const { panel, renders } = open();
		const before = renders();
		panel.handleInput("j");
		expect(renders()).toBeGreaterThan(before);
	});
});
