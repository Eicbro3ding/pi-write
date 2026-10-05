/**
 * MCP 配置迁移 —— 自研形状 → 上游 mcpServers 形状(T9-A,B 方案)。
 *
 * 背景:pi-writer 原来自持 MCP 实现,配置存 `{ servers: [...] }` 数组。改用上游
 * `createMcpExtension` 后,配置必须是上游认的 `{ mcpServers: { <name>: {...} } }`
 * 字典。本模块负责一次性、幂等、可回滚地把旧文件迁到新形状。
 *
 * 三条设计约束(来自 PI_WRITER_T9A_MCP_REWRITE.md):
 * 1. **默认写 `exposure: "direct"`** —— 还原自研「工具直接可见」语义。上游默认
 *    `codemode`(工具不进模型工具声明),不写会让既有用户的 MCP 工具突然不可见。
 * 2. **SSE 降级为 http** —— 上游只支持 stdio + streamable HTTP。降级时记录告警,
 *    URL 不变(用户若升到支持 SSE 的版本或换成 http 端点可继续用)。
 * 3. **幂等** —— 已是新形状则原样返回,不重复迁移、不覆盖用户手写的 exposure 等字段。
 *
 * 纯函数:输入原始文本 + 可选 Claude 配置路径,输出迁移结果。不碰文件系统(读 Claude
 * 文件除外,那是兼容读取的一部分),便于单测覆盖各种形状。
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../atomic-write.ts";

/** agentDir 下的配置文件名。 */
export const MCP_CONFIG_FILE = "mcp.json";

/** 自研形状的单条服务器(迁移输入)。 */
export interface LegacyServer {
	name: string;
	type: "stdio" | "sse" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
}

/** 上游形状的单条服务器(迁移输出;字段与 @earendil-works/pi-coding-agent 的 McpServerConfig 对齐)。 */
export interface UpstreamServer {
	type?: "stdio" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	/** 工具暴露策略;迁移默认 "direct"。 */
	exposure?: "codemode" | "deferred" | "direct" | "hidden";
	/** 一句话说明(上游 mcp_servers 段用)。 */
	description?: string;
	/** 是否连接,false 时保留条目但不连。 */
	enabled?: boolean;
	/** http 服务器的自定义请求头。 */
	headers?: Record<string, string>;
}

/** 迁移结果。 */
export interface MigrationResult {
	/** 上游形状配置(始终可用,即使未发生迁移)。 */
	config: { mcpServers: Record<string, UpstreamServer> };
	/** 是否发生了迁移(旧形状 → 新形状)。 */
	migrated: boolean;
	/** 迁移过程中的告警(SSE 降级、Claude 条目跳过等),供调用方打 stderr。 */
	warnings: string[];
	/** 配置错误(形状非法等);非空时应放弃迁移、按空配置继续。 */
	errors: string[];
}

/** 判断一份已解析的配置是否是「旧的自研形状」(顶层有 servers 数组)。 */
export function isLegacyShape(raw: unknown): boolean {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
	const record = raw as Record<string, unknown>;
	return Array.isArray(record.servers);
}

/** 判断一份已解析的配置是否已经是「上游形状」(顶层有 mcpServers 对象)。 */
export function isUpstreamShape(raw: unknown): boolean {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
	const record = raw as Record<string, unknown>;
	const m = record.mcpServers;
	return m !== undefined && m !== null && typeof m === "object" && !Array.isArray(m);
}

/**
 * 自研单条 → 上游单条。SSE 降级为 http 并记告警。
 * 返回 null 表示条目不可用(缺必填字段)。
 */
function legacyServerToUpstream(server: LegacyServer, warnings: string[]): UpstreamServer | null {
	if (typeof server.name !== "string" || server.name.trim().length === 0) return null;
	if (server.type === "stdio") {
		if (!server.command?.trim()) return null;
		const out: UpstreamServer = { type: "stdio", command: server.command, exposure: "direct" };
		if (server.args && server.args.length > 0) out.args = server.args;
		if (server.env && Object.keys(server.env).length > 0) out.env = server.env;
		return out;
	}
	if (server.type === "http" || server.type === "sse") {
		if (!server.url?.trim()) return null;
		if (server.type === "sse") {
			warnings.push(
				`MCP 服务器 "${server.name}":上游不支持 SSE 传输,已降级为 http(URL 不变)。若连不上,请改用该服务的 streamable HTTP 端点或 wait 上游支持。`,
			);
		}
		const out: UpstreamServer = { type: "http", url: server.url, exposure: "direct" };
		// env 在 http 传输下同样有意义(上游会把它并入请求环境 / 供自定义客户端读取),
		// 旧配置里写了就带过去 —— 丢掉等于静默改用户的配置。
		if (server.env && Object.keys(server.env).length > 0) out.env = server.env;
		return out;
	}
	return null;
}

