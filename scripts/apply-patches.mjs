#!/usr/bin/env node
/**
 * 应用 pi-write 对上游 pi-coding-agent 的 patch。
 *
 * 两件事：
 *   1. 把 patches/pi-coding-agent-pathguard.patch 打到 node_modules 的 dist 产物上
 *      （补出 setToolPathGuard / clearToolPathGuard，并给三个写入调用方带上 mode）
 *   2. 往上游 package.json 的 exports 注入两个子路径
 *      （path-utils / usage-totals —— 上游未开 ./core/* 子路径，不注入则自研侧 import 不进来）
 *
 * 为什么 exports 不放进 patch 文件：package.json 会被 npm install 重写，
 * 把它固化进 diff 会让 patch 在每次装包后失配。所以拆成脚本注入，与版本解耦。
 *
 * 幂等：重复运行安全。已在 postinstall 里挂载。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const PATCH = join(ROOT, "patches", "pi-coding-agent-pathguard.patch");

const SUBPATHS = {
  "./core/tools/path-utils": {
    types: "./dist/core/tools/path-utils.d.ts",
    import: "./dist/core/tools/path-utils.js",
  },
  "./core/usage-totals": {
    types: "./dist/core/usage-totals.d.ts",
    import: "./dist/core/usage-totals.js",
  },
};

const PATH_UTILS_JS = join(PKG_DIR, "dist/core/tools/path-utils.js");
const MARK = "__PI_WRITE_PATCH_PATH_UTILS__";

let fail = 0;
const step = (label, fn) => {
  try {
    const note = fn();
    console.log(`  ✅ ${label}${note ? ` —— ${note}` : ""}`);
  } catch (e) {
    console.error(`  ❌ ${label} —— ${e.message}`);
    fail++;
  }
};
if (!existsSync(PKG_DIR)) {
  console.error(`❌ 未找到上游包：${PKG_DIR}\n   先运行 npm install。`);
  process.exit(1);
}

// ── 1) dist patch ──
step("应用 dist patch", () => {
  const already = existsSync(PATH_UTILS_JS) && readFileSync(PATH_UTILS_JS, "utf8").includes(MARK);
  if (already) return "已是 patch 状态，跳过";

  try {
    execFileSync("patch", ["-p1", "--forward", "-i", PATCH], { cwd: PKG_DIR, stdio: "pipe" });
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`;
    // patch 全部已应用时会报 "Reversed (or previously applied) patch detected"
    if (/previously applied|Reversed/i.test(out)) return "已是 patch 状态";
    throw new Error(`patch 失败：${out.trim().split("\n").slice(-3).join(" | ")}`);
  }
  return "已应用";
});

// ── 2) exports 子路径 ──
step("注入 exports 子路径", () => {
  const p = join(PKG_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  const added = [];
  for (const [k, v] of Object.entries(SUBPATHS)) {
    if (!pkg.exports[k]) {
      pkg.exports[k] = v;
      added.push(k);
    }
  }
  if (added.length) {
    writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
    return `新增 ${added.join("、")}`;
  }
  return "已存在，跳过";
});

// ── 3) 自检 ──
step("自检：守卫声明就位", () => {
  const dts = join(PKG_DIR, "dist/core/tools/path-utils.d.ts");
  const s = readFileSync(dts, "utf8");
  if (!s.includes("setToolPathGuard")) throw new Error("path-utils.d.ts 缺少 setToolPathGuard 声明");
  return "path-utils.d.ts 含 setToolPathGuard / clearToolPathGuard";
});

console.log(fail === 0 ? "\n✅ patch 应用完成" : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
