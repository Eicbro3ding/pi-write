/**
 * 首次启动配置向导状态(~/.pi/writer/setup.json)。
 *
 * 向导引导新用户走完八步:功能介绍 → 创作方式(多/单 Agent) → 对话范围(绑定章节/分离) →
 * 执行命令(是否放开 shell) → 接入模型服务商 → 选默认模型+思考级别 → 建第一本书 → 界面偏好。
 * 完成标记落在服务端而非浏览器 localStorage:
 * - 换浏览器/清缓存/无痕模式不会重复弹;
 * - 多窗口(Electron + 浏览器 + Android 壳)状态一致;
 * - TUI 后续接入时可直接读同一文件。
 *
 * 只存「是否完成」与各步骤的完成标记,不存凭据(API key 在 agent/auth.json),
 * 也不存界面偏好(主题/开关在浏览器 localStorage)。写盘走 atomicWriteFile,
 * 与其他 writer 数据文件同款 tmp+rename,避免并发写损坏。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWriterDir } from "./config.ts";
import { atomicWriteFile } from "./atomic-write.ts";

/**
 * 状态结构版本。字段不兼容变更时递增:读到的 version 与当前不符(过新/非数字)
 * 一律按未完成处理(重新走一遍向导,代价远低于按错误结构解析)。
 */
export const SETUP_VERSION = 1;

/**
 * 向导步骤 id;数组顺序即向导展示顺序。
 *
 * 「mode / scope / shell」三步连在介绍之后(2026-10-02 起):
 *   1. mode  —— 创作方式(多 Agent / 单 Agent),决定后面几步的语境(单 Agent 没有舞台);
 *   2. scope —— 对话与章节(绑定章节 / 分离),决定对话的身份语义;
 *   3. shell —— 执行命令,唯一一个高风险权限,单独一页过风险确认。
 * 三个都是「点了就写服务端 settings.json」的即时设置,选完即生效。
 * 加步骤是**追加式**变更,不需要递增 SETUP_VERSION —— 旧 setup.json 缺这些键时按未走过
 * 解析,不影响已完成的用户(2026-10-02 之前两次加步都是这么处理的)。
 */
export const SETUP_STEPS = ["intro", "mode", "scope", "shell", "provider", "model", "book", "prefs"] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number];

/** 向导状态:完成时间 + 各步骤是否真正走过。 */
export interface SetupState {
	version: number;
	/** 完成时间(ISO 8601);null = 未完成(首次启动或已重置)。 */
	completedAt: string | null;
	/** 各步骤完成情况;未走过的步骤为 false(跳过向导时全 false)。 */
	steps: Record<SetupStepId, boolean>;
}

/** 未完成初始态(全步骤 false)。 */
export function defaultSetupState(): SetupState {
	return {
		version: SETUP_VERSION,
		completedAt: null,
		steps: { intro: false, mode: false, scope: false, shell: false, provider: false, model: false, book: false, prefs: false },
	};
}

/** 步骤 id 是否合法(parseSetupState 的白名单校验用)。 */
export function isSetupStepId(value: unknown): value is SetupStepId {
	return typeof value === "string" && (SETUP_STEPS as readonly string[]).includes(value);
}

/**
 * 解析 setup.json 内容:非对象、version 不符、字段类型不对 → 回退初始态。
 * steps 逐键白名单过滤(未知键丢弃,非 true 视为 false),因此手写/旧版文件
 * 不会把向导带进未知状态。
 */
export function parseSetupState(raw: unknown): SetupState {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaultSetupState();
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number" || obj.version !== SETUP_VERSION) return defaultSetupState();
	const steps = defaultSetupState().steps;
	const rawSteps = obj.steps;
	if (typeof rawSteps === "object" && rawSteps !== null && !Array.isArray(rawSteps)) {
		for (const key of Object.keys(rawSteps)) {
			if (isSetupStepId(key) && (rawSteps as Record<string, unknown>)[key] === true) steps[key] = true;
		}
	}
	const completedAt = typeof obj.completedAt === "string" && obj.completedAt.length > 0 ? obj.completedAt : null;
	return { version: SETUP_VERSION, completedAt, steps };
}

/** setup.json 路径(~/.pi/writer/setup.json;PI_WRITER_DIR 可整体迁移)。 */
export function getSetupPath(): string {
	return join(getWriterDir(), "setup.json");
}

/**
 * 读取向导状态。文件不存在/损坏/版本不符 → 初始态(未完成),不抛错——
 * 向导状态读取失败不应挡住主界面加载。
 */
export async function readSetupState(): Promise<SetupState> {
	try {
		const text = await readFile(getSetupPath(), "utf8");
		return parseSetupState(JSON.parse(text) as unknown);
	} catch {
		return defaultSetupState();
	}
}

/** 写入向导状态(原子写;父目录自动创建)。 */
export async function writeSetupState(state: SetupState): Promise<void> {
	await atomicWriteFile(getSetupPath(), `${JSON.stringify({ ...state, version: SETUP_VERSION }, null, 2)}\n`);
}

/** 是否已完成向导;跳过向导同样置 completedAt,避免每次启动重复弹。 */
export function isSetupCompleted(state: SetupState): boolean {
	return state.completedAt !== null;
}
