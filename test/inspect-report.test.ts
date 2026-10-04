import { describe, expect, it } from "vitest";
import { buildInspectReport, inspectHeadline } from "../src/inspect/report.ts";
import type { ChapterContextResult, ContextSection, TrimRecord } from "../src/world-context.ts";
import { defaultWriterSettings, type WriterSettings } from "../src/writer-settings.ts";

function settings(over: Partial<WriterSettings> = {}): WriterSettings {
	return { ...defaultWriterSettings(), ...over };
}

function ctx(sections: ContextSection[], trimmed: TrimRecord[] = []): Pick<ChapterContextResult, "sections" | "trimmed"> {
	return { sections, trimmed };
}

const SEC_ENTRIES: ContextSection = { id: "entries", label: "世界书·本章相关", tokens: 400, count: 5 };
const SEC_MEMORY: ContextSection = { id: "memory", label: "记忆", tokens: 100, count: 1 };
const SEC_SAMPLE: ContextSection = { id: "sample", label: "文风采样", tokens: 300, count: 1 };

describe("buildInspectReport（T5 上下文检视）", () => {
	it("分段按占用降序 —— 用户先看到「谁在吃预算」", () => {
		const r = buildInspectReport({
			slug: "fog-harbor",
			chapterFile: "ch01.jsonl",
			context: ctx([SEC_MEMORY, SEC_ENTRIES, SEC_SAMPLE]),
			settings: settings({ contextBudget: 2000 }),
		});
		expect(r.sections.map((s) => s.id)).toEqual(["entries", "sample", "memory"]);
	});

	it("used 是各段之和,percent 按预算折算", () => {
		const r = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: ctx([SEC_ENTRIES, SEC_MEMORY, SEC_SAMPLE]),
			settings: settings({ contextBudget: 1000 }),
		});
		expect(r.used).toBe(800);
		expect(r.percent).toBe(80);
	});

	it("usage 字段自带预算与百分比(前端不必自己算)", () => {
		const r = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: ctx([SEC_ENTRIES]),
			settings: settings({ contextBudget: 800 }),
		});
		expect(r.sections[0].usage).toBe("400 / 800(50%)");
	});

	it("常驻段与可裁段分得清 —— 这决定用户要不要调预算", () => {
		const r = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: ctx([SEC_MEMORY, SEC_ENTRIES, SEC_SAMPLE]),
			settings: settings(),
		});
		const byId = Object.fromEntries(r.sections.map((s) => [s.id, s.trimmable]));
		expect(byId.memory).toBe(false); // 记忆不参与裁剪
		expect(byId.entries).toBe(true);
		expect(byId.sample).toBe(true);
	});

	it("被省略的每条都带「丢了会怎样」—— 只给数字等于没说", () => {
		const r = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: ctx(
				[SEC_ENTRIES],
				[
					{ kind: "entry", label: "林婉", tokens: 120 },
					{ kind: "sample", label: "文风采样", tokens: 900 },
					{ kind: "milestones", label: "发展线·已完成", tokens: 60 },
				],
			),
			settings: settings(),
		});
		expect(r.trimmed).toHaveLength(3);
		for (const t of r.trimmed) expect(t.impact.length).toBeGreaterThan(0);
		// 里程碑那条要明确点出「会重复推进」这个后果
		expect(r.trimmed.find((t) => t.kind === "milestones")?.impact).toContain("重复");
	});

	it("未被裁时 trimmed 为空数组(UI 据此显示「没有裁切」而不是隐藏该段)", () => {
		const r = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: ctx([SEC_ENTRIES]),
			settings: settings(),
		});
		expect(r.trimmed).toEqual([]);
	});

	it("可调设置项覆盖所有影响装配的字段(用户要能改到每一处)", () => {
		const r = buildInspectReport({ slug: "s", chapterFile: "ch01.jsonl", context: ctx([]), settings: settings() });
		const keys = r.budgetItems.map((b) => b.key);
		expect(keys).toEqual(["contextBudget", "memoryBudget", "activationDepth", "noticeInjectLimit", "completedMilestoneLimit"]);
		for (const b of r.budgetItems) {
			expect(b.effect.length).toBeGreaterThan(0);
			expect(b.range).toMatch(/\d/);
		}
	});

	it("预算为 0 时不除零(设置被钳制过,但不能指望调用方一定传合法值)", () => {
		const r = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: ctx([SEC_ENTRIES]),
			settings: settings({ contextBudget: 0 }),
		});
		expect(Number.isFinite(r.percent)).toBe(true);
		expect(r.percent).toBe(0);
	});

	it("inspectHeadline 给一行摘要,无裁切时明说「无裁切」", () => {
		const clean = buildInspectReport({ slug: "s", chapterFile: "ch01.jsonl", context: ctx([SEC_ENTRIES]), settings: settings({ contextBudget: 2000 }) });
		expect(inspectHeadline(clean)).toContain("世界书 5 条");
		expect(inspectHeadline(clean)).toContain("无裁切");
		const trimmed = buildInspectReport({
			slug: "s",
			chapterFile: "ch01.jsonl",
			context: ctx([SEC_ENTRIES], [{ kind: "entry", label: "林婉", tokens: 120 }]),
			settings: settings({ contextBudget: 2000 }),
		});
		expect(inspectHeadline(trimmed)).toContain("省略 1 项");
	});
});
