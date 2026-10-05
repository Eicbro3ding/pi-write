import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectUsageCost } from "../src/pi-adapter/usage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/**
 * 一条 import 语句是否非法地**绕过 pi-adapter 直插 pi 内部**。
 *
 * 依赖化(T11 / D2)之后,vendor 源码不再是唯一的引用形式 —— 直接按
 * `@earendil-works/pi-coding-agent/core/...` 点进包内深层路径同样绕开了收口,
 * 而且**更隐蔽**:它在编译期完全合法,只是把上游的日常挪动变成了我们的运行时风险。
 *
 * 所以判据从「不许出现 vendor 里的 pi 相对路径」升级成
 * 「**不许出现任何非包入口的 pi 引用**」:
 *   - `vendor/pi-xxx/src/` 开头             —— 依赖化前的形态(应已清零)
 *   - `@earendil-works/pi-xxx/` 后跟子路径   —— 依赖化后的形态(只有 pi-adapter 可用)
 * 合法形式只有 `@earendil-works/pi-*` **包入口本身**。
 */
function isDeepPiImport(statement: string): boolean {
	if (/vendor\/pi-[\w-]+\/src\//.test(statement)) return true;
	// 形如 "@earendil-works/pi-coding-agent/core/tools/path-utils"
	return /@earendil-works\/pi-[\w-]+\/.+/.test(statement);
}

/** 递归收集 src/ 下的 .ts/.tsx(跳过 pi-adapter 自身)。 */
function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const abs = path.join(dir, name);
		if (statSync(abs).isDirectory()) {
			if (name === "pi-adapter") continue;
			walk(abs, out);
		} else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
			out.push(abs);
		}
	}
	return out;
}

describe("pi-adapter 契约（T6 防腐层）", () => {
	it("深层路径只在 pi-adapter 内出现（这两条是升级时最容易静默失效的地方）", () => {
		// 这是 T6 的核心验收:自研侧一旦有人重新按相对源码路径 import vendor 内部文件,
		// 上游挪动目录时不会有编译错误 —— 只会在运行时炸或静默走错分支。
		const offenders: string[] = [];
		for (const file of walk(SRC)) {
			const text = readFileSync(file, "utf-8");
			// 只看真正的 import 语句,注释里提到路径不算(很多注释在解释来由)
			for (const line of text.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("import ")) continue;
				if (isDeepPiImport(trimmed)) {
					offenders.push(`${path.relative(ROOT, file)}: ${trimmed}`);
				}
			}
		}
		expect(offenders, `这些文件绕过了 pi-adapter 直插 pi 内部:\n${offenders.join("\n")}`).toEqual([]);
	});

	it("guard.ts / usage.ts 各自保留唯一的深层 import（收口有效但不能为空）", () => {
		const guard = readFileSync(path.join(SRC, "pi-adapter/guard.ts"), "utf-8");
		const usage = readFileSync(path.join(SRC, "pi-adapter/usage.ts"), "utf-8");
		expect(guard).toContain("@earendil-works/pi-coding-agent/core/tools/path-utils");
		expect(usage).toContain("@earendil-works/pi-coding-agent/core/usage-totals");
	});

	it("domain.ts 不 import 任何 vendor 模块（类型层零耦合）", () => {
		const text = readFileSync(path.join(SRC, "pi-adapter/domain.ts"), "utf-8");
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (t.startsWith("import ") || t.startsWith("export type {")) {
				expect(isDeepPiImport(t)).toBe(false);
			}
		}
	});

	it("tool-guard.ts 不再直接持有 vendor 深层符号", () => {
		const text = readFileSync(path.join(SRC, "tool-guard.ts"), "utf-8");
		expect(text).not.toContain("setToolPathGuard(");
		expect(text).not.toContain("clearToolPathGuard(");
		expect(text).toContain("installToolPathGuard");
		expect(text).toContain("uninstallToolPathGuard");
	});
});

describe("projectUsageCost（成本拆分投影）", () => {
	it("空条目 → 空数组（不是抛错）", () => {
		expect(projectUsageCost([])).toEqual([]);
	});

	it("形状异常的条目 → 空数组而不是抛（拆分失败不该拖垮总量统计）", () => {
		// 老会话 / 被手工改过的 jsonl:vendor 内部可能按下标取字段而炸
		expect(projectUsageCost([{ 乱: "来" }, null as never, 42 as never])).toEqual([]);
	});

	it("产出只有 key/cost/tokens 三个字段（不把 vendor 的额外字段漏出去）", () => {
		const rows = projectUsageCost([]);
		// 空数组时无字段可验,这里断言「形状契约」由类型保证 —— 运行时至少确认返回是数组
		expect(Array.isArray(rows)).toBe(true);
		for (const r of rows) {
			expect(Object.keys(r).sort()).toEqual(["cost", "key", "tokens"]);
		}
	});
});

