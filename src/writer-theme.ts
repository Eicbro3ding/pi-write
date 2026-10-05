/**
 * pi-writer visual theme.
 *
 * A warm "ink & paper" dark palette applied on top of the pi TUI. Users can
 * still override it later with /settings; the theme is only applied once per
 * process at startup.
 */

import { Theme } from "./pi-adapter/index.ts";

/**
 * 主题色表的两个槽的类型 —— **直接取 `Theme` 的构造参数**,不重抄 `ThemeColor`
 * 联合、也不写成 `Record<ThemeColor, string>`。
 *
 * 为什么必须这么做:
 * - 上游把 4 个前景令牌(`scrollbarTrack` / `scrollbarThumb` / `thinkingMax` /
 *   `searchMatchText`)和 1 个背景令牌(`searchMatchBg`)声明为**可选**,
 *   构造参数的形状是 `Record<必选, V> & Partial<Record<可选, V>>`。
 * - `Record<ThemeColor, string>` 会把可选项也变成必填;
 * - `Record<keyof 构造参数[0], string>` 同样丢掉 `Partial` —— `keyof` 把交叉
 *   类型展平成键的联合,可选信息随之丢失(这两种写法都实测会报错)。
 *
 * 取构造参数类型 = 上游改可选性时这里自动跟随。这正是 `ThemeBg` 早就用的办法,
 * 这里把前景也统一过来。
 */
type ThemeFgColors = ConstructorParameters<typeof Theme>[0];
type ThemeBgColors = ConstructorParameters<typeof Theme>[1];

export const WRITER_THEME_NAME = "pi-writer";

const FG: ThemeFgColors = {
	accent: "#e8b56d",
	border: "#8a7a63",
	borderAccent: "#e8b56d",
	borderMuted: "#5c5346",
	success: "#9bbf88",
	error: "#d98c7a",
	warning: "#e0c07a",
	muted: "#a89e8e",
	dim: "#8d8375",
	text: "#e8e0d4",
	thinkingText: "#a89e8e",
	userMessageText: "#e8e0d4",
	customMessageText: "#e8e0d4",
	customMessageLabel: "#d6b98a",
	toolTitle: "#e8e0d4",
	toolOutput: "#a89e8e",
	mdHeading: "#e8b56d",
	mdLink: "#8fb6d9",
	mdLinkUrl: "#8d8375",
	mdCode: "#e8b56d",
	mdCodeBlock: "#a9c793",
	mdCodeBlockBorder: "#5c5346",
	mdQuote: "#a89e8e",
	mdQuoteBorder: "#5c5346",
	mdHr: "#5c5346",
	mdListBullet: "#e8b56d",
	toolDiffAdded: "#9bbf88",
	toolDiffRemoved: "#d98c7a",
	toolDiffContext: "#a89e8e",
	syntaxComment: "#7d8b6a",
	syntaxKeyword: "#d9a066",
	syntaxFunction: "#e8c98a",
	syntaxVariable: "#bcd6b8",
	syntaxString: "#c9a57b",
	syntaxNumber: "#b5ce8f",
	syntaxType: "#8fb6d9",
	syntaxOperator: "#e8e0d4",
	syntaxPunctuation: "#e8e0d4",
	thinkingOff: "#5c5346",
	thinkingMinimal: "#6f675a",
	thinkingLow: "#b08a5a",
	thinkingMedium: "#d9a066",
	thinkingHigh: "#e0b56d",
	thinkingXhigh: "#e8c07a",
	thinkingMax: "#f0cf8a",
	bashMode: "#9bbf88",
};

const BG: ThemeBgColors = {
	selectedBg: "#4a4236",
	userMessageBg: "#38322a",
	customMessageBg: "#39342c",
	toolPendingBg: "#2f2b26",
	toolSuccessBg: "#2c352a",
	toolErrorBg: "#3a2c28",
};

export function buildWriterTheme(): Theme {
	return new Theme(FG, BG, "truecolor", { name: WRITER_THEME_NAME });
}
