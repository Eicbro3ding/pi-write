/**
 * 插件 zip 安装测试(临时 PI_WRITER_DIR,真实磁盘 / 真实 zip):
 * 解包读取(id 提取 / 单层包裹剥离 / 各类拒绝)+ 落盘 + 覆盖安装语义。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPluginsDir, listPlugins, pluginExists, removePlugin } from "../src/plugin-loader.ts";
import { MAX_PLUGIN_ZIP_BYTES, readPluginZip, writePluginFiles } from "../src/web/plugin-zip.ts";

const tmp = mkdtempSync(join(tmpdir(), "piw-plugin-zip-"));
process.env.PI_WRITER_DIR = tmp;
const root = getPluginsDir();

/** 用 yazl 把 { 相对路径: 内容 } 打成 zip Buffer(真实压缩,非 mock)。 */
async function makeZip(entries: Record<string, string | Buffer>): Promise<Buffer> {
	const zip = new yazl.ZipFile();
	for (const [rel, content] of Object.entries(entries)) {
		zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), rel);
	}
	zip.end();
	const chunks: Buffer[] = [];
	await pipeline(zip.outputStream, new PassThrough().on("data", (c: Buffer) => chunks.push(c)));
	return Buffer.concat(chunks);
}

/**
 * 手写一个含越界条目的 zip(yazl 拒绝写 `..` 路径,没法用它构造这条用例)。
 * 结构:一个 local file header + 中央目录 + EOCD,内容为最小合法 zip 骨架。
 */
function makeZipWithRawEntry(entryName: string, content = "x"): Buffer {
	const nameBuf = Buffer.from(entryName, "utf8");
	const data = Buffer.from(content, "utf8");
	const crc = crc32(data);
	// local file header(30 字节固定 + 名字)
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4); // version needed
	local.writeUInt16LE(0, 6); // flags
	local.writeUInt16LE(0, 8); // method = stored
	local.writeUInt16LE(0, 10); // time
	local.writeUInt16LE(0, 12); // date
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(data.length, 18); // compressed
	local.writeUInt32LE(data.length, 22); // uncompressed
	local.writeUInt16LE(nameBuf.length, 26);
	local.writeUInt16LE(0, 28); // extra len
	const localFull = Buffer.concat([local, nameBuf, data]);
	// 中央目录
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4); // version made by
	central.writeUInt16LE(20, 6); // version needed
	central.writeUInt16LE(0, 8); // flags
	central.writeUInt16LE(0, 10); // method
	central.writeUInt16LE(0, 12); // time
	central.writeUInt16LE(0, 14); // date
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBuf.length, 28);
	central.writeUInt32LE(0, 42); // local header offset = 0
	const centralFull = Buffer.concat([central, nameBuf]);
	// EOCD
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8); // entries on disk
	eocd.writeUInt16LE(1, 10); // total entries
	eocd.writeUInt32LE(centralFull.length, 12);
	eocd.writeUInt32LE(localFull.length, 16); // central dir offset
	return Buffer.concat([localFull, centralFull, eocd]);
}

