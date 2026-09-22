/**
 * pi-writer 全局设置(~/.pi/writer/settings.json)。
 *
 * 与 setup.json(向导完成状态)、plugin-state.json(插件启停)同级:只存
 * 「影响服务端装配」的少量开关。放服务端而非浏览器 localStorage,原因与向导
 * 状态一致——换浏览器/清缓存/无痕模式不丢,多窗口(Electron + 浏览器 +
 * Android 壳)状态一致,且服务端重启后装配结果不会与界面显示分叉。
 *
 * 当前设置项:
 * - **classicMode(经典模式)**:单 agent 模式——界面上只有编辑页(隐藏舞台与
 *   世界书),编辑页的 AI 不再是受限编剧,而是带全量工具的写作 agent。切换后
 *   已建会话必须重建,新工具集才生效(server 侧 PUT 时释放 WriterHost 会话)。
 * - **enableShell(外部命令)**:放开 agent 的 shell 工具;缺省关闭(风险自担)。
 * - **shellKind / shellPath**:shell 方言(auto 按平台识别 / bash / pwsh)与显式可执行文件路径。
 *   选 pwsh 时实际执行的是 PowerShell 语法,提示词按方言叙述(见 shell-kind.ts)。
 * - **enableImageGen + image*(实验,0.1.0)**:允许 AI 调图片模型(回复嵌图 / 世界书配图)。
 *   缺省关闭 —— 它不扩大文件边界,而是把提示词与参考图发给第三方服务(可能计费),所以
 *   走实验开关,且「每次生成前先确认」默认开着。密钥只存本机。
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
import type { ShellKind } from "./shell-kind.ts";

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
	/**
	 * shell 方言(enableShell 打开时用哪个 shell 执行):`bash`(缺省)或 `pwsh`。
	 *
	 * vendor 的 shell 通道是 bash 专用的(Windows 上只找 Git Bash),这里选 pwsh 时
	 * 由 src/shell-kind.ts 解析出 pwsh 路径并经 shellPath 交给 vendor —— 实际执行的是
	 * PowerShell 语法,提示词会按方言叙述(否则模型仍写 bash 语法,必然报错)。
	 */
	shellKind: ShellKind;
	/**
	 * 显式 shell 可执行文件路径;空 = 自动(见 src/shell-kind.ts 的解析顺序)。
	 * 也用于 bash 用户指定 Cygwin/MSYS2 的 bash.exe。
	 */
	shellPath: string;
	// —— 图片生成(实验,0.1.0 / 2026-09-22)——
	/**
	 * 允许 AI 调用图片模型:回复里嵌图、更新世界书条目时写配图。
	 *
	 * 缺省**关闭**。理由与 enableShell 同款但方向不同:它不扩大文件访问边界,
	 * 而是把**提示词与参考图发给第三方服务**,可能直接产生费用。所以要走实验开关,
	 * 且"每次生成前先确认"默认开着。
	 */
	enableImageGen: boolean;
	/** 图片接口形态(目前只认 OpenAI 兼容的 images 端点)。 */
	imageProvider: ImageProvider;
	/** 图片模型名(gpt-image-1 / dall-e-3 / 自建端点的模型名)。 */
	imageModel: string;
	/** 默认出图尺寸档位;请求时按 IMAGE_SIZE_PX 换算成像素。 */
	imageSize: ImageSize;
	/** 图片端点基址;空 = 用 provider 的官方地址。 */
	imageBaseUrl: string;
	/** 图片接口密钥。**只存在本机**,生成请求由服务端直发,不经 pi-writer 服务器。 */
	imageApiKey: string;
	/** 允许 AI 在回复正文里嵌图。 */
	imageInReply: boolean;
	/** 允许 AI 更新世界书条目时写入配图。 */
	imageWorldbook: boolean;
	/** 每次生成前先确认(避免意外消耗额度)。 */
	imageConfirmBeforeGen: boolean;
}

/** 图片接口形态。目前只有一种;留成联合类型是为了加第二种时不必改调用方。 */
export type ImageProvider = "openai-images";

/** 出图尺寸档位(设计稿 ★设置 v2 · 实验)。 */
export type ImageSize = "1:1" | "3:2" | "16:9";

