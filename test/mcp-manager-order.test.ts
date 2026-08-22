/**
 * insertConnectionBySlot 纯函数测试:MCP watchdog 重连后的连接表原位插回。
 *
 * 背景:工具定义序列化进 prompt 前缀,重连后若把连接 push 到尾部,工具数组
 * 顺序漂移会让全会话提示词缓存失效(且跨服务器重名工具的「后者跳过」归属
 * 会翻转)。断开时记录配置序 slot,重连按 slot 插回;多台同时断线、乱序
 * 重连时也要恢复原始相对顺序。
 */

import { describe, expect, it } from "vitest";
import { insertConnectionBySlot } from "../src/mcp/manager.ts";

type Conn = { name: string; slot?: number };
const c = (name: string, slot?: number): Conn => ({ name, slot });
const names = (list: Conn[]): string[] => list.map((x) => x.name);

describe("insertConnectionBySlot(MCP 重连保序)", () => {
	it("空表追加", () => {
		const list: Conn[] = [];
		insertConnectionBySlot(list, c("A", 0));
		expect(names(list)).toEqual(["A"]);
	});
	it("无 slot 的连接追加尾部(不干扰有序部分)", () => {
		const list: Conn[] = [c("A", 0)];
		insertConnectionBySlot(list, c("Z"));
		expect(names(list)).toEqual(["A", "Z"]);
	});
	it("中间原位插回", () => {
		const list: Conn[] = [c("A", 0), c("C", 2)];
		insertConnectionBySlot(list, c("B", 1));
		expect(names(list)).toEqual(["A", "B", "C"]);
	});
	it("尾部插回(slot 大于全部现有)", () => {
		const list: Conn[] = [c("A", 0), c("B", 1)];
		insertConnectionBySlot(list, c("C", 2));
		expect(names(list)).toEqual(["A", "B", "C"]);
	});
	it("多台同时断线、乱序重连仍恢复原序", () => {
		// A(0) B(1) C(2) 全部断开 → 表空;按 C → A → B 顺序重连
		const list: Conn[] = [];
		insertConnectionBySlot(list, c("C", 2));
		insertConnectionBySlot(list, c("A", 0));
		expect(names(list)).toEqual(["A", "C"]);
		insertConnectionBySlot(list, c("B", 1));
		expect(names(list)).toEqual(["A", "B", "C"]);
	});
	it("现存连接缺 slot 时视为最大(新连接插在它前面)", () => {
		const list: Conn[] = [c("Z")];
		insertConnectionBySlot(list, c("A", 0));
		expect(names(list)).toEqual(["A", "Z"]);
	});
});
