/**
 * zip 只读解包原语(2026-10-11 从 book-zip.ts 抽出,供书导入与插件安装共用)。
 *
 * 存在的理由:book-zip 与 plugin-zip 的**安全校验是同一条**——路径规范化、条目数、
 * 解压总量、中文错误映射必须完全一致,否则一条通道收紧、另一条忘了收就漏了。
 * 这里只放「怎么安全地把 zip 读成一个 Map<posix 相对路径, Buffer>」,
 * 不放任何领域校验(书要 book.json、插件要 plugin.json 且 id 合法,那些在各自模块)。
 *
 * 限额分两组:
 *  - 通用上限(MAX_ENTRIES / MAX_UNCOMPRESSED)防 zip 炸弹,两条通道同值;
 *  - zip 本身体积由调用方传(书的题库可能几十 M,插件理应极小)。
 */

import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

/** 解包结果:posix 相对路径 → 内容;目录条目已跳过。 */
export interface ZipReadResult {
	files: Map<string, Buffer>;
}

/** zip 解包限额:条目数上限。防「一个 zip 内几万个碎条目」拖垮解压循环。 */
export const ZIP_MAX_ENTRIES = 2000;
/** zip 解包限额:解压后总量上限(100MB)。防 zip 炸弹(小包解压成巨物)。 */
export const ZIP_MAX_UNCOMPRESSED = 100 * 1024 * 1024;

/** 收集 Readable 流的全部数据为 Buffer。 */
async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await pipeline(stream, new PassThrough().on("data", (c: Buffer) => chunks.push(c)));
	return Buffer.concat(chunks);
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
export function toChineseZipError(err: Error): string {
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
export function normalizeEntryPath(name: string): string {
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

/**
 * 安全解包 zip Buffer 为「posix 相对路径 → 内容」的 Map(目录条目跳过)。
 *
 * 校验:zip 可解析、条目路径安全(无绝对路径/盘符/`..` 穿越/空路径)、无重复条目、
 * 条目数 ≤ maxEntries、解压总量 ≤ maxUncompressed、zip 本身 ≤ maxBytes。
 * **任何领域校验(必须含哪个文件)由调用方做** —— 本函数不认识 book/plugin。
 * 任何失败 throw Error(中文),由调用方转 HTTP 400。
 */
export async function readZipEntries(
	buffer: Buffer,
	opts: { maxBytes: number; maxEntries?: number; maxUncompressed?: number; tooLargeMessage?: string },
): Promise<ZipReadResult> {
	const maxEntries = opts.maxEntries ?? ZIP_MAX_ENTRIES;
	const maxUncompressed = opts.maxUncompressed ?? ZIP_MAX_UNCOMPRESSED;
	if (buffer.length > opts.maxBytes) {
		throw new Error(opts.tooLargeMessage ?? `zip 文件过大(超过 ${Math.round(opts.maxBytes / 1024 / 1024)}MB)`);
	}

	const zip = await openZip(buffer);
	const files = new Map<string, Buffer>();
	const seen = new Set<string>();
	let fileCount = 0;
	let totalUncompressed = 0;

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
			if (++fileCount > maxEntries) throw new Error(`zip 条目数超过上限(${maxEntries})`);
			totalUncompressed += entry.uncompressedSize;
			if (totalUncompressed > maxUncompressed) {
				throw new Error(`zip 解压总量超过上限(${maxUncompressed / 1024 / 1024}MB)`);
			}
			const content = await readEntryContent(zip, entry);
			files.set(safe, content);
		}
	} finally {
		zip.close();
	}

	return { files };
}

export { collectStream };
