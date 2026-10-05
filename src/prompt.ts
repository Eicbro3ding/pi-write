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
 *
 * **对话范围**也是装配期变量(2026-10-03):`conversationScope` 决定「会话/正文
 * 是否绑在一章上」,提示词里对应的句子全部走 `{KEY}` 占位,由 SCOPE_VARS 按范围
 * 渲染 —— 两份提示词都不许再写死绑定口径(见 SCOPE_VARS 注释)。
 */

import { loadPromptText, renderPrompt } from "./prompts.ts";
import type { ShellDialect } from "./shell-kind.ts";
import type { ConversationScope } from "./writer-settings.ts";

/** 主会话系统提示(外置 prompts/writer-main.md;含 {SHELL_LINE} 与对话范围占位)。 */
export const WRITER_SYSTEM_PROMPT: string = loadPromptText("writer-main.md");

/** 常驻编剧系统提示(外置 prompts/writer-editor.md;含对话范围占位)。 */
export const EDITOR_SYSTEM_PROMPT: string = loadPromptText("writer-editor.md");

/**
 * 「对话与章节的关系」(conversationScope)在两份提示词里的叙述 —— **唯一实现**。
 *
 * 值域与 `src/writer-settings.ts` 的 `ConversationScope` 同源。两份提示词各取自己
 * 用到的键(写在 prompts 文件里的 `{KEY}` 占位处),渲染时未提供的键原样保留。
 *
 * 为什么要有这张表:对话与章节解耦(2026-10-03)之后,提示词此前仍无条件写着
 * 「每个会话对应书的一章」「正文固定由当前章节决定」——分离模式下模型据此自我收窄,
 * 用户让它改别的章节时它会把活推回去;编剧提示词里那句「写其他路径会被工具拒绝」
 * 更是与事实相反(分离模式下正文白名单根本不设,见 writerDraftFile)。
 *
 * ⚠️ chapter 一列的句子取自**改动前的原话**,`SCOPE_SECTION` 还是空串 —— 写作 agent
 * (writer-main)在绑定章节下的系统提示因此与解耦前**逐字节一致**(test/prompt.test.ts
 * 钉住),等于不动默认模式的模型行为;编剧那份只多一条「对话范围」说明,正文路径规则
 * 的语义相同(writer-editor.md 原文被 `{EDITOR_SCOPE_LINE}` / `{EDITOR_DRAFT_RULE}`
 * 拆成两句)。
 */
const SCOPE_VARS: Record<ConversationScope, Record<string, string>> = {
	chapter: {
		// writer-main.md:「# 对话范围」整节 —— 绑定章节时**整段消失**(默认模式的
		// 提示词必须与解耦前逐字节一致,所以这里给空串而不是一段同义说明)
		SCOPE_SECTION: "",
		SESSION_SCOPE_LINE: "每个 pi-writer *会话*对应书的一章。",
		DRAFT_MIRROR_LINE: "草稿面板只镜像当前会话对应的草稿文件",
		// writer-editor.md:首条范围说明 + 正文路径规则
		EDITOR_SCOPE_LINE: "这段对话绑定当前章节(章节侧栏即切换器),「当前正文」就是这一章。",
		EDITOR_DRAFT_RULE:
			"由当前章节决定——文件不存在时用 write 创建该路径,不得自创其他文件名,也不要在 draft/ 目录写别的文件(写其他路径会被工具拒绝);",
	},
	book: {
		SCOPE_SECTION:
			"# 对话范围\n\n" +
			"**对话与章节分离**:这段对话**不隶属于任何章节**——对话可自由新建、切换、删除,切章节不切对话;正文也不锁在一章,用户随时可以让你改任意一章。\n" +
			"下文说「当前章节 / 本章」时,一律指**用户此刻正在看的那一章**(以上下文里【当前正文 · …】标注的路径为准)。他还没打开任何章节时,先问他要写哪一章(或新建一章),不要自己挑一章下手。\n",
		SESSION_SCOPE_LINE: "这段对话与章节相互独立:它不是某一章的附属,也不靠切换章节来切换话题(对话列表才是切换器)。",
		DRAFT_MIRROR_LINE: "草稿面板镜像的是用户此刻在看的那一章的草稿文件,不是这段对话",
		EDITOR_SCOPE_LINE: "这段对话不与章节绑定——对话与章节各聊各的,用户可以让你改任意一章,「当前正文」标的是他此刻正在看的那一章。",
		EDITOR_DRAFT_RULE:
			"由用户要你改的那一章决定(上下文里【当前正文 · …】标出的就是他在看的那一章)——文件不存在时用 write 创建该路径,不得自创其他文件名,也不要在 draft/ 目录写别的文件;",
	},
};

/** 按对话范围渲染占位(未提供的键原样保留,见 renderPrompt)。 */
function renderScoped(template: string, scope: ConversationScope, extra: Record<string, string> = {}): string {
	return renderPrompt(template, { ...SCOPE_VARS[scope], ...extra });
}

/** buildWriterSystemPrompt 的输入:外部工具(名称+单行描述)。 */
export interface WriterPromptTool {
	name: string;
	description: string;
}

