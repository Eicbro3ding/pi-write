import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 手机端底部输入条的布局契约(2026-10-01)。
 *
 * 为什么需要:胶囊(.ib-field)的高度必须由 textarea 撑开 —— InputBar 自己给
 * textarea 设 inline height(自动增高),胶囊只负责把它框住。一旦有人给胶囊写死
 * `height: 40px`,多行文本就会从胶囊上下两侧穿出去(胶囊边框只框住中间两行),
 * 正是这次的手机端 bug。同理,底部留白(纸张 / 伙伴栏 / 对话切换抽屉)必须跟
 * `--m-composer-h`(WritePage 的 ResizeObserver 实测)同源 —— 写死 66px 时,
 * 输入条长高就会盖住最后几行。
 *
 * 做法同 motion/themes/contrast 三个契约测试:读源码文本 + 断言,不需要 jsdom。
 */
const css = readFileSync("web/src/styles/mobile.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("手机端输入条:胶囊跟着 textarea 长", () => {
	const field = css.match(/\.m-composer \.ib-field,\s*\.stage-main \.ib-field\s*\{[^}]*\}/)?.[0] ?? "";

	it("胶囊规则存在且不写死 height(单行 40 由 min-height 兜)", () => {
		expect(field).not.toBe("");
		expect(field).toMatch(/height:\s*auto/);
		expect(field).toMatch(/min-height:\s*40px/);
		// 裸 `height: <数字>` 即写死高度;`min-height` 因前置字符是 `-` 不会误伤
		expect(field).not.toMatch(/(?:^|[;\s])height:\s*\d/);
	});

	it("输入框有明确上限,到顶后内部滚动(不无限拉长)", () => {
		const ta = css.match(/\.m-composer \.ib-field textarea,\s*\.stage-main \.ib-field textarea\s*\{[^}]*\}/)?.[0] ?? "";
		expect(ta).toMatch(/max-height:\s*104px/);
		expect(ta).toMatch(/overflow-y:\s*auto/);
	});

	it("三处底部留白都跟 --m-composer-h 走(默认值仅在实测前用一帧)", () => {
		const pads = [...css.matchAll(/padding-bottom:\s*calc\(\s*var\(--m-composer-h,\s*66px\)/g)];
		expect(pads.length).toBeGreaterThanOrEqual(3);
	});
});

describe("输入条自动增高:上限取样式表,不在 JS 里另写一份", () => {
	const inputBar = readFileSync("web/src/components/InputBar.tsx", "utf-8");

	it("resize 读计算出的 max-height,超过上限时不再走 auto 测量(会清掉滚动位置)", () => {
		expect(inputBar).toMatch(/maxHeightOf\(ta\)/);
		expect(inputBar).toMatch(/if \(ta\.scrollHeight > cap\)/);
		// 到顶那一支必须保留光标跟随:光标在末尾就把视图钉在末尾
		expect(inputBar).toMatch(/ta\.selectionStart === ta\.value\.length\)\s*ta\.scrollTop = ta\.scrollHeight/);
	});
});
