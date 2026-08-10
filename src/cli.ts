#!/usr/bin/env node

/**
 * pi-writer CLI entry point.
 *
 * Wires a book/chapter session onto pi's InteractiveMode (or print mode) using
 * the pi-coding-agent SDK. Books, chapter sessions, auth, models, settings,
 * and skills all live under ~/.pi/writer (agent config in ~/.pi/writer/agent).
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "../vendor/pi-agent-core/src/index.ts";
import {
	createAgentSessionRuntime,
	InteractiveMode,
	type PrintModeOptions,
	runPrintMode,
	SessionManager,
} from "../vendor/pi-coding-agent/src/index.ts";
import { getAgentDir, getBookDir, getBooksDir, resolveSkillsDir, VERSION } from "./config.ts";
import { createSessionRuntimeFactory } from "./session-factory.ts";

import {
	addChapter,
	createBook,
	getBookSessionsDir,
	getChapterSessionsPath,
	initChapterFile,
	listBooks,
	loadBook,
	resolveChapter,
	setCurrentChapter,
} from "./book-manager.ts";
import { writerExtension } from "./extension.ts";
import { McpManager } from "./mcp/manager.ts";
import { buildWriterSystemPrompt } from "./prompt.ts";

interface CliOptions {
	book: string | undefined;
	newBookTitle: string | undefined;
	chapter: string | undefined;
	model: string | undefined;
	thinking: string | undefined;
	prompt: string | undefined;
	printMode: boolean;
	verbose: boolean;
	help: boolean;
	version: boolean;
	web: boolean;
	stage: boolean;
	/** `pi-writer web` 子命令的透传参数(原样收集,--port 9000 等),交给 parseWebArgs。 */
	webExtra: string[];
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		book: undefined,
		newBookTitle: undefined,
		chapter: undefined,
		model: undefined,
		thinking: undefined,
		prompt: undefined,
		printMode: false,
		verbose: false,
		help: false,
		version: false,
		web: false,
		stage: false,
		webExtra: [],
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
			case "--web":
				opts.web = true;
				break;
			case "--stage":
				opts.stage = true;
				break;
			case "--port": {
				// web 模式透传参数;非 web 模式下收集后忽略(不报错,简化处理)
				const value = next();
				opts.webExtra.push("--port", value);
				break;
			}
			case "--no-browser":
			case "--electron":
				opts.webExtra.push(arg);
				break;
			case "--book":
			case "-b": {
				const value = next();
				opts.book = value;
				opts.webExtra.push("--book", value);
				break;
			}
			case "--new-book":
			case "--title":
				opts.newBookTitle = next();
				break;
			case "--chapter":
				opts.chapter = next();
				break;
			case "--model":
			case "-m": {
				const value = next();
				opts.model = value;
				opts.webExtra.push("--model", value);
				break;
			}
			case "--thinking": {
				const value = next();
				opts.thinking = value;
				opts.webExtra.push("--thinking", value);
				break;
			}
			case "-p":
			case "--print":
				opts.printMode = true;
				opts.prompt = opts.prompt ?? (argv[i + 1] && !argv[i + 1].startsWith("-") ? next() : "");
				break;
			case "--verbose":
				opts.verbose = true;
				break;
			case "-c":
			case "--continue":
				// Default startup already continues the most recent book's current chapter.
				break;
			case "-v":
			case "--version":
				opts.version = true;
				break;
			case "-h":
			case "--help":
				opts.help = true;
				break;
			default:
				if (!opts.prompt && !arg.startsWith("-")) opts.prompt = arg;
				else if (opts.prompt) opts.prompt = `${opts.prompt} ${arg}`;
				else throw new Error(`Unknown option: ${arg}`);
		}
	}
	return opts;
}

const HELP = `pi-writer ${VERSION}
A creative writing agent built on the pi SDK.

Usage:
  pi-writer                              open last book's current chapter
  pi-writer --book <slug>                open a specific book (creates if absent)
  pi-writer --new-book "My Novel"        create and open a new book titled "My Novel"
  pi-writer --chapter <index|id|file>    open a specific chapter
  pi-writer -c                           continue the current chapter of the most recent book
  pi-writer --web [--port N] [--no-browser] [--electron]
                                         start a local HTTP server (GUI backend; browser optional)
  pi-writer --stage [--book <slug>]      stage mode: multi-agent co-performance demo (director/actors/writer)

Options:
  --model <pattern>                      model specifier (provider/id or pattern; --thinking <level>)
  --thinking <level>                      off | minimal | low | medium | high | xhigh | max
  -p, --print [prompt]                    non-interactive: write the prompt and exit
  --verbose                               force verbose startup
  -v, --version                           show version
  -h, --help                              show this help

Commands inside the TUI (writer-specific):
  /chapters                switch to a chapter in the current book
  /new-chapter [title]     add a new chapter to the current book
  /rename-chapter T [L]    rename or relabel the current chapter
  /rename-book T           rename the current book
  /world                   browse characters.md / world.md / timeline.md / outline.md
  /book                    switch to another book
  /edit [path]             open the built-in editor (default: current chapter draft; --vim for vim style)
`;

