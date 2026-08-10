import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import yauzl from "yauzl";
import {
	exportBookZip,
	MAX_UNCOMPRESSED,
	MAX_ZIP_BYTES,
	readImportZip,
} from "../src/web/book-zip.ts";

/** 收集 yazl ZipFile 输出为 Buffer。 */
async function collectZip(zip: yazl.ZipFile): Promise<Buffer> {
	zip.end();
	const chunks: Buffer[] = [];
	await pipeline(zip.outputStream, new PassThrough().on("data", (c: Buffer) => chunks.push(c)));
	return Buffer.concat(chunks);
}

/** 用 yazl 把 { relPath: content } 打成 zip Buffer(测试 fixture 生成器)。 */
async function makeZip(files: Record<string, string | Buffer>): Promise<Buffer> {
	const zip = new yazl.ZipFile();
	for (const [rel, content] of Object.entries(files)) {
		zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), rel);
	}
	return collectZip(zip);
}

/** CRC-32(标准 zip 算法),用于手工构造 zip。 */
function crc32Of(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 手工构造最小 zip(store 压缩,无加密,UTF-8 条目名)。
 * yazl 会拒绝创建恶意路径(绝对路径/盘符/`..`)条目,故这些 fixture 需要直接写字节。
 */
function buildRawZip(files: Record<string, string>): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const nameBuf = Buffer.from(name, "utf8");
		const crc = crc32Of(data);
		// 本地文件头
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 条目名
		local.writeUInt16LE(0, 8); // store(不压缩)
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		parts.push(local, nameBuf, data);
		// 中央目录条目
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(0, 10);
		cen.writeUInt16LE(0, 12);
		cen.writeUInt16LE(0, 14);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(data.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt16LE(0, 30);
		cen.writeUInt16LE(0, 32);
		cen.writeUInt16LE(0, 34);
		cen.writeUInt16LE(0, 36);
		cen.writeUInt32LE(0, 38);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, nameBuf);
		offset += 30 + nameBuf.length + data.length;
	}
	// 中央目录结束记录(EOCD)
	const cenSize = central.reduce((s, b) => s + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(Object.keys(files).length, 8);
	eocd.writeUInt16LE(Object.keys(files).length, 10);
	eocd.writeUInt32LE(cenSize, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);
	return Buffer.concat([...parts, ...central, eocd]);
}

/** 列出 zip 内的原始条目名(供导出结果断言)。 */
function listEntryNames(buffer: Buffer): Promise<string[]> {
	return new Promise((resolve, reject) => {
		yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
			if (err || !zip) {
				reject(new Error(`无法打开 zip: ${err?.message ?? "未知错误"}`));
				return;
			}
			const names: string[] = [];
			zip.on("entry", (entry: yauzl.Entry) => {
				names.push(entry.fileName);
				zip.readEntry();
			});
			zip.on("end", () => resolve(names));
			zip.on("error", reject);
			zip.readEntry();
		});
	});
}

