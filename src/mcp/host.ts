/**
 * MCP 宿主适配层 —— 替代原自研 `McpManager`(T9-A,B 方案)。
 *
 * 背景:自研 `src/mcp/manager.ts`(399 行)自持连接与工具转换,改用上游
 * `createMcpExtension` 后,连接由 pi 扩展体系接管。但 web 侧仍需一个**查询/编辑
 * 配置**的入口(设置页列表、增删改、状态展示)。本文件就是这个薄适配层。
 *
 * 设计原则(见 PI_WRITER_T9A_MCP_REWRITE.md §8):
 * - **不依赖上游扩展私有状态** —— 上游把连接状态关在扩展闭包里,不导出。这里只用
 *   公开面:`loadMcpConfig` / `addMcpServerConfig` / `updateMcpServerConfig` /
 *   `removeMcpServerConfig`,以及运行时注入的 `getAllTools()` 反推工具数。
 * - **对外接口形状与原 McpManager 对齐** —— 让 server.ts 与前端改动最小。
 * - **文件读写走 mcp.json** —— 与上游同一份文件、同一形状(`mcpServers` 字典)。
 *
 * 状态保真度(已知下降):上游不暴露 `connecting/connected/needs-auth`,本适配器
 * 能给出的是「配置态 + 工具数」。约定:
 *   ok = enabled 且工具数 > 0;enabled 且 0 工具 = 连接中/失败。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "../atomic-write.ts";
import { migrateMcpConfig, migrateMcpConfigFile, serializeUpstreamConfig, type UpstreamServer } from "./migrate.ts";

/** 服务器在设置页的展示形状(与原自研 config.ts 的 McpServerConfig 对齐 + 上游新字段)。 */
export interface McpServerConfig {
	/** 显示名(唯一);同时作为工具命名空间。 */
	name: string;
	/** stdio:本地命令进程; http:streamable HTTP。 */
	type: "stdio" | "http";
	/** stdio 可执行命令。 */
	command?: string;
	/** stdio 命令行参数。 */
	args?: string[];
	/** stdio 环境变量。 */
	env?: Record<string, string>;
	/** http 端点 URL。 */
	url?: string;
	/** http 自定义请求头。 */
	headers?: Record<string, string>;
	/** 工具暴露策略(上游);缺省由上游按 codemode 处理。 */
	exposure?: "codemode" | "deferred" | "direct" | "hidden";
	/** 是否连接。 */
	enabled?: boolean;
	/** 一句话说明。 */
	description?: string;
}

/** 一个服务器的连接状态(与前端 McpServerStatus 对齐)。 */
export interface McpServerStatus {
	name: string;
	type: "stdio" | "http";
	ok: boolean;
	tools: number;
	error?: string;
}

/** 配置清单(与原自研 listConfig() 返回形状对齐)。 */
export interface McpConfigView {
	servers: McpServerConfig[];
}

/** 工具查询钩子:运行时注入 `pi.getAllTools()` 的等价物。 */
export type ToolLister = () => ToolInfo[];

/**
 * MCP 宿主适配器。
 *
 * 注:本类**不再持有任何连接**,只是「配置 + 状态视图」的读写门面。实际连接由上游
 * `createMcpExtension` 在会话内完成。
 */
export class McpHost {
	/** 运行时注入的工具清单(用于反推每个服务器的工具数)。 */
	private toolLister?: ToolLister;
	/** 最近一次 loadConfig 得到的服务器名 → 说明(供列表展示)。 */
	private lastErrors: string[] = [];

	constructor(private readonly agentDir: string) {}

	/** 配置目录(「直接编辑文件」端点读原始文本用)。 */
	getAgentDir(): string {
		return this.agentDir;
	}

	/** 注入工具清单钩子(web 侧在会话就绪后注入)。 */
	setToolLister(lister: ToolLister): void {
		this.toolLister = lister;
	}

	/** 当前配置(设置页渲染列表用)。 */
	async listConfig(): Promise<McpConfigView> {
		const loaded = await this.loadEntries();
		return { servers: loaded.map(({ name, config }) => upstreamToView(name, config)) };
	}

	/**
	 * 各服务器连接状态(配置态 + 工具数反推)。
	 *
	 * 注:本方法**同步**返回,因此用 `statusCache`(由 listConfig/upsert 等异步方法刷新)。
	 * 首次调用前若未刷新过,返回空数组;server.ts 的端点总是先 listConfig 再 getStatus。
	 */
	getStatus(): McpServerStatus[] {
		const tools = this.toolLister?.() ?? [];
		// namespace.name 形如 `mcp__<server>`(上游 mcpNamespace:非 [A-Za-z0-9_] 转 _)
		const counts = new Map<string, number>();
		for (const tool of tools) {
			const ns = tool.namespace?.name;
			if (!ns || !ns.startsWith("mcp__")) continue;
			const server = ns.slice("mcp__".length);
			counts.set(server, (counts.get(server) ?? 0) + 1);
		}
		return this.statusCache.map((entry) => {
			const count = counts.get(sanitizeNamespace(entry.name)) ?? 0;
			return {
				name: entry.name,
				type: entry.type,
				ok: entry.enabled !== false && count > 0,
				tools: count,
				...(entry.enabled === false ? { error: "已禁用" } : {}),
			};
		});
	}

