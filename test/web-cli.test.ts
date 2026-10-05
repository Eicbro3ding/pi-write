/**
 * parseWebArgs 纯函数测试:`pi-writer web` 子命令的参数解析
 * (默认 port 8811;--no-browser/--electron 布尔开关;--book/--model/--thinking 透传;非法端口抛错)。
 */

import { describe, expect, it } from "vitest";
import { parseWebArgs } from "../src/web.ts";

describe("parseWebArgs", () => {
	it("默认值", () => {
		expect(parseWebArgs([])).toEqual({
			port: 8811,
			noBrowser: false,
			electron: false,
			book: undefined,
			model: undefined,
			thinking: undefined,
		});
	});
	it("解析 --port/--no-browser/--electron", () => {
		const o = parseWebArgs(["--port", "9000", "--no-browser", "--electron"]);
		expect(o.port).toBe(9000);
		expect(o.noBrowser).toBe(true);
		expect(o.electron).toBe(true);
	});
	it("解析 --cache-retention(合法值透传,非法值抛错)", () => {
		expect(parseWebArgs(["--cache-retention", "long"]).cacheRetention).toBe("long");
		expect(parseWebArgs(["--cache-retention", "none"]).cacheRetention).toBe("none");
		expect(() => parseWebArgs(["--cache-retention", "forever"])).toThrow();
	});
	it("非法端口抛错", () => {
		expect(() => parseWebArgs(["--port", "abc"])).toThrow();
	});
});
