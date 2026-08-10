import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpConfigPath, loadMcpConfig, normalizeMcpConfig, claudeEntryToServer, saveMcpConfig, saveRawMcpConfig, validateMcpConfig } from "../src/mcp/config.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "piw-mcp-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("validateMcpConfig", () => {
	it("accepts a valid stdio + sse + http config", () => {
		const cfg = validateMcpConfig({
			servers: [
				{ name: "fs", type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
				{ name: "remote", type: "sse", url: "http://localhost:8765/sse" },
				{ name: "modern", type: "http", url: "https://api.example.com/mcp" },
			],
		});
		expect(cfg.servers).toHaveLength(3);
		expect(cfg.servers[0]?.args?.[1]).toBe("@modelcontextprotocol/server-filesystem");
		expect(cfg.servers[2]?.url).toBe("https://api.example.com/mcp");
	});

	it("rejects duplicate names", () => {
		expect(() =>
			validateMcpConfig({ servers: [{ name: "a", type: "stdio", command: "x" }, { name: "a", type: "sse", url: "http://x" }] }),
		).toThrow(/重名/);
	});

	it("rejects stdio without command and non-stdio without url", () => {
		expect(() => validateMcpConfig({ servers: [{ name: "a", type: "stdio" }] })).toThrow(/command/);
		expect(() => validateMcpConfig({ servers: [{ name: "a", type: "sse" }] })).toThrow(/url/);
		expect(() => validateMcpConfig({ servers: [{ name: "a", type: "http" }] })).toThrow(/url/);
		expect(() => validateMcpConfig({ servers: [{ name: "a", type: "weird" }] })).toThrow(/结构非法/);
	});

	it("rejects empty name and non-array servers", () => {
		expect(() => validateMcpConfig({ servers: [{ name: "", type: "stdio", command: "x" }] })).toThrow(/结构非法/);
		expect(() => validateMcpConfig({ servers: "nope" })).toThrow(/结构非法/);
	});
});

describe("claudeEntryToServer", () => {
	it("converts stdio entries with args/env, ignores directTools", () => {
		const s = claudeEntryToServer("tavily", {
			command: "npx",
			args: ["-y", "tavily-mcp"],
			env: { TAVILY_API_KEY: "xxx" },
			directTools: true,
		});
		expect(s).toEqual({ name: "tavily", type: "stdio", command: "npx", args: ["-y", "tavily-mcp"], env: { TAVILY_API_KEY: "xxx" } });
	});

	it("infers http by default for url-only entries, sse via transportType/type", () => {
		expect(claudeEntryToServer("a", { url: "https://x/mcp" })).toEqual({ name: "a", type: "http", url: "https://x/mcp" });
		expect(claudeEntryToServer("b", { url: "https://x/sse", transportType: "sse" })).toEqual({ name: "b", type: "sse", url: "https://x/sse" });
		expect(claudeEntryToServer("c", { url: "https://x/sse", type: "sse" })).toEqual({ name: "c", type: "sse", url: "https://x/sse" });
	});

	it("skips disabled entries and malformed ones", () => {
		expect(claudeEntryToServer("off", { command: "npx", disabled: true })).toBeNull();
		expect(claudeEntryToServer("junk", { foo: "bar" })).toBeNull();
		expect(claudeEntryToServer("nul", null)).toBeNull();
	});
});

describe("normalizeMcpConfig", () => {
	it("passes through the own servers-array shape", async () => {
		const cfg = await normalizeMcpConfig({ servers: [{ name: "a", type: "stdio", command: "x" }] });
		expect(cfg.servers).toHaveLength(1);
		expect(cfg.servers[0]?.name).toBe("a");
	});

	it("converts mcpServers object shape (claude format)", async () => {
		const cfg = await normalizeMcpConfig({
			mcpServers: {
				tavily: { command: "npx", args: ["-y", "tavily-mcp"] },
				remote: { url: "https://x/mcp" },
				off: { command: "npx", disabled: true },
			},
		});
		expect(cfg.servers.map((s) => s.name)).toEqual(["tavily", "remote"]);
		expect(cfg.servers[1]?.type).toBe("http");
	});

	it("imports claude-code servers from ~/.claude.json and lets local override same names", async () => {
		const claudeFile = join(tmp, "claude.json");
		writeFileSync(
			claudeFile,
			JSON.stringify({
				mcpServers: {
					importedA: { command: "npx", args: ["-y", "a"] },
					shared: { command: "npx", args: ["-y", "old"] },
				},
			}),
			"utf-8",
		);
		const cfg = await normalizeMcpConfig(
			{ imports: ["claude-code"], mcpServers: { shared: { command: "node", args: ["new.js"] } } },
			claudeFile,
		);
		expect(cfg.servers.map((s) => s.name).sort()).toEqual(["importedA", "shared"]);
		// 本地覆盖同名:shared 是本地版本
		expect(cfg.servers.find((s) => s.name === "shared")?.command).toBe("node");
	});

	it("silently skips imports when claude.json is missing or broken", async () => {
		const cfg = await normalizeMcpConfig({ imports: ["claude-code"], mcpServers: { local: { command: "npx" } } }, join(tmp, "nope.json"));
		expect(cfg.servers.map((s) => s.name)).toEqual(["local"]);
	});

	it("rejects non-object top level", async () => {
		await expect(normalizeMcpConfig(null)).rejects.toThrow(/顶层必须是对象/);
	});
});

describe("loadMcpConfig / saveMcpConfig", () => {
	it("returns empty config when file missing", async () => {
		const cfg = await loadMcpConfig(tmp);
		expect(cfg.servers).toEqual([]);
	});

	it("round-trips a config to disk", async () => {
		await saveMcpConfig(tmp, {
			servers: [{ name: "fs", type: "stdio", command: "npx", args: ["-y", "srv"], env: { DEBUG: "1" } }],
		});
		const cfg = await loadMcpConfig(tmp);
		expect(cfg.servers[0]).toMatchObject({ name: "fs", type: "stdio", command: "npx" });
		expect(cfg.servers[0]?.env).toEqual({ DEBUG: "1" });
		expect(getMcpConfigPath(tmp)).toBe(join(tmp, "mcp.json"));
	});

	it("rejects invalid JSON with a path-hinting error", async () => {
		await import("node:fs/promises").then(({ writeFile }) => writeFile(getMcpConfigPath(tmp), "{oops", "utf-8"));
		await expect(loadMcpConfig(tmp)).rejects.toThrow(/mcp\.json/);
	});

	it("rejects invalid config on save (no partial write)", async () => {
		await expect(saveMcpConfig(tmp, { servers: [{ name: "a", type: "stdio" }] } as never)).rejects.toThrow(/command/);
		// 保存失败后不应留下半成品文件
		await expect(loadMcpConfig(tmp)).resolves.toEqual({ servers: [] });
	});
});

describe("saveRawMcpConfig(直接编辑文件)", () => {
	it("writes claude shape verbatim (imports/mcpServers preserved)", async () => {
		const raw = JSON.stringify({ imports: ["claude-code"], mcpServers: { tavily: { command: "npx", args: ["-y", "tavily-mcp"], directTools: true } } }, null, 2);
		await saveRawMcpConfig(tmp, raw);
		expect(readFileSync(getMcpConfigPath(tmp), "utf-8")).toBe(raw);
		// 重读仍能合并解析
		const cfg = await loadMcpConfig(tmp);
		expect(cfg.servers.map((s) => s.name)).toContain("tavily");
	});

	it("treats empty text as clearing the config", async () => {
		await saveMcpConfig(tmp, { servers: [{ name: "a", type: "stdio", command: "x" }] });
		await saveRawMcpConfig(tmp, "  ");
		await expect(loadMcpConfig(tmp)).resolves.toEqual({ servers: [] });
	});

	it("rejects invalid JSON and invalid business shape without writing", async () => {
		await expect(saveRawMcpConfig(tmp, "{oops")).rejects.toThrow(/JSON/);
		await expect(saveRawMcpConfig(tmp, JSON.stringify({ mcpServers: { a: { foo: 1 } } }))).rejects.toThrow(/command|url/);
		// 失败后文件保持原样(不存在)
		expect(() => readFileSync(getMcpConfigPath(tmp), "utf-8")).toThrow();
	});
});
