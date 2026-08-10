/**
 * 关系图样式表与主题 token —— 从 RelationGraph.tsx 抽出的纯逻辑,
 * PreviewGraph / PreviewEntryCard / RelationGraph 三处共用。
 * themeVar 依赖 DOM(getComputedStyle),仅在渲染路径调用。
 */
import type { WorldEntryDto } from "./types.ts";

/** 读取当前主题 CSS 变量(图初始化时固定,三主题配色均可用)。 */
export function themeVar(name: string, fallback: string): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return v.length > 0 ? v : fallback;
}

/** 条目类型 → 主题 token 与回退色(强调色区分类型)。 */
export const TYPE_TOKENS: Record<WorldEntryDto["type"], string> = {
	character: "--amber",
	world: "--green",
	timeline: "--red",
	outline: "--muted",
};
export const TYPE_FALLBACKS: Record<WorldEntryDto["type"], string> = {
	character: "#d9a84e",
	world: "#8fb57f",
	timeline: "#db7e6c",
	outline: "#9a9184",
};

/**
 * 构造 cytoscape 样式表。themeVar 每次调用重新读取当前主题 CSS 变量——
 * 主题切换(data-theme 变化)后由 MutationObserver 重建样式,图随之换肤;
 * 不重建则 night 下初始化的图在浅色主题下保持黑底标签。
 */
export function buildGraphStyles(): cytoscape.StylesheetJson {
	return [
		{
			selector: "node",
			style: {
				shape: "ellipse",
				width: 88,
				height: 88,
				"background-image": "data(backgroundImage)",
				"background-fit": "cover",
				"background-clip": "node",
				label: "data(label)",
				"font-size": 10,
				"font-family": themeVar("--ui-font", "sans-serif"),
				color: "#fff",
				"text-valign": "bottom",
				"text-margin-y": -2,
				"text-max-width": "78",
				"text-wrap": "ellipsis",
				// 节点文字标签:黑底白字胶囊,保证头像/任意底色上可读(与主题无关)
				"text-background-color": "#000",
				"text-background-opacity": 0.55,
				"text-background-padding": "2px",
				"text-background-shape": "roundrectangle",
				"background-color": themeVar("--bg-elev", "#171412"),
				"border-width": 2,
				"border-color": "data(typeColor)",
				"overlay-opacity": 0,
			},
		},
		{ selector: "node[!active]", style: { opacity: 0.55 } },
		{
			selector: "node:selected, node.link-from",
			style: { "border-width": 3, "border-color": themeVar("--amber", "#d9a84e") },
		},
		{
			selector: "edge",
			style: {
				width: 2,
				"line-color": themeVar("--muted", "#9a9184"),
				"source-arrow-shape": "none",
				"target-arrow-shape": "none",
				"curve-style": "bezier",
				label: "data(label)",
				"font-size": 10,
				color: themeVar("--faint", "#7a7266"),
				"text-rotation": "autorotate",
				// 连线标签底色随主题(浅色主题下为浅底深字,不再黑底灰字)
				"text-background-color": themeVar("--bg", "#0f0e0c"),
				"text-background-opacity": 0.75,
				"text-background-padding": "2px",
				"overlay-opacity": 0,
			},
		},
		{
			selector: 'edge[arrow = "single"]',
			style: {
				"target-arrow-shape": "triangle",
				"target-arrow-color": themeVar("--muted", "#9a9184"),
			},
		},
		{
			selector: 'edge[arrow = "double"]',
			style: {
				"source-arrow-shape": "triangle",
				"source-arrow-color": themeVar("--muted", "#9a9184"),
				"target-arrow-shape": "triangle",
				"target-arrow-color": themeVar("--muted", "#9a9184"),
			},
		},
		{
			selector: "edge[?emphasized]",
			style: {
				width: 4,
				"line-color": themeVar("--amber", "#d9a84e"),
				"source-arrow-color": themeVar("--amber", "#d9a84e"),
				"target-arrow-color": themeVar("--amber", "#d9a84e"),
				color: themeVar("--amber", "#d9a84e"),
			},
		},
		{
			selector: "edge:selected",
			style: { "line-color": themeVar("--amber", "#d9a84e"), width: 4 },
		},
	];
}
