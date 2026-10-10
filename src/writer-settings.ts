/**
 * pi-writer 全局设置(~/.pi/writer/settings.json)。
 *
 * 与 setup.json(向导完成状态)、plugin-state.json(插件启停)同级:只存
 * 「影响服务端装配」的少量开关。放服务端而非浏览器 localStorage,原因与向导
 * 状态一致——换浏览器/清缓存/无痕模式不丢,多窗口(Electron + 浏览器 +
 * Android 壳)状态一致,且服务端重启后装配结果不会与界面显示分叉。
 *
 * 当前设置项:
 * - **classicMode(经典模式)**:单 agent 模式——隐藏舞台(导演/演员/旁白那套多 agent
 *   共演),编辑页的 AI 不再是受限编剧,而是带全量工具的写作 agent。**缺省开启**
 *   (2026-10-02 翻转:多 agent 那套需要用户理解"导演/演员/编剧"的分工,新用户更容易
 *   卡在第一步;单 agent 只有一个对话口,先能写起来更重要)。切换后已建会话必须重建,
 *   新工具集才生效(server 侧 PUT 时释放 WriterHost 会话)。
 * - **conversationScope(对话与章节的关系)**:`"chapter"`(缺省)= 一段对话绑一章,
 *   新章节就是新对话(会话文件 `writer-<章节>.jsonl`);`"book"` = 章节与对话各聊各的,
 *   对话可以不看章节自由新建,AI 也能编辑任意章节的正文。**缺省 chapter 是为了不替
 *   老用户改变行为**——老安装的会话文件、前端调用方式、事件过滤全都建立在「一段对话
 *   一章」上,直接翻默认等于悄悄换掉他们的对话历史归属;想要分离形态的用户在设置页
 *   显式打开即可。切换时同样释放已建会话(两种形态的装配与身份规则都不同)。
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
	/** 经典模式:单 agent(只有编辑页),写作 agent 带全量工具;**缺省开启**(2026-10-02)。 */
	classicMode: boolean;
	/**
	 * 对话与章节的关系(**缺省 "chapter"**,不替老用户改行为):
	 * - `"chapter"`:一段对话绑一章,新章节就是新对话(现状);
	 * - `"book"`:章节与对话分离——对话可自由新建、与章节无关,对话里的 AI 可编辑任意章节。
	 */
	conversationScope: ConversationScope;
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

	// —— 上下文预算(2026-10-04)——
	//
	// 此前这五项是 src/world-context.ts 里的硬编码常量(DEFAULT_CONTEXT_BUDGET
	// 等),用户完全无法调整、裁切过程也不可感知。这里把它们全部改为可配置:
	// 默认值沿用原常量,因此**未改过设置的安装行为逐字不变**。
	//
	// 为什么必须有:写作者的正文长度、世界观复杂度差异极大,一个写短篇的人被
	// 2000 token 的背景包卡住、一个写百万字长篇的人又嫌太小,写死必然有一方受损。
	/** 单次注入的背景包 token 预算(原 DEFAULT_CONTEXT_BUDGET,默认 2000)。 */
	contextBudget: number;
	/** 跨章节记忆 memory.md 注入的 token 预算(原 DEFAULT_MEMORY_BUDGET,默认 1500)。 */
	memoryBudget: number;
	/** 关联激活深度(0 = 关闭,仅关键词命中;1-3 = 多源 BFS 展开邻居)。 */
	activationDepth: number;
	/** Notice 备忘录注入上限(只注入未完成项,防上下文膨胀)。 */
	noticeInjectLimit: number;
	/** 已完成里程碑(发展线 done 节点)注入上限。 */
	completedMilestoneLimit: number;

	// —— 自定义系统提示词(2026-10-10)——
	//
	// 两段**整段替换**型覆盖:非空 = 完全顶替 prompts/ 里那份内置提示词;
	// 空串(缺省)= 用内置的。为什么不做「追加一段」:内置提示词里
	// 「你绝不做的事」「散文只有一个落点」这类硬约束是保证不越权的底线,
	// 追加型覆盖会让用户以为自己能改而实际改不掉;整段替换把控制权交全,
	// 代价是用户删掉约束后模型行为不受保护 —— 设置页的说明里写清这一点。
	//
	// 不递增 WRITER_SETTINGS_VERSION:旧文件缺字段 → 空串 → 走内置(行为不变)。
	/** 主写作 agent(writer-main)的整段替换提示词;空 = 用内置。 */
	customWriterPrompt: string;
	/** 常驻编剧(writer-editor)的整段替换提示词;空 = 用内置。 */
	customEditorPrompt: string;
}

