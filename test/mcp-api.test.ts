/**
 * MCP HTTP 路由契约。
 *
 * 2026-10 审计 BUG-019 的原始契约:服务端 readMcpServerBody 必须接受 `http`
 * (streamable HTTP,现行标准),不能只收 stdio / sse。
 *
 * T9-A(2026-10-05)改用上游 `createMcpExtension` 后契约有两处**有意变更**:
 * 1. `sse` 不再被接受 —— 上游不支持 SSE,提交 sse 返回 400 并提示改用 http
 *    (已存在的 sse 条目在配置迁移时自动降级为 http,见 src/mcp/migrate.ts)。
 * 2. 端点背后的实现从自研 `McpManager` 换成 `McpHost`(配置读写门面)。
 *
 * 这里用真实 McpHost + 真实 http 监听,覆盖新增/编辑/删除/原样保存与拒绝路径。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHost } from "../src/mcp/host.ts";
import { WriterServer } from "../src/web/server.ts";

const tmp = mkdtempSync(join(tmpdir(), "piw-mcp-api-"));

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

describe("MCP HTTP API", () => {
	let server: WriterServer;
	let base = "";
	let host: McpHost;

	beforeAll(async () => {
		host = new McpHost(tmp);
		server = new WriterServer({
			host: "127.0.0.1",
			port: 0,
			sessionHost: fakeSessionHost().host,
			webDistDir: join(tmp, "no-dist"),
			mcpHost: host,
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
	const post = (serverBody: Record<string, unknown>) =>
		fetch(`${base}/api/mcp`, { method: "POST", headers: json, body: JSON.stringify(serverBody) });

	it("未装配 mcpHost 时 404(保持既有语义)", async () => {
		const bare = new WriterServer({
			host: "127.0.0.1",
			port: 0,
			sessionHost: fakeSessionHost().host,
			webDistDir: join(tmp, "no-dist"),
		});
		const { port } = await bare.start();
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/mcp`);
			expect(res.status).toBe(404);
		} finally {
			await bare.stop();
		}
	});

	it("POST /api/mcp 接受 stdio 与 http", async () => {
		const stdio = await post({ name: "local", type: "stdio", command: "npx", args: ["-y", "server"] });
		expect(stdio.status).toBe(200);
		// http(streamable HTTP)是 BUG-019 的核心:此前必然 400
		const http = await post({ name: "modern", type: "http", url: "https://example.test/mcp" });
		expect(http.status).toBe(200);
		const body = (await http.json()) as { servers: Array<{ name: string; type: string; url?: string }> };
		expect(body.servers.find((s) => s.name === "modern")).toMatchObject({ type: "http", url: "https://example.test/mcp" });
	});

	it("POST sse 被拒绝并提示改用 http(T9-A:上游不支持 SSE)", async () => {
		const res = await post({ name: "legacy", type: "sse", url: "https://example.test/sse" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { message?: string } };
		expect(JSON.stringify(body)).toMatch(/SSE/);
	});

	it("类型/必填字段校验:未知类型、stdio 缺 command、http 缺 url、非法 URL 都 400", async () => {
		expect((await post({ name: "x", type: "websocket", url: "https://e.test" })).status).toBe(400);
		expect((await post({ name: "x", type: "stdio" })).status).toBe(400);
		expect((await post({ name: "x", type: "http" })).status).toBe(400);
		expect((await post({ name: "x", type: "http", url: "not-a-url" })).status).toBe(400);
	});

	it("暴露策略与启用开关被接受,非法 exposure 被拒", async () => {
		const ok = await post({
			name: "exposed",
			type: "stdio",
			command: "x",
			exposure: "codemode",
			enabled: false,
			description: "测试",
		});
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { servers: Array<{ name: string; exposure?: string; enabled?: boolean }> };
		const s = body.servers.find((v) => v.name === "exposed");
		expect(s?.exposure).toBe("codemode");
		expect(s?.enabled).toBe(false);
		expect((await post({ name: "bad", type: "stdio", command: "x", exposure: "nope" })).status).toBe(400);
	});

	it("PUT /api/mcp/:name 编辑成 http 也能保存(新增/编辑共用同一解析器)", async () => {
		await post({ name: "editme", type: "stdio", command: "x" });
		const res = await fetch(`${base}/api/mcp/editme`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ name: "editme", type: "http", url: "https://example.test/mcp" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { servers: Array<{ name: string; type: string }> };
		expect(body.servers.find((s) => s.name === "editme")?.type).toBe("http");
	});

	it("PUT 改名被拒(名称不可在编辑时修改)", async () => {
		await post({ name: "keepname", type: "stdio", command: "x" });
		const res = await fetch(`${base}/api/mcp/keepname`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ name: "renamed", type: "stdio", command: "x" }),
		});
		expect(res.status).toBe(400);
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

	it("DELETE 已存在的服务器成功", async () => {
		await post({ name: "todelete", type: "stdio", command: "x" });
		const del = await fetch(`${base}/api/mcp/todelete`, { method: "DELETE" });
		expect(del.status).toBe(200);
		const body = (await del.json()) as { servers: Array<{ name: string }> };
		expect(body.servers.some((s) => s.name === "todelete")).toBe(false);
	});

	it("GET /api/mcp 返回 servers + status", async () => {
		await post({ name: "listed", type: "stdio", command: "x" });
		const res = await fetch(`${base}/api/mcp`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { servers: unknown[]; status: unknown[] };
		expect(Array.isArray(body.servers)).toBe(true);
		expect(Array.isArray(body.status)).toBe(true);
	});

	it("PUT /api/mcp/raw 原样保存并回读(含 http 类型)", async () => {
		const text = JSON.stringify(
			{ mcpServers: { "raw-http": { type: "http", url: "https://example.test/mcp" } } },
			null,
			2,
		);
		const res = await fetch(`${base}/api/mcp/raw`, { method: "PUT", headers: json, body: JSON.stringify({ text }) });
		expect(res.status).toBe(200);
		const got = (await (await fetch(`${base}/api/mcp/raw`)).json()) as { text: string };
		expect(JSON.parse(got.text)).toEqual(JSON.parse(text));
		const bad = await fetch(`${base}/api/mcp/raw`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ text: "{ 坏" }),
		});
		expect(bad.status).toBe(400);
		// 坏保存不落盘(上一次的成功内容还在)
		expect(JSON.parse(readFileSync(join(host.getAgentDir(), "mcp.json"), "utf8"))).toEqual(JSON.parse(text));
	});
});
