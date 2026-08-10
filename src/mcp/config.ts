/**
 * MCP 服务器配置 —— 存 ~/.pi/writer/agent/mcp.json(与 auth.json 并列)。
 *
 * 形状仿 models.json 的 typebox 校验模式:结构非法直接抛错(中文消息),
 * 业务约束(name 非空唯一、stdio 必须有 command、sse 必须有 url)手写校验,
 * 供 web 设置页与 TUI 装配共用。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type TSchema, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { atomicWriteFile } from "../atomic-write.ts";

/** 单个 MCP 服务器配置。 */
export interface McpServerConfig {
	/** 显示名(唯一);同时作为工具命名空间。 */
	name: string;
	/** stdio:本地命令进程; sse:旧版 EventSource 服务器; http:streamable HTTP(现行标准)。 */
	type: "stdio" | "sse" | "http";
	/** stdio 可执行命令(如 npx),type=stdio 必填。 */
	command?: string;
	/** stdio 命令行参数(如 ["-y", "@modelcontextprotocol/server-everything"])。 */
	args?: string[];
	/** stdio 环境变量(缺省继承进程环境)。 */
	env?: Record<string, string>;
	/** sse/http 端点 URL,type=sse|http 必填。 */
	url?: string;
}

/** mcp.json 文件结构。 */
export interface McpConfig {
	servers: McpServerConfig[];
}

const ServerSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	type: Type.Union([Type.Literal("stdio"), Type.Literal("sse"), Type.Literal("http")]),
	command: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	url: Type.Optional(Type.String()),
});

const McpConfigSchema = Type.Object({
	servers: Type.Array(ServerSchema),
});

export type McpConfigStatic = Static<typeof McpConfigSchema>;

/** 配置根目录(agentDir)下的配置文件名。 */
export const MCP_CONFIG_FILE = "mcp.json";

/** mcp.json 绝对路径。 */
export function getMcpConfigPath(agentDir: string): string {
	return join(agentDir, MCP_CONFIG_FILE);
}

/** 校验并规范化一份配置;非法时抛中文 Error(web 设置页直接展示)。 */
export function validateMcpConfig(config: unknown): McpConfig {
	const checked = Compile(McpConfigSchema as TSchema).Check(config);
	if (!checked) throw new Error("mcp.json 结构非法:servers 必须是数组,每项含非空 name 与 type(stdio/sse/http)");
	const servers = (config as McpConfig).servers;
	const seen = new Set<string>();
	for (const s of servers) {
		if (seen.has(s.name)) throw new Error(`MCP 服务器重名: ${s.name}`);
		seen.add(s.name);
		if (s.type === "stdio" && !s.command?.trim()) throw new Error(`MCP 服务器 ${s.name}:stdio 类型必须提供 command`);
		if (s.type !== "stdio" && !s.url?.trim()) throw new Error(`MCP 服务器 ${s.name}:${s.type} 类型必须提供 url`);
	}
	return { servers };
}

/** 读取配置;文件不存在返回空配置,JSON 非法抛错(错误信息指向文件路径)。 */
export async function loadMcpConfig(agentDir: string, claudeJsonPath?: string): Promise<McpConfig> {
	const file = getMcpConfigPath(agentDir);
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		raw = "";
	}
	let parsed: unknown = {};
	if (raw.trim().length > 0) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`${file}: 配置损坏(不是合法 JSON)`);
		}
	}
	try {
		return validateMcpConfig(await normalizeMcpConfig(parsed, claudeJsonPath));
	} catch (err) {
		throw new Error(err instanceof Error ? `${file}: ${err.message}` : `${file}: 配置损坏`);
	}
}

/**
 * 把 mcp.json 内容规范化为自有形状 { servers: [...] }。识别两种顶层形状:
 * - 自有形状:{ servers: [{ name, type, command|url, ... }] }
 * - Claude 形状:{ mcpServers: { name: { command|url, args, env, transportType, disabled, directTools } }, imports? }
 *   (Claude Code / Claude Desktop 的 .mcp.json 与 claude_desktop_config.json 同款)
 * imports 含 "claude-code" 时,自动读 ~/.claude.json(Claude Code 用户级配置)的
 * mcpServers 合并进来——imports 先、本地后,本地条目覆盖同名(与 Claude Code 合并语义一致);
 * claude 文件缺失/损坏静默跳过(不阻塞启动)。Claude 专属字段(directTools/timeout 等)忽略,
 * disabled: true 的条目跳过。保存始终写回自有形状。
 */
