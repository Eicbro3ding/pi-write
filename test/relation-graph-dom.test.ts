import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../web/src/components/RelationGraph.tsx", import.meta.url), "utf8");
// 节点/边样式表自 2026-08-10 起抽到 graph-styles.ts(PreviewGraph 共用),样式断言读该文件
const styles = readFileSync(new URL("../web/src/graph-styles.ts", import.meta.url), "utf8");

describe("RelationGraph 上下文菜单结构", () => {
	it("将 Cytoscape 容器与右键菜单分离,避免菜单按钮事件被图层拦截", () => {
		expect(source).toMatch(/<div className="graph-canvas">\s*<div className="graph-cytoscape" ref=\{containerRef\} \/>/);
	});

	it("节点为「类型色环 + 圆内首字 + 名字/关系数」样式(设计稿 10)", () => {
		// 52px 圆 + 2px 类型色描边 + 首字背景图;不再用 88px 圆 + 黑底白字标签
		expect(styles).toMatch(/shape: "ellipse"/);
		expect(styles).toMatch(/width: 52/);
		expect(styles).toMatch(/"background-image": "data\(backgroundImage\)"/);
		expect(styles).toMatch(/"border-color": "data\(typeColor\)"/);
		expect(source).toMatch(/genInitialDataUrl/);
		// 节点标签在下方(名字 + 关系数),但不再用黑底白字胶囊
		expect(styles).toMatch(/"text-valign": "bottom"/);
		expect(styles).not.toMatch(/"text-background-color": "#000"/);
	});
});
