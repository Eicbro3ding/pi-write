/**
 * 写作 agent 系统提示词装配。
 *
 * 提示词本体已外置到 prompts/writer-main.md(2026-08-12)——独立文件管理,
 * 代码只负责装配(占位替换 + 动态工具清单)。装配方(cli.ts/web.ts)用
 * systemPromptOverride 时必须以 buildWriterSystemPrompt 生成,否则外部工具
 * 对 agent 不可见——这是 2026-08-08 查出的根因:静态 override 会整个替换
 * pi 自动生成的动态工具段。
 *
 * 把 assistant 定位为创意写作伙伴,以书目录为工作区(outline、章节草稿、
 * notes、世界书)。工具限定为文件读写加 word_count;刻意不提供 `bash`。
 *
 * 工具清单是**动态**的:writer-main.md 里的「你拥有的工具」是基础工具;MCP
 * 挂载的外部工具由 buildWriterSystemPrompt 追加在文末(名称+描述),bash 有无
 * 按运行环境注入(web 无、TUI 有)。
 */

import { loadPromptText } from "./prompts.ts";

/** 主会话系统提示(外置 prompts/writer-main.md;含 {SHELL_LINE} 占位)。 */
export const WRITER_SYSTEM_PROMPT: string = loadPromptText("writer-main.md");

/** buildWriterSystemPrompt 的输入:外部工具(名称+单行描述)与是否有 bash。 */
export interface WriterPromptTool {
	name: string;
	description: string;
}

/**
 * 组装最终系统提示:基础提示(WRITER_SYSTEM_PROMPT,含 {SHELL_LINE} 占位)
 * + 按环境注入 bash 行 + 文末追加外部工具(MCP)清单。
 */
export function buildWriterSystemPrompt(customTools: WriterPromptTool[], hasBash: boolean): string {
	const shellLine = hasBash
		? "你可以使用 \\`bash\\`(工作目录为书目录);浏览器与联网能力仍需经外部工具挂载。"
		: "你**没有** \\`bash\\`/shell 与浏览器工具;需要 shell 能力时告诉用户,建议他们自己运行。";
	const base = WRITER_SYSTEM_PROMPT.replace("{SHELL_LINE}", shellLine);
	if (customTools.length === 0) return base;
	const toolLines = customTools
		.map((t) => {
			const desc = t.description.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
			return `- \`${t.name}\` — ${desc}`;
		})
		.join("\n");
	return `${base}\n\n# 外部工具(MCP)\n\n以下工具由 MCP 服务器提供,可直接调用(遵守同样的先读再写/失败静默重试纪律):\n${toolLines}`;
}
