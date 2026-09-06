/**
 * 插件加载器 —— 扫描 `~/.pi/writer/plugins/<id>/`,读 plugin.json,动态 import 入口。
 *
 * 设计(2026-09 插件系统雏形):
 * - 一个插件 = 一个目录:plugin.json(id/name/version/main/enabled 可选声明)+ main
 *   入口(default export = ExtensionFactory,与 vendor InlineExtension 语义一致);
 * - 动态加载用 jiti(vendor loader 同款):运行时 import 外部模块,不走 esbuild
 *   打包,插件可写 .mjs/.js/.ts(Node 端);server.cjs 无需改打包配置;
 * - 启用状态双层:plugin.json 的 enabled(作者声明,false = 强制禁用)+
 *   plugin-state.json(用户运行时切换,禁用 ≠ 删除,插件目录可 git 管理;
 *   用户层 enabled=false 优先于 manifest 声明);
 * - 错误逐插件收集:{ id, error } 挂在该插件 info 上,坏插件不阻塞其他插件;
 *   列表/状态经 /api/plugins 暴露,设置页展示。

 * 安全边界:插件与主进程同权(似 Obsidian/酒馆社区插件),不做沙箱;显式启用,
 * 不自动安装/更新;入口路径逃逸在扫描期拒绝。
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createJiti } from "jiti/static";
import { getWriterDir } from "./config.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import type { ExtensionFactory } from "../vendor/pi-coding-agent/src/index.ts";
import type { PluginManifest } from "./plugins.ts";

/** plugins 根目录(~/.pi/writer/plugins)。 */
export function getPluginsDir(): string {
	return join(getWriterDir(), "plugins");
}

/** 插件用户启用状态文件(plugins/ 同级 plugin-state.json)。 */
export function getPluginStatePath(): string {
	return join(getWriterDir(), "plugin-state.json");
}

/** 一条插件信息(列表项 / 装载状态)。 */
export interface PluginRuntimeInfo {
	id: string;
	name: string;
	version: string;
	description?: string;
	/** plugin.json 声明 enabled:false(作者禁用;用户层无法覆盖)。 */
	manifestDisabled: boolean;
	/** 用户级启用(plugin-state.json;缺省 true)。 */
	enabled: boolean;
	/** 装载期错误(null = 正常)。 */
	error: string | null;
	/** 入口文件绝对路径(展示/调试用)。 */
	path: string;
}

export interface PluginLoadResult {
	/** 成功加载并激活的工厂(注入 extensionFactories)。 */
	factories: ExtensionFactory[];
	/** 全量插件信息(错误与状态据此展示)。 */
	infos: PluginRuntimeInfo[];
}

