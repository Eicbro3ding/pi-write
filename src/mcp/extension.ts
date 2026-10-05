/**
 * pi-writer 的 MCP 扩展 —— 装配上游 `createMcpExtension`(T9-A,B 方案)。
 *
 * ## 为什么需要这一层
 *
 * 上游自带内建 MCP 扩展(`builtin:mcp`),职责是「读 mcp.json → 连服务器 → 把工具
 * 注册成 `mcp__<server>__<tool>` → 注入 mcp_servers 提示词段」。我们**不重写它**,
 * 而是用它,只是要解决两个 pi-writer 特有的问题:
 *
 * ### 1. 配置目录必须是 `~/.pi/writer/agent`
 *
 * 上游默认 `getAgentDir()` 读环境变量 `PI_CODING_AGENT_DIR`,缺省 `~/.pi/agent`。
 * 而 pi-writer 的配置在 `~/.pi/writer/agent`(见 `src/config.ts` 的 `getAgentDir`)。
 * 解法:**在启动时把 `PI_CODING_AGENT_DIR` 指向自研 agentDir** —— 上游的默认
 * `loadConfig` 就自动读对文件,无需自定义钩子。
 *
 * ### 2. 内建扩展会与自研配置并存
 *
 * 上游把内建 MCP 标为 `replaceable: true`,让位条件是**注册同名命令/工具/flag**
 * (实读 `dist/core/resource-loader.js:67-107`)。上游内建 MCP 注册了 `/mcp` 命令,
 * 所以本扩展**也注册 `/mcp`**,触发让位:内建扩展整体不加载,由本扩展自己装配的
 * 上游扩展接手。这样:
 *   - 能力 100% 是上游的(同样的 createMcpExtension)
 *   - 配置目录由 `PI_CODING_AGENT_DIR` 决定(指向 pi-writer)
 *   - 终端里 `/mcp` 有真实的查看入口
 */

import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { McpHost } from "./host.ts";
import { migrateMcpConfigFile } from "./migrate.ts";

/** 上游读 agentDir 用的环境变量名(实读 config.js: ENV_AGENT_DIR)。 */
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * 把上游的 agentDir 指向 pi-writer 的目录。
 *
 * 幂等:已设置且非空时不覆盖(尊重用户/外层显式设置)。返回是否实际写入。
 */
export function pointUpstreamAtWriter(agentDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const current = env[ENV_AGENT_DIR];
	if (current !== undefined && current.trim().length > 0) return false;
	env[ENV_AGENT_DIR] = agentDir;
	return true;
}

export interface WriterMcpOptions {
	/** agent 配置目录(与 getAgentDir() 一致);mcp.json 就在其下。 */
	agentDir: string;
	/** 告警输出口(默认 stderr)。 */
	onWarning?: (message: string) => void;
}

/**
 * 创建 pi-writer 的 MCP 扩展工厂。
 *
 * 装配顺序(重要):
 * 1. 先把 agentDir 指向上游(必须在 `createMcpExtension` 的 loadConfig 被调用**之前**;
 *    它在 session_start 时才调用,所以工厂构造期设置即可)。
 * 2. 委托上游 `createMcpExtension()` 完成连接与工具注册。
 * 3. 注册 `/mcp` 命令:a) 触发 replaceable 让位;b) 给终端用户查看入口;
 *    并在命令里顺带暴露 `getAllTools()` 桥,供 web 侧反推工具数。
 */
export function createWriterMcpExtension(options: WriterMcpOptions): ExtensionFactory {
	const warn = options.onWarning ?? ((m: string) => process.stderr.write(`${m}\n`));
	// ① 指向 pi-writer 的 agent 目录(上游默认 loadConfig 会读 <agentDir>/mcp.json)
	pointUpstreamAtWriter(options.agentDir);
	// ② 上游扩展(真正干活的那个)
	const upstream = createMcpExtension();
	// 迁移触发标记:每个会话只迁一次(迁移本身幂等,这里只是省一次 IO)
	let migrated = false;

	return (pi: ExtensionAPI) => {
		// ③ 注册 /mcp 命令 → 让上游内建 MCP 让位 + 提供查看入口
		pi.registerCommand("mcp", {
			description: "查看 MCP 服务器状态(管理请到 web 设置页)",
			handler: async (_args, ctx) => {
				const host = new McpHost(options.agentDir);
				host.setToolLister(() => pi.getAllTools());
				await host.listConfig();
				const status = host.getStatus();
				if (status.length === 0) {
					ctx.ui.notify("未配置 MCP 服务器(可在 web 设置页添加)", "info");
					return;
				}
				const lines = status.map(
					(s) => `${s.ok ? "✓" : "·"} ${s.name} (${s.type}, ${s.tools} 个工具)${s.error ? ` — ${s.error}` : ""}`,
				);
				ctx.ui.notify(`MCP 服务器:\n${lines.join("\n")}`, "info");
			},
		});
		// 会话启动时做一次配置迁移(旧自研形状 → 上游形状)
		pi.on("session_start", async () => {
			if (migrated) return;
			migrated = true;
			const result = await migrateMcpConfigFile(options.agentDir);
			for (const w of result.warnings) warn(`[mcp] ${w}`);
			for (const e of result.errors) warn(`[mcp] 配置错误: ${e}`);
			if (result.wrote) {
				warn(`[mcp] 配置已迁移到上游 mcpServers 形状(备份:${result.backupPath ?? "无"})`);
			}
		});
		// ④ 委托上游:连接 + 工具注册 + mcp_servers 段注入
		return upstream(pi);
	};
}

/** 暴露给 web 侧的工具清单桥(由命令 handler 之外的路径获取时用)。 */
export function toolsOf(pi: ExtensionAPI): ReturnType<ExtensionAPI["getAllTools"]> {
	return pi.getAllTools();
}
