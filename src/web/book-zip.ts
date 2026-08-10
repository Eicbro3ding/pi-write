import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import yauzl from "yauzl";

/** 导出/导入限额(防 zip 炸弹)。 */
export const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_UNCOMPRESSED = 100 * 1024 * 1024; // 100MB
export const MAX_ENTRIES = 2000;

/** readImportZip 的解包结果。 */
export interface BookZipImport {
	slug: string;
	title: string;
	/** zip 根相对路径(posix 分隔符) → 文件内容;含 book.json 本身。 */
	files: Map<string, Buffer>;
}

/** 收集 Readable 流的全部数据为 Buffer。 */
async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await pipeline(stream, new PassThrough().on("data", (c: Buffer) => chunks.push(c)));
	return Buffer.concat(chunks);
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
	if (buffer.length > MAX_ZIP_BYTES) {
		throw new Error(`zip 文件过大(超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB)`);
	}

	const zip = await openZip(buffer);
	const files = new Map<string, Buffer>();
	const seen = new Set<string>();
	let fileCount = 0;
	let totalUncompressed = 0;
	let bookJson: Buffer | null = null;

	try {
		// yauzl 是回调 API:逐条 readEntry,目录条目跳过,其余逐条解压。
		for (;;) {
			const entry = await nextEntry(zip);
			if (!entry) break;
			const name = entry.fileName;
			if (name.endsWith("/")) continue; // 目录条目,正常 zip 都有,静默跳过
			const safe = normalizeEntryPath(name);
			if (seen.has(safe)) throw new Error(`zip 条目重复: ${name}`);
			seen.add(safe);
			if (++fileCount > MAX_ENTRIES) throw new Error(`zip 条目数超过上限(${MAX_ENTRIES})`);
			totalUncompressed += entry.uncompressedSize;
			if (totalUncompressed > MAX_UNCOMPRESSED) {
				throw new Error(`zip 解压总量超过上限(${MAX_UNCOMPRESSED / 1024 / 1024}MB)`);
			}
			const content = await readEntryContent(zip, entry);
			files.set(safe, content);
			if (safe === "book.json") bookJson = content;
		}
	} finally {
		zip.close();
	}

	if (!bookJson) throw new Error("zip 缺少 book.json");
	return { ...parseBookJson(bookJson), files };
}

/** yauzl.fromBuffer 的 Promise 包装;zip 损坏时经回调 err 拒绝。 */
function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.fromBuffer(
			buffer,
			{ lazyEntries: true, validateEntrySizes: true },
			(err, zip) => {
				if (err) {
					reject(new Error(`zip 无法解析: ${err.message}`));
				} else if (!zip) {
					reject(new Error("zip 无法解析"));
				} else {
					resolve(zip);
				}
			},
		);
	});
}

/** 等待下一条 zip 条目;读完返回 null。错误(含数据损坏)转为 reject。 */
function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
	return new Promise((resolve, reject) => {
		const onEntry = (entry: yauzl.Entry): void => {
			cleanup();
			resolve(entry);
		};
		const onEnd = (): void => {
			cleanup();
			resolve(null);
		};
		const onError = (err: Error): void => {
			cleanup();
			reject(new Error(toChineseZipError(err)));
		};
		const cleanup = (): void => {
			zip.removeListener("entry", onEntry);
			zip.removeListener("end", onEnd);
			zip.removeListener("error", onError);
		};
		zip.on("entry", onEntry);
		zip.on("end", onEnd);
		zip.on("error", onError);
		zip.readEntry();
	});
}

/** 解压单条条目为 Buffer。 */
function readEntryContent(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => {
			if (err || !stream) {
				reject(new Error(`zip 条目读取失败: ${err?.message ?? "未知错误"}`));
				return;
			}
			const chunks: Buffer[] = [];
			stream.on("data", (c: Buffer) => chunks.push(c));
			stream.on("end", () => resolve(Buffer.concat(chunks)));
			stream.on("error", (e) => reject(new Error(`zip 条目读取失败: ${e.message}`)));
		});
	});
}

/**
 * 把 yauzl 的英文校验错误映射为中文错误(保持本模块错误消息全部为中文)。
 * yauzl 在解析条目时即校验文件名(绝对路径/盘符/`..`),错误先于我们自己的校验抛出。
 */
function toChineseZipError(err: Error): string {
	const m = /^absolute path: (.+)$/.exec(err.message);
	if (m) {
		// yauzl 把盘符也归为 "absolute path",按内容区分给出更准确的提示
		if (/^[A-Za-z]:/.test(m[1])) return `zip 条目含盘符: ${m[1]}`;
		return `zip 条目为绝对路径: ${m[1]}`;
	}
	if (err.message.startsWith("invalid relative path:")) {
		return `zip 条目路径越界(..): ${err.message.slice("invalid relative path:".length).trim()}`;
	}
	if (err.message.startsWith("invalid characters in fileName:")) {
		return `zip 条目含非法字符: ${err.message.slice("invalid characters in fileName:".length).trim()}`;
	}
	return `zip 读取失败: ${err.message}`;
}

/**
 * 校验条目路径并把 `\\` 视为分隔符,规范化(处理 `.`/`..`)为 zip 根相对 posix 路径。
 * 拒绝:空路径、绝对路径(`/` 开头)、盘符(`C:`)、`..` 越出 zip 根。
 */
function normalizeEntryPath(name: string): string {
	if (name.length === 0) throw new Error("zip 条目路径为空");
	if (name.startsWith("/")) throw new Error(`zip 条目为绝对路径: ${name}`);
	if (/^[A-Za-z]:/.test(name)) throw new Error(`zip 条目含盘符: ${name}`);
	const out: string[] = [];
	for (const part of name.split(/[\\/]+/)) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			// 已无上级可回退 → 越出 zip 根,拒绝
			if (out.length === 0) throw new Error(`zip 条目路径越界: ${name}`);
			out.pop();
			continue;
		}
		if (/^[A-Za-z]:/.test(part)) throw new Error(`zip 条目含盘符: ${name}`);
		out.push(part);
	}
	if (out.length === 0) throw new Error("zip 条目路径为空");
	return out.join("/");
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