/** 插件 id 合法性:小写字母/数字/连字符(与 provider/模型 id 同规)。 */
export function isValidPluginId(id: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/** 读插件目录下 plugin.json;缺失/损坏返回 null(目录名兜底,不阻塞扫描)。 */
async function readManifest(dir: string): Promise<PluginManifest | null> {
	try {
		const text = await readFile(join(dir, "plugin.json"), "utf8");
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (typeof raw?.id !== "string" || typeof raw?.version !== "string") return null;
		const manifest: PluginManifest = {
			id: raw.id,
			version: raw.version,
			...(typeof raw.name === "string" ? { name: raw.name } : {}),
			...(typeof raw.description === "string" ? { description: raw.description } : {}),
			...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
			...(typeof raw.backend === "string" ? { backend: raw.backend } : {}),
			...(raw.frontend !== undefined && typeof raw.frontend === "object"
				? { frontend: raw.frontend as PluginManifest["frontend"] }
				: {}),
		};
		return manifest;
	} catch {
		return null;
	}
}

/** 插件入口:manifest.backend 优先,缺省 index.mjs;解析后必须仍在插件目录内。 */
function resolveEntry(dir: string, manifest: PluginManifest | null): { abs: string; rel: string } | null {
	const rel = manifest?.backend ?? "index.mjs";
	const abs = resolve(dir, rel);
	if (!abs.startsWith(resolve(dir) + sep) && abs !== resolve(dir)) return null;
	if (!existsSync(abs)) return null;
	return { abs, rel };
}

/** 用户层启用状态映射(id → {enabled});缺省 true。 */
async function readState(): Promise<Record<string, { enabled: boolean }>> {
	try {
		const raw = JSON.parse(await readFile(getPluginStatePath(), "utf8")) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		const out: Record<string, { enabled: boolean }> = {};
		for (const [id, value] of Object.entries(raw)) {
			if (isValidPluginId(id) && typeof value === "object" && value !== null) {
				const v = value as Record<string, unknown>;
				if (typeof v.enabled === "boolean") out[id] = { enabled: v.enabled };
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** 写入用户层启用状态(state 文件整体落盘,其他键保留)。 */
export async function writePluginEnabled(id: string, enabled: boolean): Promise<void> {
	const state = await readState();
	state[id] = { enabled };
	await atomicWriteFile(getPluginStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/** 扫描 plugins 目录,返回全量插件信息(id 排序)。目录不存在 = 零插件。 */
export async function listPlugins(): Promise<PluginRuntimeInfo[]> {
	const root = getPluginsDir();
	const state = await readState();
	if (!existsSync(root)) return [];
	const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && isValidPluginId(e.name));
	const infos: PluginRuntimeInfo[] = [];
	for (const entry of entries) {
		const dir = join(root, entry.name);
		const manifest = await readManifest(dir);
		const id = manifest?.id ?? entry.name;
		if (!isValidPluginId(id)) continue;
		const entryFile = resolveEntry(dir, manifest);
		const manifestDisabled = manifest?.enabled === false;
		// manifest 声明禁用即禁用;否则取用户层状态(缺省启用)
		const enabled = manifestDisabled ? false : (state[id]?.enabled ?? true);
		infos.push({
			id,
			name: manifest?.name ?? id,
			version: manifest?.version ?? "0.0.0",
			...(manifest?.description ? { description: manifest.description } : {}),
			manifestDisabled,
			enabled,
			error: entryFile ? null : "入口文件缺失(缺省 index.mjs)",
			path: entryFile?.abs ?? dir,
		});
	}
	return infos.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 加载并动态 import 所有启用插件,返回激活工厂 + 全量信息。
 * - jiti 按文件缓存(进程内单例),重复调用同一插件只 import 一次;
 * - 单个插件失败:error 挂在该 info,不影响其他插件;
 * - manifest 禁用 / 用户禁用 / 入口缺失 均不加载。
 */
export async function loadPlugins(): Promise<PluginLoadResult> {
	const infos = await listPlugins();
	const factories: ExtensionFactory[] = [];
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	for (const info of infos) {
		if (!info.enabled || info.error) continue;
		try {
			const mod = (await jiti.import(info.path, { default: true })) as unknown;
			const factory = mod as ExtensionFactory;
			if (typeof factory !== "function") {
				info.error = "入口未导出工厂函数(default export 必须为 function)";
				continue;
			}
			factories.push(factory);
		} catch (e) {
			info.error = `插件加载失败: ${e instanceof Error ? e.message : String(e)}`;
		}
	}
	return { factories, infos };
}

/** 删除插件目录(仅 plugins/<id>;resolve 后必须仍在 plugins 根内,防逃逸)。 */
export async function removePlugin(id: string): Promise<void> {
	if (!isValidPluginId(id)) throw new Error(`非法插件 id: ${id}`);
	const dir = resolve(getPluginsDir(), id);
	const root = resolve(getPluginsDir());
	if (!dir.startsWith(root + sep)) throw new Error("插件路径逃逸,拒绝删除");
	if (!existsSync(dir)) throw new Error(`插件不存在: ${id}`);
	await rm(dir, { recursive: true, force: true });
}
