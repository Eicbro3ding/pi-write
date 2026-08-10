/**
 * WriterServer 可选 Bearer token 鉴权:authToken 未配置时与桌面版行为完全
 * 一致(全部放行);配置后仅 Authorization: Bearer <token> 或同源 cookie
 * pi_writer_token=<token> 匹配才放行,否则 401 { error: { code: "unauthorized" } }。
 * /api/events(SSE)同样受控(守卫先于 SSE 分支)。
 */

import { describe, it, expect } from "vitest";
import { WriterServer } from "../src/web/server.ts";

/** 最小 SessionHost mock:满足 route() 实际调用面的空实现。 */
function mockHost() {
	return {
		getState: () => ({ sessionFile: "s", bookSlug: "b", chapterFile: "c", isStreaming: false, messages: [], diagnostics: {}, model: "m" }),
		subscribe: () => () => {},
		sendMessage: async () => {},
		abort: async () => {},
		switchSession: async () => {},
		injectContext: async () => {},
		getRuntime: () => undefined,
		setModel: async () => {},
		setThinkingLevel: async () => {},
		listProviders: async () => [],
		setProviderApiKey: async () => {},
		removeProvider: async () => {},
	};
}

async function startServer(token?: string) {
	const server = new WriterServer({ host: "127.0.0.1", port: 0, sessionHost: mockHost() as never, authToken: token });
	// start() 在 listen 完成回调中 resolve,返回实际端口(port 0 = 随机)
	const { port } = await server.start();
	return { server, base: `http://127.0.0.1:${port}` };
}

describe("optional bearer token", () => {
	it("无 authToken 时照常放行", async () => {
		const { server, base } = await startServer();
		const res = await fetch(`${base}/api/session`);
		expect(res.status).toBe(200);
		await server.stop();
	});
	it("有 authToken 时无凭据请求 401", async () => {
		const { server, base } = await startServer("secret");
		const res = await fetch(`${base}/api/session`);
		expect(res.status).toBe(401);
		await server.stop();
	});
	it("错误 token 401", async () => {
		const { server, base } = await startServer("secret");
		const res = await fetch(`${base}/api/session`, { headers: { Authorization: "Bearer wrong" } });
		expect(res.status).toBe(401);
		await server.stop();
	});
	it("正确 Bearer token 200", async () => {
		const { server, base } = await startServer("secret");
		const res = await fetch(`${base}/api/session`, { headers: { Authorization: "Bearer secret" } });
		expect(res.status).toBe(200);
		await server.stop();
	});
	it("正确 cookie token 200", async () => {
		const { server, base } = await startServer("secret");
		const res = await fetch(`${base}/api/session`, { headers: { cookie: "pi_writer_token=secret" } });
		expect(res.status).toBe(200);
		await server.stop();
	});
	it("SSE 无凭据 401", async () => {
		const { server, base } = await startServer("secret");
		const res = await fetch(`${base}/api/events`);
		expect(res.status).toBe(401);
		await server.stop();
	});
});