export async function normalizeMcpConfig(raw: unknown, claudeJsonPath?: string): Promise<McpConfig> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("mcp.json 顶层必须是对象(servers 数组或 mcpServers 对象)");
	}
	const record = raw as Record<string, unknown>;
	let servers: McpServerConfig[] = [];
	if (Array.isArray(record.servers)) {
		servers = record.servers as McpServerConfig[];
	} else if (record.mcpServers !== undefined) {
		if (typeof record.mcpServers !== "object" || record.mcpServers === null || Array.isArray(record.mcpServers)) {
			throw new Error("mcpServers 必须是 { 名称: 配置 } 对象");
		}
		const entries = Object.entries(record.mcpServers);
		const converted = entries
			.map(([name, entry]) => claudeEntryToServer(name, entry))
			.filter((s): s is McpServerConfig => s !== null);
		if (converted.length === 0 && entries.length > 0) {
			throw new Error("mcpServers 条目无法识别(每条需 command 或 url)");
		}
		servers = converted;
	}
	// imports: ["claude-code"] → ~/.claude.json 的 mcpServers 合并(imports 先,本地覆盖同名)
	const imports = record.imports;
	if (Array.isArray(imports) && imports.includes("claude-code")) {
		const claudeFile = claudeJsonPath ?? join(homedir(), ".claude.json");
		try {
			const claudeRaw = await readFile(claudeFile, "utf-8");
			const claude = JSON.parse(claudeRaw) as Record<string, unknown>;
			if (claude.mcpServers && typeof claude.mcpServers === "object" && !Array.isArray(claude.mcpServers)) {
				const imported = Object.entries(claude.mcpServers)
					.map(([name, entry]) => claudeEntryToServer(name, entry))
					.filter((s): s is McpServerConfig => s !== null);
				servers = [...imported.filter((i) => !servers.some((s) => s.name === i.name)), ...servers];
			}
		} catch {
			/* ~/.claude.json 不存在或损坏:跳过 imports,不阻塞 */
		}
	}
	return { servers };
}

/**
 * Claude 格式条目 → 自有形状;非法/禁用返回 null(宽松跳过,不报错——claude
 * 配置里的条目可能属于 Claude 生态,不该卡死 pi-writer)。type 推断:
 * command → stdio;有 url 时按 transportType/type 判 sse 或 http(缺省 http)。
 */
export function claudeEntryToServer(name: string, entry: unknown): McpServerConfig | null {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
	const e = entry as Record<string, unknown>;
	if (e.disabled === true) return null;
	if (typeof e.command === "string" && e.command.trim().length > 0) {
		const args = Array.isArray(e.args) ? (e.args as unknown[]).filter((a): a is string => typeof a === "string") : undefined;
		const env =
			e.env && typeof e.env === "object" && !Array.isArray(e.env)
				? (Object.fromEntries(Object.entries(e.env as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>)
				: undefined;
		const server: McpServerConfig = { name, type: "stdio", command: e.command };
		if (args && args.length > 0) server.args = args;
		if (env && Object.keys(env).length > 0) server.env = env;
		return server;
	}
	if (typeof e.url === "string" && e.url.trim().length > 0) {
		const t = typeof e.transportType === "string" ? e.transportType : typeof e.type === "string" ? e.type : "";
		const type = t === "sse" ? "sse" : "http";
		return { name, type, url: e.url };
	}
	return null;
}

/** 原子写配置(与 book-manager 的 safeWriteJson 同款 tmp+rename,统一在 atomic-write)。 */
export async function saveMcpConfig(agentDir: string, config: McpConfig): Promise<void> {
	validateMcpConfig(config);
	await atomicWriteFile(getMcpConfigPath(agentDir), JSON.stringify(config, null, 2));
}

/**
 * 原样保存 mcp.json 原始文本(「直接编辑文件」入口用)。
 * 校验两关:JSON 合法 + normalize 后业务合法(形状/重名/必填);
 * 但落盘保留用户写的原样(含 imports/mcpServers 形状与 Claude 专属字段),
 * 下次启动照常合并——所见即所得,不悄悄改写用户的文件。
 * 空文本视为清空配置(写空 servers 数组)。
 */
export async function saveRawMcpConfig(agentDir: string, rawText: string): Promise<void> {
	const file = getMcpConfigPath(agentDir);
	const trimmed = rawText.trim();
	let payload = trimmed;
	if (trimmed.length === 0) {
		payload = JSON.stringify({ servers: [] }, null, 2);
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error("不是合法 JSON,请检查括号与引号");
		}
		await normalizeMcpConfig(parsed);
	}
	await atomicWriteFile(file, payload);
}
