/**
 * shell 方言解析 —— pi-write 侧唯一实现(2026-09-18)。
 *
 * 背景:vendor 的 shell 通道是 bash 专用的——`getShellConfig()` 在 Windows 只找
 * Git Bash(找不到就抛错),spawn 形态写死 `["-c"]`。但它的 `shellPath` 设置会走
 * `getBashShellConfig()` → 仍是 `["-c"]`,而 PowerShell 的 `-Command` 恰好可缩写为
 * `-c`(微软文档 `-Command | -c`),所以把 `shellPath` 指向 pwsh.exe 能真的执行
 * PowerShell 代码。本模块负责两件事:
 *
 * 1. 按用户设置解析出实际要用的 shell(纯函数,依赖可注入 → 可单测);
 * 2. 告诉提示词该用哪种方言叙述这个工具(提示词里工具名仍叫 `bash`,必须点明)。
 *
 * ⚠️ 退出码语义(提示词必须说清,否则模型会误判):`pwsh -Command` 的进程退出码
 * 只有 0/1,原生程序(如 grep 无匹配的 exit 1)的退出码会被折算成 1,除非命令末尾
 * 自己 `exit $LASTEXITCODE`。vendor 的 bash 工具把 `{exitCode}` 交给模型判断成败。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/**
 * 用户可选的 shell 类型(setting 里的枚举值)。
 *
 * `"auto"`(缺省)= **按平台自动识别**:Windows 上优先 PowerShell(pwsh → 5.1),
 * 其余平台用 bash。显式选 bash / pwsh 时仍按显式走,不动。
 */
export type ShellKind = "auto" | "bash" | "pwsh";

/** 实际解析出的方言:"none" = 声明要 shell 但没找到可用的。 */
export type ShellDialect = "none" | "bash" | "pwsh" | "powershell";

/** 解析结果。 */
export interface ResolvedShell {
	dialect: ShellDialect;
	/**
	 * 传给 vendor `settingsManager.shellPath` 的值。
	 * undefined = 不动该设置,由 vendor 自行解析(bash 的 Git Bash / /bin/bash 探测链)。
	 */
	path?: string;
	/** 非致命提示(只找到 PowerShell 5.1、找不到指定 shell 等),供设置页展示。 */
	warning?: string;
}

/** 解析所需的用户设置子集(WriterSettings 的结构子集)。 */
export interface WriterShellSettings {
	shellKind?: ShellKind;
	/** 显式可执行文件路径;空 = 自动。 */
	shellPath?: string;
}

/** 可注入依赖(测试用;缺省打真实环境)。 */
export interface ShellResolveDeps {
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	exists?: (path: string) => boolean;
	/** 等价于 which/where:返回首个命中路径,没有返回 null。 */
	which?: (cmd: string) => string | null;
}

/** 展开开头的 ~ ;其余原样(Windows 路径不做规范化,交给 vendor)。 */
function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return `${homedir()}${path.slice(1)}`;
	return path;
}

/** 由可执行文件名判定方言:不是 pwsh/powershell 的一律按 bash 兼容壳处理(cygwin/msys2/sh)。 */
export function dialectOfPath(path: string): ShellDialect {
	const base = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
	if (base === "pwsh" || base === "pwsh.exe") return "pwsh";
	if (base === "powershell" || base === "powershell.exe") return "powershell";
	return "bash";
}

/** 默认 which/where 实现(与 vendor 的探测口径一致:验证文件确实存在)。 */
function defaultWhich(cmd: string, platform: NodeJS.Platform): string | null {
	try {
		const finder = platform === "win32" ? "where" : "which";
		const result = spawnSync(finder, [cmd], { encoding: "utf-8", timeout: 5000, windowsHide: true });
		if (result.status === 0 && result.stdout) {
			const first = result.stdout.trim().split(/\r?\n/)[0];
			if (first) return first;
		}
	} catch {
		/* 探测失败按"没有"处理 */
	}
	return null;
}

