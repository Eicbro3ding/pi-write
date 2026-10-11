import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import yazl from "yazl";
import { ZIP_MAX_ENTRIES, ZIP_MAX_UNCOMPRESSED, collectStream, readZipEntries } from "./zip-read.ts";

/** 导出/导入限额(防 zip 炸弹)。路径/条目/解压上限的权威值在 zip-read.ts。 */
export const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_UNCOMPRESSED = ZIP_MAX_UNCOMPRESSED; // 100MB
export const MAX_ENTRIES = ZIP_MAX_ENTRIES;

/** readImportZip 的解包结果。 */
export interface BookZipImport {
	slug: string;
	title: string;
	/** zip 根相对路径(posix 分隔符) → 文件内容;含 book.json 本身。 */
	files: Map<string, Buffer>;
}

/**
 * 把书目录下全部文件(递归)打包为 zip Buffer。
 * zip 内路径为书根相对路径(posix 分隔符,如 `book.json`、`draft/ch01.md`);空目录跳过。
 * book.json 必须在书根,否则拒绝导出。
 */
export async function exportBookZip(bookDir: string): Promise<Buffer> {
	if (!existsSync(bookDir) || !statSync(bookDir).isDirectory()) {
		throw new Error(`书目录不存在或不是目录: ${bookDir}`);
	}
	// 递归收集全部文件:{ zip 内相对路径(posix) → 磁盘绝对路径 }。
	// 符号链接的 Dirent 既非文件也非目录,跳过,避免打包出目录外内容。
	const files = new Map<string, string>();
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), posix.join(rel, entry.name));
			} else if (entry.isFile()) {
				files.set(posix.join(rel, entry.name), join(dir, entry.name));
			}
		}
	};
	walk(bookDir, "");
	if (!files.has("book.json")) throw new Error("书目录缺少 book.json");

	const zip = new yazl.ZipFile();
	for (const [rel, abs] of files) zip.addFile(abs, rel);
	zip.end();
	const buffer = await collectStream(zip.outputStream);
	if (buffer.length > MAX_ZIP_BYTES) {
		throw new Error(`导出的 zip 超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB,无法导出`);
	}
	return buffer;
}

/**
 * 安全解包 zip Buffer,返回书元数据与全部文件。
 * 校验:zip 可解析、路径安全(无绝对路径/盘符/`..` 穿越/空路径)、无重复条目、
 * 条目数 ≤ MAX_ENTRIES、解压总量 ≤ MAX_UNCOMPRESSED、zip 本身 ≤ MAX_ZIP_BYTES、
 * 根含 book.json 且 slug/title 合法。任何失败 throw Error(中文),由服务端层转 400。
 */
export async function readImportZip(buffer: Buffer): Promise<BookZipImport> {
	const { files } = await readZipEntries(buffer, {
		maxBytes: MAX_ZIP_BYTES,
		maxEntries: MAX_ENTRIES,
		maxUncompressed: MAX_UNCOMPRESSED,
		tooLargeMessage: `zip 文件过大(超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB)`,
	});
	const bookJson = files.get("book.json");
	if (!bookJson) throw new Error("zip 缺少 book.json");
	return { ...parseBookJson(bookJson), files };
}

/** 解析 book.json:slug 必须非空且不含 `/`、`\`、`..`;title 缺省回退 slug。 */
function parseBookJson(content: Buffer): { slug: string; title: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.toString("utf8"));
	} catch {
		throw new Error("book.json 不是合法 JSON");
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("book.json 不是合法 JSON");
	const raw = parsed as Record<string, unknown>;
	const slug = typeof raw.slug === "string" ? raw.slug : "";
	const title = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : slug;
	if (slug.length === 0) throw new Error("book.json 缺少 slug");
	if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
		throw new Error(`slug 非法: ${slug}`);
	}
	return { slug, title };
}
