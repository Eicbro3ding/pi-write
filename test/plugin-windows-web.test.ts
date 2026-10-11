/**
 * 插件浮窗(web/PluginWindows)的回归测试。
 *
 * 测两条纯逻辑,不碰 DOM:
 *  - collectWindows:哪条插件/窗口该渲染(只收 enabled 且声明了 windows 的);
 *  - normalizeRows:插件路由返回体的归一化(rows 形式 / 平铺对象 / 标量兜底)。
 *
 * 这两处是浮窗里唯一有「判断」的地方,渲染部分交给实机截图验证。
 */
import { describe, expect, it } from "vitest";
import { collectWindows, normalizeRows } from "../web/src/components/PluginWindows.tsx";
import type { PluginInfoDto } from "../web/src/types.ts";

/** 造一条插件 DTO(只填测试关心的字段)。 */
function plugin(over: Partial<PluginInfoDto> & { id: string }): PluginInfoDto {
	return {
		name: `插件 ${over.id}`,
		version: "0.1.0",
		manifestDisabled: false,
		enabled: true,
		trusted: false,
		error: null,
		path: `/tmp/${over.id}/index.mjs`,
		...over,
	};
}

describe("collectWindows", () => {
	it("只收 enabled 且声明了 windows 的插件", () => {
		const list = collectWindows([
			plugin({ id: "on", frontend: { ui: { windows: [{ id: "w", title: "窗", fields: [] }] } } }),
			plugin({ id: "off", enabled: false, frontend: { ui: { windows: [{ id: "w", title: "窗", fields: [] }] } } }),
			plugin({ id: "nowin", frontend: { ui: { settingsItems: [] } } }),
			plugin({ id: "nofe" }),
		]);
		expect(list.map((w) => w.pluginId)).toEqual(["on"]);
		expect(list[0].pluginName).toBe("插件 on");
		expect(list[0].spec.title).toBe("窗");
	});

	it("非 trusted 也收(声明式浮窗不需要完全信任)", () => {
		const list = collectWindows([
			plugin({ id: "plain", trusted: false, frontend: { ui: { windows: [{ id: "v", title: "余额", fields: [] }] } } }),
		]);
		expect(list).toHaveLength(1);
		expect(list[0].spec.id).toBe("v");
	});

	it("一个插件多个窗口全收,保留声明顺序", () => {
		const list = collectWindows([
			plugin({
				id: "multi",
				frontend: {
					ui: {
						windows: [
							{ id: "a", title: "A", fields: [] },
							{ id: "b", title: "B", fields: [] },
						],
					},
				},
			}),
		]);
		expect(list.map((w) => w.spec.id)).toEqual(["a", "b"]);
	});

	it("空列表 / 无 windows 字段 → 空", () => {
		expect(collectWindows([])).toEqual([]);
		expect(collectWindows([plugin({ id: "x", frontend: {} })])).toEqual([]);
	});
});

describe("normalizeRows", () => {
	it("rows 形式直接用(label/value 各自字符串化)", () => {
		expect(normalizeRows({ rows: [{ label: "余额", value: 12.3 }, { label: "状态", value: "可用" }] })).toEqual([
			{ label: "余额", value: "12.3" },
			{ label: "状态", value: "可用" },
		]);
	});

	it("平铺对象逐键成行", () => {
		expect(normalizeRows({ 可用: "¥12.30", 状态: "正常" })).toEqual([
			{ label: "可用", value: "¥12.30" },
			{ label: "状态", value: "正常" },
		]);
	});

	it("null/undefined 值 → 破折号;嵌套对象 JSON 兜底", () => {
		expect(normalizeRows({ a: null, b: undefined })).toEqual([
			{ label: "a", value: "—" },
			{ label: "b", value: "—" },
		]);
		expect(normalizeRows({ nested: { x: 1 } })[0].value).toBe('{"x":1}');
	});

	it("标量与数组 → 单行兜底,不猜结构", () => {
		expect(normalizeRows(42)).toEqual([{ label: "", value: "42" }]);
		expect(normalizeRows("hello")).toEqual([{ label: "", value: "hello" }]);
		expect(normalizeRows([1, 2])).toEqual([{ label: "", value: "[1,2]" }]);
	});

	it("rows 里混入非对象项被过滤", () => {
		expect(normalizeRows({ rows: [{ label: "a", value: 1 }, "junk", null] })).toEqual([{ label: "a", value: "1" }]);
	});
});