/** 图片接口形态。目前只有一种;留成联合类型是为了加第二种时不必改调用方。 */
export type ImageProvider = "openai-images";

/**
 * 对话与章节的关系(见 WriterSettings.conversationScope)。
 *
 * 加字段是**追加式变更**:不递增 WRITER_SETTINGS_VERSION —— 旧文件缺这个字段时
 * 按默认值("chapter")解析(与 setup.json 加步骤同一风格);只有整个结构不兼容
 * 才动版本号。
 */
export type ConversationScope = "chapter" | "book";

/** 出图尺寸档位。 */
export type ImageSize = "1:1" | "3:2" | "16:9";

/**
 * 尺寸档位 → 像素。取的是图片接口**真认的值**:
 * gpt-image-1 支持 1024x1024 / 1536x1024 / 1024x1536,dall-e-3 支持 1024x1024 /
 * 1792x1024 / 1024x1792。这里都取横向那一档(写作配图基本是场景图)。
 * 「1024 × 683」不是任何一家接口的合法值,所以按实际值来,
 * 界面上显示的也是这里的像素。
 */
export const IMAGE_SIZE_PX: Record<ImageSize, string> = {
	"1:1": "1024x1024",
	"3:2": "1536x1024",
	"16:9": "1792x1024",
};

/**
 * 默认设置(缺省:单 Agent 经典模式、无外部命令、bash、图片生成关闭)。
 *
 * ⚠️ `classicMode` 的默认值有**两份**,必须同步翻转:这里(服务端权威)与
 * `web/src/settings.ts` 的 `parseClassicMode`(浏览器首帧缓存,读不到服务端就按它渲染)。
 * 只改一处会让界面先画出舞台入口再收回。`test/settings.test.ts` 有一条护栏比对两者。
 *
 * 已经有 `settings.json` 的安装不受影响 —— 文件里 `classicMode` 是显式值,解析时覆盖默认;
 * 只有「从未写过 settings.json」的安装(即从没动过任何服务端设置)会跟着新默认走。
 */
export function defaultWriterSettings(): WriterSettings {
	return {
		version: WRITER_SETTINGS_VERSION,
		classicMode: true,
		// 对话与章节绑定(现状):老用户升级后行为逐字不变,分离形态由用户显式开启
		conversationScope: "chapter",
		enableShell: false,
		shellKind: "auto",
		shellPath: "",
		// 图片生成:能力默认**关**(页头自己也写着「实验开关默认关闭」;
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
		// 上下文预算:默认值与原 world-context.ts 的常量**逐一对应**,保证行为不变
		contextBudget: 2000,
		memoryBudget: 1500,
		activationDepth: 0,
		noticeInjectLimit: 10,
		completedMilestoneLimit: 6,
		// 自定义系统提示词:默认空 = 用内置(未动过设置的安装行为逐字不变)
		customWriterPrompt: "",
		customEditorPrompt: "",
	};
}

/** 数值字段的钳制:非整数/越界/非数字 → 回落默认值(见 parseWriterSettings)。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

/**
 * 自定义系统提示词的长度上限(字符)。20 万字符 ≈ 10 万 token 量级,远超任何
 * 现实写法的提示词;设上限只为挡住手写文件/坏前端塞进来的超长值(它每轮都进
 * 上下文,超长值会让每次对话都爆预算)。
 */
