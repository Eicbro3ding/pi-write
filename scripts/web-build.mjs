#!/usr/bin/env node
/**
 * web 模式全量打包脚本(GUI 后端 + Electron 壳 + 前端):
 *
 * ① esbuild 打包服务端 src/web.ts → dist/web/server.cjs(单文件 CJS,含全部
 *    vendor 依赖,除 node: 内置外零外部 require;文件名用 .cjs 而非 .js:
 *    包根 package.json 为 type: module,若叫 server.js,Node 的 import()
 *    会把 CJS 内容当 ESM 解析("require is not defined"),详见 Task 10 报告);
 * ② esbuild 打包 Electron 主进程 electron/main.ts → dist/electron/main.cjs
 *    (electron 相关模块 external,运行时由 Electron 提供);
 * ③ esbuild 打包 preload electron/preload.ts → dist/electron/preload.js;
 * ④ vite 构建前端 web/ → web/dist(静态页面,服务端自动探测提供);
 * ⑤ 自包含检查:server.cjs 不得 require 任何非 node: 内置的包;
 *    另做 node --check 语法校验 + 运行时 require 冒烟(导出契约)。
 *
 * 产物被 electron-builder(files 白名单)打进安装包:服务端与主进程都是
 * 单文件产物,运行时不依赖 node_modules。本脚本只用 node + esbuild
 * (vite 的传递依赖,已在 node_modules),不强制 bun。
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverOut = join(root, "dist", "web", "server.cjs");
const mainOut = join(root, "dist", "electron", "main.cjs");
const preloadOut = join(root, "dist", "electron", "preload.js");
const webDist = join(root, "web", "dist");

/** 运行命令,失败立即抛错(cwd 默认仓库根)。 */
function run(cmd, opts = {}) {
	console.log(`\n$ ${cmd}`);
	execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

/**
 * CJS 产物下 esbuild 把 import.meta 置为空对象(仅警告不转换)。这里模拟 bun
 * 打包的烘焙行为:把 import.meta.url 替换成该源文件的 file:// URL 字面量。
 * 不能引用 __filename —— 模块内若有同名局部变量(如 vendor config.ts 的
 * `const __filename = fileURLToPath(import.meta.url)`)会被 esbuild 重命名归一,
 * 形成自引用;且 CJS 全局 __filename 指向输出文件而非源文件,语义也不对。
 */
const importMetaUrlPlugin = {
	name: "import-meta-url-cjs",
	setup(build) {
		build.onLoad({ filter: /\.(?:[cm]?[jt]sx?)$/ }, async (args) => {
			const source = await readFile(args.path, "utf-8");
			if (!source.includes("import.meta.url")) return null; // 未命中:走默认加载器
			const loader = args.path.endsWith(".tsx")
				? "tsx"
				: args.path.endsWith(".jsx")
					? "jsx"
					: args.path.endsWith(".ts")
						? "ts"
						: "js";
			const fileUrl = pathToFileURL(args.path).href;
			return {
				contents: source.replaceAll("import.meta.url", JSON.stringify(fileUrl)),
				loader,
			};
		});
	},
};

/** esbuild 打包入口 → 单文件 CJS(全量 bundle,含 vendor;external 列表运行时提供)。 */
async function bundle(entry, outfile, external = []) {
	console.log(`\n[esbuild] ${entry} → ${outfile}`);
	await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile,
		external,
		plugins: [importMetaUrlPlugin],
		logLevel: "warning",
	});
}

/** 检查 server.cjs 自包含:静态 require 的 specifier 必须是 node: 内置或原生裸模块。 */
function checkSelfContained(file) {
	const source = readFileSync(file, "utf-8");
	// 先剥离字符串字面量与注释(注释里的示例代码如
	// `const {JWT} = require('google-auth-library')` 不是真实 require),
	// 再匹配静态 require —— 避免假阳性。
	const stripped = source
		.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, (m) => " ".repeat(m.length))
		.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
	const re = /require\(\s*["']([^"']+)["']\s*\)/g;
	const builtinBare = new Set([
		"assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
		"crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
		"http2", "https", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
		"querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers",
		"tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
	]);
	// ws 的可选原生加速器:try/catch 内 require,未安装时降级纯 JS 实现。
	// Electron asar 中无 node_modules,require 失败走 catch,行为安全。
	const optionalBare = new Set(["bufferutil", "utf-8-validate"]);
	const bad = new Set();
	for (const m of stripped.matchAll(re)) {
		const spec = m[1];
		if (spec.startsWith("node:")) continue;
		// 原生裸模块及其子路径(fs/promises、stream/promises 等)
		if (builtinBare.has(spec.split("/")[0])) continue;
		if (optionalBare.has(spec)) continue;
		bad.add(spec);
	}
	if (bad.size > 0) {
		throw new Error(`server.cjs 不是自包含产物,存在外部 require: ${[...bad].join(", ")}\n` +
			"请检查 src/web.ts 引入链中是否有未被打包的依赖(esbuild 默认全打包,如出现需排查 esbuild 配置)");
	}
	console.log(`[check] server.cjs 自包含:静态 require 均为 node: 内置或可选依赖(共 ${source.match(re)?.length ?? 0} 处)`);
}

/** 运行时冒烟:require 产物并校验导出契约(parseWebArgs/startWebServer)。 */
function smokeRequire(file) {
	const cmd = `node -e "const m = require(process.argv[1]); if (typeof m.startWebServer !== 'function' || typeof m.parseWebArgs !== 'function') { console.error('导出契约缺失:', Object.keys(m)); process.exit(1); } console.log('[smoke] server.cjs 导出契约 OK:', Object.keys(m).join(', '));" "${file}"`;
	execSync(cmd, { stdio: "inherit" });
	// 语法校验(独立跑一次,与 require 冒烟互补)
	execSync(`node --check "${file}"`, { stdio: "inherit" });
	console.log("[check] node --check 语法校验通过");
}

// 前置:无(bun 仅 TUI 单文件 bundle 需要,见 package.json 的 bundle 脚本)

// ① 服务端:单文件 CJS,打包全部依赖(含 vendor),platform node
await bundle("src/web.ts", serverOut);

// ② Electron 主进程:CJS,electron 模块运行时提供
await bundle("electron/main.ts", mainOut, ["electron*"]);

// ③ preload 脚本(electron-builder files 白名单需要;内容简单,同样 CJS)
await bundle("electron/preload.ts", preloadOut, ["electron*"]);

// ④ 前端:vite 构建到 web/dist
run("npx vite build", { cwd: join(root, "web") });

// ⑤ 产物检查:自包含 + 语法 + 导出契约
if (!existsSync(serverOut)) throw new Error(`构建失败:缺少 ${serverOut}`);
checkSelfContained(serverOut);
smokeRequire(serverOut);
if (!existsSync(join(webDist, "index.html"))) {
	throw new Error(`构建失败:缺少 ${join(webDist, "index.html")}(vite 未产出)`);
}

console.log("\nweb 打包完成:");
console.log(`  - ${serverOut}(服务端单文件,${Math.round(readFileSync(serverOut).length / 1024)} KB)`);
console.log(`  - ${mainOut}(Electron 主进程)`);
console.log(`  - ${preloadOut}(preload)`);
console.log(`  - ${webDist}(前端静态资源)`);