async function ensureBooksRoot(): Promise<void> {
	const booksDir = getBooksDir();
	if (!existsSync(booksDir)) await mkdir(booksDir, { recursive: true });
}

/**
 * 拉起 Electron 壳(`--electron`):定位 electron 可执行文件与主进程
 * dist/electron/main.cjs,spawn 后返回——服务与窗口生命周期由 Electron
 * 主进程自管(electron/main.ts 进程内起服务并开窗)。
 * - electron 可执行路径:`require("electron")` —— 非 electron 环境下该包
 *   导出可执行文件路径字符串;失败(未安装)则提示安装,不崩溃。
 * - main.cjs 双探测:优先 bun 单文件 exe 旁的 dist/electron/main.cjs;
 *   回退源码树(仓库根)dist/electron/main.cjs。
 * - main.cjs 不存在时仅打印提示(先运行 npm run build:web),不崩溃。
 */
async function launchElectronShell(): Promise<void> {
	let electronPath: string;
	try {
		const { createRequire } = await import("node:module");
		const resolved = createRequire(import.meta.url)("electron");
		if (typeof resolved !== "string" || resolved.length === 0) {
			throw new Error("electron 包未导出可执行文件路径");
		}
		electronPath = resolved;
	} catch (err) {
		process.stderr.write(
			`无法定位 electron 可执行文件(${err instanceof Error ? err.message : String(err)}),请先安装: npm install -D electron\n`,
		);
		return;
	}
	const exeMain = join(dirname(process.execPath), "dist", "electron", "main.cjs");
	const srcMain = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "electron", "main.cjs");
	const mainCjs = existsSync(exeMain) ? exeMain : existsSync(srcMain) ? srcMain : null;
	if (!mainCjs) {
		process.stderr.write("未找到 Electron 主进程 dist/electron/main.cjs,请先运行 npm run build:web 生成 Electron 主进程\n");
		return;
	}
	const { spawn } = await import("node:child_process");
	const child = spawn(electronPath, [mainCjs], { stdio: "inherit" });
	// Electron 启动失败(缺依赖/二进制损坏等)不应让本进程崩溃(与浏览器 spawn 同一处理模式)
	child.on("error", (err) => {
		process.stderr.write(`Electron 启动失败: ${err.message}\n`);
	});
	child.unref();
}

