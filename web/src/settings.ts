/**
 * 调试模式的 localStorage 键。
 *
 * **它是开发者的排障开关,不是显示偏好**(2026-09-19)。改造前叫「简化输出」,
 * 是个默认**开**的开关——要看详细得去关掉它;而且挂在首启向导里,等于把开发者的
 * 排障开关摆给第一次用的用户。现在方向与名字一致(默认关),并且**平时界面里
 * 根本没有这一项**:要在控制台跑一行命令解锁才出现。
 *
 * ⚠️ 这不是权限门。任何人打开控制台都能开,它防的是误触,不是恶意。
 */
const DEBUG_MODE_KEY = "pi-writer-debug-mode";
/** 解锁标记(界面是否显示这一项);独立于「是否开着」。 */
const DEBUG_UNLOCK_KEY = "pi-writer-debug-unlocked";
/** 一次性迁移标记。 */
const DEBUG_MIGRATED_KEY = "pi-writer-debug-migrated";
/** 改造前的旧键(默认开启的「简化输出」)。 */
const LEGACY_SIMPLIFIED_KEY = "pi-writer-simplified-tools";

/** 调试开关变化事件(控制台解锁 / 设置页切换后广播,App 据此重渲染)。 */
export const DEBUG_CHANGED_EVENT = "pi-writer-debug-changed";
export const DEBUG_UNLOCK_COMMAND = "piWriterDebug()";
export const DEBUG_LOCK_COMMAND = "piWriterDebugOff()";

/**
 * 一次性迁移:旧「简化输出」取反即「调试模式」。
 *
 * 旧键只在用户显式点过开关时才存在(默认开 = 无键)。若他当时是**关掉**简化输出
 * (= 想看详细),迁移后应保持观感:开调试模式**并同时解锁**,否则界面里看不到
 * 这项、也没有开关可关,他会以为设置丢了。若旧键不存在,什么都不做(默认非调试)。
 */
function migrateLegacyOnce(): void {
	if (typeof localStorage === "undefined") return;
	if (localStorage.getItem(DEBUG_MIGRATED_KEY) === "1") return;
	localStorage.setItem(DEBUG_MIGRATED_KEY, "1");
	const legacy = localStorage.getItem(LEGACY_SIMPLIFIED_KEY);
	if (legacy === null) return;
	localStorage.removeItem(LEGACY_SIMPLIFIED_KEY);
	if (legacy === "0") {
		localStorage.setItem(DEBUG_UNLOCK_KEY, "1");
		localStorage.setItem(DEBUG_MODE_KEY, "1");
	}
}

/** 解析存储值:仅显式 "1" 表示开启(默认关闭)。 */
export function parseDebugMode(raw: string | null | undefined): boolean {
	return raw === "1";
}

/** 界面是否已解锁显示「调试模式」这一项。 */
export function debugUnlocked(): boolean {
	if (typeof localStorage === "undefined") return false;
	migrateLegacyOnce();
	return localStorage.getItem(DEBUG_UNLOCK_KEY) === "1";
}

/** 当前是否开启调试模式(未解锁时恒为关闭 —— 关着就是关着,与界面藏不藏无关)。 */
export function debugModeEnabled(): boolean {
	if (typeof localStorage === "undefined") return false;
	migrateLegacyOnce();
	if (localStorage.getItem(DEBUG_UNLOCK_KEY) !== "1") return false;
	return parseDebugMode(localStorage.getItem(DEBUG_MODE_KEY));
}

/** 设置调试模式并持久化(只在已解锁时有效;未解锁调用等于什么都不做)。 */
export function setDebugMode(enabled: boolean): void {
	localStorage.setItem(DEBUG_MODE_KEY, enabled ? "1" : "0");
}

function notifyDebugChanged(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(DEBUG_CHANGED_EVENT));
}

/** 控制台入口:解锁「调试模式」这一项并直接打开它。 */
export function enableDebugMode(): void {
	localStorage.setItem(DEBUG_UNLOCK_KEY, "1");
	localStorage.setItem(DEBUG_MODE_KEY, "1");
	notifyDebugChanged();
}

/** 控制台入口:关掉调试模式并把这一项重新藏回界面。 */
export function disableDebugMode(): void {
	localStorage.removeItem(DEBUG_UNLOCK_KEY);
	localStorage.setItem(DEBUG_MODE_KEY, "0");
	notifyDebugChanged();
}

/** 订阅调试开关变化(返回退订函数)。 */
export function subscribeDebugChanged(fn: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	window.addEventListener(DEBUG_CHANGED_EVENT, fn);
	return () => window.removeEventListener(DEBUG_CHANGED_EVENT, fn);
}

