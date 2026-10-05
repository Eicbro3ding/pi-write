import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claudeEntryToUpstream,
	isLegacyShape,
	isUpstreamShape,
	migrateMcpConfig,
	migrateMcpConfigFile,
	serializeUpstreamConfig,
} from "../src/mcp/migrate.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "piw-mcp-mig-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("形状判定", () => {
	it("isLegacyShape 只认顶层 servers 数组", () => {
		expect(isLegacyShape({ servers: [] })).toBe(true);
		expect(isLegacyShape({ mcpServers: {} })).toBe(false);
		expect(isLegacyShape([])).toBe(false);
		expect(isLegacyShape(null)).toBe(false);
		expect(isLegacyShape({ servers: "nope" })).toBe(false);
	});

	it("isUpstreamShape 只认顶层 mcpServers 对象", () => {
		expect(isUpstreamShape({ mcpServers: {} })).toBe(true);
		expect(isUpstreamShape({ mcpServers: { a: {} } })).toBe(true);
		expect(isUpstreamShape({ servers: [] })).toBe(false);
		expect(isUpstreamShape({ mcpServers: [] })).toBe(false);
		expect(isUpstreamShape({ mcpServers: null })).toBe(false);
	});
});

describe("migrateMcpConfig · 旧形状迁移", () => {
	it("stdio 条目迁移后默认 exposure=direct(还原自研可见性)", async () => {
		const legacy = JSON.stringify({
			servers: [{ name: "fs", type: "stdio", command: "npx", args: ["-y", "srv-fs", "/tmp"] }],
		});
		const r = await migrateMcpConfig(legacy);
		expect(r.migrated).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.config.mcpServers.fs).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "srv-fs", "/tmp"],
			exposure: "direct",
		});
	});

	it("sse 条目降级为 http 并产生告警(上游不支持 SSE)", async () => {
		const legacy = JSON.stringify({
			servers: [{ name: "old-sse", type: "sse", url: "http://localhost:8765/sse" }],
		});
		const r = await migrateMcpConfig(legacy);
		expect(r.config.mcpServers["old-sse"]).toEqual({ type: "http", url: "http://localhost:8765/sse", exposure: "direct" });
		expect(r.warnings.some((w) => /SSE/.test(w) && /降级/.test(w))).toBe(true);
	});

	it("http 条目原样迁移", async () => {
		const legacy = JSON.stringify({ servers: [{ name: "api", type: "http", url: "https://x.example/mcp" }] });
		const r = await migrateMcpConfig(legacy);
		expect(r.config.mcpServers.api).toEqual({ type: "http", url: "https://x.example/mcp", exposure: "direct" });
		expect(r.warnings).toEqual([]);
	});

	it("stdio 带 env 时保留 env", async () => {
		const legacy = JSON.stringify({
			servers: [{ name: "e", type: "stdio", command: "run", env: { TOKEN: "abc" } }],
		});
		const r = await migrateMcpConfig(legacy);
		expect(r.config.mcpServers.e?.env).toEqual({ TOKEN: "abc" });
	});

	// 端到端冒烟发现的真实漏洞:http 分支漏带 env,旧配置里的值**静默消失**。
	// 这类"迁移丢字段"不会报错、不会告警,用户只能在工具连不上时反推。
	it("http 带 env 时也保留 env(与 stdio 分支对齐)", async () => {
		const legacy = JSON.stringify({
			servers: [{ name: "h", type: "http", url: "https://x.example/mcp", env: { TOKEN: "abc" } }],
		});
		const r = await migrateMcpConfig(legacy);
		expect(r.config.mcpServers.h?.env).toEqual({ TOKEN: "abc" });
		expect(r.config.mcpServers.h?.type).toBe("http");
	});

	it("sse 降级为 http 时同样保留 env", async () => {
		const legacy = JSON.stringify({
			servers: [{ name: "s", type: "sse", url: "https://x.example/sse", env: { K: "V" } }],
		});
		const r = await migrateMcpConfig(legacy);
		expect(r.config.mcpServers.s?.type).toBe("http");
		expect(r.config.mcpServers.s?.env).toEqual({ K: "V" });
		expect(r.warnings).toHaveLength(1);
	});

	it("字段不完整的条目跳过并告警,不整体失败", async () => {
		const legacy = JSON.stringify({
			servers: [
				{ name: "good", type: "stdio", command: "ok" },
				{ name: "no-cmd", type: "stdio" },
				{ name: "no-url", type: "http" },
			],
		});
		const r = await migrateMcpConfig(legacy);
		expect(Object.keys(r.config.mcpServers)).toEqual(["good"]);
		expect(r.warnings.filter((w) => /跳过/.test(w))).toHaveLength(2);
		expect(r.errors).toEqual([]);
	});

	it("重名时后者覆盖前者并告警", async () => {
		const legacy = JSON.stringify({
			servers: [
				{ name: "dup", type: "stdio", command: "first" },
				{ name: "dup", type: "stdio", command: "second" },
			],
		});
		const r = await migrateMcpConfig(legacy);
		expect(r.config.mcpServers.dup?.command).toBe("second");
		expect(r.warnings.some((w) => /重名/.test(w))).toBe(true);
	});
});

