/**
 * pi-writer 全局设置(~/.pi/writer/settings.json)。
 *
 * 与 setup.json(向导完成状态)、plugin-state.json(插件启停)同级:只存
 * 「影响服务端装配」的少量开关。放服务端而非浏览器 localStorage,原因与向导
 * 状态一致——换浏览器/清缓存/无痕模式不丢,多窗口(Electron + 浏览器 +
 * Android 壳)状态一致,且服务端重启后装配结果不会与界面显示分叉。
 *
 * 当前唯一设置项:
 * - **classicMode(经典模式)**:单 agent 模式——界面上只有编辑页(隐藏舞台与
 *   世界书),编辑页的 AI 不再是受限编剧,而是带全量工具的写作 agent。切换后
 *   已建会话必须重建,新工具集才生效(server 侧 PUT 时释放 WriterHost 会话)。
 *
 * 纯展示类偏好(简化输出/自动展开思考/编辑免确认)仍留在浏览器 localStorage,
 * 它们不影响服务端装配,不需要跨设备一致。
 *
 * 写盘走 atomicWriteFile(与其他 writer 数据文件同款 tmp+rename)。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWriterDir } from "./config.ts";
import { atomicWriteFile } from "./atomic-write.ts";

/**
 * 结构版本。字段不兼容变更时递增:读到的 version 与当前不符(过新/缺失/非数字)
 * 一律按默认值处理——代价是重置一个布尔开关,远低于按错误结构解析的风险。
 */
export const WRITER_SETTINGS_VERSION = 1;

/** 全局设置结构。 */
export interface WriterSettings {
	version: number;
	/** 经典模式:单 agent(只有编辑页),写作 agent 带全量工具;缺省关闭。 */
	classicMode: boolean;
	/**
	 * 外部命令(bash):允许 agent 在书目录外执行 shell 命令;缺省**关闭**。
	 *
	 * 这是唯一一条会把边界从"书目录"扩大到"整台机器"的开关:命令以服务进程
	 * 的权限运行,工具路径守卫对它无效(它不经过 read/write 那套校验)。
	 * 因此默认关、设置页要经风险确认才能开,并保证命令与输出在界面上实时可见。
	 */
	enableShell: boolean;
}

/** 默认设置(缺省:多 agent 形态、无外部命令)。 */
export function defaultWriterSettings(): WriterSettings {
	return { version: WRITER_SETTINGS_VERSION, classicMode: false, enableShell: false };
}

/**
 * 解析 settings.json 内容:非对象/版本不符 → 默认值;逐字段类型校验,
 * 未知键丢弃(手写或旧版文件不会把服务端带进未知装配)。
 */
export function parseWriterSettings(raw: unknown): WriterSettings {
	const out = defaultWriterSettings();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number" || obj.version !== WRITER_SETTINGS_VERSION) return out;
	if (typeof obj.classicMode === "boolean") out.classicMode = obj.classicMode;
	if (typeof obj.enableShell === "boolean") out.enableShell = obj.enableShell;
	return out;
}

/** settings.json 路径(~/.pi/writer/settings.json;PI_WRITER_DIR 可整体迁移)。 */
export function getWriterSettingsPath(): string {
	return join(getWriterDir(), "settings.json");
}

/**
 * 读取全局设置。文件不存在/损坏/版本不符 → 默认值,不抛错——
 * 设置读取失败不应挡住服务启动。
 */
export async function readWriterSettings(): Promise<WriterSettings> {
	try {
		const text = await readFile(getWriterSettingsPath(), "utf8");
		return parseWriterSettings(JSON.parse(text) as unknown);
	} catch {
		return defaultWriterSettings();
	}
}

/** 写入全局设置(原子写;父目录自动创建)。 */
export async function writeWriterSettings(settings: WriterSettings): Promise<void> {
	await atomicWriteFile(
		getWriterSettingsPath(),
		`${JSON.stringify({ ...settings, version: WRITER_SETTINGS_VERSION }, null, 2)}\n`,
	);
}

/** 读改写:只更新传入字段(未传字段保留当前值),返回落盘后的完整设置。 */
export async function updateWriterSettings(patch: Partial<Omit<WriterSettings, "version">>): Promise<WriterSettings> {
	const current = await readWriterSettings();
	const next: WriterSettings = {
		...current,
		...(patch.classicMode !== undefined ? { classicMode: patch.classicMode } : {}),
		...(patch.enableShell !== undefined ? { enableShell: patch.enableShell } : {}),
	};
	await writeWriterSettings(next);
	return next;
}
