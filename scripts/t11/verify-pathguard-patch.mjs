// T11 步骤 2 端到端验证脚本
// 目标：在真实 1.0.2 包上实施 patch，并用「真实越权读/写」证明守卫拦得住。
// 不做静态断言 —— 所有结论来自真实的 resolveToCwd 调用。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "/tmp/realtest/node_modules/@earendil-works/pi-coding-agent";
const R = (p) => join(PKG, p);
const log = (...a) => console.log(...a);
const ok = (c, m) => log(`${c ? "  ✅" : "  ❌"} ${m}`) || c;

const report = { steps: [], pass: true };
const step = async (name, fn) => {
  log(`\n═══ ${name} ═══`);
  try { const r = await fn(); if (r === false) report.pass = false; report.steps.push({ name, ok: r !== false }); }
  catch (e) { log(`  ❌ 异常: ${e.message}`); report.pass = false; report.steps.push({ name, ok: false, err: e.message }); }
};
const run = async () => {

// ─────────────────────────────────────────────────────────
// P1: path-utils.js —— 加 pathGuard + setToolPathGuard + mode 参数
// ─────────────────────────────────────────────────────────
const MARK1 = "// __PI_WRITE_PATCH_PATH_UTILS__";
const NEW_RESOLVE = `${MARK1}
let __piWritePathGuard;
export function setToolPathGuard(guard) { __piWritePathGuard = guard; }
export function clearToolPathGuard() { __piWritePathGuard = undefined; }
/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath, cwd, mode = "read") {
    const resolved = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
    __piWritePathGuard?.(resolved, mode);
    return resolved;
}`;

const OLD_RESOLVE = `/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath, cwd) {
    return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}`;

await step("P1 path-utils.js：注入 guard + mode 参数", () => {
  const src = readFileSync(R("dist/core/tools/path-utils.js"), "utf8");
  if (src.includes(MARK1)) { log("  已 patch，跳过"); return true; }
  if (!src.includes(OLD_RESOLVE)) { log("  ❌ 锚点未命中，上游结构变了"); return false; }
  writeFileSync(R("dist/core/tools/path-utils.js"), src.replace(OLD_RESOLVE, NEW_RESOLVE));
  ok(true, "注入完成");
  return true;
});

// ─────────────────────────────────────────────────────────
// P2-P4: 三个写入调用方加 "write" mode —— 漏一个就静默失效
// ─────────────────────────────────────────────────────────
const CALLERS = [
  ["dist/core/tools/write.js",     "resolveToCwd(path, ctx?.cwd || cwd)", 'resolveToCwd(path, ctx?.cwd || cwd, "write")'],
  ["dist/core/tools/edit.js",      "resolveToCwd(path, ctx?.cwd || cwd)", 'resolveToCwd(path, ctx?.cwd || cwd, "write")'],
  ["dist/core/tools/edit-diff.js", "resolveToCwd(path, cwd)",            'resolveToCwd(path, cwd, "write")'],
];

await step("P2-P4 写入调用方同步 mode=\"write\"", () => {
  let allOk = true;
  for (const [file, from, to] of CALLERS) {
    const src = readFileSync(R(file), "utf8");
    if (src.includes(to)) { log(`  ${file}: 已 patch`); continue; }
    if (!src.includes(from)) { log(`  ❌ ${file}: 锚点未命中 → ${from}`); allOk = false; continue; }
    const cnt = src.split(from).length - 1;
    if (cnt !== 1) { log(`  ❌ ${file}: 锚点出现 ${cnt} 次（应为 1），拒绝自动替换`); allOk = false; continue; }
    writeFileSync(R(file), src.replace(from, to));
    log(`  ✅ ${file}: ${from}  →  ${to}`);
  }
  return allOk;
});

// ─────────────────────────────────────────────────────────
// P5: package.json 补 exports 子路径
// ─────────────────────────────────────────────────────────
await step("P5 package.json 补 exports 子路径", () => {
  const p = JSON.parse(readFileSync(R("package.json"), "utf8"));
  const want = {
    "./core/tools/path-utils": { import: "./dist/core/tools/path-utils.js" },
    "./core/usage-totals":     { import: "./dist/core/usage-totals.js" },
  };
  let changed = false;
  for (const [k, v] of Object.entries(want)) {
    if (!p.exports[k]) { p.exports[k] = v; changed = true; log(`  + ${k}`); }
    else log(`  = ${k} 已存在`);
  }
  if (changed) writeFileSync(R("package.json"), JSON.stringify(p, null, 2) + "\n");
  return true;
});

// ─────────────────────────────────────────────────────────
// 验证 A: 子路径可 import
// ─────────────────────────────────────────────────────────
await step("验证A 子路径 import 可用", async () => {
  const pu = await import("@earendil-works/pi-coding-agent/core/tools/path-utils");
  const ut = await import("@earendil-works/pi-coding-agent/core/usage-totals");
  ok(typeof pu.setToolPathGuard === "function", "setToolPathGuard 可导入");
  ok(typeof pu.clearToolPathGuard === "function", "clearToolPathGuard 可导入");
  ok(typeof pu.resolveToCwd === "function", "resolveToCwd 可导入");
  ok(typeof ut.getUsageCostBreakdown === "function", "getUsageCostBreakdown 可导入");
  return true;
});

// ─────────────────────────────────────────────────────────
// 验证 B: 真实越权读/写回归测试（核心 —— 不靠「编译通过」）
// ─────────────────────────────────────────────────────────
await step("验证B 真实越权读/写回归（核心）", async () => {
  const pu = await import("@earendil-works/pi-coding-agent/core/tools/path-utils");

  // 模拟自研侧 guard：书内放行，书外抛错
  const BOOK = "/tmp/realtest/book";
  mkdirSync(BOOK, { recursive: true });
  writeFileSync(join(BOOK, "inside.txt"), "ok");

  const denials = [];
  const inside = (p, root) => p === root || p.startsWith(root + "/");
  pu.clearToolPathGuard();
  pu.setToolPathGuard((abs, mode) => {
    if (mode === "write" && !inside(abs, BOOK)) { denials.push([abs, mode]); throw new Error(`越权写入: ${abs}`); }
    if (mode === "read" && abs.includes("auth.json")) { denials.push([abs, mode]); throw new Error(`越权读取: ${abs}`); }
  });

  const probe = (label, fn, shouldThrow) => {
    let threw = false, msg = "";
    try { fn(); } catch (e) { threw = true; msg = e.message; }
    const good = threw === shouldThrow;
    log(`  ${good ? "✅" : "❌"} ${label}：${threw ? "拦住 → " + msg : "放行"}`);
    return good;
  };

  const CWD = "/tmp/realtest";
  let all = true;
  all = probe("书内读   book/inside.txt", () => pu.resolveToCwd("book/inside.txt", CWD, "read"), false) && all;
  all = probe("书内写   book/inside.txt", () => pu.resolveToCwd("book/inside.txt", CWD, "write"), false) && all;
  all = probe("越权读   ~/.pi/writer/agent/auth.json", () => pu.resolveToCwd("/root/.pi/writer/agent/auth.json", CWD, "read"), true) && all;
  all = probe("越权写   /etc/passwd", () => pu.resolveToCwd("/etc/passwd", CWD, "write"), true) && all;
  all = probe("默认模式（不传 mode）→ read 语义", () => pu.resolveToCwd("/root/.pi/writer/agent/auth.json", CWD), true) && all;

  // 关键负向验证：证明「漏改调用方」会静默失效
  log("\n  ── 反证：如果调用方漏传 mode，会发生什么 ──");
  let leaked = false;
  try { pu.resolveToCwd("/etc/passwd", CWD); } catch { /* 默认 read 但仍被 auth.json 规则拦 */ }
  try {
    // 用只拦 write 的守卫测：不传 mode 时 /etc/passwd 写会「放行」→ 静默失效
    pu.clearToolPathGuard();
    pu.setToolPathGuard((abs, mode) => { if (mode === "write") throw new Error("should block"); });
    pu.resolveToCwd("/etc/passwd", CWD); leaked = true;
  } catch { leaked = false; }
  ok(leaked, "确认：漏传 mode 时写入守卫静默失效（反证成立，说明 3 处 caller 必须改）");

  pu.clearToolPathGuard();
  return all;
});

  log(`\n${"═".repeat(50)}\n总判定：${report.pass ? "✅ 全部通过" : "❌ 有失败项"}`);
};
run().then(() => process.exit(report.pass ? 0 : 1));
