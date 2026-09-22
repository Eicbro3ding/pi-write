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
			// 图片生成(实验,0.1.0):能力默认关、接入配置留空、三个「允许时机」默认开
			enableImageGen: false,
			imageProvider: "openai-images",
			imageModel: "gpt-image-1",
			imageSize: "3:2",
			imageBaseUrl: "",
			imageApiKey: "",
			imageInReply: true,
			imageWorldbook: true,
			imageConfirmBeforeGen: true,
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
			...defaultWriterSettings(),
			classicMode: true,
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
		const written = { ...defaultWriterSettings(), classicMode: true, shellKind: "pwsh" as const, shellPath: "C:\\pwsh.exe" };
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
		await writeWriterSettings({ ...defaultWriterSettings(), classicMode: true, shellKind: "bash" });
		const same = await updateWriterSettings({});
		expect(same.classicMode).toBe(true);
		const off = await updateWriterSettings({ classicMode: false });
		expect(off.classicMode).toBe(false);
		await expect(readWriterSettings()).resolves.toEqual({ ...defaultWriterSettings(), classicMode: false, shellKind: "bash" });
	});

	it("图片生成(实验)字段可单独更新,且不影响其他开关", async () => {
		await updateWriterSettings({ classicMode: true });
		const on = await updateWriterSettings({ enableImageGen: true, imageModel: "dall-e-3", imageSize: "16:9" });
		expect(on).toMatchObject({ classicMode: true, enableImageGen: true, imageModel: "dall-e-3", imageSize: "16:9" });
		// 密钥/端点这类字符串字段照旧透传
		const withKey = await updateWriterSettings({ imageBaseUrl: "https://api.example.com/v1", imageApiKey: "sk-test" });
		expect(withKey).toMatchObject({ imageBaseUrl: "https://api.example.com/v1", imageApiKey: "sk-test" });
		// 关掉能力不动配置(下次开还是这套)
		const off = await updateWriterSettings({ enableImageGen: false });
		expect(off).toMatchObject({ enableImageGen: false, imageModel: "dall-e-3" });
	});

	it("图片生成字段的非法值被丢弃(回落默认),而旧文件缺字段也取默认", () => {
		// 旧文件(0.0.x)没有这些字段:能力必须是关的,不能因为缺字段而默认打开
		const legacy = parseWriterSettings({ version: WRITER_SETTINGS_VERSION });
		expect(legacy.enableImageGen).toBe(false);
		expect(legacy.imageSize).toBe("3:2");
		// 非法枚举/类型一律回落,不把未知值带进装配
		const bad = parseWriterSettings({
			version: WRITER_SETTINGS_VERSION,
			enableImageGen: "yes",
			imageSize: "21:9",
			imageProvider: "midjourney",
			imageModel: 42,
		});
		expect(bad.enableImageGen).toBe(false);
		expect(bad.imageSize).toBe("3:2");
		expect(bad.imageProvider).toBe("openai-images");
		expect(bad.imageModel).toBe("gpt-image-1");
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
