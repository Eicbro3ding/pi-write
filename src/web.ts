/**
 * `pi-writer web` 子命令:解析 web 参数、解析/创建书与章节、装配
 * SessionHost + WriterServer,常驻本地 HTTP 服务(127.0.0.1:<port>)。
 *
 * 浏览器/Electron 拉起由 cli.ts 决定(--no-browser 只起服务;--electron
 * 本模块仅透传标志,实际拉起在 Task 9)。会话装配与 cli.ts 共用
 * session-factory(createSessionRuntimeFactory),本模块只声明 web 差异项
 * (web 工具子集、无 bash 的系统提示)。
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { applyCacheRetention, getAgentDir, getBookDir, getBooksDir, resolveSkillReadOnlyDirs } from "./config.ts";
import { createAskUserTool } from "./ask-user.ts";
import {
	addChapter,
	createBook,
	getBookSessionsDir,
	getChapterSessionsPath,
	initChapterFile,
	listBooks,
	loadBook,
	setCurrentChapter,
} from "./book-manager.ts";
import { writerExtension } from "./extension.ts";
import { McpHost } from "./mcp/host.ts";
import { createWriterMcpExtension } from "./mcp/extension.ts";
import { loadPlugins } from "./plugin-loader.ts";
import { createSessionRuntimeFactory } from "./session-factory.ts";
// 2026-10-04(T6/T7):vendor 接入收口到 pi-adapter。`openSession` 打开会话文件
// 并直接产出句柄(SessionHost 的契约就是句柄);`ThinkingLevel` 是会话设置类型。
import { openSession, type ThinkingLevel } from "./pi-adapter/index.ts";
import { buildWriterSystemPrompt } from "./prompt.ts";
import { readWriterSettings } from "./writer-settings.ts";
import { resolveWriterShell } from "./shell-kind.ts";
import { WriterServer } from "./web/server.ts";
import { SessionHost } from "./web/session-host.ts";
import { StageHost } from "./web/stage-host.ts";
import { WriterHost } from "./web/writer-host.ts";

/** `pi-writer web` 子命令的解析结果。 */
export interface WebCliOptions {
	port: number; // 监听端口,默认 8811
	noBrowser: boolean; // --no-browser:只起服务不拉起浏览器
	electron: boolean; // --electron:额外拉起 Electron 窗口(Task 9 接线)
	book: string | undefined; // --book <slug>:打开指定书(不存在则创建)
	model: string | undefined; // --model <pattern>:模型指定
	thinking: string | undefined; // --thinking <level>:思考等级
	cacheRetention: string | undefined; // --cache-retention <short|long|none>:提示词缓存保留档位
	/**
	 * 前端静态目录(web/dist)显式路径。缺省时服务端按 resolveWebDistDir 探测
	 * (exe 旁 / import.meta.url 烘焙路径)——CI 构建的产物在用户机器上探测会
	 * 落空,Electron 壳必须显式传 asar 内路径。
	 */
	webDistDir?: string;
}

/**
 * web 模式禁用的内置工具(黑名单)。注意不能像旧实现那样用 `tools` 白名单
 * 收窄工具集:白名单会把 MCP customTools 一并滤掉(它们不在名单里),导致
 * MCP 工具连不上会话——这是 2026-08-08 查出的根因。改用 excludeTools 只禁
 * bash(无 bash 的 web 子集语义),MCP 工具自然放行。
 */
/**
 * web 模式禁用的工具(黑名单)。
 *
 * `bash` 默认禁用——web 没有终端可看,历史上也一直按"只给文件工具"约束。
 * 现在可由设置项 `enableShell`(设置页「外部命令」)显式放开:那时它不再进黑名单,
 * 并在 webActiveTools 里被激活。放开后命令以服务进程权限运行,路径守卫对它无效,
 * 所以必须配合"命令与输出实时可见"(见前端 tool_execution_update 归约)。
 */
export function webExcludeTools(env: Record<string, string | undefined>, opts: { shell?: boolean } = {}): string[] {
	const excluded = opts.shell ? [] : ["bash"];
	if (env.PI_WRITER_NO_SPAWN_TOOLS) excluded.push("grep", "find");
	return excluded;
}

/**
 * web 模式初始激活的内置工具(不含扩展/MCP 工具——它们经 includeAllExtensionTools
 * 自动激活)。PI_WRITER_NO_SPAWN_TOOLS 时 grep/find 一并剔除;
 * opts.shell 为真时追加 bash(顺序保证既有调用方/断言不受影响)。
 */