async function resolveInitialBook(opts: CliOptions): Promise<{ slug: string; title: string } | null> {
	if (opts.newBookTitle) {
		const book = await createBook(opts.newBookTitle);
		return { slug: book.slug, title: book.title };
	}
	if (opts.book) {
		const existing = await loadBook(opts.book);
		if (existing) return { slug: existing.slug, title: existing.title };
		// Create an untitled book with the slug as fallback title.
		const book = await createBook(opts.book);
		return { slug: book.slug, title: book.title };
	}
	const books = await listBooks();
	if (books.length === 0) {
		const book = await createBook("未命名");
		return { slug: book.slug, title: book.title };
	}
	return { slug: books[0].slug, title: books[0].title };
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	// The quit hint is rendered by pi-coding-agent with its own APP_NAME ("pi");
	// point it at pi-writer for the standalone binary.
	process.env.PI_WRITER_APP_NAME = "pi-writer";
	if (opts.help) {
		process.stdout.write(HELP);
		return;
	}
	if (opts.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (opts.stage) {
		// `pi-writer --stage`:舞台区共演 demo(导演/演员/编剧多 agent 编排),stdin 交互。
		const { runStageCli } = await import("./stage/cli.ts");
		await runStageCli({ slug: opts.book, model: opts.model, thinking: opts.thinking });
		return;
	}
	if (opts.web) {
		// `pi-writer web`:启动本地 HTTP 服务(GUI 后端),常驻;
		// 浏览器/Electron 窗口可选拉起,SIGINT 干净停止。
		const { parseWebArgs, startWebServer } = await import("./web.ts");
		const webOpts = parseWebArgs(opts.webExtra);
		if (webOpts.electron) {
			// --electron:拉起 Electron 壳。服务由 Electron 主进程进程内启动
			// (electron/main.ts 加载 dist/web/server.cjs 后自行监听 8811),本进程
			// 不再起服务,避免端口冲突;窗口生命周期由 Electron 自管。
			await launchElectronShell();
			process.on("SIGINT", () => process.exit(0));
			await new Promise(() => {}); // 常驻,等待 SIGINT
		} else {
			const { server, url } = await startWebServer(webOpts);
			process.stdout.write(`pi-writer web 已启动: ${url}\n`);
			if (!webOpts.noBrowser) {
				const { spawn } = await import("node:child_process");
				const child =
					process.platform === "win32"
						? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
						: spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
				// 打开失败(浏览器不存在等)不应让服务崩溃
				child.on("error", () => {
					process.stderr.write(`无法打开浏览器,请手动访问: ${url}\n`);
				});
				child.unref();
			}
			process.on("SIGINT", () => {
				void server.stop();
				process.exit(0);
			});
			await new Promise(() => {}); // 常驻
		}
	}
	await ensureBooksRoot();

	const initialBook = await resolveInitialBook(opts);
	if (!initialBook) {
		process.stdout.write(HELP);
		return;
	}

	const book = await loadBook(initialBook.slug);
	if (!book) throw new Error(`Book disappeared after creation: ${initialBook.slug}`);

	let chapterFile: string;
	if (opts.chapter) {
		const ch = resolveChapter(book, opts.chapter);
		if (!ch) throw new Error(`Chapter not found: ${opts.chapter}`);
		chapterFile = ch.file;
	} else if (book.currentChapterFile) {
		chapterFile = book.currentChapterFile;
	} else if (book.chapters[0]) {
		chapterFile = book.chapters[0].file;
	} else {
		const ch = await addChapter(book.slug, "第一章");
		chapterFile = ch.file;
	}

	const bookDir = getBookDir(book.slug);
	const sessionsDir = getBookSessionsDir(book.slug);
	const chapterAbsPath = getChapterSessionsPath(book.slug, chapterFile);
	if (!existsSync(bookDir)) await mkdir(bookDir, { recursive: true });
	await mkdir(sessionsDir, { recursive: true });
	await initChapterFile(chapterAbsPath, bookDir);
	await setCurrentChapter(book.slug, chapterFile);

	const agentDir = getAgentDir();
	const skillsDir = resolveSkillsDir();
	const initialSessionManager = SessionManager.open(chapterAbsPath, sessionsDir, bookDir);
	// MCP 服务器:与 web 模式共用 ~/.pi/writer/agent/mcp.json;启动时连接一次,
	// 工具经 customTools 注入(配置变更需重启 TUI 生效)
	const mcpManager = new McpManager(agentDir);
	await mcpManager.reload();

	const createRuntime = createSessionRuntimeFactory({
		agentDir,
		readOnlyDirs: [skillsDir],
		additionalSkillPaths: [skillsDir],
		// 系统提示动态生成:MCP 外部工具清单追加在文末,TUI 有 bash
		systemPromptOverride: () =>
			buildWriterSystemPrompt(
				mcpManager.getTools().map((t) => ({ name: t.name, description: t.description })),
				true,
			),
		extensionFactories: [writerExtension],
		model: opts.model,
		thinkingLevel: opts.thinking as ThinkingLevel | undefined,
		// 显式激活内置全量工具(不再用 tools 白名单——白名单会把 MCP customTools 滤掉,
		// 见 src/web.ts webExcludeTools 注释;word_count 等扩展工具自动激活)
		initialActiveToolNames: ["read", "bash", "write", "edit", "grep", "find", "ls"],
		customTools: mcpManager.getTools(),
	});

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: bookDir,
		agentDir,
		sessionManager: initialSessionManager,
	});

	// Surface any startup diagnostics briefly.
	for (const diag of runtime.diagnostics) {
		if (diag.type === "error") process.stderr.write(`${diag.message}\n`);
		else if (opts.verbose || diag.type === "warning") process.stderr.write(`${diag.message}\n`);
	}

	if (opts.printMode) {
		const printOptions: PrintModeOptions = {
			mode: "text",
			initialMessage: opts.prompt ?? "",
			initialImages: [],
			messages: [],
		};
		await runPrintMode(runtime, printOptions);
		await runtime.dispose();
		await mcpManager.close();
		return;
	}

	// Start on a clean screen: clear the terminal and its scrollback before
	// the interactive TUI takes over.
	process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

	const mode = new InteractiveMode(runtime, {
		migratedProviders: [],
		modelFallbackMessage: undefined,
		initialMessage: opts.prompt,
		initialImages: [],
		initialMessages: [],
		verbose: opts.verbose,
		// fullscreen(viewport)布局是 sidePanel 生效的前提:regular 模式只有纵向堆叠,无水平分栏。
		uiMode: "fullscreen",
	});
	await mode.run();
	await runtime.dispose();
	await mcpManager.close();
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`pi-writer: ${message}\n`);
	process.exit(1);
});
