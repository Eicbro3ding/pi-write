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

/**
 * 条目类型 → 主题 token 与回退色(类型色与状态色分离:绿/红只表示成功/失败,
 * 四个类型色是独立一层,token 见 styles.css :root)。
 */
export const TYPE_TOKENS: Record<WorldEntryDto["type"], string> = {
	character: "--type-character",
	world: "--type-world",
	timeline: "--type-timeline",
	outline: "--type-outline",
};
export const TYPE_FALLBACKS: Record<WorldEntryDto["type"], string> = {
	character: "#d9a84e",
	world: "#7b9ec9",
	timeline: "#a08cc0",
	outline: "#9a9184",
};

/** XML 转义(SVG data URL 内文本防注入)。 */
function escapeXml(s: string): string {
	return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/**
 * 节点圆内首字 SVG data URL(设计稿 10:类型色环 + 圆内首字)。
 * 无底色(透明)——节点底色由 background-color 提供;字号按 64 视窗折算,
 * 缩到 52px 节点直径时约 18px。
 */
export function genInitialDataUrl(title: string, color: string): string {
	const ch = escapeXml((title.trim() || "?").slice(0, 1));
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><text x="32" y="32" font-size="22" font-family="sans-serif" text-anchor="middle" dominant-baseline="central" fill="${escapeXml(color)}">${ch}</text></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * 构造 cytoscape 样式表。themeVar 每次调用重新读取当前主题 CSS 变量——
 * 主题切换(data-theme 变化)后由 MutationObserver 重建样式,图随之换肤;
 * 不重建则 night 下初始化的图在浅色主题下保持黑底标签。
 *
 * 节点外观(设计稿 10):52px 圆形 + 2px 类型色描边 + 圆内首字(背景图)+
 * 下方名字与关系数标签;不再用 88px 圆 + 黑底白字胶囊。
 */
export function buildGraphStyles(): cytoscape.StylesheetJson {
	return [
		{
			selector: "node",
			style: {
				shape: "ellipse",
				width: 52,
				height: 52,
				"background-image": "data(backgroundImage)",
				"background-fit": "contain",
				"background-clip": "node",
				"background-color": themeVar("--bg-elev", "#171412"),
				label: "data(label)",
				"font-size": 12,
				"font-family": themeVar("--ui-font", "sans-serif"),
				color: themeVar("--ink", "#ede6da"),
				"text-valign": "bottom",
				"text-halign": "center",
				"text-margin-y": -6,
				"text-max-width": "120",
				"text-wrap": "wrap",
				"line-height": 1.35,
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
				"font-size": 11,
				color: themeVar("--muted", "#9a9184"),
				"text-rotation": "autorotate",
				// 连线标签底色随主题(浅色主题下为浅底深字,不再黑底灰字)
				"text-background-color": themeVar("--bg-elev-2", "#1e1a16"),
				"text-background-opacity": 1,
				"text-background-padding": "3px",
				"text-background-shape": "roundrectangle",
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
