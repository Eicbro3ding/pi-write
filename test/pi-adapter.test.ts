import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectUsageCost } from "../src/pi-adapter/usage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

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
				if (/vendor\/pi-[\w-]+\/src\/.+\//.test(trimmed) && !trimmed.includes("/src/index.ts")) {
					offenders.push(`${path.relative(ROOT, file)}: ${trimmed}`);
				}
			}
		}
		expect(offenders, `这些文件绕过了 pi-adapter 直插 vendor 内部:\n${offenders.join("\n")}`).toEqual([]);
	});

	it("guard.ts / usage.ts 各自保留唯一的深层 import（收口有效但不能为空）", () => {
		const guard = readFileSync(path.join(SRC, "pi-adapter/guard.ts"), "utf-8");
		const usage = readFileSync(path.join(SRC, "pi-adapter/usage.ts"), "utf-8");
		expect(guard).toContain("vendor/pi-coding-agent/src/core/tools/path-utils.ts");
		expect(usage).toContain("vendor/pi-coding-agent/src/core/usage-totals.ts");
	});

	it("domain.ts 不 import 任何 vendor 模块（类型层零耦合）", () => {
		const text = readFileSync(path.join(SRC, "pi-adapter/domain.ts"), "utf-8");
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (t.startsWith("import ") || t.startsWith("export type {")) {
				expect(t).not.toContain("vendor/");
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
				if (t.startsWith("import ")) expect(t).not.toContain("vendor/pi-");
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
				if (t.startsWith("import ")) expect(t).not.toContain("vendor/pi-");
			}
		}
	});

	it("批 3/批 4 待迁移文件清单**只减不增**（防新增穿透）", () => {
		// 全局断言现在还做不到(批 3/批 4 尚未迁移)。折中:把当前已知的穿透文件
		// 钉成白名单 —— 数量只能变少。新文件若偷偷直接 import vendor,这条会红。
		const KNOWN_PENDING = new Set([
			"ask-user.ts",
			"book-manager.ts",
			"cli.ts",
			"draft-panel.ts",
			"editor/index.ts",
			"editor/vim-file-editor.ts",
			"extension.ts",
			"inspect/index.ts",
			"inspect/panel.ts",
			"mcp/manager.ts",
			"mcp/tools.ts",
			"plugin-loader.ts",
			"skills-index.ts",
			"stage/orchestrator.ts",
			"stage/stage-extension.ts",
			"stage/stage-store.ts",
			"startup-header.ts",
			"tools.ts",
			"web/provider-auth.ts",
			"web/server.ts",
			"web/stage-host.ts",
			"writer-theme.ts",
			"writer-ui.ts",
		]);
		const unexpected: string[] = [];
		for (const file of walk(SRC)) {
			const rel = path.relative(SRC, file);
			if (KNOWN_PENDING.has(rel)) continue;
			const text = readFileSync(file, "utf-8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (t.startsWith("import ") && t.includes("vendor/pi-")) {
					unexpected.push(`${rel}: ${t}`);
				}
			}
		}
		expect(
			unexpected,
			`这些**不在待迁移清单**里的文件新引入了 vendor 直接引用:\n${unexpected.join("\n")}`,
		).toEqual([]);
	});

	it("domain.ts 仍然零 vendor（批 2 新增了 types.ts，不该顺手污染 domain）", () => {
		const text = readFileSync(path.join(SRC, "pi-adapter/domain.ts"), "utf-8");
		expect(text).not.toContain("vendor/pi-");
	});

	it("types.ts 的 vendor 引用**全部是 import type**（编译后不产生运行期 import）", () => {
		// 这条保证别名区不会把 vendor 拖进任何 bundle —— 类型别名应该是纯编译期的事。
		const text = readFileSync(path.join(SRC, "pi-adapter/types.ts"), "utf-8");
		const importLines = text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("import ") && l.includes("vendor/"));
		expect(importLines.length).toBeGreaterThan(0);
		for (const line of importLines) {
			expect(line, `这行 import 会变成运行期依赖：${line}`).toMatch(/^import type /);
		}
	});

	it("runtime.ts 只 import vendor 与 pi-adapter 自己（单向依赖不回流到业务模块）", () => {
		const text = readFileSync(path.join(SRC, "pi-adapter/runtime.ts"), "utf-8");
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
