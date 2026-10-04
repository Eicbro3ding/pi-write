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
import type { ToolDefinition } from "../pi-adapter/index.ts";
import { VERSION } from "../config.ts";
import { WriteQueue } from "../write-queue.ts";
import { loadMcpConfig, saveMcpConfig, saveRawMcpConfig, type McpConfig, type McpServerConfig } from "./config.ts";
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
	/** 配置序(连接表中的原始位置):watchdog 重连后按此原位插回,保工具序稳定。 */
	slot?: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * 按 slot(断开前的配置序)把重连的连接原位插回连接表:找第一个 slot 更大的
 * 连接插到它前面;没有更大的(或本连接无 slot)追加尾部。
 * 纯函数(只依赖元素的 slot 字段)便于单测覆盖多台同时断线、乱序重连的组合。
 */
export function insertConnectionBySlot<T extends { slot?: number }>(connections: T[], conn: T): void {
	const at = conn.slot === undefined ? -1 : connections.findIndex((c) => (c.slot ?? Number.MAX_SAFE_INTEGER) > conn.slot!);
	if (at >= 0) connections.splice(at, 0, conn);
	else connections.push(conn);
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
	/**
	 * mcp.json 读-改-写串行队列(2026-10 审计 BUG-020):并发新增/编辑/删除/raw 保存
	 * 若各自基于旧快照写回,后完成的那份会覆盖先完成的服务器变更。锁内重新读最新文件。
	 */
	private readonly configQueue = new WriteQueue();
	/** reload 自身的串行链(2026-10 审计 RISK-005):两次 reload 交错会让旧代连接写进新代状态。 */
	private reloadChain: Promise<void> = Promise.resolve();
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

	/**
	 * mcp.json 的**唯一读-改-写入口**(BUG-020):锁内重新读取最新文件 → 变更 →
	 * 校验并原子写 → reload。四步在同一个队列任务里,因此并发请求不会互相覆盖,
	 * reload 读到的也必然是刚写下的那份配置。
	 *
	 * 注意:reload 走的是另一条 `reloadChain`,不会与本次的 configQueue 互锁。
	 */
	private async mutateConfig<T>(mutate: (config: McpConfig) => T | Promise<T>): Promise<T> {
		return this.configQueue.run("mcp-config", async () => {
			const config = await loadMcpConfig(this.agentDir);
			const value = await mutate(config);
			await saveMcpConfig(this.agentDir, config);
			await this.reload();
			return value;
		});
	}

	/**
	 * 新增/更新服务器配置并重连。
	 *
	 * `mode` 把「重名/不存在」的判定挪进队列内(BUG-020 的 TOCTOU:此前路由先 listConfig
	 * 检查再 upsert,两个并发新增同名服务器都能通过检查):
	 * - `create`:name 已存在 → 抛中文 Error(路由映射 400)
	 * - `update`:name 不存在 → 抛中文 Error(路由映射 404)
	 * - 缺省 `any`:存在则覆盖,不存在则追加
	 */
	async upsertServer(server: McpServerConfig, mode: "create" | "update" | "any" = "any"): Promise<McpConfig> {
		return this.mutateConfig((config) => {
			const idx = config.servers.findIndex((s) => s.name === server.name);
			if (mode === "create" && idx !== -1) throw new Error(`MCP 服务器重名: ${server.name}`);
			if (mode === "update" && idx === -1) throw new Error(`MCP 服务器不存在: ${server.name}`);
			if (idx === -1) config.servers.push(server);
			else config.servers[idx] = server;
			return config;
		});
	}

	/** 删除服务器配置并重连;不存在抛中文 Error。判定同样在队列内。 */
	async removeServer(name: string): Promise<McpConfig> {
		return this.mutateConfig((config) => {
			const next = config.servers.filter((s) => s.name !== name);
			if (next.length === config.servers.length) throw new Error(`MCP 服务器不存在: ${name}`);
			config.servers = next;
			return config;
		});
	}

	/**
	 * 原样保存 mcp.json 原始文本(「直接编辑文件」入口)并重连。
	 * 与 upsert/remove 共用同一写队列:并发保存不会互相覆盖,也不会与结构化编辑交错。
	 */
	async saveRawConfig(rawText: string): Promise<McpConfig> {
		return this.configQueue.run("mcp-config", async () => {
			await saveRawMcpConfig(this.agentDir, rawText);
			await this.reload();
			return loadMcpConfig(this.agentDir);
		});
	}

	/**
	 * 按当前 connections 重建 tools 与 status(跨服务器工具重名:后者跳过,保持工具名唯一)。
	 *
	 * 2026-10:重建时**保留连接失败的条目**。此前这里是 `this.status = status`(只由
	 * connections 生成),把 reload 循环里刚 push 的失败原因整片擦掉 —— 「坏 server
	 * 记入 status」实际上永远看不到,设置页只会看到一台服务器凭空消失。重连成功后
	 * 该名字已在 connections 中,失败条目自然被丢弃(按 name 去重,不产生重复行)。
	 */
	private rebuild(): void {
		const claimed = new Set<string>();
		const tools: ToolDefinition[] = [];
		const status: McpServerStatus[] = [];
		const connected = new Set<string>();
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
			connected.add(conn.config.name);
			status.push({ name: conn.config.name, type: conn.config.type, ok: true, tools: conn.tools.length - skipped });
		}
		for (const s of this.status) {
			if (!s.ok && !connected.has(s.name)) status.push(s);
		}
		this.tools = tools;
		this.status = status;
	}

	/** 注册 watchdog:连接意外断开时从连接表移除并调度重连(退避翻倍,封顶 30s)。
	 *  断开时记录原下标(slot),重连后按 slot 原位插回——工具定义序列化进
	 *  prompt 前缀,顺序漂移(旧实现 push 到尾部)会让全会话提示词缓存失效,
	 *  且跨服务器重名工具的「后者跳过」归属会翻转。 */
	private armWatchdog(conn: McpConnection, gen: number): void {
		conn.client.onclose = () => {
			if (this.closed || this.generation !== gen) return;
			const idx = this.connections.indexOf(conn);
			if (idx >= 0) conn.slot = idx;
			this.connections = this.connections.filter((c) => c !== conn);
			this.rebuild();
			void this.reconnectLoop(conn.config, gen, RETRY_BASE_DELAY_MS);
		};
	}

	/** 重连循环:失败记入 status 并退避重试;成功恢复连接并通知服务端。
	 *  按 conn.slot 原位插回(insertConnectionBySlot)——数组里可能已有其他
	 *  重连回来的连接,直接用下标 splice 会破坏相对顺序。 */
	private async reconnectLoop(config: McpServerConfig, gen: number, delayMs: number): Promise<void> {
		await sleep(delayMs);
		if (this.closed || this.generation !== gen) return;
		try {
			const conn = await connectServer(config, (c) => this.armWatchdog(c, gen));
			insertConnectionBySlot(this.connections, conn);
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

	/**
	 * 关闭旧连接并重连(配置变更/服务启动时调用)。失败隔离:坏 server 记入 status,不中断其他。
	 *
	 * 2026-10 审计 RISK-005:reload 自身必须串行 + 每段 await 后检查世代,否则两次 reload
	 * 交错时旧调用会在新调用清空/建立连接之后继续写 `connections/tools/status`,最终状态
	 * 可能属于旧配置。这里排成一条链(不与 configQueue 互锁),并在关闭、读配置、
	 * 逐个连接前后都做世代检查;`close()` 之后迟到的结果一律丢弃。
	 */
	async reload(): Promise<void> {
		const run = this.reloadChain.then(
			() => this.reloadOnce(),
			() => this.reloadOnce(),
		);
		this.reloadChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async reloadOnce(): Promise<void> {
		if (this.closed) return;
		const gen = ++this.generation;
		/** 世代已过期(有更新的 reload 或已 close):本调用不得再写任何共享状态。 */
		const stale = () => this.closed || this.generation !== gen;
		await Promise.allSettled(this.connections.map((c) => c.close()));
		if (stale()) return;
		this.connections = [];
		this.tools = [];
		this.status = [];
		let config;
		try {
			config = await loadMcpConfig(this.agentDir);
		} catch (err) {
			if (stale()) return;
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
		if (stale()) return;
		if (config.servers.length === 0) return;
		for (const server of config.servers) {
			try {
				const conn = await connectServer(server, (c) => this.armWatchdog(c, gen));
				// 连接期间世代变了(新的 reload 或 close):丢弃刚建立的连接,不写进连接表
				if (stale()) {
					await conn.close();
					return;
				}
				conn.slot = this.connections.length;
				this.connections.push(conn);
			} catch (err) {
				if (stale()) return;
				this.status.push({
					name: server.name,
					type: server.type,
					ok: false,
					tools: 0,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (stale()) return;
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
