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
import type { ThinkingLevel } from "../vendor/pi-agent-core/src/index.ts";
import { SessionManager } from "../vendor/pi-coding-agent/src/index.ts";
import { getAgentDir, getBookDir, getBooksDir, resolveSkillsDir } from "./config.ts";
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
import { McpManager } from "./mcp/manager.ts";
import { createSessionRuntimeFactory } from "./session-factory.ts";
import { buildWriterSystemPrompt } from "./prompt.ts";
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
	temperature: number | undefined; // --temperature <number>:采样温度
	topP: number | undefined; // --top-p <number>:核采样概率
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
export function webExcludeTools(env: Record<string, string | undefined>): string[] {
	const excluded = ["bash"];
	if (env.PI_WRITER_NO_SPAWN_TOOLS) excluded.push("grep", "find");
	return excluded;
}

/**
 * web 模式初始激活的内置工具(不含扩展/MCP 工具——它们经 includeAllExtensionTools
 * 自动激活)。PI_WRITER_NO_SPAWN_TOOLS 时 grep/find 一并剔除。
 */
export function webActiveTools(env: Record<string, string | undefined>): string[] {
	const builtin = ["read", "write", "edit", "grep", "find", "ls"];
	if (env.PI_WRITER_NO_SPAWN_TOOLS) return builtin.filter((t) => t !== "grep" && t !== "find");
	return builtin;
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
		temperature: undefined,
		topP: undefined,
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
			case "--temperature": {
				const v = Number(next());
				if (Number.isNaN(v)) throw new Error(`Invalid temperature: ${argv[i]}`);
				opts.temperature = v;
				break;
			}
			case "--top-p": {
				const v = Number(next());
				if (Number.isNaN(v)) throw new Error(`Invalid top-p: ${argv[i]}`);
				opts.topP = v;
				break;
			}
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
	const skillsDir = resolveSkillsDir();
	const sessionManager = SessionManager.open(chapterAbsPath, sessionsDir, bookDir);
	// MCP 服务器:读 mcp.json → 连接各 server → 工具定义注入 createRuntime 的
	// customTools(单个 server 失败隔离,状态经 /api/mcp 展示;配置变更后由
	// server 端点触发 reload + 会话重建,新工具随之生效)
	const mcpManager = new McpManager(agentDir);
	await mcpManager.reload();

	// createRuntime 工厂:与 cli.ts 共用 session-factory 的装配(隐藏 skill
	// 命令;工具集为 web 子集;--model/--thinking 解析),只声明 web 差异项。
	const createRuntime = createSessionRuntimeFactory({
		agentDir,
		readOnlyDirs: [skillsDir],
		additionalSkillPaths: [skillsDir],
		// 系统提示必须动态生成:静态字符串会覆盖 pi 的动态工具段,
		// MCP 外部工具对 agent 不可见(2026-08-08 根因)
		systemPromptOverride: () =>
			buildWriterSystemPrompt(
				mcpManager.getTools().map((t) => ({ name: t.name, description: t.description })),
				false,
			),
		extensionFactories: [writerExtension],
		model: opts.model,
		thinkingLevel: opts.thinking as ThinkingLevel | undefined,
		temperature: opts.temperature,
		topP: opts.topP,
		// 黑名单禁 bash(web 子集),显式激活内置工具;白名单会滤掉 MCP customTools
		excludeTools: webExcludeTools(process.env),
		initialActiveToolNames: webActiveTools(process.env),
		// MCP 工具(经 customTools 注册;配置为空时是空数组,行为与之前一致)
		customTools: mcpManager.getTools(),
	});

	const host = new SessionHost({
		createRuntime,
		cwd: bookDir,
		agentDir,
		sessionManager,
		toolGuard: { readOnlyDirs: [skillsDir] },
	});
	await host.start();
	// 常驻编剧宿主:每本书一个 writer 会话,惰性创建;model/thinking 同 stage
	// (writer 端点未装配时由 server 侧 404,与 MCP/stage 同款)
	const writerHost = new WriterHost({ model: opts.model, thinkingLevel: opts.thinking, temperature: opts.temperature, topP: opts.topP, getMcpTools: () => mcpManager.getTools() });
	// 舞台区宿主:每本书每个章节一个编排器,惰性创建;model/thinking 复用 web 的 CLI 选项
	// (stage 端点未装配时由 server 侧 404,与 MCP 同款);writerHost 注入用于收幕委托
	// (常驻编剧 === 收幕编剧,2026-08-11)
	const stageHost = new StageHost({ model: opts.model, thinkingLevel: opts.thinking, temperature: opts.temperature, topP: opts.topP, writerHost, getMcpTools: () => mcpManager.getTools() });
	// PI_WRITER_TOKEN:可选 Bearer token(Android 壳注入);未设置时与桌面版行为完全一致
	const server = new WriterServer({
		host: "127.0.0.1",
		port: opts.port,
		sessionHost: host,
		authToken: process.env.PI_WRITER_TOKEN,
		mcpManager,
		stageHost,
		writerHost,
		// Electron 壳显式传 asar 内前端目录;缺省探测(烘焙路径)在 CI 产物上会落空
		...(opts.webDistDir ? { webDistDir: opts.webDistDir } : {}),
	});
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