export function webActiveTools(env: Record<string, string | undefined>, opts: { shell?: boolean } = {}): string[] {
	const builtin = ["read", "write", "edit", "grep", "find", "ls"];
	const filtered = env.PI_WRITER_NO_SPAWN_TOOLS ? builtin.filter((t) => t !== "grep" && t !== "find") : builtin;
	return opts.shell ? [...filtered, "bash"] : filtered;
}

/** 解析 `pi-writer web` 的子参数;未知选项或非法端口抛错。 */
export function parseWebArgs(argv: string[]): WebCliOptions {
	const opts: WebCliOptions = {
		port: 8811,
		noBrowser: false,
		electron: false,
		book: undefined,
		model: undefined,
		thinking: undefined,
		cacheRetention: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`Missing value for ${arg}`);
			i++;
			return v;
		};
		switch (arg) {
			case "--port": {
				const v = Number(next());
				if (!Number.isInteger(v) || v <= 0 || v > 65535) throw new Error(`Invalid port: ${argv[i]}`);
				opts.port = v;
				break;
			}
			case "--no-browser":
				opts.noBrowser = true;
				break;
			case "--electron":
				opts.electron = true;
				break;
			case "--book":
				opts.book = next();
				break;
			case "--model":
				opts.model = next();
				break;
			case "--thinking":
				opts.thinking = next();
				break;
			case "--cache-retention":
				opts.cacheRetention = next();
				applyCacheRetention(opts.cacheRetention);
				break;
			default:
				throw new Error(`Unknown web option: ${arg}`);
		}
	}
	return opts;
}

/** 定位 skills 目录:统一收敛在 config.resolveSkillsDir(env 可注入供测试)。 */
export { resolveSkillsDir as resolveSkillsDirWithEnv } from "./config.ts";

/**
 * 解析要打开的书与章节(逻辑同 cli.ts main() 的 resolveInitialBook):
 * opts.book 有值则 loadBook,不存在则 createBook(opts.book);
 * 无 opts.book 时 listBooks() 取最新一本,列表为空则 createBook("未命名");
 * 章节取 book.currentChapterFile ?? chapters[0] ?? addChapter(book.slug, "第一章")。
 */
async function resolveInitialBook(
	opts: WebCliOptions,
): Promise<{ slug: string; chapterFile: string }> {
	let slug: string;
	if (opts.book) {
		const existing = await loadBook(opts.book);
		if (existing) {
			slug = existing.slug;
		} else {
			// 以 slug 作为书名的兜底创建(与 cli.ts 一致)
			const book = await createBook(opts.book);
			slug = book.slug;
		}
	} else {
		const books = await listBooks();
		if (books.length === 0) {
			const book = await createBook("未命名");
			slug = book.slug;
		} else {
			slug = books[0]!.slug; // listBooks 按 updatedAt 倒序,最新在前
		}
	}
	const book = await loadBook(slug);
	if (!book) throw new Error(`Book disappeared after creation: ${slug}`);
	let chapterFile: string;
	if (book.currentChapterFile) {
		chapterFile = book.currentChapterFile;
	} else if (book.chapters[0]) {
		chapterFile = book.chapters[0]!.file;
	} else {
		const ch = await addChapter(book.slug, "第一章");
		chapterFile = ch.file;
	}
	return { slug, chapterFile };
}

/**
 * 启动 web 模式:解析书/章节 → 初始化会话文件与 book.json →
 * 装配 SessionHost(createRuntime 照抄 cli.ts)→ WriterServer 监听
 * 127.0.0.1:<port>。返回 server 句柄(调用方负责 SIGINT 停止)与访问 URL。
 */
