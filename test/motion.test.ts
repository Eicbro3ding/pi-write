import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DUR, EASE, EDGE_SLIDE } from "../web/src/motion.ts";

/**
 * 动效 token 契约测试(2026-09-30 动效审查后补)。
 *
 * 为什么需要:`web/src/motion.ts`(TS)与 `web/src/styles.css` 的 `:root`(CSS)是
 * **两处手写副本**,此前只靠注释声明「同源同值」;关键帧里的位移/时长又是第三、四份
 * 副本。任一侧改动无人拦截 —— 已有过漂移(注释写 180ms、代码 200ms)。这里照
 * `test/themes.test.ts`(主题 token 键集)与 `test/contrast.test.ts`(取色)的做法,
 * 用「读源码文本 + 断言」把镜像关系钉住,无需 jsdom。
 */

const STYLE_FILES = [
	"web/src/styles.css",
	...readdirSync("web/src/styles")
		.filter((f) => f.endsWith(".css"))
		.map((f) => `web/src/styles/${f}`),
];

const styles = readFileSync("web/src/styles.css", "utf-8");
/** 去掉注释再扫描,否则注释里的示例声明会被当成真声明。 */
const allCss = STYLE_FILES.map((f) => readFileSync(f, "utf-8"))
	.join("\n")
	.replace(/\/\*[\s\S]*?\*\//g, "");

/** 从 CSS 文本读取某个自定义属性的值。 */
function varOf(css: string, name: string): string {
	const m = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
	if (!m) throw new Error(`styles.css 缺少 ${name}`);
	return m[1]!.trim();
}

/** 抽数字(用于 cubic-bezier 控制点比较)。 */
function nums(s: string): number[] {
	return (s.match(/-?\d*\.?\d+/g) ?? []).map(Number);
}

describe("动效 token:TS ↔ CSS 同源同值", () => {
	it("DUR.fast/base/slow === --dur-fast/base/slow", () => {
		expect(varOf(styles, "--dur-fast")).toBe(`${DUR.fast * 1000}ms`);
		expect(varOf(styles, "--dur-base")).toBe(`${DUR.base * 1000}ms`);
		expect(varOf(styles, "--dur-slow")).toBe(`${DUR.slow * 1000}ms`);
	});

	it("EASE.out/inOut === --ease-out/--ease-inout(四个控制点逐个相等)", () => {
		expect(nums(varOf(styles, "--ease-out"))).toEqual([...EASE.out]);
		expect(nums(varOf(styles, "--ease-inout"))).toEqual([...EASE.inOut]);
	});

	it("EDGE_SLIDE 与水平边缘滑入关键帧的 translateX 偏移一致", () => {
		// slide-in-right / slide-in-left / slide-out-left 三处字面量,必须等于 EDGE_SLIDE
		expect(styles).toContain(`translateX(${EDGE_SLIDE}px)`);
		expect(styles).toContain(`translateX(-${EDGE_SLIDE}px)`);
		const offsets = [...styles.matchAll(/@keyframes slide-(?:in|out)-(?:left|right)\s*\{[^}]*translateX\((-?[\d.]+)px\)/g)].map((m) => Number(m[1]));
		expect(offsets.length).toBeGreaterThanOrEqual(2);
		for (const o of offsets) expect(Math.abs(o)).toBe(EDGE_SLIDE);
	});
});

describe("动效结构契约", () => {
	it("每个被引用的 animation 名都有对应 @keyframes", () => {
		const declared = new Set([...allCss.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]!));
		const used = new Set<string>();
		for (const m of allCss.matchAll(/animation:\s*([^;{}]+)/g)) {
			const value = m[1]!.trim();
			if (value === "none") continue; // 降级/禁用,不是动画名
			used.add(value.split(/\s+/)[0]!);
		}
		const missing = [...used].filter((n) => !declared.has(n));
		expect(missing, `缺少 @keyframes:${missing.join(", ")}`).toEqual([]);
	});

	it("prefers-reduced-motion 熔断块同时清掉 animation 与 transition 时长", () => {
		const m = styles.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
		expect(m, "styles.css 缺少全局 reduced-motion 块").toBeTruthy();
		const block = m![1]!;
		for (const decl of ["animation-duration", "animation-iteration-count", "transition-duration"]) {
			expect(block, `${decl} 未被熔断`).toMatch(new RegExp(`${decl}[^;]*!important`));
		}
	});
});

/**
 * 裸时长白名单:**只放无限环境循环与 spinner**(它们用各自的自然节奏,不在 DUR 三档里)。
 * 任何一次性/入场退场时长都必须走 `var(--dur-*)` —— 该断言就是要拦住新的漂移,
 * 所以不要把"看起来更轻"的一次性时长加到这里,而是给它一个 token 或改名成新档位。
 */
const RAW_DURATION_ALLOWLIST = new Set([
	"tab-live-pulse 1.6s", // 生成中指示灯呼吸
	"think-float 1.6s", // 思考颜文字浮动
	"stat-pulse 1.6s", // 顶栏 loading 脉冲
	"se-blink 1.2s", // 舞台编辑闪烁
	"compact-flow 1.4s", // 压缩不确定进度流光
	"sk-flow 1.4s", // 骨架屏流光(与 compact-flow 同一族的无限环境循环)
	"act-rotate 900ms", // spinner(linear,非 token 档位)
]);

describe("裸时长漂移守卫", () => {
	it("animation 简写里除白名单外不出现裸时长", () => {
		const offenders: string[] = [];
		for (const m of allCss.matchAll(/animation:\s*([^;]+);/g)) {
			const value = m[1]!.trim();
			if (value === "none") continue;
			const name = value.split(/\s+/)[0]!;
			const raw = value.match(/(?<![\w-])(\d*\.?\d+)(m?s)\b/);
			if (!raw) continue;
			const key = `${name} ${raw[1]}${raw[2]}`;
			if (!RAW_DURATION_ALLOWLIST.has(key)) offenders.push(value);
		}
		expect(offenders, `animation 裸时长应改用 var(--dur-*):\n${offenders.join("\n")}`).toEqual([]);
	});

	it("transition 里的时长必须是 var(--dur-*)", () => {
		const offenders: string[] = [];
		for (const m of allCss.matchAll(/transition:\s*([^;]+);/g)) {
			const value = m[1]!.trim();
			if (value === "none") continue;
			// 逐个属性子声明检查(声明可跨行、用逗号分隔)
			for (const part of value.split(",")) {
				if (/var\(--dur-/.test(part)) continue;
				if (/^\s*visibility 0s/.test(part)) continue; // 关闭态 visibility 兜底
				if (/\d/.test(part.replace(/\b0s\b/g, ""))) offenders.push(value.replace(/\s+/g, " "));
			}
		}
		expect([...new Set(offenders)], `transition 裸时长应改用 var(--dur-*):\n${offenders.join("\n")}`).toEqual([]);
	});
});