describe("migrateMcpConfig · 新形状保真(幂等)", () => {
	it("已是上游形状时不迁移,且不覆盖用户的 exposure", async () => {
		const upstream = JSON.stringify({
			mcpServers: { a: { type: "stdio", command: "x", exposure: "codemode" } },
		});
		const r = await migrateMcpConfig(upstream);
		expect(r.migrated).toBe(false);
		// 关键:不能把用户显式写的 codemode 改回 direct
		expect(r.config.mcpServers.a?.exposure).toBe("codemode");
	});

	it("保留上游专属字段(enabled / description / headers / toolExposure)", async () => {
		const upstream = JSON.stringify({
			mcpServers: {
				web: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" }, enabled: false },
				doc: { type: "stdio", command: "d", description: "文档", toolExposure: { search: "hidden" } },
			},
		});
		const r = await migrateMcpConfig(upstream);
		expect(r.config.mcpServers.web?.headers).toEqual({ Authorization: "Bearer t" });
		expect(r.config.mcpServers.web?.enabled).toBe(false);
		expect(r.config.mcpServers.doc?.description).toBe("文档");
		expect(r.config.mcpServers.doc?.toolExposure).toEqual({ search: "hidden" });
	});

	it("只含 enabled 的覆盖项保留(上游项目级 mcp.json 用法)", async () => {
		const upstream = JSON.stringify({ mcpServers: { off: { enabled: false } } });
		const r = await migrateMcpConfig(upstream);
		expect(r.config.mcpServers.off).toEqual({ enabled: false });
	});

	it("type 缺省时按 command/url 推断", async () => {
		const upstream = JSON.stringify({
			mcpServers: { a: { command: "x" }, b: { url: "https://y" } },
		});
		const r = await migrateMcpConfig(upstream);
		expect(r.config.mcpServers.a?.type).toBe("stdio");
		expect(r.config.mcpServers.b?.type).toBe("http");
	});

	it("无 command 无 url 也无 enabled/exposure 的条目跳过并告警", async () => {
		const upstream = JSON.stringify({ mcpServers: { junk: { foo: 1 } } });
		const r = await migrateMcpConfig(upstream);
		expect(r.config.mcpServers.junk).toBeUndefined();
		expect(r.warnings.some((w) => /无法识别|跳过/.test(w) || /既无/.test(w))).toBe(true);
	});
});

describe("migrateMcpConfig · 边界与错误", () => {
	it("空文本 = 空配置", async () => {
		const r = await migrateMcpConfig("");
		expect(r.config.mcpServers).toEqual({});
		expect(r.migrated).toBe(false);
		expect(r.errors).toEqual([]);
	});

	it("非法 JSON 报错但不抛异常", async () => {
		const r = await migrateMcpConfig("{ not json");
		expect(r.errors.some((e) => /JSON/.test(e))).toBe(true);
		expect(r.config.mcpServers).toEqual({});
	});

	it("顶层既非 servers 也非 mcpServers 时报错", async () => {
		const r = await migrateMcpConfig(JSON.stringify({ unrelated: 1 }));
		expect(r.errors.some((e) => /servers/.test(e))).toBe(true);
	});

	it("mcpServers 条目非对象时报错", async () => {
		const r = await migrateMcpConfig(JSON.stringify({ mcpServers: { bad: "string" } }));
		expect(r.errors.some((e) => /对象/.test(e))).toBe(true);
	});
});

