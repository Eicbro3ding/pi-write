import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AgentMessage } from "../vendor/pi-agent-core/src/index.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InlineExtension,
} from "../vendor/pi-coding-agent/src/index.ts";
import type { TUI } from "../vendor/pi-tui/src/index.ts";
import {
	addChapter,
	createBook,
	getChapterSessionsPath,
	initChapterFile,
	listBooks,
	loadBook,
	renameBook,
	setCurrentChapter,
	updateChapter,
} from "./book-manager.ts";
import { APP_TITLE, getBookDir } from "./config.ts";
import { autoSaveConflicts, DraftEditorPanel } from "./draft-panel.ts";
import { type ChatApi, type ChatMessage, openFileEditor, parseEditArgs } from "./editor/index.ts";
import { createWriterStartupHeader, type WriterHeaderContext } from "./startup-header.ts";
import { applyWorldUpdate, wordCountTool, worldFindTool, worldUpdateTool } from "./tools.ts";
import { flattenWorldTree, renderWorldTree, renderWorldTreeFromData } from "./world-tree.ts";
import { ensureWorld } from "./world-data.ts";
import { chatTextOfMessage } from "./session-text.ts";
import { buildChapterContext, DEFAULT_CONTEXT_BUDGET, trimMemory } from "./world-context.ts";
import { buildWriterTheme } from "./writer-theme.ts";
import { countWriting, WriterFooter, WriterInfoBar, type WriterUiState } from "./writer-ui.ts";

/**
 * Inline extension that wires pi-writer commands and tools into a pi
 * InteractiveMode session. The cli passes this to DefaultResourceLoader so it
 * is loaded as `<inline:pi-writer>`.
 */

const WRITER_SLOT = "writer";

/** Sinks registered by an open built-in editor; fed by the session event stream. */
const activeChatSinks = new Set<(message: ChatMessage) => void>();
let writerThemeApplied = false;
/** Shared snapshot feeding the info bar, footer, and welcome card. */
const writerUi: WriterUiState = {};
/** Last TUI seen by the writer components; used to force a re-render. */
let writerTui: TUI | undefined;
/** The currently mounted persistent draft panel (right side of the chat). */
let activeDraftPanel: DraftEditorPanel | undefined;
let draftInputRegistered = false;
/** Set while the full-screen /edit overlay is open so its mouse input wins. */
let editorOverlayOpen = false;

/** 章节会话文件 → 章节 id("ch04.jsonl" → "ch04")。 */
export function chapterIdFromFile(file: string): string {
	return file.replace(/\.jsonl$/, "");
}

/** .writer/ 下与 outline.md 为导出视图,禁止直接编辑(--force 绕过)。 */
export function isReadonlyPath(relPath: string): boolean {
	// win32 反斜杠路径、前导 ./ 与前导分隔符(.\outline.md、/outline.md、./outline.md)归一化后再判断
	const normalized = relPath.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "");
	return normalized.startsWith(".writer/") || normalized === "outline.md";
}

/** 背景包 custom 消息(nextTurn 注入,不触发独立回复)。 */
export function worldContextMessage(text: string): { customType: string; content: Array<{ type: "text"; text: string }> } {
	return { customType: "world-context", content: [{ type: "text", text }] };
}

/**
 * 从会话文件文本(JSONL)提取最近的用户消息文本(新→旧,最多 count 条)。
 * 只认 type 携带 message 且 role 为 user 的条目;custom_message(背景包注入)
 * 没有 message 字段,天然排除,不会污染「最近用户消息」。
 */
export function recentUserMessagesFromSessionText(sessionText: string, count = 2): string[] {
	const out: string[] = [];
	for (const line of sessionText.split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line) as unknown;
		} catch {
			continue;
		}
		const message = (entry as { message?: unknown } | null)?.message;
		if (!message) continue;
		if ((message as { role?: unknown }).role !== "user") continue;
		const text = chatTextOfMessage(message as AgentMessage);
		if (text && text.length > 0) out.push(text);
	}
	return out.slice(-count);
}

/** 读取会话文件并提取最近用户消息;文件不存在/不可读返回空数组。 */
async function recentUserMessagesFromSessionFile(absPath: string, count = 2): Promise<string[]> {
	try {
		return recentUserMessagesFromSessionText(await readFile(absPath, "utf-8"), count);
	} catch {
		return [];
	}
}