/**
 * 尺寸档位 → 像素。取的是图片接口**真认的值**:
 * gpt-image-1 支持 1024x1024 / 1536x1024 / 1024x1536,dall-e-3 支持 1024x1024 /
 * 1792x1024 / 1024x1792。这里都取横向那一档(写作配图基本是场景图)。
 * 设计稿画的「1024 × 683」不是任何一家接口的合法值,所以按实际值来,
 * 界面上显示的也是这里的像素。
 */
export const IMAGE_SIZE_PX: Record<ImageSize, string> = {
	"1:1": "1024x1024",
	"3:2": "1536x1024",
	"16:9": "1792x1024",
};

/** 默认设置(缺省:多 agent 形态、无外部命令、bash、图片生成关闭)。 */
export function defaultWriterSettings(): WriterSettings {
	return {
		version: WRITER_SETTINGS_VERSION,
		classicMode: false,
		enableShell: false,
		shellKind: "auto",
		shellPath: "",
		// 图片生成:能力默认**关**(设计稿页头自己也写着「实验开关默认关闭」;
		// 画板里开关是开的,那是演示态)。三个「允许时机」默认开 —— 一旦启用就按
		// 完整设计意图工作,而不是启用后还要再拨三个开关
		enableImageGen: false,
		imageProvider: "openai-images",
		imageModel: "gpt-image-1",
		imageSize: "3:2",
		imageBaseUrl: "",
		imageApiKey: "",
		imageInReply: true,
		imageWorldbook: true,
		imageConfirmBeforeGen: true,
	};
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
	// 枚举字段只认合法值(shellKind 拼错 → 回落 bash,而不是把未知值带进装配)
	if (obj.shellKind === "auto" || obj.shellKind === "bash" || obj.shellKind === "pwsh") out.shellKind = obj.shellKind;
	// 路径字段只认字符串并去空白;上限防手写文件塞入超长值
	if (typeof obj.shellPath === "string") out.shellPath = obj.shellPath.trim().slice(0, 500);
	// 图片生成(实验)。密钥同样只认字符串并限长 —— 它是本机凭证,不回显、不进日志
	if (typeof obj.enableImageGen === "boolean") out.enableImageGen = obj.enableImageGen;
	if (obj.imageProvider === "openai-images") out.imageProvider = obj.imageProvider;
	if (typeof obj.imageModel === "string") out.imageModel = obj.imageModel.trim().slice(0, 200);
	if (obj.imageSize === "1:1" || obj.imageSize === "3:2" || obj.imageSize === "16:9") out.imageSize = obj.imageSize;
	if (typeof obj.imageBaseUrl === "string") out.imageBaseUrl = obj.imageBaseUrl.trim().slice(0, 500);
	if (typeof obj.imageApiKey === "string") out.imageApiKey = obj.imageApiKey.trim().slice(0, 500);
	if (typeof obj.imageInReply === "boolean") out.imageInReply = obj.imageInReply;
	if (typeof obj.imageWorldbook === "boolean") out.imageWorldbook = obj.imageWorldbook;
	if (typeof obj.imageConfirmBeforeGen === "boolean") out.imageConfirmBeforeGen = obj.imageConfirmBeforeGen;
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
		...(patch.shellKind !== undefined ? { shellKind: patch.shellKind } : {}),
		...(patch.shellPath !== undefined ? { shellPath: patch.shellPath } : {}),
		...(patch.enableImageGen !== undefined ? { enableImageGen: patch.enableImageGen } : {}),
		...(patch.imageProvider !== undefined ? { imageProvider: patch.imageProvider } : {}),
		...(patch.imageModel !== undefined ? { imageModel: patch.imageModel } : {}),
		...(patch.imageSize !== undefined ? { imageSize: patch.imageSize } : {}),
		...(patch.imageBaseUrl !== undefined ? { imageBaseUrl: patch.imageBaseUrl } : {}),
		...(patch.imageApiKey !== undefined ? { imageApiKey: patch.imageApiKey } : {}),
		...(patch.imageInReply !== undefined ? { imageInReply: patch.imageInReply } : {}),
		...(patch.imageWorldbook !== undefined ? { imageWorldbook: patch.imageWorldbook } : {}),
		...(patch.imageConfirmBeforeGen !== undefined
			? { imageConfirmBeforeGen: patch.imageConfirmBeforeGen }
			: {}),
	};
	await writeWriterSettings(next);
	return next;
}
