/**
 * 插件 zip 安装(2026-10-11)。
 *
 * 与书导入(book-zip.ts)共用 zip-read.ts 的安全解包,差别只在「领域校验」:
 *  - 书要根含 book.json;
 *  - 插件要根含 plugin.json,且其中的 id 合法(isValidPluginId),目录名以 id 为准
 *    (不信 zip 里的目录名,也不信 manifest 里的 id 与目录名一致——写盘时统一按 id 建目录)。
 *
 * 两种 zip 布局都接受(App 里手动打包很常见两种):
 *  1) 根就是插件目录:      plugin.json / index.mjs ...
 *  2) 外面包一层目录:      my-plugin/plugin.json / my-plugin/index.mjs ...
 *     —— 单层包裹时剥掉这一层(前提:所有条目都在同一个顶层目录下)。
 *
 * 安全边界(与 removePlugin 同款):落盘前每条路径再校验一次越界;安装对象目录
 * 必须在 plugins 根内。
 *
 * 覆盖安装(2026-10-11 起):同 id 已存在时直接替换。替换走「先写暂存目录,再原子换入」,
 * 中途失败(磁盘满/权限)不会把旧插件删掉留下半个目录——旧版本要么完整保留,要么被
 * 新版本完整换掉。唯一例外:换入的最后一步(把旧目录挪走)之后若重命名失败,会尽力回滚。
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { getPluginsDir, isValidPluginId } from "../plugin-loader.ts";
import { readZipEntries } from "./zip-read.ts";

/** 插件 zip 限额:比书小得多(插件是几个 .mjs/.json)。 */
export const MAX_PLUGIN_ZIP_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_PLUGIN_ENTRIES = 500;
const MAX_PLUGIN_UNCOMPRESSED = 20 * 1024 * 1024; // 20MB

/** 解包结果:插件 id + 根相对路径 → 内容。 */
export interface PluginZipImport {
	id: string;
	/** 剥掉包裹目录后、插件根相对路径(posix)→ 内容;含 plugin.json 本身。 */
	files: Map<string, Buffer>;
}

/**
 * 单层包裹剥离:若所有条目都在同一个顶层目录(<dir>/...)且根无文件,剥掉这一层。
 * 「根有文件」与「有多个顶层目录」都视为不包裹,原样返回(不猜)。
 */
function unwrapSingleRoot(files: Map<string, Buffer>): Map<string, Buffer> {
	const roots = new Set<string>();
	let rootHasFile = false;
	for (const rel of files.keys()) {
		const slash = rel.indexOf("/");
		if (slash === -1) {
			rootHasFile = true;
			break;
		}
		roots.add(rel.slice(0, slash));
	}
	if (rootHasFile || roots.size !== 1) return files;
	// 唯一顶层目录 → 剥掉
	const prefix = `${[...roots][0]}/`;
	const out = new Map<string, Buffer>();
	for (const [rel, buf] of files) out.set(rel.slice(prefix.length), buf);
	return out;
}

/**
 * 解包插件 zip,返回 id 与文件(不写盘)。
 * 校验:zip 可解析/路径安全(由 readZipEntries)、根含 plugin.json、plugin.json 合法
 * JSON 且 id 合法。任何失败 throw Error(中文),由服务端层转 400。
 */
export async function readPluginZip(buffer: Buffer): Promise<PluginZipImport> {
	const { files } = await readZipEntries(buffer, {
		maxBytes: MAX_PLUGIN_ZIP_BYTES,
		maxEntries: MAX_PLUGIN_ENTRIES,
		maxUncompressed: MAX_PLUGIN_UNCOMPRESSED,
		tooLargeMessage: `插件 zip 超过 ${MAX_PLUGIN_ZIP_BYTES / 1024 / 1024}MB`,
	});
	const stripped = unwrapSingleRoot(files);
	const manifestBuf = stripped.get("plugin.json");
	if (!manifestBuf) throw new Error("zip 缺少 plugin.json(压缩包根目录或单层子目录下需有 plugin.json)");
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestBuf.toString("utf8"));
	} catch {
		throw new Error("plugin.json 不是合法 JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("plugin.json 不是合法 JSON 对象");
	}
	const id = (parsed as Record<string, unknown>).id;
	if (typeof id !== "string" || !isValidPluginId(id)) {
		throw new Error("plugin.json 的 id 缺失或非法(须小写字母/数字/连字符)");
	}
	return { id, files: stripped };
}

/**
 * 把已解包的插件文件安装到 `~/.pi/writer/plugins/<id>/`,同 id 已存在时覆盖。
 *
 * 覆盖策略:先整份写进暂存目录 `<id>.staging-<rand>`,写完再换入目标位置。
 * 换入时若目标存在,先把旧目录重命名成 `<id>.old-<rand>`(同盘 rename,近乎原子),
 * 再把暂存目录 rename 成目标名;成功后删掉旧目录。任一步失败都尽量回滚,
 * 使「旧版本完整保留」而非「留下半个新目录」。
 * 每条相对路径落盘前再校验一次越界。
 */
export async function writePluginFiles(id: string, files: Map<string, Buffer>): Promise<string> {
	if (!isValidPluginId(id)) throw new Error(`非法插件 id: ${id}`);
	const root = getPluginsDir();
	const pluginDir = join(root, id);
	await mkdir(root, { recursive: true });

	// 1) 全量写暂存目录(此时还没碰旧版本;失败直接清掉暂存即回滚)
	const stagingDir = join(root, `${id}.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	try {
		await mkdir(stagingDir, { recursive: true });
		for (const [rel, content] of files) {
			// readZipEntries 已保证 posix 相对路径,落盘前再防御性校验一次
			const abs = join(stagingDir, ...rel.split("/"));
			if (abs !== stagingDir && !abs.startsWith(stagingDir + sep)) {
				throw new Error(`插件条目路径越界: ${rel}`);
			}
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content);
		}
	} catch (err) {
		await rm(stagingDir, { recursive: true, force: true });
		throw err;
	}

	// 2) 换入:目标存在则先挪走旧版本,再 rename 暂存目录为正式名
	const backupDir = join(root, `${id}.old-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const hadOld = existsSync(pluginDir);
	if (hadOld) await rename(pluginDir, backupDir);
	try {
		await rename(stagingDir, pluginDir);
	} catch (err) {
		// rename 失败:把旧版本挪回来,清掉暂存,报错
		if (hadOld) await rename(backupDir, pluginDir).catch(() => {});
		await rm(stagingDir, { recursive: true, force: true });
		throw err;
	}
	// 3) 换入成功,清掉旧版本(清不掉不致命,不影响新版本已生效)
	if (hadOld) await rm(backupDir, { recursive: true, force: true }).catch(() => {});
	return pluginDir;
}
