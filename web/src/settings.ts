/** 简化输出开关的 localStorage 键。 */
const SIMPLIFIED_KEY = "pi-writer-simplified-tools";

/**
 * 解析存储值:仅显式 "0" 表示关闭,缺省/其他值一律视为开启(默认开启)。
 */
export function parseSimplifiedTools(raw: string | null | undefined): boolean {
	return raw !== "0";
}

/** 当前是否开启简化输出(工具卡片隐藏)。 */
export function simplifiedToolsEnabled(): boolean {
	return parseSimplifiedTools(localStorage.getItem(SIMPLIFIED_KEY));
}

/** 设置简化输出并持久化。 */
export function setSimplifiedTools(enabled: boolean): void {
	localStorage.setItem(SIMPLIFIED_KEY, enabled ? "1" : "0");
}

/** 自动展开思考开关的 localStorage 键。 */
const AUTO_EXPAND_THINKING_KEY = "pi-writer-auto-expand-thinking";

/**
 * 解析存储值:仅显式 "0" 表示关闭,缺省/其他值一律视为开启(默认开启——
 * 「自动展开思考」是默认行为,可在设置页关闭)。
 */
export function parseAutoExpandThinking(raw: string | null | undefined): boolean {
	return raw !== "0";
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
