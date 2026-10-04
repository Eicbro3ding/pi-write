/**
 * `/inspect` 上下文检视面板(2026-10-04,T5)。
 *
 * 全屏 overlay,可滚动,回答一个问题:**这一轮 agent 到底看到了什么、还差什么**。
 *
 * 为什么单独做一个面板而不是几行 notify:
 * - 「透明」要求可追溯。用户看到「省略 2 项」必然要问哪 2 项、为什么、怎么改;
 *   notify 会一闪而过,答案必须留在一个能上下翻的地方。
 * - 面板不改任何东西 —— 它是只读的。要改去设置(面板把字段名直接写出来)。
 *
 * 键位:↑/↓ 或 j/k 滚动 · g/G 顶/底 · q/Esc 退出 · Tab 在「分段 / 省略 / 设置」间切换。
 */

import type { Theme } from "../../vendor/pi-coding-agent/src/index.ts";
import { type Component, CURSOR_MARKER, type Focusable, matchesKey, sliceByColumn, type TUI, truncateToWidth, visibleWidth } from "../../vendor/pi-tui/src/index.ts";
import type { InspectReport } from "./report.ts";

export interface InspectPanelOptions {
	report: InspectReport;
}

type DoneCallback = () => void;

const TAB_LABELS = ["分段占用", "被省略", "可调设置"] as const;
type TabIndex = 0 | 1 | 2;

export class InspectPanel implements Component, Focusable {
	focused = false;
	wantsKeyRelease = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly report: InspectReport;
	private readonly done: DoneCallback;
	private tab: TabIndex = 0;
	private scrollTop = 0;
	private closed = false;
	private lastContentHeight = 0;
	private lastViewportHeight = 0;

