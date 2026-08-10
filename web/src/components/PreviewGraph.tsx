import { useEffect, useRef } from "react";
import cytoscape, { type ElementDefinition } from "cytoscape";
import type { WorldDataDto } from "../types.ts";
import type { WorldDiff } from "../preview.ts";
import { themeVar, TYPE_TOKENS, TYPE_FALLBACKS } from "../graph-styles.ts";
import { imageUrl } from "../api/client.ts";
import { genAvatarDataUrl } from "../graph-logic.ts";

/** 卡片尺寸的节点标题:10 字符截断。 */
function previewNodeLabel(title: string): string {
	const t = title.trim() || "未命名";
	return t.length > 10 ? `${t.slice(0, 10)}…` : t;
}

/** 迷你图样式表:themeVar 每次调用重读主题变量,主题切换后由 MutationObserver 重建。 */
function buildPreviewStyles(): cytoscape.StylesheetJson {
	return [
		{
			selector: "node",
			style: {
				shape: "ellipse",
				width: 56,
				height: 56,
				"background-color": themeVar("--bg-elev", "#171412"),
				"background-image": "data(backgroundImage)",
				"background-fit": "cover",
				"background-clip": "node",
				"border-width": 2,
				"border-color": "data(typeColor)",
				label: "data(label)",
				"font-size": 9,
				"font-family": themeVar("--ui-font", "sans-serif"),
				color: "#fff",
				"text-valign": "bottom",
				"text-margin-y": -2,
				"text-max-width": "50",
				"text-wrap": "ellipsis",
				"text-background-color": "#000",
				"text-background-opacity": 0.55,
				"text-background-padding": "2px",
				"text-background-shape": "roundrectangle",
				"overlay-opacity": 0,
			},
		},
		{ selector: "node.added", style: { "border-width": 5, "border-color": themeVar("--amber", "#d9a84e") } },
		{ selector: "node.modified", style: { "border-style": "dashed", "border-width": 3 } },
		{
			selector: "edge",
			style: {
				width: 2,
				"line-color": themeVar("--muted", "#9a9184"),
				"source-arrow-shape": "none",
				"target-arrow-shape": "none",
				"curve-style": "bezier",
				label: "data(label)",
				"font-size": 9,
				color: themeVar("--faint", "#7a7266"),
				"text-rotation": "autorotate",
				"text-background-color": themeVar("--bg", "#0f0e0c"),
				"text-background-opacity": 0.75,
				"text-background-padding": "2px",
				"overlay-opacity": 0,
			},
		},
		{ selector: 'edge[arrow = "single"]', style: { "target-arrow-shape": "triangle", "target-arrow-color": themeVar("--muted", "#9a9184") } },
		{ selector: 'edge[arrow = "double"]', style: { "source-arrow-shape": "triangle", "source-arrow-color": themeVar("--muted", "#9a9184"), "target-arrow-shape": "triangle", "target-arrow-color": themeVar("--muted", "#9a9184") } },
		{ selector: "edge[?emphasized]", style: { width: 4, "line-color": themeVar("--amber", "#d9a84e"), "source-arrow-color": themeVar("--amber", "#d9a84e"), "target-arrow-color": themeVar("--amber", "#d9a84e"), color: themeVar("--amber", "#d9a84e") } },
	];
}

/**
 * 精简只读关系图(cytoscape):节点 = 条目(类型配色),边 = 关系。
 * 本次新增节点彩色粗描边,修改节点虚线描边,删除节点不画(摘要行列出)。
 * 随组件挂载创建实例、卸载销毁,无位置持久化、无编辑交互。
 */
export function PreviewGraph({ world, diff, slug }: { world: WorldDataDto; diff: WorldDiff; slug: string | null }) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const added = new Set(diff.addedEntries.map((e) => e.id));
		const modified = new Set(diff.modifiedEntries.map((e) => e.id));
		const nodeElements: ElementDefinition[] = world.entries.map((e) => ({
			data: {
				id: e.id,
				label: previewNodeLabel(e.title),
				typeColor: themeVar(TYPE_TOKENS[e.type], TYPE_FALLBACKS[e.type]),
				// 主图同款:有图用图;无图回退"白底+首字"文字头像
				backgroundImage: e.avatar && slug ? imageUrl(slug, e.avatar) : genAvatarDataUrl(e.title, themeVar(TYPE_TOKENS[e.type], TYPE_FALLBACKS[e.type])),
			},
			...(added.has(e.id) || modified.has(e.id) ? { classes: added.has(e.id) ? "added" : "modified" } : {}),
		}));
		const edgeElements: ElementDefinition[] = world.relations.map((r) => ({
			data: {
				id: r.id,
				source: r.from,
				target: r.to,
				label: r.label || r.type || "关系",
				arrow: r.arrow ?? "double",
				emphasized: r.emphasized,
			},
		}));
		const cy = cytoscape({
			container,
			elements: [...nodeElements, ...edgeElements],
			style: buildPreviewStyles(),
			layout: { name: "cose", animate: false },
		});
		// 主题切换后重建样式(与主图一致:themeVar 构造时读取,需刷新)
		const observer = new MutationObserver(() => {
			cy.style().fromJson(buildPreviewStyles()).update();
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => {
			observer.disconnect();
			cy.destroy();
		};
	}, [world, diff]);

	return <div className="preview-graph" ref={containerRef} />;
}
