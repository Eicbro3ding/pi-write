/**
 * web 装配纯函数测试:`PI_WRITER_NO_SPAWN_TOOLS` env 剔除 grep/find
 * (无纯 JS fallback 的 spawn 工具);env 缺省/空串时返回完整列表。
 * webExcludeTools/webActiveTools 是白名单方案的替代(黑名单 + 显式激活):
 * 白名单会把 MCP customTools 滤掉,黑名单只禁 bash,自定义工具放行。
 * (旧 webTools/ALL_WEB_TOOLS 白名单方案已随 2026-08-10 会话工厂收敛删除,
 * 生产装配只走黑名单 + 显式激活。)
 */

import { describe, expect, it } from "vitest";
import { webActiveTools, webExcludeTools } from "../src/web.ts";

describe("webExcludeTools / webActiveTools", () => {
	it("黑名单恒禁 bash(web 子集语义),不碰其他工具", () => {
		expect(webExcludeTools({})).toEqual(["bash"]);
		expect(webExcludeTools({ PI_WRITER_NO_SPAWN_TOOLS: "1" })).toEqual(["bash", "grep", "find"]);
	});
	it("激活列表只含内置工具,不含扩展/MCP 工具(它们自动激活)", () => {
		expect(webActiveTools({})).toEqual(["read", "write", "edit", "grep", "find", "ls"]);
		expect(webActiveTools({ PI_WRITER_NO_SPAWN_TOOLS: "1" })).toEqual(["read", "write", "edit", "ls"]);
		expect(webActiveTools({})).not.toContain("bash");
	});
});
