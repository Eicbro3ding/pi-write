/**
 * 服务端全局设置(~/.pi/writer/settings.json)测试:临时 PI_WRITER_DIR + 真实磁盘。
 * 覆盖解析容错(损坏/版本不符/字段类型)、默认值、读改写 merge 语义。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WRITER_SETTINGS_VERSION,
	defaultWriterSettings,
	getWriterSettingsPath,
	parseWriterSettings,
	readWriterSettings,
	updateWriterSettings,
	writeWriterSettings,
} from "../src/writer-settings.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-settings-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

describe("parseWriterSettings", () => {
	it("缺省关闭经典模式,shell 方言为 auto(按平台识别)、路径为空", () => {
		expect(defaultWriterSettings()).toEqual({
			version: WRITER_SETTINGS_VERSION,
			classicMode: false,
			enableShell: false,
			shellKind: "auto",
			shellPath: "",
		});
	});

	it("版本不符/非对象/字段类型错 → 回退默认值", () => {
		expect(parseWriterSettings(null)).toEqual(defaultWriterSettings());
		expect(parseWriterSettings([])).toEqual(defaultWriterSettings());
		expect(parseWriterSettings({ version: 999, classicMode: true })).toEqual(defaultWriterSettings());
		expect(parseWriterSettings({ classicMode: true })).toEqual(defaultWriterSettings());
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, classicMode: "1" })).toEqual(defaultWriterSettings());
	});

	it("合法文件按字段还原(未知字段丢弃)", () => {
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, classicMode: true, enableShell: false, extra: 1 })).toEqual({
			version: WRITER_SETTINGS_VERSION,
			classicMode: true,
			enableShell: false,
			shellKind: "auto",
			shellPath: "",
		});
	});

	it("enableShell 缺省关闭,非法值回退关闭", () => {
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, enableShell: true }).enableShell).toBe(true);
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, enableShell: "yes" }).enableShell).toBe(false);
		// 旧文件没有这个字段:读出来必须是关闭(危险开关不能因为缺字段而默认打开)
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION }).enableShell).toBe(false);
	});

	it("shellKind 只认 auto/bash/pwsh,拼错或旧文件缺字段 → 回落 auto", () => {
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellKind: "pwsh" }).shellKind).toBe("pwsh");
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellKind: "bash" }).shellKind).toBe("bash");
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellKind: "auto" }).shellKind).toBe("auto");
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellKind: "zsh" }).shellKind).toBe("auto");
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellKind: 7 }).shellKind).toBe("auto");
		// 旧文件没这个字段:回落到 auto(平台自己认),而不是钉死 bash
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION }).shellKind).toBe("auto");
	});

	it("shellPath 去空白、非字符串回落空、超长截断", () => {
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellPath: "  C:\\pwsh.exe  " }).shellPath).toBe("C:\\pwsh.exe");
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellPath: 42 }).shellPath).toBe("");
		expect(parseWriterSettings({ version: WRITER_SETTINGS_VERSION, shellPath: "x".repeat(900) }).shellPath).toHaveLength(500);
	});
});

describe("settings.json 读写", () => {
	it("文件不存在 → 默认值(不抛错)", async () => {
		await expect(readWriterSettings()).resolves.toEqual(defaultWriterSettings());
	});

	it("写入后落盘为 JSON 且父目录自动创建", async () => {
		const written = { version: WRITER_SETTINGS_VERSION, classicMode: true, enableShell: false, shellKind: "pwsh" as const, shellPath: "C:\\pwsh.exe" };
		await writeWriterSettings(written);
		const path = getWriterSettingsPath();
		expect(path).toBe(join(tmp, "settings.json"));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(written);
		await expect(readWriterSettings()).resolves.toEqual(written);
	});

	it("损坏文件 → 默认值", async () => {
		writeFileSync(join(tmp, "settings.json"), "{ not json", "utf8");
		await expect(readWriterSettings()).resolves.toEqual(defaultWriterSettings());
	});

	it("updateWriterSettings 只改传入字段", async () => {
		await writeWriterSettings({ version: WRITER_SETTINGS_VERSION, classicMode: true, enableShell: false, shellKind: "bash", shellPath: "" });
		const same = await updateWriterSettings({});
		expect(same.classicMode).toBe(true);
		const off = await updateWriterSettings({ classicMode: false });
		expect(off.classicMode).toBe(false);
		await expect(readWriterSettings()).resolves.toEqual({ version: WRITER_SETTINGS_VERSION, classicMode: false, enableShell: false, shellKind: "bash", shellPath: "" });
	});

	it("shell 方言与路径可单独更新(与经典模式/外部命令互不干扰)", async () => {
		await updateWriterSettings({ classicMode: true });
		const withPwsh = await updateWriterSettings({ shellKind: "pwsh" });
		expect(withPwsh).toMatchObject({ classicMode: true, shellKind: "pwsh", shellPath: "" });
		const withPath = await updateWriterSettings({ shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" });
		expect(withPath).toMatchObject({ classicMode: true, shellKind: "pwsh", shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" });
		const backToBash = await updateWriterSettings({ shellKind: "bash", shellPath: "" });
		expect(backToBash).toMatchObject({ classicMode: true, shellKind: "bash", shellPath: "" });
	});

	it("两个字段互不干扰(classicMode 与 enableShell 各自独立)", async () => {
		await updateWriterSettings({ classicMode: true });
		const withShell = await updateWriterSettings({ enableShell: true });
		expect(withShell).toMatchObject({ classicMode: true, enableShell: true });
		const shellOff = await updateWriterSettings({ enableShell: false });
		expect(shellOff).toMatchObject({ classicMode: true, enableShell: false });
	});
});