export const CUSTOM_PROMPT_MAX_CHARS = 200_000;

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
	// 对话与章节的关系:枚举只认合法值——旧文件缺字段 / 拼错 → 回落 "chapter"(现状),
	// 不能因为缺字段就把老用户的对话归属换成别的形态
	if (obj.conversationScope === "chapter" || obj.conversationScope === "book") out.conversationScope = obj.conversationScope;
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
	// 上下文预算:数值一律钳制在合理区间(手写文件塞负数/超大值不应破坏装配)。
	// 上限取 20000 是因为最大的模型上下文也不过 20 万 token,单包背景超过这个数
	// 已无意义;下限保证「至少能塞进一条设定」。
	out.contextBudget = clampInt(obj.contextBudget, 200, 20000, 2000);
	out.memoryBudget = clampInt(obj.memoryBudget, 100, 20000, 1500);
	out.activationDepth = clampInt(obj.activationDepth, 0, 5, 0);
	out.noticeInjectLimit = clampInt(obj.noticeInjectLimit, 0, 50, 10);
	out.completedMilestoneLimit = clampInt(obj.completedMilestoneLimit, 0, 30, 6);
	// 自定义系统提示词:只认字符串并限长。**不做 trim 判空以外的事** ——
	// 提示词里的前导/尾随空白是用户排版的一部分,裁掉等于改他的稿。
	// 纯空白视为「没写」(否则用户清空后以为回到内置,实际拿到一段空白提示词)。
	if (typeof obj.customWriterPrompt === "string") out.customWriterPrompt = clampPrompt(obj.customWriterPrompt);
	if (typeof obj.customEditorPrompt === "string") out.customEditorPrompt = clampPrompt(obj.customEditorPrompt);
	return out;
}

/** 自定义提示词的归一:超长截断;纯空白 → 空串(= 用内置)。 */
function clampPrompt(value: string): string {
	if (value.trim().length === 0) return "";
	return value.length > CUSTOM_PROMPT_MAX_CHARS ? value.slice(0, CUSTOM_PROMPT_MAX_CHARS) : value;
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
		...(patch.conversationScope !== undefined ? { conversationScope: patch.conversationScope } : {}),
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
		...(patch.customWriterPrompt !== undefined ? { customWriterPrompt: clampPrompt(patch.customWriterPrompt) } : {}),
		...(patch.customEditorPrompt !== undefined ? { customEditorPrompt: clampPrompt(patch.customEditorPrompt) } : {}),
		// 上下文预算(2026-10-10 补):此前这五项只有「读」没有「写」——parseWriterSettings
		// 认它们、装配时消费它们,但 updateWriterSettings 的 patch 透传里漏了,
		// 于是 PUT /api/settings 传进来也会被静默丢掉,用户只能手编 settings.json。
		// 这里补上之后,**钳制与 parseWriterSettings 同一套**(clampInt 同参),
		// 使「写进来的值」与「重启后解析出的值」逐字一致 —— 否则界面显示 50000、
		// 重启后变 20000,就是又一处「显示与装配分叉」。
		...(patch.contextBudget !== undefined ? { contextBudget: clampInt(patch.contextBudget, 200, 20000, 2000) } : {}),
		...(patch.memoryBudget !== undefined ? { memoryBudget: clampInt(patch.memoryBudget, 100, 20000, 1500) } : {}),
		...(patch.activationDepth !== undefined ? { activationDepth: clampInt(patch.activationDepth, 0, 5, 0) } : {}),
		...(patch.noticeInjectLimit !== undefined ? { noticeInjectLimit: clampInt(patch.noticeInjectLimit, 0, 50, 10) } : {}),
		...(patch.completedMilestoneLimit !== undefined
			? { completedMilestoneLimit: clampInt(patch.completedMilestoneLimit, 0, 30, 6) }
			: {}),
	};
	await writeWriterSettings(next);
	return next;
}
