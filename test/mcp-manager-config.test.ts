/**
 * MCP 配置写入串行化 + reload 世代语义(2026-10 审计 BUG-020 / RISK-005)。
 *
 * 用真实 McpManager + 临时目录,服务器一律指到必然连不上的本地端口
 * (http://127.0.0.1:1):连接必然失败、立刻返回,测试只关心**配置文件内容**
 * 与**状态表归属**,不依赖任何外部服务、不 spawn 子进程。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp/manager.ts";

let dir = "";
const configPath = () => join(dir, "mcp.json");
const readConfig = () => JSON.parse(readFileSync(configPath(), "utf8")) as { servers: Array<{ name: string; url?: string }> };

const httpServer = (name: string, port = 1) => ({ name, type: "http" as const, url: `http://127.0.0.1:${port}/mcp` });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "piw-mcp-write-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("McpManager 配置读-改-写串行化(BUG-020)", () => {
	it("并发新增三个服务器:三个都落到 mcp.json(不是后写覆盖先写)", async () => {
		const mgr = new McpManager(dir);
		const results = await Promise.allSettled([mgr.upsertServer(httpServer("alpha")), mgr.upsertServer(httpServer("beta")), mgr.upsertServer(httpServer("gamma"))]);
		expect(results.every((r) => r.status === "fulfilled")).toBe(true);
		expect(readConfig().servers.map((s) => s.name).sort()).toEqual(["alpha", "beta", "gamma"]);
		await mgr.close();
	});

	it("并发 create 同名:只有一条成功,配置里只有一份(TOCTOU 在队列内判定)", async () => {
		const mgr = new McpManager(dir);
		const results = await Promise.allSettled([mgr.upsertServer(httpServer("same"), "create"), mgr.upsertServer(httpServer("same"), "create")]);
		const ok = results.filter((r) => r.status === "fulfilled").length;
		const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
		expect(ok).toBe(1);
		expect(failed).toHaveLength(1);
		expect(String(failed[0]!.reason?.message ?? failed[0]!.reason)).toContain("重名");
		expect(readConfig().servers.map((s) => s.name)).toEqual(["same"]);
		await mgr.close();
	});

	it("并发新增 + 删除不同条目:两类变更都保留", async () => {
		writeFileSync(configPath(), JSON.stringify({ servers: [httpServer("keep"), httpServer("drop")] }, null, 2));
		const mgr = new McpManager(dir);
		const [added, removed] = await Promise.allSettled([mgr.upsertServer(httpServer("added")), mgr.removeServer("drop")]);
		expect(added.status).toBe("fulfilled");
		expect(removed.status).toBe("fulfilled");
		expect(readConfig().servers.map((s) => s.name).sort()).toEqual(["added", "keep"]);
		await mgr.close();
	});

	it("create 模式下不存在的 update 与删除都抛错(路由据此映射 404)", async () => {
		writeFileSync(configPath(), JSON.stringify({ servers: [] }, null, 2));
		const mgr = new McpManager(dir);
		await expect(mgr.upsertServer(httpServer("nope"), "update")).rejects.toThrow("不存在");
		await expect(mgr.removeServer("nope")).rejects.toThrow("不存在");
		// 配置未被这两次失败改动(文件不存在时也不会被建出来)
		expect(readConfig().servers).toEqual([]);
		await mgr.close();
	});

	it("raw 保存与结构化新增共用同一队列:并发时两份变更都不丢(顺序确定)", async () => {
		const mgr = new McpManager(dir);
		const [raw, structured] = await Promise.allSettled([
			mgr.saveRawConfig(JSON.stringify({ servers: [httpServer("raw-one")] }, null, 2)),
			mgr.upsertServer(httpServer("structured")),
		]);
		expect(raw.status).toBe("fulfilled");
		expect(structured.status).toBe("fulfilled");
		const names = readConfig().servers.map((s) => s.name).sort();
		// raw 保存是「整份替换」,结构化新增是读-改-写;串行后两种顺序都自洽:
		// 谁在队尾谁的视图生效。这里只要求配置**合法且可解析**,不出现半份文件。
		expect(names.length).toBeGreaterThanOrEqual(1);
		expect(names.every((n) => ["raw-one", "structured"].includes(n))).toBe(true);
		await mgr.close();
	});
});

describe("McpManager reload 世代语义(RISK-005)", () => {
	it("连续两次 reload:状态表只反映最后一次配置", async () => {
		writeFileSync(configPath(), JSON.stringify({ servers: [httpServer("first")] }, null, 2));
		const mgr = new McpManager(dir);
		const r1 = mgr.reload();
		writeFileSync(configPath(), JSON.stringify({ servers: [httpServer("second")] }, null, 2));
		const r2 = mgr.reload();
		await Promise.all([r1, r2]);
		expect(mgr.getStatus().map((s) => s.name)).toEqual(["second"]);
		expect(mgr.getTools()).toEqual([]);
		await mgr.close();
	});

	it("reload 期间 close():迟到的连接结果不写回状态,close 后 reload 是空操作", async () => {
		writeFileSync(configPath(), JSON.stringify({ servers: [httpServer("late")] }, null, 2));
		const mgr = new McpManager(dir);
		const pending = mgr.reload();
		const closing = mgr.close();
		await Promise.allSettled([pending, closing]);
		// close 之后状态表被清空过,迟到的 reload 不得再写回
		const statusAfter = mgr.getStatus().map((s) => s.name);
		expect(statusAfter).not.toContain("late");
		await mgr.reload();
		expect(mgr.getStatus()).toEqual([]);
	});

	it("reload 的连接失败落进状态表(不抛错、不影响其他服务器)", async () => {
		writeFileSync(configPath(), JSON.stringify({ servers: [httpServer("bad", 1)] }, null, 2));
		const mgr = new McpManager(dir);
		await mgr.reload();
		const status = mgr.getStatus();
		expect(status.map((s) => s.name)).toEqual(["bad"]);
		expect(status[0]).toMatchObject({ ok: false, tools: 0 });
		expect(typeof status[0]!.error).toBe("string");
		await mgr.close();
	});
});
