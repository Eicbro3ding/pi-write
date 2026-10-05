#!/usr/bin/env node
/**
 * 打包 CLI 与库入口（`npm run build` 的第二段）。
 *
 * ## 为什么不是 tsc 直接 emit
 *
 * 源码里的相对 import 写的是 `.ts` 扩展名（`import { x } from "./config.ts"`，
 * 全项目 261 处），配合 tsconfig 的 `allowImportingTsExtensions`。这个组合下
 * tsc **不能** emit JS（会报 TS5096），就算强行 emit 出来，`dist/src/*.js` 里的
 * import 仍写着 `.ts` —— Node 一跑就是 `ERR_MODULE_NOT_FOUND`。所以：
 *
 *   - **tsc 只负责出声明**（`--emitDeclarationOnly`），喂 `types` 字段；
 *   - **可执行/可被引用的 JS 由 esbuild 出**（与 `build:web`、`build:electron`
 *     同一套做法，项目里已经验证过）。
 *
 * ## 为什么 CLI 产物放在 dist/ 而不是 dist/src/
 *
 * `src/prompts.ts` 探测 prompts 目录的最后一态是 `join(here, "..", "prompts")`
 * —— `here` 是**模块所在目录**。产物若放 `dist/src/cli.js`，上跳一级是 `dist/prompts`，
 * 而 `files` 白名单里 prompts 在**包根**，于是 npm 包装完一启动就崩（提示词缺失）。
 * 放 `dist/cli.js`：上跳一级正好是包根 → `prompts/` 命中。
 *
 * ## 自检（关键）
 *
 * 产物里**不许出现 `from "./xxx.ts"`**。这是本次修复的核心，也是最容易悄悄退回的
 * 形态 —— 哪天有人把 build 改回 tsc emit，编译照样"成功"，只有用户启动时才炸。
 * 所以自检把它钉死。
 *
 * 用法：node scripts/build-cli.mjs
 */

import { existsSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 两个产物都放 dist/ 根：prompts 探测是 `join(here, "..", "prompts")`，
// 只有 here = dist/ 时上跳一级才是包根（files 白名单里 prompts 就在包根）。
// 放进 dist/src/ 会去找 dist/prompts —— 不存在，一 import 就抛「提示词文件缺失」。
const OUT_CLI = path.join(ROOT, "dist", "cli.js");
const OUT_LIB = path.join(ROOT, "dist", "index.js");

const problems = [];

/**
 * esbuild 打包一个入口。
 * `--packages=external`：npm 依赖保持外置，运行时从 node_modules 解析
 * （单文件 exe 那是 `bundle` 脚本用 bun 另做的，用途不同）。
 */
function bundle(entry, outfile, label) {
	mkdirSync(path.dirname(outfile), { recursive: true });
	execFileSync(
		"npx",
		[
			"esbuild",
			entry,
			"--bundle",
			"--platform=node",
			"--format=esm",
			"--packages=external",
			"--log-level=warning",
			`--outfile=${outfile}`,
		],
		{ cwd: ROOT, stdio: "inherit" },
	);
	if (!existsSync(outfile)) {
		problems.push(`${label}: 产物未生成 ${path.relative(ROOT, outfile)}`);
		return null;
	}
	const size = (readFileSync(outfile).length / 1024).toFixed(0);
	console.log(`  ✓ ${label} → ${path.relative(ROOT, outfile)}（${size} KB）`);
	return readFileSync(outfile, "utf-8");
}

console.log("\n打包 CLI 与库入口（esbuild）");

const cli = bundle("src/cli.ts", OUT_CLI, "CLI 可执行入口");
const lib = bundle("src/index.ts", OUT_LIB, "库入口 exports.import");

// ── 自检：产物里不许残留 .ts 相对 import ────────────────────────────────────
console.log("\n自检");

function assertNoTsImports(text, label) {
	// 读不到内容就**不能**静默跳过 —— 那会让自检在最需要它的时候假装通过
	// （这次就踩了：产物路径改了，标签还写着旧路径，于是"通过"了个不存在的文件）
	if (text == null) {
		problems.push(`${label}: 产物不存在，无法自检`);
		return;
	}
	const hits = [...text.matchAll(/from\s+"(\.\.?\/[^"]*\.ts)"/g)].map((m) => m[1]);
	if (hits.length > 0) {
		problems.push(
			`${label}: 残留 ${hits.length} 处 .ts 相对 import（如 ${hits[0]}）—— ` +
				"tsc emit 的产物不能直接跑，见本文件顶部说明",
		);
	} else {
		console.log(`  ✓ ${label}: 无 .ts 相对 import 残留`);
	}
}

// 标签用**实际路径**算出来，不写死 —— 写死就会在改了输出位置后自检一个不存在的文件
assertNoTsImports(cli, path.relative(ROOT, OUT_CLI));
assertNoTsImports(lib, path.relative(ROOT, OUT_LIB));

if (cli && !cli.startsWith("#!")) {
	problems.push("dist/cli.js 缺 shebang —— bin 直接执行会走 shell 解析");
} else if (cli) {
	console.log("  ✓ dist/cli.js 带 shebang");
	chmodSync(OUT_CLI, 0o755);
	console.log("  ✓ dist/cli.js 已 chmod +x");
}

console.log("\n" + "=".repeat(64));
if (problems.length > 0) {
	console.error(`✗ ${problems.length} 项自检未过：\n`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log("✓ 构建完成");
console.log("  冒烟：node dist/cli.js --help");
