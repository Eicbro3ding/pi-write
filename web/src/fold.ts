/**
 * 长内容折叠分档(设计稿 03-组件规范/04「高度分档」)。
 *
 * 原来 diff / 命令输出的 max-height 是写死的(240 / 220),短内容被无谓地截断、
 * 长内容又看不到全貌,「展开」入口也没意义。改成分档:
 * - 短(≤12 行):全部展开,不折叠;
 * - 中(13-40 行)与长(>40 行):收到 12 行 + 底部渐隐 + 「展开全部(共 N 行)」,
 *   展开后最高 480px、块内滚动。
 */
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

/** 展开入口文案(设计稿:中/长两档共用同一句,带总行数)。 */
export function foldLabel(lineCount: number): string {
	return `展开全部(共 ${lineCount} 行)`;
}