/** 最小 CRC-32(手写 zip 用例需要正确 CRC,yauzl 校验)。 */
function crc32(buf: Buffer): number {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

/** 一个最小可装载插件的文件集。 */
function pluginFiles(id: string): Record<string, string> {
	return {
		"plugin.json": JSON.stringify({ id, version: "0.1.0", name: `插件 ${id}` }),
		"index.mjs": `export default function factory() { return "ok"; }`,
	};
}

beforeAll(() => {
	mkdirSync(root, { recursive: true });
});
beforeEach(() => {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("readPluginZip(解包与校验)", () => {
	it("根即插件目录:取出 id 与文件", async () => {
		const parsed = await readPluginZip(await makeZip(pluginFiles("dice")));
		expect(parsed.id).toBe("dice");
		expect([...parsed.files.keys()].sort()).toEqual(["index.mjs", "plugin.json"]);
	});

	it("单层包裹目录:剥掉顶层目录", async () => {
		const wrapped = Object.fromEntries(
			Object.entries(pluginFiles("wrapped")).map(([k, v]) => [`my-plugin/${k}`, v]),
		);
		const parsed = await readPluginZip(await makeZip(wrapped));
		expect(parsed.id).toBe("wrapped");
		expect([...parsed.files.keys()].sort()).toEqual(["index.mjs", "plugin.json"]);
	});

	it("根有文件同时也有子目录:不剥离(避免猜错)", async () => {
		const mixed = { ...pluginFiles("mixed"), "sub/extra.txt": "x" };
		const parsed = await readPluginZip(await makeZip(mixed));
		expect(parsed.id).toBe("mixed");
		expect([...parsed.files.keys()].sort()).toEqual(["index.mjs", "plugin.json", "sub/extra.txt"]);
	});

	it("缺 plugin.json → 报错", async () => {
		await expect(readPluginZip(await makeZip({ "index.mjs": "export default 1;" }))).rejects.toThrow(/缺少 plugin\.json/);
	});

	it("plugin.json 不是合法 JSON → 报错", async () => {
		await expect(readPluginZip(await makeZip({ "plugin.json": "{ not json" }))).rejects.toThrow(/不是合法 JSON/);
	});

	it("plugin.json 的 id 非法(大写)→ 报错", async () => {
		const bad = { "plugin.json": JSON.stringify({ id: "BadId", version: "1.0.0" }) };
		await expect(readPluginZip(await makeZip(bad))).rejects.toThrow(/id 缺失或非法/);
	});

	it("plugin.json 缺 id → 报错", async () => {
		const bad = { "plugin.json": JSON.stringify({ version: "1.0.0" }) };
		await expect(readPluginZip(await makeZip(bad))).rejects.toThrow(/id 缺失或非法/);
	});

	it("路径穿越(../)→ 拒绝", async () => {
		// yazl 拒绝写 `..` 路径,只能手写 zip 字节构造这条用例
		const evil = makeZipWithRawEntry("../escape.txt");
		await expect(readPluginZip(evil)).rejects.toThrow(/越界|无法解析|路径/);
	});

	it("zip 超过 10MB → 拒绝", async () => {
		// 用真随机内容,否则 deflate 会把可压缩串压到极小、测不到体积上限
		const blob = randomBytes(MAX_PLUGIN_ZIP_BYTES + 1024);
		const big = await makeZip({ ...pluginFiles("big"), "blob.bin": blob });
		await expect(readPluginZip(big)).rejects.toThrow(/超过 10MB/);
	});
});

describe("writePluginFiles + pluginExists(落盘与覆盖)", () => {
	it("落盘后可被 listPlugins 扫到", async () => {
		const parsed = await readPluginZip(await makeZip(pluginFiles("dice")));
		await writePluginFiles(parsed.id, parsed.files);
		expect(existsSync(join(root, "dice", "plugin.json"))).toBe(true);
		expect(readFileSync(join(root, "dice", "index.mjs"), "utf8")).toContain("factory");
		const list = await listPlugins();
		expect(list.map((p) => p.id)).toContain("dice");
	});

	it("pluginExists:安装前后", async () => {
		expect(pluginExists("dice")).toBe(false);
		await writePluginFiles("dice", (await readPluginZip(await makeZip(pluginFiles("dice")))).files);
		expect(pluginExists("dice")).toBe(true);
		expect(pluginExists("BadId")).toBe(false);
	});

	it("覆盖安装:同 id 再装替换旧文件,且不留暂存/旧目录", async () => {
		const v1 = {
			"plugin.json": JSON.stringify({ id: "dice", version: "0.1.0", name: "骰子" }),
			"index.mjs": `export default function factory() { return "v1"; }`,
			"extra.txt": "旧版本独有",
		};
		await writePluginFiles("dice", (await readPluginZip(await makeZip(v1))).files);
		expect(pluginExists("dice")).toBe(true);

		const v2 = {
			"plugin.json": JSON.stringify({ id: "dice", version: "0.2.0", name: "骰子" }),
			"index.mjs": `export default function factory() { return "v2"; }`,
		};
		await writePluginFiles("dice", (await readPluginZip(await makeZip(v2))).files);

		expect(readFileSync(join(root, "dice", "index.mjs"), "utf8")).toContain("v2");
		// 旧版本独有的文件不应残留(整目录被换掉,而非逐文件覆盖)
		expect(existsSync(join(root, "dice", "extra.txt"))).toBe(false);
		expect(JSON.parse(readFileSync(join(root, "dice", "plugin.json"), "utf8")).version).toBe("0.2.0");
		// 暂存目录/旧目录都不该留下
		expect(existsSync(join(root, "dice.staging"))).toBe(false);
		const leftovers = readdirSync(root).filter((n) => n.startsWith("dice."));
		expect(leftovers).toEqual([]);
		const list = await listPlugins();
		expect(list.filter((p) => p.id === "dice")).toHaveLength(1);
	});

	it("删除后可再次安装", async () => {
		await writePluginFiles("dice", (await readPluginZip(await makeZip(pluginFiles("dice")))).files);
		await removePlugin("dice");
		expect(pluginExists("dice")).toBe(false);
		await writePluginFiles("dice", (await readPluginZip(await makeZip(pluginFiles("dice")))).files);
		expect(pluginExists("dice")).toBe(true);
	});
});
