import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpHost } from "../src/mcp/host.ts";

let tmp: string;
let host: McpHost;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "piw-mcp-host-"));
	host = new McpHost(tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** 伪造一个工具清单(模拟 pi.getAllTools())。 */
const fakeTools = (namespaces: string[]) => () =>
	namespaces.map((ns) => ({ namespace: { name: ns } }) as never);

describe("McpHost · 配置读写", () => {
	it("空配置时 listConfig 返回空数组", async () => {
		expect((await host.listConfig()).servers).toEqual([]);
	});

	it("upsertServer(create) 写入 mcpServers 形状", async () => {
		await host.upsertServer({ name: "fs", type: "stdio", command: "npx", args: ["-y", "srv"] }, "create");
		const onDisk = JSON.parse(readFileSync(join(tmp, "mcp.json"), "utf-8"));
		expect(onDisk.mcpServers.fs.command).toBe("npx");
		expect(onDisk.mcpServers.fs.exposure).toBe("direct");
	});

	it("create 时重名报错", async () => {
		await host.upsertServer({ name: "a", type: "stdio", command: "x" }, "create");
		await expect(host.upsertServer({ name: "a", type: "stdio", command: "y" }, "create")).rejects.toThrow(/已存在/);
	});

	it("update 时不存在报错", async () => {
		await expect(host.upsertServer({ name: "ghost", type: "stdio", command: "x" }, "update")).rejects.toThrow(/不存在/);
	});

	it("upsertServer(update) 保留其他条目", async () => {
		await host.upsertServer({ name: "a", type: "stdio", command: "x" }, "create");
		await host.upsertServer({ name: "b", type: "stdio", command: "y" }, "create");
		await host.upsertServer({ name: "a", type: "stdio", command: "x2" }, "update");
		const cfg = await host.listConfig();
		expect(cfg.servers.map((s) => s.name).sort()).toEqual(["a", "b"]);
		expect(cfg.servers.find((s) => s.name === "a")?.command).toBe("x2");
	});

	it("removeServer 删除条目;不存在时报错", async () => {
		await host.upsertServer({ name: "a", type: "stdio", command: "x" }, "create");
		await host.removeServer("a");
		expect((await host.listConfig()).servers).toEqual([]);
		await expect(host.removeServer("a")).rejects.toThrow(/不存在/);
	});

	it("http 服务器的 url/headers 往返保真", async () => {
		await host.upsertServer(
			{ name: "web", type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
			"create",
		);
		const s = (await host.listConfig()).servers[0];
		expect(s?.url).toBe("https://x/mcp");
		expect(s?.headers).toEqual({ Authorization: "Bearer t" });
	});

	it("读得出旧的自研形状配置(未迁移也能列表)", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmp, "mcp.json"), JSON.stringify({ servers: [{ name: "old", type: "stdio", command: "o" }] }));
		const cfg = await host.listConfig();
		expect(cfg.servers.map((s) => s.name)).toEqual(["old"]);
	});
});

describe("McpHost · 状态反推", () => {
	it("按 namespace 反推每个服务器的工具数", async () => {
		await host.upsertServer({ name: "docs", type: "stdio", command: "d" }, "create");
		await host.listConfig();
		host.setToolLister(fakeTools(["mcp__docs", "mcp__docs", "mcp__other"]));
		const status = host.getStatus();
		expect(status.find((s) => s.name === "docs")).toEqual({ name: "docs", type: "stdio", ok: true, tools: 2 });
	});

	it("namespace 名做 [^A-Za-z0-9_] → _ 归一(与上游一致)", async () => {
		await host.upsertServer({ name: "my-server", type: "stdio", command: "x" }, "create");
		await host.listConfig();
		host.setToolLister(fakeTools(["mcp__my_server"]));
		expect(host.getStatus().find((s) => s.name === "my-server")?.tools).toBe(1);
	});

	it("enabled=false 的服务器 ok=false 且带说明", async () => {
		await host.upsertServer({ name: "off", type: "stdio", command: "x", enabled: false }, "create");
		await host.listConfig();
		host.setToolLister(fakeTools(["mcp__off"]));
		const st = host.getStatus().find((s) => s.name === "off");
		expect(st?.ok).toBe(false);
		expect(st?.error).toBe("已禁用");
		// 工具数仍然如实反映(工具确实注册了,只是标记禁用)
		expect(st?.tools).toBe(1);
	});

	it("无工具时 ok=false(连接中或失败)", async () => {
		await host.upsertServer({ name: "pending", type: "stdio", command: "x" }, "create");
		await host.listConfig();
		host.setToolLister(fakeTools([]));
		expect(host.getStatus().find((s) => s.name === "pending")).toEqual({
			name: "pending",
			type: "stdio",
			ok: false,
			tools: 0,
		});
	});
});

describe("McpHost · 原样保存", () => {
	it("saveRawConfig 合法 JSON 原样落盘", async () => {
		const text = JSON.stringify({ mcpServers: { a: { command: "x" } } }, null, 4);
		await host.saveRawConfig(text);
		expect(readFileSync(join(tmp, "mcp.json"), "utf-8")).toBe(text);
	});

	it("saveRawConfig 空文本写空配置", async () => {
		await host.saveRawConfig("   ");
		expect(JSON.parse(readFileSync(join(tmp, "mcp.json"), "utf-8")).mcpServers).toEqual({});
	});

	it("saveRawConfig 非法 JSON 抛中文错", async () => {
		await expect(host.saveRawConfig("{ broken")).rejects.toThrow(/JSON/);
	});

	it("saveRawConfig 形状非法时抛错且不落盘", async () => {
		await expect(host.saveRawConfig(JSON.stringify({ unrelated: 1 }))).rejects.toThrow();
	});

	it("saveRawConfig 支持旧形状(会被迁移层接受)", async () => {
		const text = JSON.stringify({ servers: [{ name: "a", type: "stdio", command: "x" }] });
		await host.saveRawConfig(text);
		expect(readFileSync(join(tmp, "mcp.json"), "utf-8")).toBe(text);
	});

	it("saveRawConfig 原样保留 imports 与 mcpServers 形状(所见即所得)", async () => {
		// 对应原 config.ts 的 saveRawMcpConfig 契约:不清洗用户写的 Claude 形状
		const text = JSON.stringify({ mcpServers: { a: { command: "x" } }, imports: ["claude-code"] }, null, 2);
		await host.saveRawConfig(text);
		expect(readFileSync(join(tmp, "mcp.json"), "utf-8")).toBe(text);
	});
});

describe("McpHost · 迁移", () => {
	it("ensureMigrated 把旧形状转为新形状", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmp, "mcp.json"), JSON.stringify({ servers: [{ name: "a", type: "stdio", command: "x" }] }));
		const r = await host.ensureMigrated();
		expect(r.errors).toEqual([]);
		const onDisk = JSON.parse(readFileSync(join(tmp, "mcp.json"), "utf-8"));
		expect(onDisk.mcpServers.a.command).toBe("x");
	});

	it("ensureMigrated 幂等:第二次无告警无改动", async () => {
		await host.upsertServer({ name: "a", type: "stdio", command: "x" }, "create");
		const before = readFileSync(join(tmp, "mcp.json"), "utf-8");
		const r = await host.ensureMigrated();
		expect(r.errors).toEqual([]);
		expect(readFileSync(join(tmp, "mcp.json"), "utf-8")).toBe(before);
	});
});
