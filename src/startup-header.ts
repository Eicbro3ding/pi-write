/**
 * pi-writer startup header.
 *
 * Rendered as a centered welcome card: a boxed wordmark, the current
 * book/chapter context, a tagline, and the essential commands. Resize-safe:
 * the card is rebuilt on every render with the current terminal width.
 */

import type { Theme } from "../vendor/pi-coding-agent/src/index.ts";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "../vendor/pi-tui/src/index.ts";
import { APP_NAME, VERSION } from "./config.ts";

export interface WriterHeaderContext {
	bookTitle?: string;
	chapterLabel?: string;
	chapterCount?: number;
	wordCount?: number;
}

export class WriterHeaderComponent implements Component {
	private readonly theme: Theme;
	private readonly context: WriterHeaderContext;

	constructor(_tui: TUI, theme: Theme, context: WriterHeaderContext) {
		this.theme = theme;
		this.context = context;
	}

	invalidate(): void {
		// No cached render state.
	}

	render(width: number): string[] {
		const cardWidth = Math.min(width, 76);
		const inner = Math.max(16, cardWidth - 4);
		const indent = Math.max(0, Math.floor((width - cardWidth) / 2));
		const t = this.theme;

		const border = (s: string): string => t.fg("border", s);
		const content = (text: string, padLeft = 1): string => {
			const padRight = Math.max(0, inner - padLeft - visibleWidth(text));
			return `${border("│ ")}${" ".repeat(padLeft)}${text}${" ".repeat(padRight)}${border(" │")}`;
		};
		const centered = (text: string): string => {
			const padLeft = Math.max(0, Math.floor((inner - visibleWidth(text)) / 2));
			return content(text, padLeft);
		};

		const wordmark = `${t.fg("accent", "✒ ")}${t.bold(t.fg("text", APP_NAME))}${t.fg("dim", ` v${VERSION}`)}`;
		const contextLine =
			this.context.bookTitle !== undefined
				? `${t.fg("muted", "《")}${t.fg("accent", this.context.bookTitle)}${t.fg("muted", "》")}${
						this.context.chapterLabel ? `${t.fg("muted", " · ")}${t.fg("text", this.context.chapterLabel)}` : ""
					}${
						this.context.chapterCount !== undefined
							? `${t.fg("borderMuted", " · ")}${t.fg("muted", `共 ${this.context.chapterCount} 章`)}`
							: ""
					}${
						this.context.wordCount !== undefined
							? `${t.fg("borderMuted", " · ")}${t.fg("muted", `草稿约 ${this.context.wordCount} 字`)}`
							: ""
					}`
				: t.fg("muted", "新建一本书，写下第一章");
		const tagline = t.italic(t.fg("dim", "以笔为舟 · 一章一章，写就你的世界"));
		const commands = t.fg("dim", "/chapters 章节 · /world 世界书 · /book 切换书 · /edit 编辑器");
		const hints = t.fg("dim", "escape 中断 · ctrl+c/ctrl+d 清空/退出 · / 命令 · ! shell · ctrl+o 更多");

		const lines: string[] = [];
		lines.push(`${border("╭")}${border("─".repeat(cardWidth - 2))}${border("╮")}`);
		lines.push(centered(wordmark));
		lines.push(content(contextLine));
		lines.push(centered(tagline));
		lines.push(content(""));
		lines.push(content(truncateToWidth(commands, inner, "…")));
		lines.push(content(truncateToWidth(hints, inner, "…")));
		lines.push(`${border("╰")}${border("─".repeat(cardWidth - 2))}${border("╯")}`);

		return lines.map((line) => " ".repeat(indent) + line);
	}
}

export function createWriterStartupHeader(
	tui: TUI,
	theme: Theme,
	context?: WriterHeaderContext,
): WriterHeaderComponent {
	return new WriterHeaderComponent(tui, theme, context ?? {});
}