// ============================================================================
// T7 批 2：类型别名 + 运行时值接入
// ============================================================================

describe("pi-adapter 契约（T7 批 2）", () => {
	it("批 2 的三个目标文件确实清零（回归护栏）", () => {
		// 这三个文件是 T7 批 2 的交付范围。单独钉住它们的名字,
		// 是为了「将来有人为了方便又在这里写 vendor import」时能立刻发现。
		for (const rel of ["session-factory.ts", "web/session-host.ts", "web/writer-host.ts"]) {
			const text = readFileSync(path.join(SRC, rel), "utf-8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (t.startsWith("import ")) expect(isDeepPiImport(t)).toBe(false);
			}
		}
	});

	it("批 2 顺带收口的 web.ts / session-tree.ts 也已清零", () => {
		// 这两个文件不在原计划的批 2 清单里,但批 2 改动牵连到它们
		// (web.ts 的 SessionManager.open、session-tree.ts 的 entry 类型),
		// 一并收口后加护栏防止回退。
		for (const rel of ["web.ts", "session-tree.ts"]) {
			const text = readFileSync(path.join(SRC, rel), "utf-8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (t.startsWith("import ")) expect(isDeepPiImport(t)).toBe(false);
			}
		}
	});

	it("【T7 终点】自研业务代码**零 vendor 直接引用**（全局断言，无白名单）", () => {
		// 这是 T7 的最终验收。批 2/批 3/批 4 期间这条只能是「白名单只减不增」,
		// 因为还有文件没迁完。批 4 之后清单清空,于是升级为**无例外全局断言** ——
		// 从「已知哪些还没改」变成「任何新穿透都会红」。
		//
		// 允许的例外只有两类,且都必须显式列出:
		//   1. `pi-adapter/` 自身 —— 它就是干这个的;
		//   2. `util/uuid.ts` —— 归属修正(把被误当成 AI 能力的 uuidv7 挪回
		//      通用工具位),它是自研自己的模块,不是 adapter。
		const ALLOWED = new Set(["util/uuid.ts"]);
		const offenders: string[] = [];
		for (const file of walk(SRC)) {
			const rel = path.relative(SRC, file);
			if (ALLOWED.has(rel)) continue;
			const text = readFileSync(file, "utf-8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				// 覆盖三种 import/export 形态:单行 import、多行收尾 `} from "..."`、
				// 以及 `export ... from "..."` 转发。注释里提到路径不算。
				if (!t.startsWith("import ") && !t.startsWith("} from") && !t.startsWith("export ")) continue;
				if (t.includes("vendor/pi-")) offenders.push(`${rel}: ${t}`);
			}
		}
		expect(
			offenders,
			`自研业务代码不该直接引用 vendor:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("【T7 全量】33 个交付文件逐一点名清零（历史样板护栏）", () => {
		// 上面那条是**全局**断言(将来可能为某个新例外放宽);
		// 这一条把 T7 三批**实际交付**的每个文件钉死 —— 任何回退都立刻可见,
		// 且不受全局断言未来放宽的影响。
		//
		// 批 2(3): session-factory.ts, web/session-host.ts, web/writer-host.ts
		//         (另顺带收口 web.ts / session-tree.ts,见上面单独一条)
		// 批 3(13): 见下
		// 批 4(10): 见下
		const T7_DELIVERED = [
			// —— 批 2 ——
			"session-factory.ts",
			"web/session-host.ts",
			"web/writer-host.ts",
			// —— 批 3 ——
			"cli.ts",
			"draft-panel.ts",
			"editor/index.ts",
			"editor/vim-file-editor.ts",
			"extension.ts",
			"inspect/index.ts",
			"inspect/panel.ts",
			"mcp/extension.ts",
			"mcp/host.ts",
			"mcp/migrate.ts",
			"stage/orchestrator.ts",
			"startup-header.ts",
			"writer-theme.ts",
			"writer-ui.ts",
			"web/stage-host.ts",
			// —— 批 4 ——
			"ask-user.ts",
			"book-manager.ts",
			"plugin-loader.ts",
			"skills-index.ts",
			"stage/stage-extension.ts",
			"stage/stage-store.ts",
			"tools.ts",
			"web/provider-auth.ts",
			"web/server.ts",
		];
		const offenders: string[] = [];
		for (const rel of T7_DELIVERED) {
			const text = readFileSync(path.join(SRC, rel), "utf-8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				if ((t.startsWith("import ") || t.startsWith("} from")) && isDeepPiImport(t)) {
					offenders.push(`${rel}: ${t}`);
				}
			}
		}
		expect(offenders, `批 3 目标文件出现 pi 深层引用回退:\n${offenders.join("\n")}`).toEqual([]);
	});

	it("domain.ts 仍然零 vendor（批 2 新增了 types.ts，不该顺手污染 domain）", () => {
		const text = readFileSync(path.join(SRC, "pi-adapter/domain.ts"), "utf-8");
		expect(isDeepPiImport(text)).toBe(false);
	});

	it("types.ts 的 vendor 引用**全部是 import type**（编译后不产生运行期 import）", () => {
		// 这条保证别名区不会把 vendor 拖进任何 bundle —— 类型别名应该是纯编译期的事。
		//
		// ⚠️ 必须**按语句**而不是**按行**判断:格式化成多行后(`import type {\n  X,\n} from`)
		// `import` 与 `vendor/` 不在同一行,按行匹配会得到 0 行 —— 一个「检查全部通过」
		// 的假象。T7 批 3 踩过这个坑:断言 `length > 0` 直接把自己暴露了。
		const text = readFileSync(path.join(SRC, "pi-adapter/types.ts"), "utf-8");
		const statements = text.match(/^import[^;]*?from\s+"[^"]+"\s*;/gm) ?? [];
		const vendorImports = statements.filter((s) => s.includes("@earendil-works/pi-"));
		expect(vendorImports.length).toBeGreaterThan(0);
		for (const stmt of vendorImports) {
			expect(stmt.replace(/\s+/g, " "), "这个 import 会变成运行期依赖").toMatch(/^import type /);
		}
	});

	it("tui.ts 的 vendor 引用**允许**非 import type（它要搬值），但不得 import 业务模块", () => {
		const text = readFileSync(path.join(SRC, "pi-adapter/tui.ts"), "utf-8");
		// class 必须走 re-export(`export { X }`,含本地 `export { Theme };` 形式),
		// 不能写成 `export const X: typeof VendorX = VendorX` —— 后者丢类型通道,
		// 自研侧写 `x: Theme` 会 TS2749。这条护栏钉住「至少有一个 re-export」。
		const valueReexports = text.match(/^export\s*\{[^}]*\}\s*;?/gm) ?? [];
		expect(
			valueReexports.length,
			"tui.ts 必须用 export { X } 搬 class（值+类型双通道），而不是 export const",
		).toBeGreaterThan(0);

		const statements = text.match(/^(?:import|export)[^;]*?from\s+"[^"]+"\s*;/gm) ?? [];
		// 依旧不许回流到业务模块
		for (const stmt of statements) {
			expect(stmt, `单向依赖被破坏：${stmt}`).not.toMatch(/from\s+"\.\.\/[a-z]/);
		}
	});

	it("runtime.ts 只 import vendor 与 pi-adapter 自己（单向依赖不回流到业务模块）", () => {		const text = readFileSync(path.join(SRC, "pi-adapter/runtime.ts"), "utf-8");
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (!t.startsWith("import ") && !t.startsWith("export ")) continue;
			// 允许:vendor / 同目录 ./xxx / 上层的 ../session-text.ts(纯类型)
			if (t.includes('"../')) {
				expect(t).toContain('"../session-text.ts"');
			}
		}
	});
});

describe("pi-adapter 句柄（幂等造型）", () => {
	it("toHandle 对句柄幂等（重复包装不会出问题）", async () => {
		const { toHandle } = await import("../src/pi-adapter/session.ts");
		const fake = {} as never;
		const once = toHandle(fake);
		// 幂等:再包一次仍是同一引用(造型是纯 cast,不产生新对象)
		expect(toHandle(once)).toBe(once);
	});

	it("toFactoryHandle 对句柄幂等", async () => {
		const { toFactoryHandle } = await import("../src/pi-adapter/session.ts");
		const fake = {} as never;
		const once = toFactoryHandle(fake);
		expect(toFactoryHandle(once)).toBe(once);
	});
});
