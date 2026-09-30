import { describe, expect, it } from "vitest";
import { collapsedText, countLines, FOLD_COLLAPSED_LINES, FOLD_SHORT_MAX, foldLabel, isFoldable } from "../web/src/fold.ts";
import {
	PREVIEW_AUTO_FOLD_WEIGHT,
	previewDefaultOpen,
	previewFoldSummary,
	previewWeight,
	shouldAutoFold,
} from "../web/src/fold.ts";
import type { PreviewData } from "../web/src/preview.ts";

/** 造 n 行的文本。 */
function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `第 ${i + 1} 行`).join("\n");
}

describe("长内容折叠分档(03-组件规范/04)", () => {
	it("countLines:空文本 0 行,单行 1 行", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("a")).toBe(1);
		expect(countLines("a\nb")).toBe(2);
	});
	it("短档(≤12 行)不折叠", () => {
		expect(isFoldable(FOLD_SHORT_MAX)).toBe(false);
		expect(isFoldable(1)).toBe(false);
		expect(isFoldable(0)).toBe(false);
	});
	it("中档/长档(>12 行)折叠", () => {
		expect(isFoldable(13)).toBe(true);
		expect(isFoldable(120)).toBe(true);
	});
	it("折叠态只保留前 12 行", () => {
		const text = lines(30);
		const shown = collapsedText(text).split("\n");
		expect(shown).toHaveLength(FOLD_COLLAPSED_LINES);
		expect(shown[0]).toBe("第 1 行");
		expect(shown[11]).toBe("第 12 行");
	});
	it("不足 12 行时原样返回", () => {
		expect(collapsedText(lines(5))).toBe(lines(5));
	});
	it("展开入口文案带总行数", () => {
		expect(foldLabel(28)).toBe("展开全部(共 28 行)");
		expect(foldLabel(120)).toBe("展开全部(共 120 行)");
	});
});

/* ════════════════════════════════════════════════════════════════
   预览卡的智能折叠(2026-09-30):默认开/收由内容体量决定
   ════════════════════════════════════════════════════════════════ */

/** n 行 diff(全 context 行,只关心行数)。 */
function diff(n: number) {
	return Array.from({ length: n }, (_, i) => ({ kind: "context" as const, text: `第 ${i + 1} 行` }));
}

function draft(rows: number): PreviewData {
	return { kind: "draft", toolName: "write", sections: [{ path: "draft/ch01.md", diff: diff(rows) }] };
}
function entries(n: number): PreviewData {
	return {
		kind: "world",
		toolName: "world_update",
		slug: "book",
		mode: "entry",
		entries: Array.from({ length: n }, (_, i) => ({ id: `e${i}` })) as never,
		allEntries: [],
	};
}
function graph(changes: number): PreviewData {
	const d = {
		addedEntries: Array.from({ length: changes }, (_, i) => ({ id: `a${i}` })),
		modifiedEntries: [],
		removedEntries: [],
		addedRelations: [],
		removedRelations: [],
		modifiedRelations: [],
	};
	return { kind: "world", toolName: "world_update", slug: "book", mode: "graph", afterWorld: {} as never, worldDiff: d as never };
}
function script(beats: number): PreviewData {
	return {
		kind: "script",
		toolName: "script_confirm",
		sceneId: "s1",
		script: { text: { shared: { beats: Array.from({ length: beats }, (_, i) => `节拍 ${i}`) } } } as never,
	};
}

describe("预览卡智能折叠:体量判据", () => {
	it("草稿:体量 = 全部 section 的 diff 行数(多文件累加)", () => {
		expect(previewWeight(draft(10))).toBe(10);
		expect(
			previewWeight({
				kind: "draft",
				toolName: "write",
				sections: [{ path: "a.md", diff: diff(3) }, { path: "b.md", diff: diff(4) }],
			}),
		).toBe(7);
	});

	it("词条:每条≈4 行;世界图:体量 = 增删改条目+关系的总数", () => {
		expect(previewWeight(entries(3))).toBe(12);
		expect(previewWeight(graph(5))).toBe(5);
	});

	it("剧本:按节拍数 ×3;加载失败占位恒 0(永不折叠)", () => {
		expect(previewWeight(script(7))).toBe(21);
		expect(previewWeight({ kind: "draft", error: true, toolName: "write", path: null })).toBe(0);
		expect(shouldAutoFold({ kind: "world", error: true, toolName: "world_update", path: null })).toBe(false);
	});

	it("小预览默认展开,大预览默认折叠(阈值处恰好不折)", () => {
		expect(shouldAutoFold(draft(5))).toBe(false);
		expect(shouldAutoFold(draft(PREVIEW_AUTO_FOLD_WEIGHT))).toBe(false); // 等于阈值:不折
		expect(shouldAutoFold(draft(PREVIEW_AUTO_FOLD_WEIGHT + 1))).toBe(true);
	});

	it("世界图模式不因「图大」而折叠(图是可视组件,体量只作判据)", () => {
		// 关系/条目极多时仍按体量判定;此处锁定阈值语义,防止有人把图改成 0
		expect(previewWeight(graph(61))).toBe(61);
		expect(shouldAutoFold(graph(61))).toBe(true);
	});

	it("折叠摘要说清收了多少", () => {
		expect(previewFoldSummary(draft(120))).toBe("共 120 行 diff");
		expect(previewFoldSummary(entries(3))).toBe("共 3 个词条");
		expect(previewFoldSummary(graph(8))).toBe("共 8 处变更");
		expect(previewFoldSummary(script(4))).toBe("共 4 个节拍");
		expect(previewFoldSummary({ kind: "draft", error: true, toolName: "write", path: null })).toBe("");
	});

	it("previewDefaultOpen:体量小 / 有动作 / forceOpen 都展开,只有「体量大且无动作」才收", () => {
		expect(previewDefaultOpen(draft(5), { hasActions: false })).toBe(true);
		expect(previewDefaultOpen(draft(200), { hasActions: false })).toBe(false);
		// 动作按钮在折叠体里会被藏起来 → 有动作一律展开
		expect(previewDefaultOpen(draft(200), { hasActions: true })).toBe(true);
		expect(previewDefaultOpen(draft(200), { hasActions: false, forceOpen: true })).toBe(true);
		// 加载失败占位永不折叠
		expect(previewDefaultOpen({ kind: "draft", error: true, toolName: "write", path: null }, { hasActions: false })).toBe(true);
	});
});
