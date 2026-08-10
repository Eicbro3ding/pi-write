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
