/**
 * 长内容折叠分档。
 *
 * 原来 diff / 命令输出的 max-height 是写死的(240 / 220),短内容被无谓地截断、
 * 长内容又看不到全貌,「展开」入口也没意义。改成分档:
 * - 短(≤12 行):全部展开,不折叠;
 * - 中(13-40 行)与长(>40 行):收到 12 行 + 底部渐隐 + 「展开全部(共 N 行)」,
 *   展开后最高 480px、块内滚动。
 *
 * 文件末尾另有「预览卡默认折叠」的体量判据(previewWeight/shouldAutoFold)。
 */
import type { PreviewData } from "./preview.ts";

export const FOLD_SHORT_MAX = 12;
export const FOLD_COLLAPSED_LINES = 12;
export const FOLD_EXPANDED_MAX_PX = 480;

/** 行数(空文本算 0 行)。 */
export function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

/** 是否需要折叠(超过短内容档)。 */
export function isFoldable(lineCount: number): boolean {
	return lineCount > FOLD_SHORT_MAX;
}

/** 折叠态显示的文本:保留前 12 行。 */
export function collapsedText(text: string, lines = FOLD_COLLAPSED_LINES): string {
	const parts = text.split("\n");
	return parts.length <= lines ? text : parts.slice(0, lines).join("\n");
}

/** 展开入口文案。 */
export function foldLabel(lineCount: number): string {
	return `展开全部(共 ${lineCount} 行)`;
}

/* ════════════════════════════════════════════════════════════════
   预览卡的「智能折叠」(2026-09-30)
   ════════════════════════════════════════════════════════════════

   卡片级折叠此前只有手动入口、且默认全开:一回合里 AI 改了一个大文件(几百行 diff)
   或多条词条,消息流会被这一张卡直接撑爆,用户得先手动收起才能继续读对话。
   这里给「默认开还是默认收」一个**按内容体量**的纯函数判据:

   - 小预览(几行 diff / 一两条词条)= 默认展开:没什么可收的,收起来反而多点一次;
   - 大预览 = 默认折叠,折叠头仍是有效信息(草稿卡有「路径 + 增删行数」,
     世界卡有标题),并给一行折叠摘要说明收了多少。

   阈值刻意取得宽松(约为两块屏幕的内容):智能折叠是**防撑爆**,不是省地方 ——
   动不动就收起来会比不折叠更烦。 */

/** 卡片默认折叠的内容体量阈值(≈两屏);小于它一律默认展开。 */
export const PREVIEW_AUTO_FOLD_WEIGHT = 60;

/**
 * 预览内容体量(越大越该默认折叠)。按类型取最接近"视觉高度"的指标:
 * - 草稿:全部 section 的 diff 行数(这就是要渲染的行数);
 * - 世界树图模式:条目增删改 + 关系增删改的总数(图本身不折叠,这里只用于判断);
 * - 词条模式:词条数 × 4(一条词条卡≈标题/元信息/正文/关系四行);
 * - 剧本:节拍数 × 3(每拍含编号/标题/正文); * - 加载失败的「预览加载失败」占位:0(永不折叠)。
 */
export function previewWeight(data: PreviewData): number {
	if ("error" in data) return 0;
	if (data.kind === "draft") {
		return data.sections.reduce((n, s) => n + s.diff.length, 0);
	}
	if (data.kind === "script") {
		return data.script.text.shared.beats.length * 3;
	}
	if (data.mode === "graph") {
		const d = data.worldDiff;
		return (
			d.addedEntries.length +
			d.modifiedEntries.length +
			d.removedEntries.length +
			d.addedRelations.length +
			d.modifiedRelations.length +
			d.removedRelations.length
		);
	}
	return data.entries.length * 4;
}

/** 是否默认折叠(体量超过阈值)。 */
export function shouldAutoFold(data: PreviewData): boolean {
	return previewWeight(data) > PREVIEW_AUTO_FOLD_WEIGHT;
}

/**
 * 预览卡「默认是否展开」的最终判据:体量小 → 展开;**体内有动作** → 也展开
 * (动作按钮在折叠体会被藏起来,用户会以为卡片坏了)。两者都取反才折叠。
 */
export function previewDefaultOpen(
	data: PreviewData,
	opts: { hasActions: boolean; forceOpen?: boolean },
): boolean {
	if (opts.forceOpen) return true;
	if (opts.hasActions) return true;
	return !shouldAutoFold(data);
}

/** 折叠头里那行摘要:「已折叠 · 共 N 行 diff」/「已折叠 · N 个词条」… */
export function previewFoldSummary(data: PreviewData): string {
	if ("error" in data) return "";
	if (data.kind === "draft") return `共 ${previewWeight(data)} 行 diff`;
	if (data.kind === "script") return `共 ${data.script.text.shared.beats.length} 个节拍`;
	if (data.mode === "graph") return `共 ${previewWeight(data)} 处变更`;
	return `共 ${data.entries.length} 个词条`;
}