/**
 * 找 PowerShell。顺序:标准安装目录(Program Files\PowerShell\7)→ PATH 上的 pwsh
 * → 回退 Windows PowerShell 5.1(系统自带,方言不同,给 warning)。
 * @returns 找到的方言与路径;都没有返回 null。
 */
function findPowerShell(
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>,
	exists: (path: string) => boolean,
	which: (cmd: string) => string | null,
): ResolvedShell | null {
	if (platform === "win32") {
		for (const dir of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
			if (!dir) continue;
			const candidate = `${dir}\\PowerShell\\7\\pwsh.exe`;
			if (exists(candidate)) return { dialect: "pwsh", path: candidate };
		}
		const onPath = which("pwsh.exe");
		if (onPath && exists(onPath)) return { dialect: "pwsh", path: onPath };
		const legacy = which("powershell.exe");
		if (legacy && exists(legacy)) {
			return {
				dialect: "powershell",
				path: legacy,
				warning: "只找到 Windows PowerShell 5.1:不支持 && / ||,部分 7.x 语法不可用",
			};
		}
		return null;
	}
	// 非 Windows:pwsh 可能装在 PATH(如 Linux/macOS 的 PowerShell 7)
	const onPath = which("pwsh");
	if (onPath) return { dialect: "pwsh", path: onPath };
	return null;
}

/**
 * 解析当前设置下实际生效的 shell。
 *
 * - 填了 `shellPath`:按该文件判定方言(bash/pwsh/powershell);文件不存在 → none + warning。
 * - `shellKind: "bash"`(缺省):返回 `{ dialect: "bash" }` 且**不带 path** —— 让 vendor
 *   走它自己的探测链(Git Bash → PATH bash → /bin/bash → sh),保留 Cygwin/MSYS2 等用法。
 * - `shellKind: "pwsh"`:探测 pwsh;找不到 → none + warning(提示词据此不要说有 shell)。
 */
export function resolveWriterShell(settings: WriterShellSettings, deps: ShellResolveDeps = {}): ResolvedShell {
	const platform = deps.platform ?? process.platform;
	const exists = deps.exists ?? existsSync;
	const which = deps.which ?? ((cmd: string) => defaultWhich(cmd, platform));
	const env = deps.env ?? process.env;

	const custom = (settings.shellPath ?? "").trim();
	if (custom) {
		const abs = expandHome(custom);
		if (!exists(abs)) return { dialect: "none", warning: `找不到指定的 shell:${custom}` };
		return { dialect: dialectOfPath(abs), path: abs };
	}

	const kind = settings.shellKind ?? "auto";

	// 按平台自动识别:Windows 上没有原生 bash,先用 PowerShell;其余平台 bash 是本地常识
	if (kind === "auto") {
		if (platform !== "win32") return { dialect: "bash" };
		const auto = findPowerShell(platform, env, exists, which);
		if (auto) return auto;
		// 没找到任何 PowerShell:回落到 bash 让 vendor 去探 Git Bash —— 但不能
		// 只说「用 bash」,Windows 上没装 Git Bash 时它会直接抛错,得先提醒
		return {
			dialect: "bash",
			warning: "未检测到 PowerShell,按 bash 方言处理(Windows 上需要已安装 Git Bash;也可在设置里指定 pwsh 或 bash.exe 路径)",
		};
	}

	if (kind !== "pwsh") return { dialect: "bash" };

	const found = findPowerShell(platform, env, exists, which);
	if (found) return found;
	return {
		dialect: "none",
		warning: "未找到 PowerShell:请安装 PowerShell 7(pwsh),或在设置里填写 pwsh 可执行文件路径",
	};
}

/** 设置页里的方言选项名(与 web/src/types.ts 的 ShellKindDto 同集合)。 */
export const SHELL_KIND_LABELS: Record<ShellKind, string> = {
	auto: "自动(按平台识别)",
	bash: "bash",
	pwsh: "PowerShell",
};

/** 设置页/诊断用的方言名称。 */
export const SHELL_DIALECT_LABELS: Record<ShellDialect, string> = {
	none: "无 shell",
	bash: "bash",
	pwsh: "PowerShell 7(pwsh)",
	powershell: "Windows PowerShell 5.1",
};