/** 建临时书目录并写入文件,回调后清理。 */
async function withBookDir(
	files: Record<string, string>,
	fn: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-writer-zip-test-"));
	try {
		for (const [rel, content] of Object.entries(files)) {
			const abs = join(dir, ...rel.split("/"));
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		}
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("exportBookZip", () => {
	it("打包书目录,zip 内含 book.json 与全部文件,路径为书根相对", async () => {
		await withBookDir(
			{
				"book.json": JSON.stringify({ slug: "test-book", title: "测试书" }),
				"draft/ch01.md": "# 第一章",
				".writer/characters.md": "角色卡",
				"outline.md": "大纲",
			},
			async (dir) => {
				const buffer = await exportBookZip(dir);
				const { files } = await readImportZip(buffer);
				expect([...files.keys()].sort()).toEqual(
					[".writer/characters.md", "book.json", "draft/ch01.md", "outline.md"].sort(),
				);
				expect(files.get("draft/ch01.md")?.toString()).toBe("# 第一章");
				expect(files.get(".writer/characters.md")?.toString()).toBe("角色卡");
				expect(files.get("outline.md")?.toString()).toBe("大纲");
				expect(JSON.parse(files.get("book.json")!.toString())).toMatchObject({
					slug: "test-book",
					title: "测试书",
				});
			},
		);
	});

	it("跳过空目录", async () => {
		await withBookDir({ "book.json": JSON.stringify({ slug: "test-book" }) }, async (dir) => {
			mkdirSync(join(dir, "draft"));
			const buffer = await exportBookZip(dir);
			const names = await listEntryNames(buffer);
			expect(names).toEqual(["book.json"]);
			expect(names.some((n) => n.startsWith("draft"))).toBe(false);
		});
	});

	it("目录缺少 book.json 拒绝导出", async () => {
		await withBookDir({ "outline.md": "大纲" }, async (dir) => {
			await expect(exportBookZip(dir)).rejects.toThrow("book.json");
		});
	});
});

describe("readImportZip", () => {
	it("合法 zip 返回 slug/title 与文件内容", async () => {
		const zip = await makeZip({
			"book.json": JSON.stringify({ slug: "my-book", title: "我的书" }),
			"draft/ch01.md": "正文",
		});
		const result = await readImportZip(zip);
		expect(result.slug).toBe("my-book");
		expect(result.title).toBe("我的书");
		expect(result.files.get("draft/ch01.md")?.toString()).toBe("正文");
		expect(result.files.get("book.json")).toBeDefined();
	});

	it("book.json 缺 title 时回退为 slug", async () => {
		const zip = await makeZip({ "book.json": JSON.stringify({ slug: "my-book" }) });
		const result = await readImportZip(zip);
		expect(result.slug).toBe("my-book");
		expect(result.title).toBe("my-book");
	});

	it("slug 含 /、\\ 或 .. 拒绝", async () => {
		for (const bad of ["a/b", "a\\b", "a..b"]) {
			const zip = await makeZip({ "book.json": JSON.stringify({ slug: bad }) });
			await expect(readImportZip(zip)).rejects.toThrow("slug");
		}
	});

	it("缺 book.json 拒绝", async () => {
		const zip = await makeZip({ "draft/ch01.md": "正文" });
		await expect(readImportZip(zip)).rejects.toThrow("book.json");
	});

	it("路径穿越条目(../evil.md)拒绝", async () => {
		const zip = buildRawZip({
			"book.json": JSON.stringify({ slug: "b" }),
			"../evil.md": "x",
		});
		await expect(readImportZip(zip)).rejects.toThrow("..");
	});

	it("绝对路径条目(/etc/passwd)拒绝", async () => {
		const zip = buildRawZip({
			"book.json": JSON.stringify({ slug: "b" }),
			"/etc/passwd": "x",
		});
		await expect(readImportZip(zip)).rejects.toThrow("绝对路径");
	});

	it("盘符条目(C:/evil.md)拒绝", async () => {
		const zip = buildRawZip({
			"book.json": JSON.stringify({ slug: "b" }),
			"C:/evil.md": "x",
		});
		await expect(readImportZip(zip)).rejects.toThrow("盘符");
	});

	it("重复条目路径拒绝", async () => {
		const zip = new yazl.ZipFile();
		zip.addBuffer(Buffer.from(JSON.stringify({ slug: "b" })), "book.json");
		zip.addBuffer(Buffer.from("a"), "dup.txt");
		zip.addBuffer(Buffer.from("b"), "dup.txt");
		const buffer = await collectZip(zip);
		await expect(readImportZip(buffer)).rejects.toThrow("重复");
	});

	it("条目数超过 2000 拒绝", async () => {
		const files: Record<string, string> = { "book.json": JSON.stringify({ slug: "b" }) };
		for (let i = 0; i < 2001; i++) files[`f${i}.txt`] = "x";
		const zip = await makeZip(files);
		await expect(readImportZip(zip)).rejects.toThrow("2000");
	});

	it("解压总量超过 100MB 拒绝", async () => {
		const zip = await makeZip({
			"book.json": JSON.stringify({ slug: "b" }),
			// 100MB + 1 字节("a" 重复可压缩,但解压后总量仍超限)
			"big.txt": "a".repeat(MAX_UNCOMPRESSED + 1),
		});
		await expect(readImportZip(zip)).rejects.toThrow("100MB");
	});

	it("zip 本身超过 50MB 拒绝", async () => {
		const zip = await makeZip({
			"book.json": JSON.stringify({ slug: "b" }),
			"big.bin": randomBytes(MAX_ZIP_BYTES + 1),
		});
		await expect(readImportZip(zip)).rejects.toThrow("50MB");
	});

	it("非法 zip(buffer 乱字节)拒绝", async () => {
		await expect(readImportZip(Buffer.from("这不是一个 zip 文件"))).rejects.toThrow();
	});
});
