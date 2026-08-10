import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../web/src/components/RelationGraph.tsx", import.meta.url), "utf8");
// 节点/边样式表自 2026-08-10 起抽到 graph-styles.ts(PreviewGraph 共用),样式断言读该文件
const styles = readFileSync(new URL("../web/src/graph-styles.ts", import.meta.url), "utf8");

describe("RelationGraph 上下文菜单结构", () => {
	it("将 Cytoscape 容器与右键菜单分离,避免菜单按钮事件被图层拦截", () => {
		expect(source).toMatch(/<div className="graph-canvas">\s*<div className="graph-cytoscape" ref=\{containerRef\} \/>/);
	});

	it("节点为圆形头像样式(ellipse + background-image + 底部标题条)", () => {
		expect(styles).toMatch(/shape: "ellipse"/);
		expect(styles).toMatch(/"background-image": "data\(backgroundImage\)"/);
		expect(styles).toMatch(/"text-valign": "bottom"/);
		expect(source).toMatch(/genAvatarDataUrl/);
	});
});
