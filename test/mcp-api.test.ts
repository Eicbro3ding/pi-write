/**
 * MCP HTTP 路由契约(2026-10 审计 BUG-019)。
 *
 * 共享 schema(src/mcp/config.ts)、McpManager 连接层与前端选项都支持 `http`
 * (streamable HTTP,现行标准),但服务端的 readMcpServerBody 此前只收 stdio / sse ——
 * 前端选 http 保存必然 400。这里用真实 http 监听 + fake mcpManager/sessionHost 覆盖
 * 三种类型的新增与编辑,以及必填字段/URL 形态的拒绝路径。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WriterServer } from "../src/web/server.ts";
import { getMcpConfigPath, saveRawMcpConfig } from "../src/mcp/config.ts";

const tmp = mkdtempSync(join(tmpdir(), "piw-mcp-api-"));
/** 假 McpManager:只记录 saveMcpConfig/reload 的效果,不真的连服务器。 */
function fakeMcpManager(agentDir: string) {
	const saved: Array<Array<Record<string, unknown>>> = [];
	const state = {
		config: { servers: [] as Array<Record<string, unknown>> },
		status: [] as Array<{ name: string; type: string; ok: boolean; tools: number }>,
	};
	return {
		agentDir,
		saved,
		onReconnect: undefined as unknown,
		getAgentDir: () => agentDir,
		getTools: () => [],
		getStatus: () => state.status,
		listConfig: async () => state.config,
		async upsertServer(server: Record<string, unknown>, mode: "create" | "update" | "any" = "any") {
			const idx = state.config.servers.findIndex((s) => s.name === server.name);
			if (mode === "create" && idx !== -1) throw new Error(`MCP 服务器重名: ${server.name}`);
			if (mode === "update" && idx === -1) throw new Error(`MCP 服务器不存在: ${server.name}`);
			if (idx === -1) state.config.servers.push(server);
			else state.config.servers[idx] = server;
			saved.push([...state.config.servers]);
			return state.config;
		},
		async removeServer(name: string) {
			const next = state.config.servers.filter((s) => s.name !== name);
			if (next.length === state.config.servers.length) throw new Error(`MCP 服务器不存在: ${name}`);
			state.config.servers = next;
			saved.push([...next]);
			return { servers: next };
		},
		async saveRawConfig(rawText: string) {
			// 用真实实现:先校验 JSON/形状再落盘(坏内容不写文件)
			await saveRawMcpConfig(agentDir, rawText);
			state.config = JSON.parse(rawText);
			return state.config;
		},
		async reload() {},
		async close() {},
	};
}

function fakeSessionHost() {
	const listeners = new Set<(e: unknown) => void>();
	return {
		host: {
			subscribe: (l: (e: unknown) => void) => {
				listeners.add(l);
				return () => listeners.delete(l);
			},
			getState: () => ({ bookSlug: null, chapterFile: null, isStreaming: false, messages: [], diagnostics: [] }),
			reloadRuntime: async () => {},
			dispose: async () => {},
		} as never,
	};
}

describe("MCP HTTP API(BUG-019)", () => {
	let server: WriterServer;
	let base = "";
	let mgr: ReturnType<typeof fakeMcpManager>;

	beforeAll(async () => {
		// agentDir 用已存在的临时目录(raw 保存是直接写文件)
		mgr = fakeMcpManager(tmp);
		server = new WriterServer({
			host: "127.0.0.1",
			port: 0,
			sessionHost: fakeSessionHost().host,
			webDistDir: join(tmp, "no-dist"),
			mcpManager: mgr as never,
		});
		const { port } = await server.start();
		base = `http://127.0.0.1:${port}`;
	});
	afterAll(async () => {
		await server.stop();
		rmSync(tmp, { recursive: true, force: true });
	});

	const json = { "content-type": "application/json" } as const;
	// 路由契约:POST/PUT 的 body **就是**服务器对象(前端 client 同款,无外层包装)
	const post = (server: Record<string, unknown>) => fetch(`${base}/api/mcp`, { method: "POST", headers: json, body: JSON.stringify(server) });

	it("POST /api/mcp 接受 stdio / sse / http 三种类型", async () => {
		const stdio = await post({ name: "local", type: "stdio", command: "npx", args: ["-y", "server"] });
		expect(stdio.status).toBe(200);
		const sse = await post({ name: "legacy", type: "sse", url: "https://example.test/sse" });
		expect(sse.status).toBe(200);
		// http(streamable HTTP)此前必然 400
		const http = await post({ name: "modern", type: "http", url: "https://example.test/mcp" });
		expect(http.status).toBe(200);
		const body = (await http.json()) as { servers: Array<{ name: string; type: string; url?: string }> };
		expect(body.servers.find((s) => s.name === "modern")).toMatchObject({ type: "http", url: "https://example.test/mcp" });
	});

	it("类型/必填字段校验:未知类型、stdio 缺 command、sse/http 缺 url、非法 URL 都 400", async () => {
		expect((await post({ name: "x", type: "websocket", url: "https://e.test" })).status).toBe(400);
		expect((await post({ name: "x", type: "stdio" })).status).toBe(400);
		expect((await post({ name: "x", type: "sse" })).status).toBe(400);
		expect((await post({ name: "x", type: "http" })).status).toBe(400);
		expect((await post({ name: "x", type: "http", url: "not-a-url" })).status).toBe(400);
		expect((await post({ name: "x", type: "sse", url: "ftp://e.test/sse" })).status).toBe(400);
	});

	it("PUT /api/mcp/:name 编辑成 http 也能保存(新增/编辑共用同一解析器)", async () => {
		await post({ name: "editme", type: "sse", url: "https://example.test/sse" });
		const res = await fetch(`${base}/api/mcp/editme`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ name: "editme", type: "http", url: "https://example.test/mcp" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { servers: Array<{ name: string; type: string }> };
		expect(body.servers.find((s) => s.name === "editme")?.type).toBe("http");
	});

	it("POST 重名 → 400;PUT 不存在的名字 → 404;DELETE 不存在的名字 → 404", async () => {
		await post({ name: "dupe", type: "http", url: "https://example.test/mcp" });
		expect((await post({ name: "dupe", type: "http", url: "https://example.test/mcp" })).status).toBe(400);
		const put = await fetch(`${base}/api/mcp/nope`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ name: "nope", type: "http", url: "https://example.test/mcp" }),
		});
		expect(put.status).toBe(404);
		const del = await fetch(`${base}/api/mcp/nope`, { method: "DELETE" });
		expect(del.status).toBe(404);
	});

	it("PUT /api/mcp/raw 原样保存并回读(含 http 类型)", async () => {
		const text = JSON.stringify({ servers: [{ name: "raw-http", type: "http", url: "https://example.test/mcp" }] }, null, 2);
		const res = await fetch(`${base}/api/mcp/raw`, { method: "PUT", headers: json, body: JSON.stringify({ text }) });
		expect(res.status).toBe(200);
		const got = (await (await fetch(`${base}/api/mcp/raw`)).json()) as { text: string };
		expect(JSON.parse(got.text)).toEqual(JSON.parse(text));
		const bad = await fetch(`${base}/api/mcp/raw`, { method: "PUT", headers: json, body: JSON.stringify({ text: "{ 坏" }) });
		expect(bad.status).toBe(400);
		// 坏保存不落盘(上一次的成功内容还在)
		expect(JSON.parse(readFileSync(getMcpConfigPath(mgr.getAgentDir()), "utf8"))).toEqual(JSON.parse(text));
	});
});
