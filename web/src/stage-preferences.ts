/**
 * 舞台页本地偏好(localStorage 持久化)——纯函数,可单测。
 *
 * 两项偏好:
 * 1. **对话形态**(设计稿 04 文档流 / 05 气泡):缺省「文档流」(满宽浅面板 + 无气泡,
 *    靠分隔线分段);「气泡」是供用户选择的差分(左右对齐 + 28px 圆头像),不是替代品。
 * 2. **右侧面板收起**:收起后右栏收成 48px 竖条(竖排文字 + « 展开)。
 *
 * 写法与 web/src/settings.ts 的其它偏好同一套:仅显式 "1" 开启,缺省/非法值回退关闭。
 * 舞台面板/消息流形态是舞台页专属,故独立成模块(避免与设置页偏好定义互相踩)。
 */

/** 对话形态。 */
export type ConversationStyle = "doc" | "bubble";

/** 对话形态偏好的 localStorage 键。 */
export const BUBBLE_CHAT_KEY = "pi-writer-bubble-chat";

/** 右侧面板收起态的 localStorage 键。 */
export const STAGE_PANEL_COLLAPSED_KEY = "pi-writer:stage-panel-collapsed";

/** 解析存储值:仅显式 "1" 表示开启,缺省/其他值一律视为关闭(默认文档流)。 */
export function parseBubbleChat(raw: string | null | undefined): boolean {
	return raw === "1";
}

/** 当前对话形态(默认「文档流」)。 */
export function conversationStyle(): ConversationStyle {
	return parseBubbleChat(localStorage.getItem(BUBBLE_CHAT_KEY)) ? "bubble" : "doc";
}

/** 设置对话形态并持久化。 */
export function setConversationStyle(style: ConversationStyle): void {
	localStorage.setItem(BUBBLE_CHAT_KEY, style === "bubble" ? "1" : "0");
}

/** 解析存储值:仅显式 "1" 表示收起(默认展开)。 */
export function parsePanelCollapsed(raw: string | null | undefined): boolean {
	return raw === "1";
}

/** 右侧面板是否处于收起态(读写失败一律回退展开)。 */
export function panelCollapsed(): boolean {
	try {
		return parsePanelCollapsed(localStorage.getItem(STAGE_PANEL_COLLAPSED_KEY));
	} catch {
		/* 隐私模式下 localStorage 不可用:本次会话内仍然生效 */
		return false;
	}
}

/** 持久化右侧面板收起态(写失败静默——只影响下次进入页面时的初值)。 */
export function setPanelCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(STAGE_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
	} catch {
		/* 同上 */
	}
}