/**
 * 回车键行为。`newline` = 回车换行、Ctrl/Cmd+Enter 发送(旧行为,**缺省**);
 * `send` = 回车直接发送、Shift+Enter 换行。
 *
 * 缺省保持旧行为:这是后加的开关,没有存量值时改默认等于替所有老用户改键位。
 */
export type EnterBehavior = "send" | "newline";

const ENTER_BEHAVIOR_KEY = "pi-writer-enter-behavior";

/** 解析存储值:仅显式 "send" 表示回车即发送,其余(含缺省)一律换行。 */
export function parseEnterBehavior(raw: string | null | undefined): EnterBehavior {
	return raw === "send" ? "send" : "newline";
}

/** 当前回车行为。 */
export function enterBehavior(): EnterBehavior {
	return parseEnterBehavior(localStorage.getItem(ENTER_BEHAVIOR_KEY));
}

/** 设置回车行为并持久化。 */
export function setEnterBehavior(v: EnterBehavior): void {
	localStorage.setItem(ENTER_BEHAVIOR_KEY, v);
}

/** 自动展开思考开关的 localStorage 键。 */
const AUTO_EXPAND_THINKING_KEY = "pi-writer-auto-expand-thinking";

/**
 * 解析存储值:仅显式 "1" 表示开启,缺省/其他值一律视为关闭。
 *
 * 设计稿 04/06 定稿:**思考块默认收起**(原来展开时一条思考能撑到 2230px,把回复
 * 推到屏幕外);想常看思维链的人在设置里打开「自动展开思考」。
 */
export function parseAutoExpandThinking(raw: string | null | undefined): boolean {
	return raw === "1";
}

/** 当前是否自动展开思考块。 */
export function autoExpandThinkingEnabled(): boolean {
	return parseAutoExpandThinking(localStorage.getItem(AUTO_EXPAND_THINKING_KEY));
}

/** 设置自动展开思考并持久化。 */
export function setAutoExpandThinking(enabled: boolean): void {
	localStorage.setItem(AUTO_EXPAND_THINKING_KEY, enabled ? "1" : "0");
}

/** 编辑免确认开关的 localStorage 键。 */
const AUTO_CONFIRM_EDIT_KEY = "pi-writer-auto-confirm-edits";

/**
 * 解析存储值:仅显式 "1" 表示开启,缺省/其他值一律视为关闭(默认关闭——
 * 编剧编辑默认走「待确认」卡片,可在设置页开启免确认)。
 */
export function parseAutoConfirmEdits(raw: string | null | undefined): boolean {
	return raw === "1";
}

/** 当前是否开启编辑免确认(编剧编辑落盘即归档,不再弹待确认卡)。 */
export function autoConfirmEditsEnabled(): boolean {
	return parseAutoConfirmEdits(localStorage.getItem(AUTO_CONFIRM_EDIT_KEY));
}

/** 设置编辑免确认并持久化。 */
export function setAutoConfirmEdits(enabled: boolean): void {
	localStorage.setItem(AUTO_CONFIRM_EDIT_KEY, enabled ? "1" : "0");
}

/**
 * 对话形态偏好(设计稿 04 文档流 / 05 气泡,舞台页消息流按它切换 className)。
 *
 * 定义与实现在 `stage-preferences.ts`(舞台页专属偏好,避免与设置页其它偏好
 * 的定义互相踩);此处转发,设置页照旧从 settings.ts 取用。
 */
export { BUBBLE_CHAT_KEY, conversationStyle, parseBubbleChat, setConversationStyle } from "./stage-preferences.ts";
export type { ConversationStyle } from "./stage-preferences.ts";

/**
 * 经典模式开关的 localStorage 键。
 *
 * 经典模式是**服务端设置**(~/.pi/writer/settings.json,决定 agent 装配),
 * 这里只留一份本地缓存:首帧渲染就能决定顶栏显示哪几页,不必等服务端往返;
 * App 挂载后拉 GET /api/settings 对账,以服务端为准覆盖本地值。
 */
const CLASSIC_MODE_KEY = "pi-writer-classic-mode";

/**
 * 解析存储值:仅显式 "1" 表示开启,缺省/其他值一律视为关闭(默认关闭——
 * 缺省形态是多 agent:舞台 + 编辑 + 世界书)。
 */
export function parseClassicMode(raw: string | null | undefined): boolean {
	return raw === "1";
}

/** 本地缓存的经典模式状态(权威值在服务端)。 */
export function classicModeEnabled(): boolean {
	return parseClassicMode(localStorage.getItem(CLASSIC_MODE_KEY));
}

/** 缓存经典模式状态(服务端写入成功 / 启动对账后调用)。 */
export function setClassicMode(enabled: boolean): void {
	localStorage.setItem(CLASSIC_MODE_KEY, enabled ? "1" : "0");
}