describe("migrateMcpConfig · Claude 兼容读取(imports)", () => {
	it("imports: claude-code 时读入 ~/.claude.json 的 mcpServers", async () => {
		const claudeFile = join(tmp, "claude.json");
		writeFileSync(claudeFile, JSON.stringify({ mcpServers: { fromClaude: { command: "cc", args: ["a"] } } }));
		const legacy = JSON.stringify({
			servers: [{ name: "local", type: "stdio", command: "l" }],
			imports: ["claude-code"],
		});
		const r = await migrateMcpConfig(legacy, claudeFile);
		expect(r.config.mcpServers.fromClaude?.command).toBe("cc");
		expect(r.config.mcpServers.local?.command).toBe("l");
	});

	it("本地同名条目优先于 Claude 导入", async () => {
		const claudeFile = join(tmp, "claude.json");
		writeFileSync(claudeFile, JSON.stringify({ mcpServers: { dup: { command: "from-claude" } } }));
		const legacy = JSON.stringify({
			servers: [{ name: "dup", type: "stdio", command: "from-local" }],
			imports: ["claude-code"],
		});
		const r = await migrateMcpConfig(legacy, claudeFile);
		expect(r.config.mcpServers.dup?.command).toBe("from-local");
	});

	it("Claude 文件缺失时静默跳过,不报错", async () => {
		const legacy = JSON.stringify({ servers: [], imports: ["claude-code"] });
		const r = await migrateMcpConfig(legacy, join(tmp, "nonexistent.json"));
		expect(r.errors).toEqual([]);
		expect(r.config.mcpServers).toEqual({});
	});

	it("上游形状 + imports 也能展开(Claude 形状扩展)", async () => {
		const claudeFile = join(tmp, "claude.json");
		writeFileSync(claudeFile, JSON.stringify({ mcpServers: { c1: { url: "https://c1/mcp" } } }));
		const upstream = JSON.stringify({
			mcpServers: { a: { command: "x" } },
			imports: ["claude-code"],
		});
		const r = await migrateMcpConfig(upstream, claudeFile);
		expect(r.config.mcpServers.c1?.url).toBe("https://c1/mcp");
		expect(r.config.mcpServers.a?.command).toBe("x");
	});
});

describe("claudeEntryToUpstream", () => {
	it("command → stdio,url → http,disabled 跳过", () => {
		expect(claudeEntryToUpstream("a", { command: "x" })?.type).toBe("stdio");
		expect(claudeEntryToUpstream("b", { url: "https://y" })?.type).toBe("http");
		expect(claudeEntryToUpstream("c", { command: "x", disabled: true })).toBeNull();
		expect(claudeEntryToUpstream("d", "nope")).toBeNull();
		expect(claudeEntryToUpstream("e", {})).toBeNull();
	});

	it("迁移条目带 exposure=direct;headers 透传", () => {
		expect(claudeEntryToUpstream("a", { command: "x" })?.exposure).toBe("direct");
		expect(claudeEntryToUpstream("b", { url: "https://y", headers: { H: "v" } })?.headers).toEqual({ H: "v" });
	});
});

describe("serializeUpstreamConfig", () => {
	it("2 空格缩进且可往返解析", async () => {
		const text = serializeUpstreamConfig({ mcpServers: { a: { type: "stdio", command: "x", exposure: "direct" } } });
		expect(text).toContain('\n  "mcpServers"');
		const back = await migrateMcpConfig(text);
		expect(back.config.mcpServers.a?.command).toBe("x");
	});
});

describe("migrateMcpConfigFile · 文件层", () => {
	const fileOf = () => join(tmp, "mcp.json");

	it("旧形状 → 写回新形状 + 备份原文件", async () => {
		writeFileSync(fileOf(), JSON.stringify({ servers: [{ name: "a", type: "stdio", command: "x" }] }));
		const r = await migrateMcpConfigFile(tmp);
		expect(r.wrote).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.backupPath).toBeDefined();
		expect(existsSync(r.backupPath!)).toBe(true);
		// 备份内容 = 原始文本
		expect(JSON.parse(readFileSync(r.backupPath!, "utf-8")).servers).toHaveLength(1);
		// 落盘已是新形状
		const onDisk = JSON.parse(readFileSync(fileOf(), "utf-8"));
		expect(onDisk.mcpServers.a.exposure).toBe("direct");
		expect(onDisk.servers).toBeUndefined();
	});

	it("幂等:已是新形状时不写文件、不备份", async () => {
		const upstream = JSON.stringify({ mcpServers: { a: { command: "x" } } });
		writeFileSync(fileOf(), upstream);
		const r = await migrateMcpConfigFile(tmp);
		expect(r.wrote).toBe(false);
		expect(r.backupPath).toBeUndefined();
		// 文件未被改写(逐字节一致)
		expect(readFileSync(fileOf(), "utf-8")).toBe(upstream);
	});

	it("连续两次调用:第二次无操作", async () => {
		writeFileSync(fileOf(), JSON.stringify({ servers: [{ name: "a", type: "stdio", command: "x" }] }));
		const first = await migrateMcpConfigFile(tmp);
		expect(first.wrote).toBe(true);
		const second = await migrateMcpConfigFile(tmp);
		expect(second.wrote).toBe(false);
	});

	it("文件不存在时按空配置,不创建文件", async () => {
		const r = await migrateMcpConfigFile(tmp);
		expect(r.wrote).toBe(false);
		expect(r.config.mcpServers).toEqual({});
		expect(existsSync(fileOf())).toBe(false);
	});

	it("JSON 非法时不动原文件、报错", async () => {
		const broken = "{ broken";
		writeFileSync(fileOf(), broken);
		const r = await migrateMcpConfigFile(tmp);
		expect(r.wrote).toBe(false);
		expect(r.errors.length).toBeGreaterThan(0);
		expect(readFileSync(fileOf(), "utf-8")).toBe(broken);
	});
});