/**
 * 按方言叙述 shell 工具。
 *
 * 三条要点:
 * 1. **工具名在 vendor 里始终叫 `bash`**(参数 schema 与描述都是 bash 口径),
 *    方言不同时必须在这里点明,否则模型会写 bash 语法直接报错。
 * 2. **拿到 shell 就拿到了整台机器,必须如实说清**(2026-09-20)。此前这里只写
 *    「工作目录为书目录」并把联网说成「仍需经外部工具挂载」——与事实相反:
 *    shell 以 pi-writer 服务进程的用户身份运行,能访问网络、执行任意程序与代码、
 *    读写书目录之外的路径(`installToolPathGuard` 管不到它,见 docs/security.md)。
 *    模型不知道自己的能力范围就会绕远路(该联网时说自己没这能力、该跑脚本时纯手算)。
 * 3. pwsh 的两条关键差异(详见 shell-kind.ts 模块注释):
 *    - 语法/路径:PowerShell cmdlet 与原生路径,不是 bash 的 `$VAR`/heredoc;
 *    - 退出码:`pwsh -Command` 的退出码会被折算,要真实退出码须自己 `exit $LASTEXITCODE`。
 */
const SHELL_LINES: Record<ShellDialect, string> = {
	none: "你**没有** `bash`/shell 与浏览器工具;需要 shell 能力时告诉用户,建议他们自己运行。",
	bash: "你可以使用 `bash` 执行命令。**这是整台机器的权限,不只是书目录**:它以 pi-writer 服务进程的用户身份运行,可以访问网络(下载文件、调用 API、查询资料)、执行任意代码与程序(python/node/编译器/本机 CLI 工具)、读写书目录之外的路径。既然用户已在设置里显式开启它,该用就用——需要联网查证或跑脚本时不要绕路。涉及删除、覆盖、对外发送这类不可逆动作时先说一句。默认工作目录为书目录。",
	pwsh: "你可以使用 `bash` 工具执行命令——本机它由 **PowerShell 7(pwsh)** 执行:请写 PowerShell 语法与原生路径(如 `Get-ChildItem`、`$env:NAME`、`C:\\...`),不要用 bash 的 `$VAR`/heredoc;要拿真实退出码请在命令末尾加 `exit $LASTEXITCODE`(否则原生程序的退出码会被折算)。**这是整台机器的权限,不只是书目录**:可以访问网络、执行任意代码与程序、读写书目录之外的路径。默认工作目录为书目录。",
	powershell: "你可以使用 `bash` 工具执行命令——本机它由 **Windows PowerShell 5.1** 执行:请写 PowerShell 语法与原生路径(如 `Get-ChildItem`、`$env:NAME`、`C:\\...`),且 **不支持 `&&`/`||`**(多条命令用 `;` 或分次调用);不要用 bash 的 `$VAR`/heredoc。**这是整台机器的权限,不只是书目录**:可以访问网络、执行任意代码与程序、读写书目录之外的路径。默认工作目录为书目录。",
};

/**
 * 取某个方言下的 shell 说明行。编剧/导演等固定角色提示词没有占位符,由调用方
 * 自行追加这一行(否则角色拿着 shell 工具却不知道它是什么方言)。
 */
export function writerShellLine(shell: ShellDialect): string {
	return SHELL_LINES[shell];
}

/**
 * 组装最终系统提示:基础提示(WRITER_SYSTEM_PROMPT,含 {SHELL_LINE} 与对话范围
 * 占位)+ 按运行环境注入 shell 行 + 按对话范围渲染绑定口径。
 *
 * ## 关于 MCP 工具清单(T9-A,2026-10-05)
 *
 * 本函数**不再拼接 MCP 外部工具清单**。改用上游 `createMcpExtension` 后:
 * - 迁移默认给每个服务器写 `exposure: "direct"`,`mcp__<server>__<tool>` 直接进
 *   模型工具声明(含 name/description/schema),**无需**在提示词里复述一遍;
 * - 若用户显式改用 `codemode`/`deferred`,上游经 `before_agent_start` 把
 *   `mcp_servers` 段注入对话(`sections`,`agent-session.js:1272`),同样不经过本函数。
 *
 * 首参 `customTools` 保留(签名稳定,调用方传 `[]`)以兼容既有测试与 `writer-host`
 * 的调用形状;它现在只用于「非 MCP 的额外工具说明」这一潜在场景。
 *
 * `scope` 缺省 `"chapter"`:TUI 与「绑定章节」模式必须拿到与解耦前逐字一致的
 * 提示词;只有分离模式(web 的自由对话)才换成不绑章节的叙述。
 */
export function buildWriterSystemPrompt(customTools: WriterPromptTool[], shell: ShellDialect, scope: ConversationScope = "chapter"): string {
	const base = renderScoped(WRITER_SYSTEM_PROMPT, scope, { SHELL_LINE: writerShellLine(shell) });
	if (customTools.length === 0) return base;
	const toolLines = customTools
		.map((t) => {
			const desc = t.description.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
			return `- \`${t.name}\` — ${desc}`;
		})
		.join("\n");
	return `${base}\n\n# 外部工具\n\n以下工具可直接调用(遵守同样的先读再写/失败静默重试纪律):\n${toolLines}`;
}

/**
 * 常驻编剧系统提示(EDITOR_SYSTEM_PROMPT)按对话范围渲染。
 *
 * 编剧在两种范围下都可能出现:绑定章节时正文白名单锁在当前章;分离模式下白名单
 * 不设、可改任意章 —— 提示词必须跟着变,否则那句「写其他路径会被工具拒绝」在分离
 * 模式下就是一句与事实相反的假约束。shell 行由调用方另追加(见 writer-host)。
 */
export function buildEditorSystemPrompt(scope: ConversationScope = "chapter"): string {
	return renderScoped(EDITOR_SYSTEM_PROMPT, scope);
}