	/** 上次加载的错误(供 /api/mcp 返回诊断)。 */
	getErrors(): string[] {
		return this.lastErrors;
	}

	/** 新增或更新一个服务器。mode="create" 时重名报错(与原 manager 语义一致)。 */
	async upsertServer(server: McpServerConfig, mode: "create" | "update"): Promise<void> {
		// 读-改-写在同一处完成,避免并发丢失更新(与原 manager 的写队列等价:Node 单线程
		// 下 await 之间可能交错,但本方法内部只有一次 await,足够) 
		const { config } = await migrateMcpConfig(await this.readRaw());
		const exists = config.mcpServers[server.name] !== undefined;
		if (mode === "create" && exists) throw new Error(`MCP 服务器已存在: ${server.name}`);
		if (mode === "update" && !exists) throw new Error(`MCP 服务器不存在: ${server.name}`);
		config.mcpServers[server.name] = viewToUpstream(server);
		await atomicWriteFile(this.configPath(), serializeUpstreamConfig(config));
	}

	/** 删除一个服务器。 */
	async removeServer(name: string): Promise<void> {
		const { config } = await migrateMcpConfig(await this.readRaw());
		if (config.mcpServers[name] === undefined) throw new Error(`MCP 服务器不存在: ${name}`);
		delete config.mcpServers[name];
		await atomicWriteFile(this.configPath(), serializeUpstreamConfig(config));
	}

	/**
	 * 原样保存 mcp.json 文本(「直接编辑文件」入口)。
	 * 校验:JSON 合法 + 迁移层能解析出配置。非法抛中文 Error。
	 */
	async saveRawConfig(rawText: string): Promise<void> {
		const trimmed = rawText.trim();
		if (trimmed.length === 0) {
			await atomicWriteFile(this.configPath(), JSON.stringify({ mcpServers: {} }, null, 2));
			return;
		}
		try {
			JSON.parse(trimmed);
		} catch {
			throw new Error("不是合法 JSON,请检查括号与引号");
		}
		// 用迁移层试解析:非法形状会带 errors
		const { errors } = await migrateMcpConfig(trimmed);
		if (errors.length > 0) throw new Error(errors.join("; "));
		await atomicWriteFile(this.configPath(), trimmed);
	}

	/**
	 * 启动时调用:把旧的自研形状配置迁移到上游形状。
	 * 返回告警/错误(由调用方打 stderr),不抛异常。
	 */
	async ensureMigrated(): Promise<{ warnings: string[]; errors: string[] }> {
		const result = await migrateMcpConfigFile(this.agentDir);
		return { warnings: result.warnings, errors: result.errors };
	}

	// —— 内部 ——

	/** 当前配置里的服务器清单(含 enabled 状态缓存,供 getStatus 用)。 */
	private statusCache: Array<{ name: string; type: "stdio" | "http"; enabled?: boolean }> = [];

	private configPath(): string {
		return join(this.agentDir, "mcp.json");
	}

	/** 读 mcp.json 原始文本(不存在返回空串)。 */
	private async readRaw(): Promise<string> {
		try {
			return await readFile(this.configPath(), "utf-8");
		} catch {
			return "";
		}
	}

	/** 读上游形状配置(读不到时按空),并刷新状态缓存。 */
	private async loadEntries(): Promise<Array<{ name: string; config: UpstreamServer }>> {
		const { config, errors } = await migrateMcpConfig(await this.readRaw());
		this.lastErrors = errors;
		const entries = Object.entries(config.mcpServers).map(([name, cfg]) => ({ name, config: cfg }));
		this.statusCache = entries.map((e) => ({
			name: e.name,
			type: e.config.type === "http" ? "http" : "stdio",
			enabled: e.config.enabled,
		}));
		return entries;
	}
}

/** 上游 namespace 化:非 [A-Za-z0-9_] 转 `_`(与上游 mcpNamespace 一致)。 */
function sanitizeNamespace(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** 上游条目 → 前端展示形状。 */
function upstreamToView(name: string, cfg: UpstreamServer): McpServerConfig {
	const view: McpServerConfig = { name, type: cfg.type === "http" ? "http" : "stdio" };
	if (cfg.command !== undefined) view.command = cfg.command;
	if (cfg.args !== undefined) view.args = cfg.args;
	if (cfg.env !== undefined) view.env = cfg.env;
	if (cfg.url !== undefined) view.url = cfg.url;
	if (cfg.headers !== undefined) view.headers = cfg.headers;
	if (cfg.exposure !== undefined) view.exposure = cfg.exposure;
	if (cfg.enabled !== undefined) view.enabled = cfg.enabled;
	if (cfg.description !== undefined) view.description = cfg.description;
	return view;
}

/** 前端形状 → 上游条目。 */
function viewToUpstream(view: McpServerConfig): UpstreamServer {
	const cfg: UpstreamServer = { type: view.type };
	if (view.command !== undefined) cfg.command = view.command;
	if (view.args !== undefined) cfg.args = view.args;
	if (view.env !== undefined) cfg.env = view.env;
	if (view.url !== undefined) cfg.url = view.url;
	if (view.headers !== undefined) cfg.headers = view.headers;
	cfg.exposure = view.exposure ?? "direct";
	if (view.enabled !== undefined) cfg.enabled = view.enabled;
	if (view.description !== undefined) cfg.description = view.description;
	return cfg;
}