/**
 * Claude 形状条目 → 上游条目(宽松跳过非法/禁用条目,不报错)。
 * Claude 生态的条目可能与本项目无关,不该卡死启动。
 */
export function claudeEntryToUpstream(name: string, entry: unknown): UpstreamServer | null {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
	const e = entry as Record<string, unknown>;
	if (e.disabled === true) return null;
	if (typeof e.command === "string" && e.command.trim().length > 0) {
		const out: UpstreamServer = { type: "stdio", command: e.command, exposure: "direct" };
		if (Array.isArray(e.args)) {
			const args = (e.args as unknown[]).filter((a): a is string => typeof a === "string");
			if (args.length > 0) out.args = args;
		}
		if (e.env && typeof e.env === "object" && !Array.isArray(e.env)) {
			const env = Object.fromEntries(
				Object.entries(e.env as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
			) as Record<string, string>;
			if (Object.keys(env).length > 0) out.env = env;
		}
		return out;
	}
	if (typeof e.url === "string" && e.url.trim().length > 0) {
		const out: UpstreamServer = { type: "http", url: e.url, exposure: "direct" };
		if (e.headers && typeof e.headers === "object" && !Array.isArray(e.headers)) {
			const headers = Object.fromEntries(
				Object.entries(e.headers as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
			) as Record<string, string>;
			if (Object.keys(headers).length > 0) out.headers = headers;
		}
		return out;
	}
	return null;
}

/**
 * 把 mcpServers 字典(Claude / 上游形状)规范化为上游形状,保留上游专属字段
 * (exposure / enabled / description / headers / toolExposure 等)。
 *
 * 与 `claudeEntryToUpstream` 的区别:本函数**保真**——已是上游形状的条目原样保留,
 * 不做 exposure 缺省填充(缺省由上游自己按 codemode 处理,那是用户显式选择新格式时的意图)。
 * 只有**从旧形状迁移**来的条目才填 `exposure: "direct"`。
 */
function passthroughUpstreamEntry(entry: unknown): UpstreamServer | null {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
	const e = entry as Record<string, unknown>;
	if (typeof e.command === "string" && e.command.trim().length > 0) {
		const out: UpstreamServer = { ...e, type: (e.type as "stdio" | undefined) ?? "stdio" };
		return out;
	}
	if (typeof e.url === "string" && e.url.trim().length > 0) {
		return { ...e, type: (e.type as "http" | undefined) ?? "http" };
	}
	// 只含 enabled/exposure/toolExposure/description 的「覆盖项」(上游项目级 mcp.json 允许):原样保留
	if (e.command === undefined && e.url === undefined) {
		const hasUpstreamField =
			e.enabled !== undefined ||
			e.exposure !== undefined ||
			e.toolExposure !== undefined ||
			e.description !== undefined;
		if (hasUpstreamField) return { ...e };
	}
	return null;
}

/**
 * 迁移入口。
 *
 * @param rawText   mcp.json 原始文本(空文本 = 空配置)
 * @param claudeJsonPath  兼容读取的 Claude 配置路径,缺省 `~/.claude.json`
 */
export async function migrateMcpConfig(rawText: string, claudeJsonPath?: string): Promise<MigrationResult> {
	const warnings: string[] = [];
	const errors: string[] = [];
	const servers: Record<string, UpstreamServer> = {};
	let migrated = false;

	let parsed: unknown = {};
	const trimmed = rawText.trim();
	if (trimmed.length > 0) {
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			errors.push("mcp.json 不是合法 JSON");
			return { config: { mcpServers: {} }, migrated: false, warnings, errors };
		}
	}

	// —— 读:三种形状 ——
	if (isLegacyShape(parsed)) {
		// 旧的自研形状 { servers: [...] } → 需要迁移
		migrated = true;
		for (const raw of (parsed as { servers: unknown[] }).servers) {
			if (raw === null || typeof raw !== "object") continue;
			const server = raw as LegacyServer;
			const up = legacyServerToUpstream(server, warnings);
			if (up === null) {
				warnings.push(`MCP 服务器 "${(raw as LegacyServer).name ?? "?"}":字段不完整,已跳过`);
				continue;
			}
			if (servers[server.name]) {
				warnings.push(`MCP 服务器重名:"${server.name}" 重复出现,后者覆盖前者`);
			}
			servers[server.name] = up;
		}
	} else if (isUpstreamShape(parsed)) {
		// 已是上游 / Claude 形状:保真读取
		for (const [name, entry] of Object.entries((parsed as { mcpServers: Record<string, unknown> }).mcpServers)) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				errors.push(`MCP 服务器 "${name}":条目必须是对象`);
				continue;
			}
			// passthroughUpstreamEntry 已判定条目是否可用(含只有 enabled/exposure 的覆盖项)
			const up = passthroughUpstreamEntry(entry);
			if (up === null) {
				warnings.push(`MCP 服务器 "${name}":既无 command 也无 url,已跳过`);
				continue;
			}
			servers[name] = up;
		}
	} else if (trimmed.length > 0 && Object.keys(parsed as object).length > 0) {
		errors.push("mcp.json 顶层必须是 { servers: [...] } 或 { mcpServers: {...} }");
	}

	// —— imports: ["claude-code"] → 读 ~/.claude.json 合并(兼容读取) ——
	const imports = (parsed as { imports?: unknown }).imports;
	if (Array.isArray(imports) && imports.includes("claude-code")) {
		const claudeFile = claudeJsonPath ?? join(homedir(), ".claude.json");
		try {
			const claudeRaw = await readFile(claudeFile, "utf-8");
			const claude = JSON.parse(claudeRaw) as Record<string, unknown>;
			const m = claude.mcpServers;
			if (m && typeof m === "object" && !Array.isArray(m)) {
				for (const [name, entry] of Object.entries(m as Record<string, unknown>)) {
					// 本地已有同名 → 本地优先(与 Claude Code 合并语义一致)
					if (servers[name]) continue;
					const up = claudeEntryToUpstream(name, entry);
					if (up === null) continue;
					servers[name] = up;
				}
			}
		} catch {
			/* ~/.claude.json 不存在或损坏:跳过 imports,不阻塞 */
		}
		if (migrated) {
			warnings.push("imports 已展开为具体服务器条目(上游不认 imports),原键不再写回。");
		}
	}

	return { config: { mcpServers: servers }, migrated, warnings, errors };
}

