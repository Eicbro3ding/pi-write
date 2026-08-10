/**
 * pi-writer visual theme.
 *
 * A warm "ink & paper" dark palette applied on top of the pi TUI. Users can
 * still override it later with /settings; the theme is only applied once per
 * process at startup.
 */

import { Theme, type ThemeColor } from "../vendor/pi-coding-agent/src/index.ts";

/** Background color tokens (keys of Theme's bg record). */
type ThemeBg = keyof ConstructorParameters<typeof Theme>[1];

export const WRITER_THEME_NAME = "pi-writer";

const FG: Record<ThemeColor, string> = {
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

const BG: Record<ThemeBg, string> = {
	selectedBg: "#4a4236",
	scrollbarThumb: "#6b6355",
	userMessageBg: "#38322a",
	customMessageBg: "#39342c",
	toolPendingBg: "#2f2b26",
	toolSuccessBg: "#2c352a",
	toolErrorBg: "#3a2c28",
};

export function buildWriterTheme(): Theme {
	return new Theme(FG, BG, "truecolor", { name: WRITER_THEME_NAME });
}
