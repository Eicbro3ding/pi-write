/**
 * McpManager —— MCP 服务器连接的生命周期管理。
 *
 * 读取 mcp.json 配置 → 逐 server 连接(stdio/sse/http)→ 拉工具列表 →
 * 转成 pi 的 ToolDefinition 供 createRuntime 工厂注入(customTools)。
 * 单个服务器失败不阻塞其他(状态列表里记录错误,web 设置页展示);
 * reload() 先关闭旧连接再重连,配置变更后由 /api/mcp 端点触发。
 *
 * 容错:连接意外断开(stdio 子进程退出/远端断连)由 watchdog 自动重连,
 * 退避 3s 起、翻倍封顶 30s;重连成功后经 onReconnect 通知服务端重建会话
 * (工具快照更新)。主动 reload/close 通过 generation 计数阻止旧回调误重连。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "../../vendor/pi-coding-agent/src/index.ts";
import { VERSION } from "../config.ts";
import { loadMcpConfig, saveMcpConfig, type McpConfig, type McpServerConfig } from "./config.ts";
import { mcpToolToDefinition, type McpCallResult, type McpToolInfo } from "./tools.ts";

/** 连接与工具列表超时(ms):本地 stdio 快,远端 http/sse 可能慢。 */
const CONNECT_TIMEOUT_MS = 20_000;
/** watchdog 重连初始延迟(ms)。 */
const RETRY_BASE_DELAY_MS = 3_000;
/** watchdog 重连最大延迟(ms)。 */
const RETRY_MAX_DELAY_MS = 30_000;
/** 收集的 stderr 尾部上限(字符):启动失败时拼进错误信息,方便排查 npx 等。 */
const STDERR_TAIL_LIMIT = 4_000;

/** 单个 MCP 服务器的连接状态(供设置页展示成功/失败与工具数)。 */
export interface McpServerStatus {
	name: string;
	type: "stdio" | "sse" | "http";
	ok: boolean;
	tools: number;
	/** 连接失败时的中文错误(不包含工具名冲突等软告警)。 */
	error?: string;
}

interface McpConnection {
	config: McpServerConfig;
	client: Client;
	tools: ToolDefinition[];
	/** 关闭 client 与 transport;重复调用安全。 */
	close: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** 认证失败的常见特征(401/403 状态码或 SDK 的 OAuth 提示),追加可读说明。 */
function enrichAuthError(detail: string): string {
	if (/401|403|unauthorized|oauth|authorization required/i.test(detail)) {
		return `${detail}(该服务器需要授权/OAuth,当前版本暂不支持,请改用公开端点或本地 stdio)`;
	}
	return detail;
}

/**
 * 连接一个 MCP server 并返回 client + 工具定义列表;失败抛中文 Error。
 * armWatchdog 在连接就绪后立即注册意外断开回调(由 manager 提供,闭包持有
 * connection 引用,断开时调度自动重连)。
 */
async function connectServer(
	config: McpServerConfig,
	armWatchdog?: (conn: McpConnection) => void,
): Promise<McpConnection> {
	const client = new Client({ name: "pi-writer", version: VERSION });
	let transport;
	// stdio 的 stderr 收集:pipe 模式下 transport.stderr 是 Readable,启动失败时
	// 把尾部拼进错误信息(很多失败只有 stderr 里才看得到真正原因)
	let stderrTail = "";
	if (config.type === "stdio") {
		if (!config.command?.trim()) throw new Error("stdio 服务器缺少 command");
		transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			...(config.env ? { env: config.env } : {}),
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
		});
	} else if (config.type === "http") {
		if (!config.url?.trim()) throw new Error("http 服务器缺少 url");
		transport = new StreamableHTTPClientTransport(new URL(config.url));
	} else {
		if (!config.url?.trim()) throw new Error("sse 服务器缺少 url");
		transport = new SSEClientTransport(new URL(config.url));
	}
	try {
		await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
		const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
		const infos: McpToolInfo[] = (listed.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));
		const tools = infos.map((t) =>
			mcpToolToDefinition(t, async (args, signal) => {
				const r = await client.callTool({ name: t.name, arguments: args }, undefined, { signal });
				return { content: (r.content ?? []) as McpCallResult["content"], isError: r.isError === true, _meta: r._meta as McpCallResult["_meta"] };
			}),
		);
		const conn: McpConnection = {
			config,
			client,
			close: async () => {
				try {
					await client.close();
				} catch {
					/* 关闭失败(进程已退出等)忽略 */
				}
			},
			tools,
		};
		armWatchdog?.(conn);
		return conn;
	} catch (err) {
		// 连接/初始化失败:尽力关闭半开连接,避免残留子进程
		try {
			await client.close();
		} catch {
			/* ignore */
		}
		let detail = err instanceof Error ? err.message : String(err);
		detail = enrichAuthError(detail);
		const stderrNote = stderrTail.trim().length > 0 ? `\n标准错误: ${stderrTail.trim()}` : "";
		throw new Error(`连接失败: ${detail}${stderrNote}`);
	}
}

