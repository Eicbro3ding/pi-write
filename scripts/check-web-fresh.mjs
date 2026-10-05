#!/usr/bin/env node
/**
 * 检查 `dist/web/server.cjs` 是否比它的源码新。
 *
 * ## 为什么需要这个
 *
 * `npm run build` 产的是 `dist/cli.js` / `dist/index.js`(tsc 声明 + build-cli.mjs),
 * 而 **`npm run web` 跑的是 `dist/web/server.cjs`** —— 那个文件只由
 * **`npm run build:web`** 产出。
 *
 * 于是「改完源码 → `npm run build` → `npm run web`」这条最自然的路径会
 * **跑在旧产物上**,而且**不报任何错**(旧文件还在,能正常启动)。
 * 这是「改了不生效」类的静默失败:2026-10-05 T13 端到端排查时真踩过一次,
 * 因此误判「MCP 配置迁移完全没生效」,白查半小时。
 *
 * ## 这个脚本做什么
 *
 * 不构建(启动路径上加全量构建太慢),只**比时间戳**:若任一源码文件比产物新,
 * 打一条醒目警告并给出正确命令,然后 `exit 0` —— 不阻断启动,
 * 因为「跑旧产物看别的功能」有时是合理需求。
 *
 * 用法:`node scripts/check-web-fresh.mjs`(由 `npm run web` 自动带上)。
 */

import { statSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = join(root, "dist", "web", "server.cjs");

/** 参与比较的源码根:服务端自研源码 + 前端源码 + 打包脚本自身。 */
const SOURCE_ROOTS = ["src", "web/src", "electron", "scripts/web-build.mjs"];

/** 递归收集 .ts / .tsx / .mjs 源码的 mtime(取最大值)。 */
function newestSourceMtime(path, acc = { time: 0, file: "" }) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return acc;
  }
  if (st.isFile()) {
    if (/\.(ts|tsx|mjs)$/.test(path) && st.mtimeMs > acc.time) {
      acc.time = st.mtimeMs;
      acc.file = path;
    }
    return acc;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    newestSourceMtime(join(path, entry), acc);
  }
  return acc;
}

let artifactStat;
try {
  artifactStat = statSync(artifact);
} catch {
  console.error(
    `[check-web-fresh] 找不到 ${relative(root, artifact)} —— web 产物尚未构建。\n` +
      `                  请先运行:  npm run build:web\n`,
  );
  process.exit(0);
}

let newest = { time: 0, file: "" };
for (const rel of SOURCE_ROOTS) {
  newest = newestSourceMtime(join(root, rel), newest);
}

if (newest.time > artifactStat.mtimeMs) {
  const staleMin = Math.round((newest.time - artifactStat.mtimeMs) / 60000);
  console.error(
    `\n[check-web-fresh] ⚠  web 产物可能过期 —— 你启动的是旧代码。\n` +
      `                  产物: ${relative(root, artifact)}  (${new Date(artifactStat.mtimeMs).toISOString()})\n` +
      `                  更新的源码: ${relative(root, newest.file)}  (${new Date(newest.time).toISOString()},早 ${staleMin} 分钟)\n` +
      `\n                  正确命令:  npm run build:web  &&  npm run web\n` +
      `                  (注意:'npm run build' 只产 cli.js / index.js,不产 server.cjs)\n`,
  );
}
