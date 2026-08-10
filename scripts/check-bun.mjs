#!/usr/bin/env node
/**
 * 检查 bun 是否可用。`npm run bundle`(TUI 单文件可执行 + 多平台交叉编译)
 * 需要 bun —— esbuild/tsc 只能产出 JS,Node SEA 无法交叉编译到 arm64,
 * 目前没有平替;web/Electron 构建(build:web / build:electron)不需要 bun。
 */
import { execSync } from "node:child_process";

try {
	execSync("bun --version", { stdio: "pipe" });
} catch {
	console.error(
		"未找到 bun:`npm run bundle`(TUI 单文件交叉编译)需要 bun,请先安装 https://bun.sh。\n" +
			"提示:`npm run build:web` / `npm run build:electron`(web 后端 + Electron 壳)不依赖 bun。",
	);
	process.exit(1);
}
