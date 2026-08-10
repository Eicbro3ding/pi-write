/**
 * Electron 主进程:进程内启动本地 web 服务,窗口加载服务页面。
 *
 * 阶段 1 无 IPC:渲染进程只访问 http://127.0.0.1:<port>(contextIsolation
 * 开启、nodeIntegration 关闭),主进程仅负责起服务、开窗、外链转交系统
 * 浏览器、窗口关闭时停服退出。
 */

import { app, BrowserWindow, dialog, shell } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WebCliOptions } from "../src/web.ts";

/** 备用端口列表:按序尝试;被 pi-writer 残留实例占用时杀掉后重试该端口,否则换下一个。 */
const PORTS = [8811, 8812, 8813, 8814];

/**
 * 查端口占用进程 PID(Windows netstat / 其他平台 lsof);查不到返回 null。
 * 端口监听地址按 127.0.0.1 匹配(服务只绑回环)。
 */
function pidOnPort(port: number): number | null {
	try {
		if (process.platform === "win32") {
			const out = execFileSync("netstat", ["-ano"], { encoding: "utf-8" });
			for (const line of out.split(/\r?\n/)) {
				const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
				if (m && Number(m[1]) === port) return Number(m[2]);
			}
			return null;
		}
		const pid = Number.parseInt(execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf-8" }).trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** 占用进程是否属于 pi-writer 生态(残留实例,可安全杀);其他程序占用则跳过该端口。 */
function isPiWriterProcess(pid: number): boolean {
	try {
		const name =
			process.platform === "win32"
				? (execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf-8" })
						.split(",")[0]
						?.replaceAll('"', "")
						.toLowerCase() ?? "")
				: execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf-8" }).trim().toLowerCase();
		return ["node", "electron", "pi-writer", "tsx"].some((k) => name.includes(k));
	} catch {
		return false;
	}
}

/** 强杀残留实例(失败静默,调用方换下一端口)。 */
function killPid(pid: number): void {
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
		} else {
			process.kill(pid, "SIGKILL");
		}
	} catch {
		/* 杀不掉则跳过该端口 */
	}
}

/** 服务端打包产物(dist/web/server.cjs,Task 10 bun 单文件)的运行时形态。 */
interface WebServerBundle {
	startWebServer(opts: WebCliOptions): Promise<{
		server: { stop(): Promise<void> };
		url: string;
		port: number;
	}>;
}

/**
 * import() 产物的实际形态:命名导出不可靠,导出可能只挂在 default 上
 * (bun CJS 产物经 cjs-module-lexer 静态分析识别不出命名导出)。
 */
type LoadedServerModule = Partial<WebServerBundle> & { default?: Partial<WebServerBundle> };

/** 当前运行中的服务句柄(窗口关闭/启动失败时停服)。 */
let runningServer: { stop(): Promise<void> } | undefined;

/**
 * 解析 preload 脚本绝对路径。注意:不能依赖 __dirname/import.meta.url——
 * bun 会把它们烘焙成源码目录(electron/)的常量,而运行时脚本在
 * dist/electron/。按两种启动布局探测:
 * - `electron .`/打包后:appPath 为应用根,preload 位于 dist/electron/ 下;
 * - `electron dist/electron/main.cjs`(Task 10 冒烟):appPath 即 dist/electron,preload 同目录。
 */
function resolvePreloadPath(): string {
	const appPath = app.getAppPath();
	const candidates = [join(appPath, "dist/electron", "preload.js"), join(appPath, "preload.js")];
	return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * 动态加载服务端打包产物;相对路径按 main.cjs 所在目录(dist/electron)解析。
 *
 * 产物是 bun 打的 CJS 单文件(module.exports 整体挂出):Node 的 import()
 * 对 `module.exports = __toCommonJS(...)` 这种打包器包装无法静态识别命名
 * 导出(cjs-module-lexer 局限),因此统一从 default(即 module.exports)取,
 * 同时保留命名导出兜底(产物形态变化时仍可工作)。
 */
async function loadServerBundle(): Promise<WebServerBundle> {
	// 用变量拼动态 import:bun 与 tsc 均不做静态模块解析,因此开发期产物
	// 尚不存在(dist/web/server.cjs 由 Task 10 产出)时编译与类型检查也不
	// 报错;运行时才按相对路径加载。main.cjs 位于 dist/electron/,产物在
	// dist/web/,故相对 specifier 为 ../web/server.cjs(dev 冒烟见 Task 10 Step 3)。
	const specifier = "../web/server.cjs";
	const mod = (await import(specifier)) as LoadedServerModule;
	const bundle = mod.startWebServer ? mod : mod.default;
	if (!bundle?.startWebServer) {
		throw new Error(`服务端产物缺少 startWebServer 导出: ${specifier}`);
	}
	return bundle as WebServerBundle;
}

async function createWindow(url: string): Promise<void> {
	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		backgroundColor: "#1e1a15",
		// 写作工具用不到 Electron 默认菜单(File/Edit/View…):平时隐藏,
		// 按 Alt 可临时唤出(保留开发者工具的菜单快捷键)
		autoHideMenuBar: true,
		// 项目图标(exe 图标由 electron-builder 从 ico.png 生成;窗口/任务栏图标
		// 打包后从 asar 内读取,dev 下 appPath 即仓库根)
		icon: join(app.getAppPath(), "ico.png"),
		webPreferences: {
			preload: resolvePreloadPath(),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	// 外链(如模型服务商登录页)一律转交系统浏览器,不在应用内新开窗口
	win.webContents.setWindowOpenHandler(({ url: u }) => {
		void shell.openExternal(u);
		return { action: "deny" };
	});
	await win.loadURL(url);
	// 窗口关闭 → 停本地服务 → 退出应用
	win.on("closed", () => {
		const server = runningServer;
		runningServer = undefined;
		void server?.stop().catch(() => undefined);
		app.quit();
	});
}

async function main(): Promise<void> {
	try {
		const { startWebServer } = await loadServerBundle();
		const base: Omit<WebCliOptions, "port"> = {
			noBrowser: true,
			electron: true,
			book: undefined,
			model: undefined,
			thinking: undefined,
			// 显式传 asar 内前端目录(web/dist 打进 asar;resolveWebDistDir 的
			// import.meta.url 烘焙路径只对构建机有效,CI 产物在用户机器上会 404)
			webDistDir: join(app.getAppPath(), "web", "dist"),
		};
		// 备用端口:按序尝试;EADDRINUSE 且占用者是 pi-writer 残留实例 → 杀掉重试,
		// 否则换下一端口(不误杀其他程序)
		let url: string | undefined;
		let server: { stop(): Promise<void> } | undefined;
		for (const port of PORTS) {
			try {
				({ url, server } = await startWebServer({ ...base, port }));
				break;
			} catch (err) {
				const isAddrInUse =
					err instanceof Error && (err.message.includes("EADDRINUSE") || err.message.includes("address already in use"));
				if (!isAddrInUse) throw err;
				const pid = pidOnPort(port);
				if (pid !== null && isPiWriterProcess(pid)) {
					killPid(pid);
					try {
						({ url, server } = await startWebServer({ ...base, port }));
						break;
					} catch {
						/* 杀后仍失败:换下一端口 */
					}
				}
			}
		}
		if (!url || !server) throw new Error(`端口 ${PORTS.join("/")} 均不可用,请检查占用进程`);
		runningServer = server;
		await createWindow(url);
	} catch (err) {
		// 兜底:清理已启动的服务,弹错误框后退出
		const server = runningServer;
		runningServer = undefined;
		if (server) void server.stop().catch(() => undefined);
		dialog.showErrorBox("pi-writer 启动失败", err instanceof Error ? err.message : String(err));
		app.quit();
	}
}

app.whenReady().then(() => void main());
// 所有窗口关闭即退出(阶段 1 桌面应用无托盘等常驻需求)
app.on("window-all-closed", () => app.quit());