/** Derive the book slug from an absolute chapter session file path. */
function bookSlugFromSessionFile(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	return basename(dirname(sessionFile));
}

/** Derive the chapter file basename from an absolute session file path. */
function chapterFileFromSessionFile(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	return basename(sessionFile);
}

/** Resolve the book/chapter labels shown in the startup header. */
async function writerHeaderContext(ctx: ExtensionContext): Promise<WriterHeaderContext> {
	const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const slug = bookSlugFromSessionFile(sessionFile);
	if (!slug) return {};
	const book = await loadBook(slug);
	if (!book) return {};
	const file = chapterFileFromSessionFile(sessionFile);
	const ch = file ? book.chapters.find((c) => c.file === file) : undefined;
	return {
		bookTitle: book.title,
		chapterLabel: ch?.title ?? file,
		chapterCount: book.chapters.length,
	};
}

/** Refresh the shared book/chapter/word-count snapshot used by the UI. */
async function refreshWriterUi(ctx: ExtensionContext): Promise<void> {
	const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const slug = bookSlugFromSessionFile(sessionFile);
	const file = chapterFileFromSessionFile(sessionFile);
	writerUi.bookTitle = undefined;
	writerUi.chapterLabel = undefined;
	writerUi.chapterFile = file ? `draft/${file.replace(/\.jsonl$/, ".md")}` : undefined;
	writerUi.wordCount = undefined;
	if (!slug || !file) return;
	const book = await loadBook(slug);
	if (book) {
		writerUi.bookTitle = book.title;
		const ch = book.chapters.find((c) => c.file === file);
		writerUi.chapterLabel = ch?.title ?? ch?.id ?? file;
	} else {
		writerUi.bookTitle = slug;
		writerUi.chapterLabel = file;
	}
	writerUi.draftTitle = `《${writerUi.bookTitle}》${writerUi.chapterLabel ? ` · ${writerUi.chapterLabel}` : ""}`;
	const draftPath = join(getBookDir(slug), "draft", file.replace(/\.jsonl$/, ".md"));
	writerUi.draftPath = draftPath;
	try {
		if (!existsSync(draftPath)) {
			writerUi.wordCount = 0;
			writerUi.draftText = "";
			return;
		}
		const text = await readFile(draftPath, "utf-8");
		writerUi.draftText = text;
		writerUi.wordCount = countWriting(text);
	} catch {
		writerUi.wordCount = undefined;
		writerUi.draftText = undefined;
	}
}

/** Extract the trailing `(id)` suffix from a selector item string. */
export function idSuffixOf(item: string): string | undefined {
	const match = /\(([^()]*)\)\s*$/.exec(item.trim());
	return match?.[1] || undefined;
}

/**
 * 选择项消歧:重复的显示行(同名条目渲染出相同文本)追加 `(id)`,保证每个
 * 条目都能被选中;唯一行原样保留。返回 items 后,用 items.indexOf(picked)
 * 取回下标即可(重复行带 id 后不再撞车)。
 */
export function disambiguateSelectItems(labels: string[], ids: string[]): string[] {
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	return labels.map((label, i) => (counts.get(label)! > 1 ? `${label}  (${ids[i] ?? ""})` : label));
}

function chapterListItems(book: {
	chapters: Array<{ id: string; file: string; title: string; label: string | null }>;
	currentChapterFile: string | null;
}): string[] {
	return book.chapters.map((c, i) => {
		const cur = c.file === book.currentChapterFile ? "★" : " ";
		const label = c.label ? ` [${c.label}]` : "";
		return `${cur} ${String(i + 1).padStart(2, " ")}. ${c.title}${label}  (${c.id})`;
	});
}

async function refreshStatus(ctx: ExtensionContext): Promise<void> {
	const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const slug = bookSlugFromSessionFile(sessionFile);
	const file = chapterFileFromSessionFile(sessionFile);
	if (!slug || !file) {
		ctx.ui.setStatus(WRITER_SLOT, "📖 (无书)");
		return;
	}
	const book = await loadBook(slug);
	if (!book) {
		ctx.ui.setStatus(WRITER_SLOT, `📖 ${slug} (索引缺失)`);
		return;
	}
	const ch = book.chapters.find((c) => c.file === file);
	const label = ch?.label ? ` [${ch.label}]` : "";
	ctx.ui.setStatus(WRITER_SLOT, `📖 《${book.title}》· ${ch?.id ?? file} · ${ch?.title ?? file}${label}`);
}

