/**
 * shell 方言解析测试(src/shell-kind.ts)。
 *
 * 纯逻辑:平台/环境/文件存在性/which 全部注入,不碰真实系统——否则 CI 上
 * (Linux 无 pwsh)与开发机(Windows 装了 pwsh)会得出不同断言。
 */
import { describe, expect, it } from "vitest";
import { dialectOfPath, resolveWriterShell, SHELL_DIALECT_LABELS } from "../src/shell-kind.ts";

/** 构造注入环境:existing = 存在的文件集合,onPath = which 的结果表。 */
function deps(options: {
	platform?: NodeJS.Platform;
	existing?: string[];
	onPath?: Record<string, string>;
	env?: Record<string, string | undefined>;
}) {
	const existing = new Set(options.existing ?? []);
	const onPath = options.onPath ?? {};
	return {
		platform: options.platform ?? ("linux" as NodeJS.Platform),
		env: options.env ?? {},
		exists: (p: string) => existing.has(p),
		which: (cmd: string) => onPath[cmd] ?? null,
	};
}

describe("dialectOfPath", () => {
	it("按可执行文件名判定方言(Windows 反斜杠同样识别)", () => {
		expect(dialectOfPath("/usr/bin/bash")).toBe("bash");
		expect(dialectOfPath("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("bash");
		expect(dialectOfPath("/usr/bin/pwsh")).toBe("pwsh");
		expect(dialectOfPath("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
		expect(dialectOfPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
		// 不是已知 PowerShell 的一律按 bash 兼容壳(cygwin/msys2/sh)
		expect(dialectOfPath("/bin/sh")).toBe("bash");
	});
});

describe("resolveWriterShell · bash(缺省)", () => {
	it("不指定路径时交给 vendor 探测(path 为 undefined,保留 Cygwin 等用法)", () => {
		expect(resolveWriterShell({}, deps({}))).toEqual({ dialect: "bash" });
		expect(resolveWriterShell({ shellKind: "bash" }, deps({}))).toEqual({ dialect: "bash" });
		// 方言错误值等同缺省(解析层再兜一次底)
		expect(resolveWriterShell({ shellKind: "zsh" as never }, deps({}))).toEqual({ dialect: "bash" });
	});
});

describe("resolveWriterShell · pwsh", () => {
	it("Windows:优先标准安装目录 Program Files\\PowerShell\\7\\pwsh.exe", () => {
		const p = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const r = resolveWriterShell({ shellKind: "pwsh" }, deps({ platform: "win32", existing: [p], env: { ProgramFiles: "C:\\Program Files" } }));
		expect(r).toEqual({ dialect: "pwsh", path: p });
	});

	it("Windows:标准目录没有 → 用 PATH 上的 pwsh", () => {
		const p = "D:\\tools\\pwsh.exe";
		const r = resolveWriterShell({ shellKind: "pwsh" }, deps({ platform: "win32", existing: [p], onPath: { "pwsh.exe": p } }));
		expect(r).toEqual({ dialect: "pwsh", path: p });
	});

	it("Windows:只有系统自带 PowerShell 5.1 → 回退并带 warning(方言不同)", () => {
		const p = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		const r = resolveWriterShell({ shellKind: "pwsh" }, deps({ platform: "win32", existing: [p], onPath: { "powershell.exe": p } }));
		expect(r.dialect).toBe("powershell");
		expect(r.path).toBe(p);
		expect(r.warning).toContain("5.1");
	});

	it("Windows:都没有 → none + warning(提示词据此不要说有 shell)", () => {
		const r = resolveWriterShell({ shellKind: "pwsh" }, deps({ platform: "win32" }));
		expect(r.dialect).toBe("none");
		expect(r.path).toBeUndefined();
		expect(r.warning).toContain("未找到 PowerShell");
	});

	it("非 Windows:走 PATH 上的 pwsh;没有则 none", () => {
		expect(resolveWriterShell({ shellKind: "pwsh" }, deps({ onPath: { pwsh: "/usr/bin/pwsh" } }))).toEqual({
			dialect: "pwsh",
			path: "/usr/bin/pwsh",
		});
		expect(resolveWriterShell({ shellKind: "pwsh" }, deps({})).dialect).toBe("none");
	});
});

describe("resolveWriterShell · 显式路径(优先级最高)", () => {
	it("填了存在的路径 → 按文件判定方言(即使 shellKind 是 bash)", () => {
		const p = "C:\\cygwin64\\bin\\bash.exe";
		expect(resolveWriterShell({ shellKind: "pwsh", shellPath: p }, deps({ platform: "win32", existing: [p] }))).toEqual({
			dialect: "bash",
			path: p,
		});
		expect(resolveWriterShell({ shellKind: "bash", shellPath: "/opt/pwsh" }, deps({ existing: ["/opt/pwsh"] }))).toEqual({
			dialect: "pwsh",
			path: "/opt/pwsh",
		});
	});

	it("填了不存在的路径 → none + warning(不静默回落另一个 shell)", () => {
		const r = resolveWriterShell({ shellKind: "bash", shellPath: "C:\\nope\\pwsh.exe" }, deps({ platform: "win32" }));
		expect(r.dialect).toBe("none");
		expect(r.warning).toContain("找不到指定的 shell");
	});

	it("路径两侧空白被忽略,空串等同未填", () => {
		const r = resolveWriterShell({ shellKind: "pwsh", shellPath: "  /usr/bin/pwsh  " }, deps({ existing: ["/usr/bin/pwsh"] }));
		expect(r).toEqual({ dialect: "pwsh", path: "/usr/bin/pwsh" });
		expect(resolveWriterShell({ shellKind: "bash", shellPath: "   " }, deps({})).dialect).toBe("bash");
	});
});

describe("SHELL_DIALECT_LABELS", () => {
	it("四种方言都有展示名(设置页/诊断用)", () => {
		expect(Object.keys(SHELL_DIALECT_LABELS).sort()).toEqual(["bash", "none", "powershell", "pwsh"]);
	});
});
