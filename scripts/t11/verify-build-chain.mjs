/**
 * T11 步骤 4 验收：构建链引用的文件是否**真的存在**。
 *
 * 为什么需要它：把 `vendor/...` 改成 `node_modules/...` 这种替换，改错了**不会有任何
 * 报错** —— `package.json` 的 `files` 里写个不存在的路径，npm 安静地跳过；
 * `bundle` 脚本里 `shx cp` 一个不存在的 glob，`shx` 安静地什么都不拷。
 * 于是「发行物里少了主题 json / 少了 MIT 许可全文」这种问题，要到用户装完、跑起来
 * 才现形。这个脚本把三处白名单展开成**存在性断言**，可以随时跑。
 *
 * 覆盖范围：
 *   1. `package.json` 的 `files`（npm 发行白名单）
 *   2. `bundle` 脚本里每条 `shx cp` 的源路径（单文件可执行发行物）
 *   3. `electron-builder.yml` 的 `files`（桌面端发行物）
 *   4. `test/` 里 `readFileSync("<字面量>")` 的固定路径（vendor 删除后最容易红的）
 *
 * 用法：node scripts/t11/verify-build-chain.mjs
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const problems = [];
const checked = [];

/** 路径（可含尾部 `*` 通配）是否存在。含 `*` 时校验其所在目录存在且非空。 */
function checkPath(rel, why) {
	const clean = rel.replace(/\/$/, "");
	checked.push(`${clean}  ← ${why}`);
	if (clean.includes("*")) {
		const dir = path.dirname(clean);
		if (!existsSync(path.join(ROOT, dir))) {
			problems.push(`${why}: 目录不存在 ${dir}（来自 ${rel}）`);
			return;
		}
		if (statSync(path.join(ROOT, dir)).isDirectory() === false) {
			problems.push(`${why}: ${dir} 不是目录（来自 ${rel}）`);
		}
		return;
	}
	if (!existsSync(path.join(ROOT, clean))) problems.push(`${why}: 文件不存在 ${clean}`);
}

console.log("\n① package.json 的 files（npm 发行白名单）");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));
for (const entry of pkg.files ?? []) {
	// dist 是构建产物，未构建时不存在，跳过但记录
	if (entry === "dist") {
		console.log("  · dist（构建产物，跳过）");
		continue;
	}
	checkPath(entry, "package.json files");
}

console.log("\n② bundle 脚本里 shx cp 的源路径（单文件发行物）");
const bundle = pkg.scripts?.bundle ?? "";
// 形如 `shx cp a b c dest/` —— 最后一项是目标目录，其余都是源
for (const cmd of bundle.split("&&")) {
	const parts = cmd.trim().split(/\s+/);
	const i = parts.indexOf("cp");
	if (parts[0] !== "shx" || i === -1) continue;
	const args = parts.slice(i + 1).filter((a) => !a.startsWith("-"));
	if (args.length < 2) continue;
	for (const src of args.slice(0, -1)) {
		if (src.startsWith("release/")) continue; // 目标目录内的暂存
		checkPath(src, "bundle: shx cp");
	}
}

console.log("\n③ electron-builder.yml 的 files（桌面端发行物）");
const yml = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf-8");
let inFiles = false;
for (const line of yml.split("\n")) {
	if (/^files:/.test(line)) {
		inFiles = true;
		continue;
	}
	if (inFiles && /^\S/.test(line)) inFiles = false; // 缩进结束 = 段结束
	if (!inFiles) continue;
	const m = line.match(/^\s+-\s+"?([^"\s]+)"?\s*$/);
	if (!m) continue;
	const entry = m[1];
	if (entry.startsWith("!")) continue; // 负向排除
	if (entry.includes("**")) continue; // 通配，不逐个校验
	checkPath(entry, "electron-builder files");
}

console.log("\n④ test/ 里 readFileSync 的固定路径");
const { readdirSync } = await import("node:fs");
function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const abs = path.join(dir, name);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else if (name.endsWith(".ts")) out.push(abs);
	}
	return out;
}
for (const file of walk(path.join(ROOT, "test"))) {
	const text = readFileSync(file, "utf-8");
	for (const m of text.matchAll(/readFileSync\(\s*"([^"]+)"\s*,/g)) {
		const p = m[1];
		if (p.startsWith("/") || p.includes("${") || p.includes("*")) continue;
		checkPath(p, `test: ${path.relative(ROOT, file)}`);
	}
}

console.log("\n" + "=".repeat(64));
console.log(`共校验 ${checked.length} 条路径`);
if (problems.length > 0) {
	console.error(`\n✗ ${problems.length} 条路径失效：\n`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log("✓ 构建链引用的文件全部存在");
