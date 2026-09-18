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
 * notes、世界书)。工具限定为文件读写加 word_count;是否提供 shell 由运行环境与
 * 设置决定(web 默认无、TUI 有;方言见 shell-kind.ts)。
 *
 * 工具清单是**动态**的:writer-main.md 里的「你拥有的工具」是基础工具;MCP
 * 挂载的外部工具由 buildWriterSystemPrompt 追加在文末(名称+描述),shell 方言
 * 按运行环境注入。
 */

import { loadPromptText } from "./prompts.ts";
import type { ShellDialect } from "./shell-kind.ts";

/** 主会话系统提示(外置 prompts/writer-main.md;含 {SHELL_LINE} 占位)。 */
export const WRITER_SYSTEM_PROMPT: string = loadPromptText("writer-main.md");

/** buildWriterSystemPrompt 的输入:外部工具(名称+单行描述)。 */
export interface WriterPromptTool {
	name: string;
	description: string;
}

/**
 * 按方言叙述 shell 工具。注意 vendor 里工具名**始终叫 `bash`**(参数 schema 与
 * 描述都是 bash 口径),方言不同时必须在这里点明,否则模型会写 bash 语法直接报错。
 *
 * pwsh 的两条关键差异(详见 shell-kind.ts 模块注释):
 * - 语法/路径:PowerShell cmdlet 与原生路径,不是 bash 的 `$VAR`/heredoc;
 * - 退出码:`pwsh -Command` 的退出码会被折算,要真实退出码须自己 `exit $LASTEXITCODE`。
 */
const SHELL_LINES: Record<ShellDialect, string> = {
	none: "你**没有** \\`bash\\`/shell 与浏览器工具;需要 shell 能力时告诉用户,建议他们自己运行。",
	bash: "你可以使用 \\`bash\\`(工作目录为书目录);浏览器与联网能力仍需经外部工具挂载。",
	pwsh: "你可以使用 \\`bash\\` 工具执行命令——本机它由 **PowerShell 7(pwsh)** 执行:请写 PowerShell 语法与原生路径(如 `Get-ChildItem`、`$env:NAME`、`C:\\...`),不要用 bash 的 `$VAR`/heredoc;要拿真实退出码请在命令末尾加 `exit $LASTEXITCODE`(否则原生程序的退出码会被折算)。工作目录为书目录。",
	powershell: "你可以使用 \\`bash\\` 工具执行命令——本机它由 **Windows PowerShell 5.1** 执行:请写 PowerShell 语法与原生路径(如 `Get-ChildItem`、`$env:NAME`、`C:\\...`),且 **不支持 `&&`/`||`**(多条命令用 `;` 或分次调用);不要用 bash 的 `$VAR`/heredoc。工作目录为书目录。",
};

/**
 * 取某个方言下的 shell 说明行。编剧/导演等固定角色提示词没有占位符,由调用方
 * 自行追加这一行(否则角色拿着 shell 工具却不知道它是什么方言)。
 */
export function writerShellLine(shell: ShellDialect): string {
	return SHELL_LINES[shell];
}

/**
 * 组装最终系统提示:基础提示(WRITER_SYSTEM_PROMPT,含 {SHELL_LINE} 占位)
 * + 按运行环境注入 shell 行 + 文末追加外部工具(MCP)清单。
 */
export function buildWriterSystemPrompt(customTools: WriterPromptTool[], shell: ShellDialect): string {
	const shellLine = writerShellLine(shell);
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