function writerFactory(pi: ExtensionAPI): void {
	// Register the writer-only custom tools.
	pi.registerTool(wordCountTool);
	pi.registerTool(worldUpdateTool);
	pi.registerTool(worldFindTool);

	// Keep the footer slot in sync after lifecycle events.
	pi.on("session_start", async (_event, ctx) => {
		if (!writerThemeApplied) {
			const applied = ctx.ui.setTheme(buildWriterTheme());
			writerThemeApplied = applied.success;
		}
		await refreshWriterUi(ctx);
		const context = await writerHeaderContext(ctx);
		ctx.ui.setHeader((tui, theme) => createWriterStartupHeader(tui, theme, context));
		// 信息条放在输入框下方、页脚上方，默认贴近底部。
		ctx.ui.setWidget(
			"writer-info",
			(tui, theme) => {
				writerTui = tui;
				return new WriterInfoBar(tui, theme, writerUi);
			},
			{ placement: "belowEditor" },
		);
		ctx.ui.setFooter((tui, theme) => {
			writerTui = tui;
			return new WriterFooter(tui, theme, writerUi);
		});
		// 常驻草稿编辑器：聊天区右侧面板。
		ctx.ui.setWidget(
			"draft-panel",
			(tui, theme) => {
				writerTui = tui;
				// Register the panel's input listener directly on the TUI so it
				// survives /reload and session switches (extension-registered
				// listeners are cleared by resetExtensionUI).
				if (!draftInputRegistered) {
					tui.addInputListener((data) => {
						if (editorOverlayOpen) return undefined;
						return activeDraftPanel?.handleTerminalInput(data);
					});
					draftInputRegistered = true;
				}
				const panel = new DraftEditorPanel(tui, theme, writerUi, {
					onSave: async (text, opts) => {
						const draftPath = writerUi.draftPath;
						if (!draftPath) return "error";
						try {
							// 自动保存前的冲突检查:文件已被 AI/其他进程修改(与面板基线
							// 不一致)时拒绝覆盖,防止面板把刚写入的内容整体冲掉;
							// 显式 Ctrl+S 是用户有意的覆盖,放行。
							if (opts.auto) {
								let current: string | null = null;
								try {
									current = await readFile(draftPath, "utf-8");
								} catch {
									current = null; // 文件不存在:首次保存,无冲突
								}
								if (autoSaveConflicts(current, opts.baseline)) return "conflict";
							}
							await mkdir(dirname(draftPath), { recursive: true });
							await writeFile(draftPath, text, "utf-8");
							writerUi.wordCount = countWriting(text);
							return "saved";
						} catch {
							return "error";
						}
					},
				});
				activeDraftPanel = panel;
				return panel;
			},
			{ placement: "sidePanel" },
		);
		ctx.ui.setTitle(APP_TITLE);
		await refreshStatus(ctx);
		// Some hosts attach the session file slightly after session_start;
		// refresh once more so the bar never shows a stale “未命名”.
		// print 模式或 session 已替换时 ctx 会 stale,这个回调只是 best-effort,忽略异常。
		setTimeout(() => {
			try {
				if (!ctx.hasUI) return;
				void refreshWriterUi(ctx).then(() => {
					activeDraftPanel?.reloadIfClean();
					writerTui?.requestRender();
				});
			} catch {
				// 会话已替换/无 UI:无需刷新
			}
		}, 350);
	});
	pi.on("message_end", (event) => {
		const text = chatTextOfMessage(event.message);
		if (!text) return;
		const role = event.message.role === "user" ? "user" : "assistant";
		for (const sink of activeChatSinks) sink({ role, text });
	});
	pi.on("turn_end", async (_event, ctx) => {
		await refreshWriterUi(ctx);
		activeDraftPanel?.reloadIfClean();
		await refreshStatus(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		await refreshStatus(ctx);
	});

	pi.registerCommand("chapters", {
		description: "列出本书所有章节并切换",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("无法打开选择器: 非交互模式", "error");
				return;
			}
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) {
				ctx.ui.notify("当前不在任何书中", "error");
				return;
			}
			const book = await loadBook(slug);
			if (!book) {
				ctx.ui.notify(`找不到书: ${slug}`, "error");
				return;
			}
			if (book.chapters.length === 0) {
				ctx.ui.notify("本书暂无章节", "info");
				return;
			}
			const items = chapterListItems(book);
			const picked = await ctx.ui.select("切换到章节", items);
			if (!picked) return;
			const id = idSuffixOf(picked);
			const ch = id ? book.chapters.find((c) => c.id === id) : undefined;
			if (!ch) return;
			await switchChapter(ctx, slug, ch.file);
		},
	});

	pi.registerCommand("new-chapter", {
		description: "新建本书一章（可选: /new-chapter 章节标题）",
		handler: async (args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) {
				ctx.ui.notify("当前不在任何书中", "error");
				return;
			}
			const book = await loadBook(slug);
			if (!book) {
				ctx.ui.notify(`找不到书: ${slug}`, "error");
				return;
			}
			const title = args.trim() || `第 ${book.chapters.length + 1} 章`;
			const ch = await addChapter(slug, title);
			ctx.ui.notify(`已新建章节: ${ch.id} · ${ch.title}`, "info");
			await switchChapter(ctx, slug, ch.file);
		},
	});

	pi.registerCommand("rename-chapter", {
		description: "改名当前章节（用法: /rename-chapter 新标题 [新标签]）",
		handler: async (args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			const file = chapterFileFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug || !file) {
				ctx.ui.notify("当前不在任何章节中", "error");
				return;
			}
			const parts = args
				.trim()
				.split(/\s+/)
				.filter((s) => s.length > 0);
			const title = parts[0];
			const label = parts[1];
			if (!title && label === undefined) {
				ctx.ui.notify("用法: /rename-chapter 新标题 [新标签]", "info");
				return;
			}
			const patch: { title?: string; label?: string | null } = {};
			if (title) patch.title = title;
			if (label !== undefined) patch.label = label;
			await updateChapter(slug, file, patch);
			await refreshStatus(ctx);
			ctx.ui.notify("章节已更新", "info");
		},
	});

	pi.registerCommand("rename-book", {
		description: "改名当前书（用法: /rename-book 新标题）",
		handler: async (args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) {
				ctx.ui.notify("当前不在任何书中", "error");
				return;
			}
			const title = args.trim();
			if (!title) {
				ctx.ui.notify("用法: /rename-book 新标题", "info");
				return;
			}
			// 目录已整体迁移(工作区 + 会话);若改的是当前书,把会话切到新路径的同一章节,
			// 否则运行中会话会停留在旧路径(bookSlug 由会话文件路径推导,会错位)
			const file = chapterFileFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			const book = await renameBook(slug, title);
			if (file && file === book.currentChapterFile) {
				await switchChapter(ctx, book.slug, file);
			}
			await refreshStatus(ctx);
			ctx.ui.notify(`已重命名为《${book.title}》(${book.slug})`, "info");
		},
	});

	pi.registerCommand("world", {
		description: "浏览世界书与档案（人物/世界/时间线/大纲）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("无法打开选择器: 非交互模式", "error");
				return;
			}
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) {
				ctx.ui.notify("当前不在任何书中", "error");
				return;
			}
			const nodes = renderWorldTreeFromData((await ensureWorld(slug)).entries);
			if (nodes.length === 0) {
				ctx.ui.notify("世界书为空，在 web 世界书页创建条目", "info");
				return;
			}
			const flat = flattenWorldTree(nodes);
			const labels = renderWorldTree(nodes);
			// 同名条目渲染行相同,indexOf 会恒取第一个:重复行追加 (id) 消歧
			const items = disambiguateSelectItems(labels, flat.map((n) => n.id));
			const picked = await ctx.ui.select("世界书与档案", items);
			if (!picked) return;
			const node = flat[items.indexOf(picked)];
			if (!node) return;
			const body = node.body.length > 0 ? node.body : "(该条目暂无内容)";
			const message = `${node.title}  (${node.fileRel})\n\n${body}`;
			// Only invoke the LLM when the user explicitly confirms editing.
			const edit = await ctx.ui.confirm("编辑该条目？", message);
			if (edit) {
				pi.sendUserMessage(`编辑 ${node.fileRel} 中的 ${node.title} 条目：${node.body}`, {});
			}
		},
	});

	pi.registerCommand("notice", {
		description: "查看 Notice(当前剧情指引)",
		handler: async (_args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) { ctx.ui.notify("当前不在任何书中", "error"); return; }
			const world = await ensureWorld(slug);
			if (world.notice.text.length === 0) { ctx.ui.notify("Notice 为空", "info"); return; }
			ctx.ui.notify(`[Notice${world.notice.enabled ? "" : "(已停用)"}] ${world.notice.text}`, "info");
		},
	});

	pi.registerCommand("storyline", {
		description: "查看发展线并标记章节完成",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("无法打开选择器: 非交互模式", "error");
				return;
			}
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) { ctx.ui.notify("当前不在任何书中", "error"); return; }
			const world = await ensureWorld(slug);
			if (world.storyline.nodes.length === 0) {
				ctx.ui.notify("发展线为空(在 web 世界书页或经 agent 建议创建)", "info");
				return;
			}
			const items = world.storyline.nodes.map((n) => {
				const mark = n.status === "in-progress" ? "▶" : n.status === "done" ? "✓" : n.status === "shelved" ? "◼" : "○";
				return `${mark} ${n.title}  [${n.status}]${n.next ? ` · 下一步: ${n.next}` : ""}`;
			});
			const picked = await ctx.ui.select("发展线(选择节点标记完成)", items);
			if (!picked) return;
			const idx = items.indexOf(picked);
			const node = world.storyline.nodes[idx];
			if (!node) return;
			const { saveWorld } = await import("./world-data.ts");
			// 只改状态,不传 next:标记完成不能清掉节点的「下一步」内容(与 web 端一致)
			const nextWorld = applyWorldUpdate(world, { op: "advance_storyline", id: node.id, status: "done" });
			await saveWorld(slug, nextWorld);
			ctx.ui.notify(`已标记完成: ${node.title}`, "info");
		},
	});

	pi.registerCommand("constraints", {
		description: "查看启用的写作约束(只读,编辑请去 web)",
		handler: async (_args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) { ctx.ui.notify("当前不在任何书中", "error"); return; }
			const world = await ensureWorld(slug);
			const enabled = world.constraints.filter((c) => c.enabled);
			if (enabled.length === 0) { ctx.ui.notify("没有启用的约束", "info"); return; }
			ctx.ui.notify(`启用约束(${enabled.length}): ${enabled.map((c) => c.name).join("、")}`, "info");
		},
	});

	pi.registerCommand("relations", {
		description: "查看关系网(文本列表,编辑请去 web 关系图)",
		handler: async (_args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) { ctx.ui.notify("当前不在任何书中", "error"); return; }
			const world = await ensureWorld(slug);
			if (world.relations.length === 0) { ctx.ui.notify("暂无关系", "info"); return; }
			const titleOf = (id: string): string => world.entries.find((e) => e.id === id)?.title ?? id;
			const lines = world.relations.map((r) =>
				`${titleOf(r.from)} —${r.emphasized ? "★" : ""}${r.label || r.type || "关系"}→ ${titleOf(r.to)}`,
			);
			ctx.ui.notify(`关系网(${lines.length}):\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("new-book", {
		description: "新建一本书并切换到它的第一章（可选: /new-book 标题）",
		handler: async (args, ctx) => {
			let title = args.trim();
			if (title.length === 0) {
				if (!ctx.hasUI) {
					ctx.ui.notify("非交互模式下需要标题参数: /new-book <标题>", "error");
					return;
				}
				const input = await ctx.ui.input("新书标题", "未命名");
				if (input === undefined) return;
				title = input.trim();
				if (title.length === 0) title = "未命名";
			}
			const book = await createBook(title);
			const ch = book.chapters[0];
			if (!ch) {
				ctx.ui.notify(`《${book.title}》创建失败: 无章节`, "error");
				return;
			}
			await switchChapter(ctx, book.slug, ch.file);
		},
	});

	pi.registerCommand("adopt-draft", {
		description: "把 draft/ 下手动创建的 md 转正为正式章节(用法: /adopt-draft <文件名>)",
		handler: async (args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) {
				ctx.ui.notify("当前不在任何书中", "error");
				return;
			}
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("用法: /adopt-draft <文件名>(draft/ 下的 .md,可不带扩展名)", "info");
				return;
			}
			const file = name.endsWith(".md") ? name : `${name}.md`;
			// 只接受单文件名(防路径穿越/子目录)
			if (file.includes("/") || file.includes("\\") || file === "." || file === "..") {
				ctx.ui.notify("只接受 draft/ 下的单文件名", "error");
				return;
			}
			const bookDir = getBookDir(slug);
			const src = join(bookDir, "draft", file);
			if (!existsSync(src)) {
				ctx.ui.notify(`draft/${file} 不存在`, "error");
				return;
			}
			// 手动文件没有对应的会话/索引:注册为新章节,内容复制到正式草稿
			// draft/chNN.md 后移除原文件(避免两个文件内容分叉),再切过去。
			const ch = await addChapter(slug, file.replace(/\.md$/, ""));
			const dst = join(bookDir, "draft", `${ch.id}.md`);
			await copyFile(src, dst);
			await unlink(src);
			ctx.ui.notify(`已转正: ${ch.id} · ${ch.title}(草稿内容已复制到 draft/${ch.id}.md)`, "info");
			await switchChapter(ctx, slug, ch.file);
		},
	});

	pi.registerCommand("edit", {
		description: "用内置编辑器打开草稿（/edit [路径]；--vim 启用 vim 模式）",
		handler: async (args, ctx) => {
			const slug = bookSlugFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			const file = chapterFileFromSessionFile(ctx.sessionManager.getSessionFile() ?? undefined);
			if (!slug) {
				ctx.ui.notify("当前不在任何书中", "error");
				return;
			}
			const bookDir = getBookDir(slug);
			const parsed = parseEditArgs(args);
			const relPath = parsed.path || `draft/${(file ?? "ch01").replace(/\.jsonl$/, "")}.md`;
			if (isReadonlyPath(relPath) && !parsed.force) {
				ctx.ui.notify("该文件是 world.json 的导出视图,编辑请走 web 世界书页或 /world 命令(--force 强制打开)", "info");
				return;
			}
			const book = await loadBook(slug);
			const ch = file ? book?.chapters.find((c) => c.file === file) : undefined;
			const editorTitle = `${book ? `《${book.title}》` : slug}${ch ? ` · ${ch.title}` : ""} · ${relPath}`;
			const absPath = resolve(bookDir, relPath);
			if (absPath !== bookDir && !absPath.startsWith(bookDir + sep)) {
				ctx.ui.notify("路径必须在书目录内", "error");
				return;
			}
			let initial = "";
			if (existsSync(absPath)) {
				initial = await readFile(absPath, "utf-8");
			}
			editorOverlayOpen = true;
			const result = await openFileEditor(ctx, {
				displayPath: relPath,
				title: editorTitle,
				initialContent: initial,
				vim: parsed.vim,
				chat: createChatApi(pi),
				onSave: async (content) => {
					try {
						await mkdir(dirname(absPath), { recursive: true });
						await writeFile(absPath, content, "utf-8");
						return true;
					} catch (err: unknown) {
						ctx.ui.notify(`保存失败: ${err instanceof Error ? err.message : String(err)}`, "error");
						return false;
					}
				},
			}).finally(() => {
				editorOverlayOpen = false;
				// The full-screen editor disables terminal mouse reporting on
				// close; hand it back to the persistent draft panel.
				activeDraftPanel?.enableMouse();
			});
			if (result.saved) {
				ctx.ui.notify(`已保存 ${relPath}`, "info");
			} else {
				ctx.ui.notify("未保存", "info");
			}
			await refreshWriterUi(ctx);
			activeDraftPanel?.reloadIfClean();
		},
	});

	function createChatApi(api: ExtensionAPI): ChatApi {
		return {
			send: (text) => {
				api.sendUserMessage(text);
			},
			subscribe: (listener) => {
				activeChatSinks.add(listener);
				return () => {
					activeChatSinks.delete(listener);
				};
			},
		};
	}

	pi.registerCommand("book", {
		description: "列出并切换到其他书",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("无法打开选择器: 非交互模式", "error");
				return;
			}
			const books = await listBooks();
			if (books.length === 0) {
				ctx.ui.notify("尚无任何书", "info");
				return;
			}
			const items = books.map((b) => `${b.title}  (${b.slug})`);
			const picked = await ctx.ui.select("选择书", items);
			if (!picked) return;
			const slug = idSuffixOf(picked);
			if (!slug) return;
			const targetBook = await loadBook(slug);
			if (!targetBook) {
				ctx.ui.notify(`找不到书: ${slug}`, "error");
				return;
			}
			if (targetBook.chapters.length === 0) {
				ctx.ui.notify(`《${targetBook.title}》暂无章节`, "info");
				return;
			}
			const chItems = chapterListItems(targetBook);
			const chPicked = await ctx.ui.select("切换到章节", chItems);
			if (!chPicked) return;
			const chId = idSuffixOf(chPicked);
			const ch = chId ? targetBook.chapters.find((c) => c.id === chId) : undefined;
			if (!ch) return;
			await switchChapter(ctx, targetBook.slug, ch.file);
		},
	});
}

async function switchChapter(ctx: ExtensionCommandContext, slug: string, file: string): Promise<void> {
	const bookDir = getBookDir(slug);
	const absPath = getChapterSessionsPath(slug, file);
	await initChapterFile(absPath, bookDir);
	// 构造本章背景包(注入在 withSession 内用 newCtx.sendMessage 完成,
	// 旧 ctx/pi 在 switchSession 后已 invalidate,不能在切换后使用)
	const chapterId = chapterIdFromFile(file);
	let draftText = "";
	try {
		const draftAbs = join(bookDir, "draft", `${chapterId}.md`);
		if (existsSync(draftAbs)) draftText = await readFile(draftAbs, "utf-8");
	} catch {
		draftText = "";
	}
	const world = await ensureWorld(slug);
	// 跨章节记忆:memory.md(容量有限,注入端按预算裁剪;不存在则为空)
	let memory = "";
	try {
		memory = trimMemory(await readFile(join(bookDir, "memory.md"), "utf-8"));
	} catch {
		memory = "";
	}
	// 目标章节已有历史:注入它自己的最近用户消息(与 web 服务端一致,避免把
	// 旧章节的消息错当成新章节的 recent);新章节(空会话)回退到当前章节的
	// 消息做连续性。
	const targetRecent = await recentUserMessagesFromSessionFile(absPath);
	const recent =
		targetRecent.length > 0
			? targetRecent
			: (ctx.sessionManager.getEntries() ?? [])
					.filter((e) => (e as { message?: { role?: string } }).message?.role === "user")
					.slice(-2)
					.map((e) => chatTextOfMessage((e as { message: AgentMessage }).message) ?? "")
					.filter((s) => s.length > 0);
	// 发展线当前节点的 goal/next 并入扫描输入(与 spec 2.1 的扫描输入一致)
	const current = world.storyline.nodes.find((n) => n.status === "in-progress");
	if (current) {
		const goalText = [current.goal, current.next ?? ""].filter((s) => s.length > 0).join(" ");
		if (goalText.length > 0) recent.push(goalText);
	}
	const context = buildChapterContext(world, { chapterId, draftText, recentUserMessages: recent, memory, budget: DEFAULT_CONTEXT_BUDGET });
	const result = await ctx.switchSession(absPath, {
		withSession: async (newCtx) => {
			await setCurrentChapter(slug, file);
			// 用 newCtx.sendMessage(绑定新会话)注入,nextTurn 随下个用户 prompt 进入,
			// 不触发独立回复;切换取消时 withSession 不执行,注入自动跳过
			if (context.text.length > 0) {
				await newCtx.sendMessage({ ...worldContextMessage(context.text), display: true }, { deliverAs: "nextTurn" });
			}
			newCtx.ui.notify(`已切换到 ${file}`, "info");
		},
	});
	if (result.cancelled) {
		ctx.ui.notify("切换已取消", "info");
	}
}

export const writerExtension: InlineExtension = {
	name: "pi-writer",
	factory: writerFactory,
};