/** 把上游形状序列化为文件文本(2 空格缩进,与项目其他 JSON 一致)。 */
export function serializeUpstreamConfig(config: { mcpServers: Record<string, UpstreamServer> }): string {
	return JSON.stringify(config, null, 2);
}

/** 文件层迁移结果。 */
export interface FileMigrationResult {
	/** 迁移后(或原本就是)上游形状的配置。 */
	config: { mcpServers: Record<string, UpstreamServer> };
	/** 是否实际改写了文件。 */
	wrote: boolean;
	/** 备份文件路径(仅在发生迁移时存在)。 */
	backupPath?: string;
	/** 告警(透传迁移层 + 落盘相关)。 */
	warnings: string[];
	/** 错误;非空时文件未被改动。 */
	errors: string[];
}

/**
 * 文件层迁移:读 mcp.json → 迁移 → (需要时)备份 + 原子改写。
 *
 * 幂等:已是上游形状则不写文件。失败(JSON 非法等)**不动原文件**,交调用方按空配置继续。
 * 迁移时先备份到 `<file>.bak-<ts>`,用户可手工回滚。
 *
 * @param agentDir  agent 配置目录(与 getMcpConfigPath 一致)
 * @param claudeJsonPath  兼容读取的 Claude 配置路径
 */
export async function migrateMcpConfigFile(agentDir: string, claudeJsonPath?: string): Promise<FileMigrationResult> {
	const file = join(agentDir, MCP_CONFIG_FILE);
	let raw = "";
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		/* 文件不存在 = 空配置 */
	}
	const result = await migrateMcpConfig(raw, claudeJsonPath);
	if (result.errors.length > 0) {
		return { config: result.config, wrote: false, warnings: result.warnings, errors: result.errors };
	}
	if (!result.migrated) {
		// 无需迁移(已是新形状,或文件本来就不存在)
		return { config: result.config, wrote: false, warnings: result.warnings, errors: [] };
	}
	// 备份原文件(存在才备份)
	let backupPath: string | undefined;
	if (raw.trim().length > 0) {
		backupPath = `${file}.bak-${Date.now()}`;
		await writeFile(backupPath, raw, "utf-8");
	}
	await atomicWriteFile(file, serializeUpstreamConfig(result.config));
	return { config: result.config, wrote: true, backupPath, warnings: result.warnings, errors: [] };
}
