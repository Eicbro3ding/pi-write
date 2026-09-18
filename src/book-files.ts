/**
 * 书目录文件清单(只读)— 工作区面板的数据源。
 *
 * 定位(2026-09-18 定稿,按作者反馈收窄):**这里放的是 AI 产出的中间产物**
 * ——收集的资料、笔记片段、参考图,以及各章草稿。它回答的是"这本书的工作台
 * 上摊着哪些东西",不是"把这本书记录了一遍"。
 *
 * 因此**不列**两类东西:
 * 1. **生成物 / 镜像**:`outline.md`、`.writer/*.md` 由 world.json 导出,时间线、
 *    人物档案这类内容在**世界书页**看才是权威视图——摆进工作区只会让人以为
 *    那是一个可以编辑的稿子(改了还会被下一次 world_update 覆盖)。
 *    见 `isGeneratedView`;
 * 2. **实现细节 / 机器数据**:`book.json`、`world.json`、`cast.json`、`stage/`、
 *    `*.jsonl`、隐藏文件、`node_modules`/`.git`/`sessions`/`agent`。
 *
 * 分组按语义(草稿 / 资料与笔记 / 图片 / 其他),不镜像磁盘树:每个条目仍带真实
 * 相对路径,想直连磁盘的人有出口。
 *
 * 安全:只走书目录内部(readdir 递归,不拼接用户输入路径);不跟随符号链接
 * (链接可能指向书目录外,跟随等于把边界拆了);深度与条目数都有上限,
 * 防止异常目录把响应撑爆。
 */

import { readdir, stat, lstat, readFile, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, sep } from "node:path";
import { WORLD_FILES } from "./world-data.ts";

/** 文件分组 id;前端按此顺序渲染。 */
export type BookFileGroup = "draft" | "notes" | "image" | "other";

/** 文件可渲染类型:text 走 markdown/纯文本预览,image 走 <img>,binary 只给元信息。 */
export type BookFileKind = "text" | "image" | "binary";

/** 一个文件条目。 */
export interface BookFileEntry {
	/** 书目录相对路径(posix 分隔符),如 "draft/ch01.md"。 */
	path: string;
	/** 文件名(次要信息;展示名见 title)。 */
	name: string;
	/**
	 * 行内展示名:草稿 = 章节标题(book.json 的 title),其余 = 文件名。
	 * 由服务端给,避免每个客户端各写一份映射。
	 */
	title: string;
	group: BookFileGroup;
	kind: BookFileKind;
	bytes: number;
	/** 最后修改时间(ms;排序用)。 */
	mtime: number;
	/** 草稿组:所属章节 id("ch01");其余为 null。 */
	chapterId: string | null;
	/** 草稿组:章节标题(book.json 查不到时回退章节 id);其余为 null。 */
	chapterTitle: string | null;
}

/** 分组元信息(标签与说明放服务端:面板、TUI、Android 壳共用一套说法)。 */
export interface BookFileGroupInfo {
	id: BookFileGroup;
	label: string;
	description: string;
}

/** 分组定义(数组顺序 = 展示顺序)。 */
export const BOOK_FILE_GROUPS: readonly BookFileGroupInfo[] = [
	{ id: "draft", label: "草稿", description: "各章正文，AI 与人共同维护的交付物" },
	{ id: "notes", label: "资料与笔记", description: "AI 收集的资料、随手记的片段与跨章记忆" },
	{ id: "image", label: "图片", description: "书目录内的图片资产（含世界书条目主图）" },
	{ id: "other", label: "其他", description: "不属于以上分类的书目录文件" },
];

/** 递归深度上限(book 目录正常只有 1-2 层)。 */
const MAX_DEPTH = 4;
/** 条目数上限(超出即截断,防异常目录把响应撑爆)。 */
const MAX_ENTRIES = 2000;

/** 世界书导出的视图文件(内容以 world.json 为准,权威视图在界面里)。 */
const VIEW_FILES = new Set<string>(WORLD_FILES.map((f) => f.rel));

/** 一律跳过的目录名(实现细节或机器数据)。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "sessions", "agent", "stage", ".writer"]);

/** 一律跳过的书目录根文件(机器数据 / 生成物;界面另有入口)。 */
const SKIP_FILES = new Set(["world.json", "book.json", "cast.json"]);