export async function startWebServer(opts: WebCliOptions): Promise<{
	server: WriterServer;
	url: string;
	port: number;
}> {
	// books 根目录(web 分支在 cli.ts main() 的 ensureBooksRoot 之前接管,这里自行确保)
	const booksDir = getBooksDir();
	if (!existsSync(booksDir)) await mkdir(booksDir, { recursive: true });

	const { slug, chapterFile } = await resolveInitialBook(opts);

	const bookDir = getBookDir(slug);
	const sessionsDir = getBookSessionsDir(slug);
	const chapterAbsPath = getChapterSessionsPath(slug, chapterFile);
	if (!existsSync(bookDir)) await mkdir(bookDir, { recursive: true });
	await mkdir(sessionsDir, { recursive: true });
	await initChapterFile(chapterAbsPath, bookDir);
	await setCurrentChapter(slug, chapterFile);

	const agentDir = getAgentDir();
	// 服务端全局设置(经典模式 / 外部命令 / shell 方言):必须在装配 createRuntime
	// 之前读——工具集与系统提示(有没有 shell、哪种方言)都在这里定下来,
	// 晚读会让开关"下次重启才生效"
	const writerSettings = await readWriterSettings();
	const shellEnabled = writerSettings.enableShell;
	// 方言解析(见 shell-kind.ts):选 pwsh 但本机没装 → dialect none,按"无 shell"装配,
	// 提示词不会宣称有 shell(否则模型会去调一个必然报错的工具)
	const resolvedShell = resolveWriterShell(writerSettings);
	const shellOn = shellEnabled && resolvedShell.dialect !== "none";
	if (shellEnabled && resolvedShell.warning) process.stderr.write(`${resolvedShell.warning}\n`);
	const sessionManager = openSession(chapterAbsPath, sessionsDir, bookDir);
	// MCP(T9-A):改用上游 createMcpExtension,工具经 `mcp__<server>__<tool>` 直接进
	// 模型工具声明(exposure=direct)。McpHost 只是「配置 + 状态视图」的门面,
	// 供 /api/mcp 端点读改写;连接本身由上游扩展在会话内完成。
	const mcpHost = new McpHost(agentDir);
	// 迁移告警必须打出来:SSE 降级与「字段不完整已跳过」都是用户**看不见就查不出来**的
	// 静默失败(旧条目留在文件里也不会报错,只是永远不生效)。
	{
		const { warnings, errors } = await mcpHost.ensureMigrated();
		for (const w of warnings) process.stderr.write(`[mcp] ${w}\n`);
		for (const e of errors) process.stderr.write(`[mcp] 配置错误: ${e}\n`);
	}

	// 外部插件:扫描 ~/.pi/writer/plugins/<id>/ → jiti 动态 import 启用插件 →
	// 工厂并入 extensionFactories(单个插件失败隔离,error 经 /api/plugins 展示)
	const pluginLoad = await loadPlugins();
	const { factories: pluginFactories } = pluginLoad;

	// createRuntime 工厂:与 cli.ts 共用 session-factory 的装配(隐藏 skill
	// 命令;工具集为 web 子集;--model/--thinking 解析),只声明 web 差异项。
	const createRuntime = createSessionRuntimeFactory({
		agentDir,
		// 技能目录(自带 skills/ + 全局技能目录)由 session-factory 统一并入,调用方不必再传
		// 系统提示必须动态生成:静态字符串会覆盖 pi 的动态工具段。
		// MCP 工具清单不再手工拼 —— 上游 mcp_servers 段/工具声明自动处理(见 prompt.ts 注释)
		systemPromptOverride: () => buildWriterSystemPrompt([], shellOn ? resolvedShell.dialect : "none"),
		extensionFactories: [writerExtension, createWriterMcpExtension({ agentDir })],
		pluginFactories,
		model: opts.model,
		thinkingLevel: opts.thinking as ThinkingLevel | undefined,
		// shell 方言:path 有值(pwsh/自定义)则写进 vendor settings;null = 清空让 vendor
		// 走 bash 探测链(设置里从 pwsh 切回 bash 时必须清,否则提示词说 bash、实际跑 pwsh)
		shellPath: resolvedShell.path ?? null,
		// 黑名单禁 bash(web 子集;设置里放开「外部命令」后不再禁),显式激活内置工具;
		// 白名单会滤掉扩展工具(MCP 工具经扩展注册,不走 customTools)
		excludeTools: webExcludeTools(process.env, { shell: shellOn }),
		initialActiveToolNames: webActiveTools(process.env, { shell: shellOn }),
		// 主会话同样能用提问卡片(闸门是进程级单例,与编剧会话共用一张 pending 表)。
		// MCP 工具已改走上游扩展,不再进 customTools。
		customTools: [createAskUserTool()],
	});

	const host = new SessionHost({
		// 2026-10-04(T7 批 2):`createSessionRuntimeFactory` 现在**自己返回句柄**,
		// 调用点不再需要 toFactoryHandle 包装(重复包装已被 adapter 的幂等处理,
		// 但去掉更直白)。`openSession` 直接产出句柄,也不再需要 toHandle。
		createRuntime,
		cwd: bookDir,
		agentDir,
		sessionManager,
		toolGuard: { readOnlyDirs: resolveSkillReadOnlyDirs() },
	});
	await host.start();
	// 常驻编剧宿主:每本书一个 writer 会话,惰性创建;model/thinking 同 stage
	// (writer 端点未装配时由 server 侧 404,与 MCP/stage 同款)。
	// 设置(经典模式 / 外部命令 / 对话与章节的关系)在启动时读一次,之后切换走 PUT /api/settings。
	const writerHost = new WriterHost({
		model: opts.model,
		thinkingLevel: opts.thinking,
		// MCP 工具不再经此注入(T9-A):上游扩展已把 `mcp__<server>__<tool>` 注册进
		// 会话工具声明,宿主提示词无需再手工复述。保留参数形状(可选),传空数组。
		getMcpTools: () => [],
		classicMode: writerSettings.classicMode,
		// 对话与章节的关系(缺省 chapter = 一段对话绑一章);启动时读一次,
		// 之后切换走 PUT /api/settings → setConversationScope
		conversationScope: writerSettings.conversationScope,
		enableShell: shellEnabled,
		// shell 方言(选 pwsh 时实际执行 PowerShell,提示词按方言叙述);解析不到则按无 shell
		shellDialect: shellOn ? resolvedShell.dialect : "none",
		shellPath: resolvedShell.path ?? null,
		// 图片生成(实验,0.1.0):启动时读一次;之后切换走 PUT /api/settings → setImageGen
		enableImageGen: writerSettings.enableImageGen,
	});
	// 舞台区宿主:每本书每个章节一个编排器,惰性创建;model/thinking 复用 web 的 CLI 选项
	// (stage 端点未装配时由 server 侧 404,与 MCP 同款);writerHost 注入用于收幕委托
	// (常驻编剧 === 收幕编剧,2026-08-11)。getMcpTools 同 writerHost:上游扩展已接管工具注册。
	const stageHost = new StageHost({ model: opts.model, thinkingLevel: opts.thinking, writerHost, getMcpTools: () => [] });
	// PI_WRITER_TOKEN:可选 Bearer token(Android 壳注入);未设置时与桌面版行为完全一致
	const server = new WriterServer({
		host: "127.0.0.1",
		port: opts.port,
		sessionHost: host,
		authToken: process.env.PI_WRITER_TOKEN,
		mcpHost,
		stageHost,
		writerHost,
		// Electron 壳显式传 asar 内前端目录;缺省探测(烘焙路径)在 CI 产物上会落空
		...(opts.webDistDir ? { webDistDir: opts.webDistDir } : {}),
	});
	// 插件装载态(错误/声明/命令注册表/trusted 路由)交给 server,GET /api/plugins 合并展示
	server.setPluginInfos(pluginLoad.infos, pluginLoad.webCommands, pluginLoad.routes);
	const { port } = await server.start();
	return { server, url: `http://127.0.0.1:${port}`, port };
}

/**
 * 直接执行产物(`node dist/web/server.cjs`)时的入口:解析参数 → 起服 →
 * 打印 URL → 常驻,SIGINT 干净停止。逻辑与 cli.ts 的 web 分支一致。
 */
async function runMain(): Promise<void> {
	const opts = parseWebArgs(process.argv.slice(2));
	const { server, url } = await startWebServer(opts);
	process.stdout.write(`pi-writer web 已启动: ${url}\n`);
	process.on("SIGINT", () => {
		void server.stop().then(() => process.exit(0));
	});
	await new Promise(() => {}); // 常驻,等待 SIGINT
}

// 仅当本文件被直接执行时自动起服:esbuild 打 CJS(require.main === module)与
// bun 编译(把 import.meta.main 烘焙为 require.main === module)行为一致;
// tsx 等纯 ESM 运行时下 require/module 未定义,同样跳过——入口守卫对
// 三种形态(cli.ts 导入 / electron 导入 / node 直跑产物)行为一致。
const isDirectRun =
	typeof require !== "undefined" &&
	typeof module !== "undefined" &&
	(require as NodeJS.Require).main === module;
if (isDirectRun) {
	void runMain().catch((err) => {
		process.stderr.write(`启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}
