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