	constructor(tui: TUI, theme: Theme, options: InspectPanelOptions, done: DoneCallback) {
		this.tui = tui;
		this.theme = theme;
		this.report = options.report;
		this.done = done;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.tab = (((this.tab + 1) % TAB_LABELS.length) as TabIndex);
			this.scrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.tab = (((this.tab + TAB_LABELS.length - 1) % TAB_LABELS.length) as TabIndex);
			this.scrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "j" || matchesKey(data, "down")) {
			this.scrollBy(1);
			return;
		}
		if (data === "k" || matchesKey(data, "up")) {
			this.scrollBy(-1);
			return;
		}
		if (data === "g") {
			this.scrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "G") {
			this.scrollTop = Math.max(0, this.lastContentHeight - this.lastViewportHeight);
			this.tui.requestRender();
			return;
		}
	}

	private scrollBy(delta: number): void {
		const max = Math.max(0, this.lastContentHeight - this.lastViewportHeight);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta, max));
		this.tui.requestRender();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done();
	}

	dispose(): void {
		this.closed = true;
	}

	render(width: number): string[] {
		const rows = Math.max(10, this.tui.terminal.rows);
		const inner = Math.max(20, width - 4);
		const body = this.bodyLines(inner);
		const viewport = rows - 5; // 顶栏 + 页签 + 底栏 + 上下边框
		this.lastContentHeight = body.length;
		this.lastViewportHeight = viewport;
		const maxScroll = Math.max(0, body.length - viewport);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));

		const t = this.theme;
		const border = (s: string): string => t.fg("border", s);
		const out: string[] = [];
		out.push(border(`┌${"─".repeat(Math.max(0, width - 2))}┐`));
		out.push(this.line(this.titleBar(), width, border));

		const vis = body.slice(this.scrollTop, this.scrollTop + viewport);
		for (let i = 0; i < viewport; i++) {
			const content = vis[i] ?? "";
			out.push(this.line(content, width, border));
		}
		const more = body.length > viewport ? `${this.scrollTop + 1}-${Math.min(body.length, this.scrollTop + viewport)}/${body.length}` : `${body.length}/${body.length}`;
		out.push(this.line(this.footer(more), width, border));
		out.push(border(`└${"─".repeat(Math.max(0, width - 2))}┘`));
		return out;
	}

	/** 把一行内容夹进边框里(pos 保留已含 SGR 的可见宽度)。 */
	private line(content: string, width: number, border: (s: string) => string): string {
		const inner = Math.max(0, width - 2);
		const clipped = sliceByColumn(content, 0, inner, true);
		const pad = Math.max(0, inner - visibleWidth(clipped));
		return `${border("│")}${clipped}${" ".repeat(pad)}${border("│")}`;
	}

	private titleBar(): string {
		const t = this.theme;
		const title = t.bold(t.fg("accent", "上下文检视"));
		const where = t.fg("dim", `${this.report.slug}${this.report.chapterTitle ? ` · ${this.report.chapterTitle}` : ""}${this.report.chapterFile ? ` · ${this.report.chapterFile}` : ""}`);
		return `${title}  ${where}`;
	}

	private footer(more: string): string {
		const t = this.theme;
		const tabs = TAB_LABELS.map((label, i) => (i === this.tab ? t.bg("selectedBg", t.fg("accent", ` ${label} `)) : t.fg("dim", ` ${label} `))).join("");
		const hints = t.fg("dim", `Tab 切换 · ↑↓/jk 滚动 · g/G 顶点 · q 退出   ${more}`);
		return `${tabs}  ${hints}`;
	}

	/** 当前页签的主体内容(纯文本 + SGR,不含边框)。 */
	private bodyLines(width: number): string[] {
		if (this.tab === 0) return this.sectionLines(width);
		if (this.tab === 1) return this.trimLines(width);
		return this.budgetLines(width);
	}

	private sectionLines(width: number): string[] {
		const t = this.theme;
		const r = this.report;
		const lines: string[] = [];
		lines.push(`${t.fg("text", "总量")}  ${this.bar(r.used, r.budget, width - 24)}  ${t.bold(`${r.used}/${r.budget}`)} ${t.fg("dim", `(${r.percent}%)`)}`);
		lines.push("");
		lines.push(t.fg("muted", "每段实际进入上下文的量(裁掉的不计;裁掉的看「被省略」页):"));
		lines.push("");
		if (r.sections.length === 0) {
			lines.push(t.fg("dim", "  (本章没有任何背景注入 —— 世界书为空?检查 /world 与 /constraints)"));
			return lines;
		}
		for (const s of r.sections) {
			const name = s.label.padEnd(12, " ");
			const bar = this.bar(s.tokens, r.budget, Math.max(8, width - 44));
			const cnt = s.count > 0 ? t.fg("dim", ` ×${s.count}`) : "";
			const warn = s.trimmable ? t.fg("warning", " 可裁") : t.fg("success", " 常驻");
			lines.push(`  ${t.fg("text", name)}${bar} ${String(s.tokens).padStart(5)}${cnt}${warn}`);
		}
		return lines;
	}

	private trimLines(width: number): string[] {
		const t = this.theme;
		const r = this.report;
		const lines: string[] = [];
		if (r.trimmed.length === 0) {
			lines.push(t.fg("success", "本次没有裁切 —— 世界书全部装下了。"));
			lines.push("");
			lines.push(t.fg("dim", "若你预期这里应该有条目被省略,说明预算还够;反之调小 contextBudget 才会出现裁切。"));
			return lines;
		}
		lines.push(t.fg("warning", `因预算不足,以下内容未进入上下文(共 ${r.trimmed.length} 项):`));
		lines.push("");
		for (const item of r.trimmed) {
			lines.push(`  ${t.fg("error", "✗")} ${t.bold(item.label)} ${t.fg("dim", `约 ${item.tokens} tok`)}`);
			lines.push(`    ${t.fg("dim", this.wrap(item.impact, width - 6).join("\n    "))}`);
		}
		lines.push("");
		lines.push(t.fg("dim", `想全部装下:把 contextBudget 调大到 ${r.used + r.trimmed.reduce((s, x) => s + x.tokens, 0)} 以上(Tab 到「可调设置」看字段名)。`));
		return lines;
	}

	private budgetLines(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		lines.push(t.fg("muted", "这些字段决定上面看到的一切;改它们去设置文件(找不到就在界面里搜「设置」):"));
		lines.push("");
		for (const b of this.report.budgetItems) {
			lines.push(`  ${t.fg("accent", b.key)}`);
			lines.push(`    ${t.fg("text", b.label)} = ${t.bold(String(b.value))}   ${t.fg("dim", `[${b.range}]`)}`);
			lines.push(`    ${t.fg("dim", this.wrap(b.effect, width - 6).join("\n    "))}`);
			lines.push("");
		}
		return lines;
	}

	/** 一条横向占用条;`cells` 为可用列数(含方括号)。 */
	private bar(value: number, total: number, cells: number): string {
		const inner = Math.max(4, Math.min(cells - 2, 40));
		const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
		const filled = Math.round(ratio * inner);
		if (filled === 0) return this.theme.fg("borderMuted", `[${"·".repeat(inner)}]`);
		// 越接近满越红:88% 以上告警(留一点给尾部固有的 Notice/发展线)
		const color = ratio >= 0.88 ? "error" : ratio >= 0.6 ? "warning" : "success";
		return `${this.theme.fg("borderMuted", "[")}${this.theme.fg(color, "█".repeat(filled))}${this.theme.fg("borderMuted", `${"·".repeat(inner - filled)}]`)}`;
	}

	/** 按可见列宽换行(不处理 SGR —— 调用方传的是纯文本)。 */
	private wrap(text: string, width: number): string[] {
		const limit = Math.max(8, width);
		const out: string[] = [];
		let rest = text;
		while (rest.length > 0) {
			if (visibleWidth(rest) <= limit) {
				out.push(rest);
				break;
			}
			out.push(sliceByColumn(rest, 0, limit, false));
			rest = rest.slice(sliceByColumn(rest, 0, limit, false).length).trimStart();
		}
		return out.length > 0 ? out : [""];
	}
}

/** 供 `ui.custom` 使用的光标占位(面板不需要真实光标,返回空串避免残留方块)。 */
export const INSPECT_CURSOR = CURSOR_MARKER;