/** 文本类扩展名(markdown 之外按纯文本读)。 */
const TEXT_EXTS = new Set(["md", "markdown", "txt", "json", "csv", "tsv", "yaml", "yml", "log"]);
/** 图片类扩展名(与 read 工具/上传端点支持的一致)。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);

/** 取扩展名(小写,无点)。 */
function extOf(name: string): string {
	const i = name.lastIndexOf(".");
	return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** 文件类型判据。 */
export function classifyBookFileKind(rel: string): BookFileKind {
	const ext = extOf(rel);
	if (IMAGE_EXTS.has(ext)) return "image";
	if (TEXT_EXTS.has(ext)) return "text";
	return "binary";
}

/**
 * 路径 → 分组。判据全部基于书目录相对路径(去掉了分隔符歧义:两条分支都按
 * posix 前缀匹配,调用方保证传入的是 `/` 分隔的相对路径)。
 * 生成物(见 isGeneratedView)在调用方已被排除,走到这里一律落「其他」。
 */
export function classifyBookFileGroup(rel: string): BookFileGroup {
	if (rel.startsWith("draft/")) return "draft";
	if (rel === "memory.md" || rel.startsWith("notes/")) return "notes";
	if (rel.startsWith("images/")) return "image";
	return "other";
}

/**
 * 该路径是否为**世界书生成的视图文件**(outline.md 与 .writer/*.md,见 WORLD_FILES)。
 *
 * 这类文件的权威视图在界面里(世界书页 / TUI 命令),磁盘上的 md 只是导出镜像:
 * 摆进工作区会被当成可以编辑的稿子,而改了会在下一次 world_update 时被覆盖。
 * 清单与读取端点都据此排除——不列 = 也读不到,两侧规则同源。
 */
export function isGeneratedView(rel: string): boolean {
	return VIEW_FILES.has(rel) || rel.startsWith(".writer/");
}

/**
 * 递归收集书目录内的文件条目。
 *
 * chapters 用于把 `draft/ch01.md` 映射成章节标题(缺省则 chapterTitle = 章节 id)。
 * 返回按「分组顺序 → 草稿按章序 → 组内按 mtime 倒序」排列,前端可直接渲染。
 * 目录不存在返回空数组(不抛错:空书/刚创建的书是正常状态)。
 */
export async function listBookFiles(
	bookDir: string,
	chapters: ReadonlyArray<{ id: string; title: string }> = [],
): Promise<BookFileEntry[]> {
	const titleById = new Map(chapters.map((c) => [c.id, c.title]));
	const out: BookFileEntry[] = [];

	/** 递归一层的内部实现;rel 是相对 bookDir 的 posix 路径("" 表示根)。 */
	async function walk(rel: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
		const abs = rel === "" ? bookDir : join(bookDir, rel);
		let entries: Dirent[];
		try {
			entries = await readdir(abs, { withFileTypes: true });
		} catch {
			return; // 目录不可读(权限/竞态删除):跳过该层
		}
		for (const entry of entries) {
			if (out.length >= MAX_ENTRIES) return;
			const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			// 不跟随符号链接:链接可指向书目录外,跟随等于把路径边界拆了
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				if (entry.name.startsWith(".")) continue; // 工具/版本控制目录(.writer 也在 SKIP_DIRS 里)
				await walk(childRel, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name.startsWith(".")) continue; // 隐藏文件(含 tmp/备份)
			if (entry.name.endsWith(".jsonl")) continue; // 转录/会话/编辑记录:机器数据
			// 世界书 / 书索引 / 演员池:数据文件,界面另有入口(世界书页 / 章节栏 / 舞台页)
			if (SKIP_FILES.has(childRel)) continue;
			if (isGeneratedView(childRel)) continue; // 生成物:权威视图在界面里
			const group = classifyBookFileGroup(childRel);
			let bytes = 0;
			let mtime = 0;
			try {
				const st = await stat(join(bookDir, childRel));
				bytes = st.size;
				mtime = st.mtimeMs;
			} catch {
				continue; // 竞态删除:跳过
			}
			const chapterId = group === "draft" ? childRel.slice("draft/".length).replace(/\.md$/, "") : null;
			const chapterTitle = chapterId ? (titleById.get(chapterId) ?? chapterId) : null;
			out.push({
				path: childRel,
				name: entry.name,
				// 展示名:草稿用章节标题,其余用文件名
				title: chapterTitle ?? entry.name,
				group,
				kind: classifyBookFileKind(childRel),
				bytes,
				mtime,
				chapterId,
				chapterTitle,
			});
		}
	}

	await walk("", 0);

	const groupOrder = new Map(BOOK_FILE_GROUPS.map((g, i) => [g.id, i]));
	const chapterOrder = new Map(chapters.map((c, i) => [c.id, i]));
	out.sort((a, b) => {
		const ga = groupOrder.get(a.group) ?? 99;
		const gb = groupOrder.get(b.group) ?? 99;
		if (ga !== gb) return ga - gb;
		if (a.group === "draft" && b.group === "draft") {
			// 草稿按章节顺序(书里的顺序),不按 mtime——章节位置是稳定语义
			const ca = chapterOrder.get(a.chapterId ?? "") ?? 99;
			const cb = chapterOrder.get(b.chapterId ?? "") ?? 99;
			if (ca !== cb) return ca - cb;
		}
		if (a.mtime !== b.mtime) return b.mtime - a.mtime;
		return a.path.localeCompare(b.path);
	});
	return out;
}

/** 单次读取的字节上限(超出截断——工作区里出现超大文件是用户自己的事,不该把浏览器灌死)。 */
export const MAX_READ_BYTES = 512 * 1024;

/**
 * 相对路径是否属于工作区可读范围(**与清单同一套排除规则**,单一真相源:
 * 列得出来的就一定读得到,读得到的就一定列得出来;两侧规则一旦分叉,
 * 就会出现「点了没反应」或「列不出来但能读」的幽灵)。
 *
 * 拒绝:空路径、内含 NUL、绝对路径/盘符、任一段为 `.`/`..`/空、
 * 隐藏文件与隐藏目录(含 `.writer/`)、`*.jsonl`、根级机器数据文件、世界书生成物。
 */
export function isWorkspaceFile(rel: string): boolean {
	if (rel.length === 0 || rel.includes("\0")) return false;
	if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return false;
	const segs = rel.split("/");
	const name = segs[segs.length - 1]!;
	for (const seg of segs) if (seg === "" || seg === "." || seg === "..") return false;
	if (name.startsWith(".")) return false;
	if (name.endsWith(".jsonl")) return false;
	if (segs.length === 1 && SKIP_FILES.has(rel)) return false;
	if (isGeneratedView(rel)) return false;
	for (const seg of segs.slice(0, -1)) {
		if (SKIP_DIRS.has(seg)) return false;
		if (seg.startsWith(".")) return false;
	}
	return true;
}

/**
 * 校验并 stat 一个工作区文件。返回绝对路径与元信息;不满足条件返回 null:
 * 路径不在工作区范围 / 不存在 / 不是**普通文件**(目录、**符号链接**一律拒绝——
 * 链接可指向书目录外,读它等于把边界拆了)。
 *
 * 两道符号链接防线,缺一不可(2026-09-18 单测抓出来的洞):
 * - `lstat` 拒掉**末段**是链接的情况(如 `leak.md -> /外部/secret.md`);
 * - `realpath` 包含性检查拒掉**中间目录**是链接的情况
 *   (如 `notes/linked/secret.md`,其中 `notes/linked` 是链接)——lstat 会跟随
 *   中间段,只看末段的实现会读穿到书目录外。
 * 返回的 abs 用 realpath 结果,后续读盘不经由可能被替换的链接路径。
 */
export async function statWorkspaceFile(
	bookDir: string,
	rel: string,
): Promise<{ abs: string; bytes: number; mtime: number } | null> {
	if (!isWorkspaceFile(rel)) return null;
	const abs = join(bookDir, rel);
	try {
		const st = await lstat(abs);
		if (!st.isFile()) return null;
		const [rootReal, absReal] = await Promise.all([realpath(bookDir), realpath(abs)]);
		if (absReal !== rootReal && !absReal.startsWith(rootReal + sep)) return null;
		return { abs: absReal, bytes: st.size, mtime: st.mtimeMs };
	} catch {
		return null;
	}
}

/** 工作区文本文件内容。 */
export interface BookFileText {
	path: string;
	kind: BookFileKind;
	bytes: number;
	mtime: number;
	/** 文件内容;超过 MAX_READ_BYTES 时截断。 */
	text: string;
	/** 是否被截断(前端据此提示「只显示前 N KB」)。 */
	truncated: boolean;
}

/**
 * 读工作区文本文件(二进制类型与非法路径返回 null,由调用方给 400/404)。
 * 图片不走这里——它们按字节流回给 <img>,没必要在 JSON 里塞 base64。
 */
export async function readWorkspaceText(bookDir: string, rel: string): Promise<BookFileText | null> {
	const kind = classifyBookFileKind(rel);
	if (kind !== "text") return null;
	const info = await statWorkspaceFile(bookDir, rel);
	if (!info) return null;
	let buf: Buffer;
	try {
		buf = await readFile(info.abs);
	} catch {
		return null;
	}
	const truncated = buf.length > MAX_READ_BYTES;
	const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
	return {
		path: rel,
		kind,
		bytes: info.bytes,
		mtime: info.mtime,
		text: slice.toString("utf8"),
		truncated,
	};
}