export class McpManager {
	private connections: McpConnection[] = [];
	private tools: ToolDefinition[] = [];
	private status: McpServerStatus[] = [];
	private closed = false;
	/** 世代计数:reload/close 递增,旧连接/旧重连循环看到世代不匹配即放弃。 */
	private generation = 0;
	/** watchdog 重连成功后的回调(服务端借此重建会话让新工具生效)。 */
	onReconnect?: (name: string) => void;

	constructor(private readonly agentDir: string) {}

	/** 配置所在目录(「直接编辑文件」端点读原始文本用)。 */
	getAgentDir(): string {
		return this.agentDir;
	}

	/** 当前可注入 agent 的工具定义。 */
	getTools(): ToolDefinition[] {
		return this.tools;
	}

	/** 当前各服务器连接状态。 */
	getStatus(): McpServerStatus[] {
		return this.status;
	}

	/** 当前配置(供设置页渲染列表)。 */
	async listConfig(): Promise<McpConfig> {
		return loadMcpConfig(this.agentDir);
	}

	/** 新增/更新服务器配置并重连;name 冲突(新增时)抛中文 Error。 */
	async upsertServer(server: McpServerConfig): Promise<McpConfig> {
		const config = await loadMcpConfig(this.agentDir);
		const idx = config.servers.findIndex((s) => s.name === server.name);
		if (idx === -1) {
			config.servers.push(server);
		} else {
			config.servers[idx] = server;
		}
		await saveMcpConfig(this.agentDir, config);
		await this.reload();
		return config;
	}

	/** 删除服务器配置并重连;不存在抛中文 Error。 */
	async removeServer(name: string): Promise<McpConfig> {
		const config = await loadMcpConfig(this.agentDir);
		const next = config.servers.filter((s) => s.name !== name);
		if (next.length === config.servers.length) throw new Error(`MCP 服务器不存在: ${name}`);
		await saveMcpConfig(this.agentDir, { servers: next });
		await this.reload();
		return { servers: next };
	}

	/** 按当前 connections 重建 tools 与 status(跨服务器工具重名:后者跳过,保持工具名唯一)。 */
	private rebuild(): void {
		const claimed = new Set<string>();
		const tools: ToolDefinition[] = [];
		const status: McpServerStatus[] = [];
		for (const conn of this.connections) {
			let skipped = 0;
			for (const tool of conn.tools) {
				if (claimed.has(tool.name)) {
					skipped++;
					continue;
				}
				claimed.add(tool.name);
				tools.push(tool);
			}
			status.push({ name: conn.config.name, type: conn.config.type, ok: true, tools: conn.tools.length - skipped });
		}
		this.tools = tools;
		this.status = status;
	}

	/** 注册 watchdog:连接意外断开时从连接表移除并调度重连(退避翻倍,封顶 30s)。 */
	private armWatchdog(conn: McpConnection, gen: number): void {
		conn.client.onclose = () => {
			if (this.closed || this.generation !== gen) return;
			this.connections = this.connections.filter((c) => c !== conn);
			this.rebuild();
			void this.reconnectLoop(conn.config, gen, RETRY_BASE_DELAY_MS);
		};
	}

	/** 重连循环:失败记入 status 并退避重试;成功恢复连接并通知服务端。 */
	private async reconnectLoop(config: McpServerConfig, gen: number, delayMs: number): Promise<void> {
		await sleep(delayMs);
		if (this.closed || this.generation !== gen) return;
		try {
			const conn = await connectServer(config, (c) => this.armWatchdog(c, gen));
			this.connections.push(conn);
			this.rebuild();
			this.onReconnect?.(config.name);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.status = [
				...this.status.filter((s) => s.name !== config.name),
				{ name: config.name, type: config.type, ok: false, tools: 0, error: `自动重连中(${delayMs / 1000}s 后再试): ${msg}` },
			];
			void this.reconnectLoop(config, gen, Math.min(delayMs * 2, RETRY_MAX_DELAY_MS));
		}
	}

	/** 关闭旧连接并重连(配置变更/服务启动时调用)。失败隔离:坏 server 记入 status,不中断其他。 */
	async reload(): Promise<void> {
		this.generation++;
		const gen = this.generation;
		await Promise.allSettled(this.connections.map((c) => c.close()));
		this.connections = [];
		this.tools = [];
		this.status = [];
		let config;
		try {
			config = await loadMcpConfig(this.agentDir);
		} catch (err) {
			this.status = [
				{
					name: "(配置)",
					type: "stdio",
					ok: false,
					tools: 0,
					error: err instanceof Error ? err.message : "mcp.json 读取失败",
				},
			];
			return;
		}
		if (config.servers.length === 0) return;
		for (const server of config.servers) {
			try {
				const conn = await connectServer(server, (c) => this.armWatchdog(c, gen));
				this.connections.push(conn);
			} catch (err) {
				this.status.push({
					name: server.name,
					type: server.type,
					ok: false,
					tools: 0,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		this.rebuild();
	}

	/** 关闭全部连接(服务停止时)。 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.generation++;
		await Promise.allSettled(this.connections.map((c) => c.close()));
		this.connections = [];
		this.tools = [];
	}
}
