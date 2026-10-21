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

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getWriterDir } from "./config.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import type { ExtensionFactory } from "./pi-adapter/index.ts";
import type { PluginManifest, PluginSettingsFieldSpec, PluginSettingsFieldType, PluginSettingsItemSpec, PluginSlashCommandSpec, PluginUiSpec, PluginWindowSpec } from "./plugins.ts";

/** plugins 根目录(~/.pi/writer/plugins)。 */
export function getPluginsDir(): string {
	return join(getWriterDir(), "plugins");
}

/** 插件用户启用状态文件(plugins/ 同级 plugin-state.json)。 */
export function getPluginStatePath(): string {
	return join(getWriterDir(), "plugin-state.json");
}

/** 插件设置值文件(plugins/<id>/settings.json;声明式设置菜单的持久化)。 */
export function getPluginSettingsPath(id: string): string {
	return join(getPluginsDir(), id, "settings.json");
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
	/** 用户级完全信任(plugin-state.json;缺省 false)。开启后解锁后端自定义路由 + 前端 JS。 */
	trusted: boolean;
	/** 装载期错误(null = 正常)。 */
	error: string | null;
	/** 入口文件绝对路径(展示/调试用)。 */
	path: string;
	/** 是否存在可加载的前端 JS 入口(manifest 声明或缺省 frontend.mjs;不论 trusted)。
	 *  前端只对 hasFrontend 的插件注入 script —— 没有入口却按缺省拼 URL,
	 *  会每 30s 打一次 404。 */
	hasFrontend: boolean;
	/** 清单声明的插件 UI(设置菜单 schema/斜杠命令/前端 JS;经字段级白名单校验)。 */
	frontend?: PluginManifest["frontend"];
}

/** 插件 Web 命令处理器(入口具名导出 webCommands;主进程执行,renderer 零 JS)。 */
export type PluginWebCommandHandler = (params: { term?: string; bookSlug?: string }) => Promise<string> | string;

/** 插件后端路由(入口具名导出 routes;仅 trusted 插件生效,segments 自动加插件 id 前缀)。 */
export interface PluginRouteDef {
	method: string;
	segments: readonly string[];
	handler: (ctx: { req: import("node:http").IncomingMessage; res: import("node:http").ServerResponse; params: Record<string, string>; url: URL }) => Promise<void>;
}

/** loadPlugins 结果:工厂 + 信息 + Web 命令注册表 + 后端路由。 */
export interface PluginLoadResult {
	/** 成功加载并激活的工厂(注入 extensionFactories)。 */
	factories: ExtensionFactory[];
	/** 全量插件信息(错误与状态据此展示)。 */
	infos: PluginRuntimeInfo[];
	/** Web 命令注册表:pluginId → (commandName → handler);未声明 webCommands 的插件无条目。 */
	webCommands: Map<string, Record<string, PluginWebCommandHandler>>;
	/** 后端路由(仅 trusted 插件;segments 已加插件 id 前缀,直接并入路由表)。 */
	routes: PluginRouteDef[];
}

/** 插件 id 合法性:小写字母/数字/连字符(与 provider/模型 id 同规)。 */
export function isValidPluginId(id: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/** 设置字段键合法性(settings.json 的键;小写字母/数字/连字符/点/下划线)。 */
export function isValidSettingsKey(key: string): boolean {
	return /^[a-z0-9][a-z0-9-_.]{0,63}$/.test(key);
}

const SETTINGS_FIELD_TYPES: readonly PluginSettingsFieldType[] = ["string", "number", "boolean", "select", "textarea"];

/** 单个设置字段声明校验(非法 type/缺 key/缺 label 丢弃;select 无 options 丢弃)。 */
function checkFieldSpec(raw: unknown): PluginSettingsFieldSpec | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const f = raw as Record<string, unknown>;
	if (typeof f.key !== "string" || !isValidSettingsKey(f.key)) return null;
	if (typeof f.label !== "string" || f.label.trim().length === 0) return null;
	if (typeof f.type !== "string" || !SETTINGS_FIELD_TYPES.includes(f.type as PluginSettingsFieldType)) return null;
	const type = f.type as PluginSettingsFieldType;
	let options: { value: string; label: string }[] | undefined;
	if (type === "select") {
		if (!Array.isArray(f.options) || f.options.length === 0) return null;
		options = f.options
			.filter((o): o is { value: string; label: string } =>
				typeof o === "object" && o !== null && typeof (o as Record<string, unknown>).value === "string" &&
				typeof (o as Record<string, unknown>).label === "string")
			.map((o) => ({ value: o.value, label: o.label }));
		if (options.length === 0) return null;
	}
	const defaultVal = type === "boolean" ? (typeof f.default === "boolean" ? f.default : undefined)
		: type === "number" ? (typeof f.default === "number" ? f.default : undefined)
		: (typeof f.default === "string" ? f.default : undefined);
	return {
		key: f.key,
		label: f.label,
		type,
		...(typeof f.desc === "string" && f.desc.trim().length > 0 ? { desc: f.desc } : {}),
		...(defaultVal !== undefined ? { default: defaultVal } : {}),
		...(options ? { options } : {}),
	};
}

/** 设置菜单项(section)校验:fields 至少一条且全部合法;非法字段逐条丢弃。 */
function checkSettingsItem(raw: unknown): PluginSettingsItemSpec | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const s = raw as Record<string, unknown>;
	if (typeof s.title !== "string" || s.title.trim().length === 0 || !Array.isArray(s.fields)) return null;
	const fields = s.fields.map(checkFieldSpec).filter((f): f is PluginSettingsFieldSpec => f !== null);
	if (fields.length === 0) return null;
	return {
		title: s.title,
		...(typeof s.description === "string" && s.description.trim().length > 0 ? { description: s.description } : {}),
		fields,
	};
}

/** 斜杠命令声明校验:trigger 合法(小写字母/数字/连字符,可含中文提示词)+ hint 必填。 */
function checkSlashCommandSpec(raw: unknown): PluginSlashCommandSpec | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const c = raw as Record<string, unknown>;
	if (typeof c.trigger !== "string" || c.trigger.trim().length === 0 || c.trigger.includes("/")) return null;
	if (typeof c.hint !== "string" || c.hint.trim().length === 0) return null;
	return { trigger: c.trigger.trim(), hint: c.hint.trim() };
}

/** 位置百分比钳制(0-100;非数/缺失返回 undefined)。 */
function clampPct(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	return Math.min(100, Math.max(0, v));
}

/** 正尺寸钳制(1-2000px;非数/越界返回 undefined)。 */
function clampSize(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	return Math.min(2000, Math.max(1, Math.round(v)));
}

/** dataSource 合法性:相对路径片段(不含 .. / 不以 / 开头 / 无协议)。 */
function isValidDataSource(s: string): boolean {
	if (s.length === 0 || s.length > 128) return false;
	if (s.startsWith("/") || s.includes("..") || s.includes("://")) return false;
	return /^[a-z0-9][a-z0-9-_.\/]*$/i.test(s);
}

/**
 * 浮窗声明校验:fields 至少一条;contentKind=data 时必须有合法 dataSource
 * (取数只能走插件自己的路由,不放开任意 URL)。非法逐条丢弃,不阻塞整个插件。
 */
function checkWindowSpec(raw: unknown): PluginWindowSpec | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const w = raw as Record<string, unknown>;
	if (typeof w.id !== "string" || !isValidSettingsKey(w.id)) return null;
	if (typeof w.title !== "string" || w.title.trim().length === 0) return null;
	const contentKind = w.contentKind === "data" ? "data" : "fields";
	let fields: PluginSettingsFieldSpec[] = [];
	if (Array.isArray(w.fields)) {
		fields = w.fields.map(checkFieldSpec).filter((f): f is PluginSettingsFieldSpec => f !== null);
	}
	let dataSource: string | undefined;
	if (contentKind === "data") {
		if (typeof w.dataSource !== "string" || !isValidDataSource(w.dataSource)) return null;
		dataSource = w.dataSource;
	} else if (fields.length === 0) {
		// fields 形态必须有字段;data 形态才允许空 fields
		return null;
	}
	const px = typeof w.position === "object" && w.position !== null ? (w.position as Record<string, unknown>) : null;
	const x = clampPct(px?.x);
	const y = clampPct(px?.y);
	const sz = typeof w.size === "object" && w.size !== null ? (w.size as Record<string, unknown>) : null;
	const width = clampSize(sz?.width);
	const height = clampSize(sz?.height);
	return {
		id: w.id,
		title: w.title.trim(),
		...(typeof w.subtitle === "string" && w.subtitle.trim().length > 0 ? { subtitle: w.subtitle.trim() } : {}),
		...(typeof w.settingsLabel === "string" && w.settingsLabel.trim().length > 0 ? { settingsLabel: w.settingsLabel.trim() } : {}),
		...(x !== undefined && y !== undefined ? { position: { x, y } } : {}),
		...(width !== undefined || height !== undefined ? { size: { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) } } : {}),
		fields,
		...(contentKind === "data" ? { contentKind: "data" as const, dataSource } : {}),
		...(w.layout === "cards" ? { layout: "cards" as const } : {}),
		...(w.closable === false ? { closable: false } : {}),
	};
}

/** frontend 声明校验:字段级白名单(非法项丢弃,不阻塞整个插件)。 */
function checkFrontend(raw: unknown): PluginManifest["frontend"] | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const f = raw as Record<string, unknown>;
	const out: PluginManifest["frontend"] = {};
	if (Array.isArray(f.slashCommands)) {
		const commands = f.slashCommands.map(checkSlashCommandSpec).filter((c): c is PluginSlashCommandSpec => c !== null);
		if (commands.length > 0) out.slashCommands = commands;
	}
	if (typeof f.ui === "object" && f.ui !== null) {
		const ui = f.ui as Record<string, unknown>;
		const uiOut: PluginUiSpec = {};
		if (Array.isArray(ui.settingsItems)) {
			const items = ui.settingsItems.map(checkSettingsItem).filter((i): i is NonNullable<PluginUiSpec["settingsItems"]>[number] => i !== null);
			if (items.length > 0) uiOut.settingsItems = items;
		}
		if (Array.isArray(ui.windows)) {
			const windows = ui.windows.map(checkWindowSpec).filter((w): w is PluginWindowSpec => w !== null);
			if (windows.length > 0) uiOut.windows = windows;
		}
		if (Object.keys(uiOut).length > 0) out.ui = uiOut;
	}
	// 前端 JS 入口:仅收 .mjs 后缀的相对文件名(防指向插件目录外;缺省 frontend.mjs)
	if (typeof f.frontend === "string" && /^[a-z0-9][a-z0-9-_.]*\.mjs$/i.test(f.frontend) && !f.frontend.includes("/")) {
		out.frontend = f.frontend;
	}
	return Object.keys(out).length > 0 ? out : undefined;
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
			...(checkFrontend(raw.frontend) ? { frontend: checkFrontend(raw.frontend) } : {}),
		};
		return manifest;
	} catch {
		return null;
	}
}

/** 插件入口:manifest.backend 优先,缺省 index.mjs;解析后必须仍在插件目录内。 */
function resolveEntry(dir: string, manifest: PluginManifest | null): { abs: string; rel: string } | null {
	// 空串/纯空白按缺省处理(abs === dir 会被当成入口目录,import 必失败)
	const rel = (manifest?.backend ?? "index.mjs").trim() || "index.mjs";
	const abs = resolve(dir, rel);
	if (!abs.startsWith(resolve(dir) + sep) && abs !== resolve(dir)) return null;
	if (abs === resolve(dir)) return null;
	try {
		if (!statSync(abs).isFile()) return null;
	} catch {
		return null;
	}
	return { abs, rel };
}

/** 用户层设置映射(id → {enabled, trusted});白名单只透传 boolean 键。 */
interface PluginUserState {
	enabled: boolean;
	trusted: boolean;
}

/** 读取用户层状态(白名单:enabled/trusted;与同 id 其他键共存)。 */
async function readState(): Promise<Record<string, PluginUserState>> {
	try {
		const raw = JSON.parse(await readFile(getPluginStatePath(), "utf8")) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		const out: Record<string, PluginUserState> = {};
		for (const [id, value] of Object.entries(raw)) {
			if (isValidPluginId(id) && typeof value === "object" && value !== null) {
				const v = value as Record<string, unknown>;
				const entry = {
					...(typeof v.enabled === "boolean" ? { enabled: v.enabled } : {}),
					...(typeof v.trusted === "boolean" ? { trusted: v.trusted } : {}),
				};
				if (Object.keys(entry).length > 0) out[id] = entry as PluginUserState;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * 写入用户层状态(merge 语义:只更新传入键,同 id 其他键保留)。
 * 兼容旧调用——writePluginEnabled/writePluginTrusted 都经此落盘。
 */
async function writePluginState(id: string, patch: Partial<PluginUserState>): Promise<void> {
	const state = await readState();
	state[id] = { ...(state[id] ?? {}), ...patch };
	await atomicWriteFile(getPluginStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/** 写入用户层启用状态。 */
export async function writePluginEnabled(id: string, enabled: boolean): Promise<void> {
	await writePluginState(id, { enabled });
}

/** 写入用户层完全信任状态(缺省 false;开启后解锁后端路由 + 前端 JS)。 */
export async function writePluginTrusted(id: string, trusted: boolean): Promise<void> {
	await writePluginState(id, { trusted });
}

/**
 * 删除某插件在 plugin-state.json 里的条目(删除插件时调用)。
 *
 * 不清理的后果:删掉插件再装同 id(别人的包、或旧包)会**静默继承**上一次的
 * trusted —— 后端路由与前端 JS 直接解锁,用户从未对这份代码授权过。
 */
export async function clearPluginState(id: string): Promise<void> {
	const state = await readState();
	if (!(id in state)) return;
	delete state[id];
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
		// 目录名即 id:删除 / 前端 JS / 设置文件都按 id 拼路径。以 manifest.id 为准
		// 会在两者不一致时造出「列表里有、却删不掉也读不到前端」的幽灵插件。
		const id = entry.name;
		const manifest = await readManifest(dir);
		const entryFile = resolveEntry(dir, manifest);
		const manifestDisabled = manifest?.enabled === false;
		// manifest 声明禁用即禁用;否则取用户层状态(缺省启用)
		const enabled = manifestDisabled ? false : (state[id]?.enabled ?? true);
		// 完全信任:用户级(缺省 false)
		const trusted = state[id]?.trusted ?? false;
		const frontendPath = getPluginFrontendPath(id, manifest?.frontend?.frontend);
		// 清单 id 必须与目录名一致(文档约定)。不一致时明确报错,不替用户选一个"真相"
		const idMismatch = manifest !== null && manifest.id !== id;
		infos.push({
			id,
			name: manifest?.name ?? id,
			version: manifest?.version ?? "0.0.0",
			...(manifest?.description ? { description: manifest.description } : {}),
			manifestDisabled,
			enabled,
			trusted,
			error: idMismatch
				? `plugin.json 的 id(${manifest.id})与目录名(${id})不一致`
				: entryFile ? null : "入口文件缺失(缺省 index.mjs)",
			path: entryFile?.abs ?? dir,
			hasFrontend: frontendPath !== null,
			...(manifest?.frontend ? { frontend: manifest.frontend } : {}),
		});
	}
	return infos.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 入口模块缓存:id → { stamp, mod }。
 *
 * 为什么需要:启停 / 保存插件设置 / 安装等动作都会重新 loadPlugins。若每次都
 * `?r=随机` 重新 import,插件的模块顶层副作用(定时器、事件监听、模块级缓存)
 * 会随每次操作再执行一遍,而且旧模块永远不会被回收。
 * 按「mtime + size」指纹复用:文件没改就沿用同一实例,改了才重新执行。
 */
const moduleCache = new Map<string, { stamp: string; mod: Record<string, unknown> }>();

/** 入口文件指纹(取不到时用空串,让 import 自己抛错)。 */
function entryStamp(abs: string): string {
	try {
		const st = statSync(abs);
		return `${st.mtimeMs}-${st.size}`;
	} catch {
		return "";
	}
}

/** 取插件入口模块(带指纹缓存);文件未变时复用上次 import 的实例。 */
async function loadPluginModule(info: PluginRuntimeInfo): Promise<Record<string, unknown>> {
	const stamp = entryStamp(info.path);
	const hit = moduleCache.get(info.id);
	if (hit && hit.stamp === stamp) return hit.mod;
	// Node 原生 import + 指纹 query:入口约定 .mjs;指纹变化才重新读取文件
	const mod = (await import(`${pathToFileURL(info.path).href}?v=${encodeURIComponent(stamp)}`)) as Record<string, unknown>;
	moduleCache.set(info.id, { stamp, mod });
	return mod;
}

/**
 * 插件后端路由的保留段:插件路由现在优先于内置路由匹配,若允许占用这些段,
 * 一个 `segments: ["settings"]` 就能顶掉插件的设置读写端点。
 * (只拦精确同名段;`balance` 这种业务名不受影响)
 */
const RESERVED_ROUTE_SEGMENTS = new Set(["settings", "command", "install"]);

/**
 * 加载并动态 import 所有启用插件,返回激活工厂 + 全量信息 + Web 命令注册表。
 * - jiti 按文件缓存(进程内单例),重复调用同一插件只 import 一次;
 * - 单个插件失败:error 挂在该 info,不影响其他插件;
 * - manifest 禁用 / 用户禁用 / 入口缺失 均不加载;
 * - Web 命令:入口具名导出 webCommands({ trigger: handler });
 *   trigger 必须出现在 manifest.frontend.slashCommands 声明里,否则忽略(防未声明入口)。
 */
export async function loadPlugins(): Promise<PluginLoadResult> {
	const infos = await listPlugins();
	const factories: ExtensionFactory[] = [];
	const webCommands: Map<string, Record<string, PluginWebCommandHandler>> = new Map();
	const routes: PluginRouteDef[] = [];
	// 已删除/改名的插件不再占缓存
	const alive = new Set(infos.map((i) => i.id));
	for (const id of [...moduleCache.keys()]) if (!alive.has(id)) moduleCache.delete(id);
	for (const info of infos) {
		if (!info.enabled || info.error) continue;
		try {
			const mod = await loadPluginModule(info);
			const factory = mod?.default as ExtensionFactory;
			if (typeof factory !== "function") {
				info.error = "入口未导出工厂函数(default export 必须为 function)";
				continue;
			}
			factories.push(factory);
			// Web 命令注册表:只收 manifest 已声明的 trigger(白名单,防未声明 handler 被调)
			const declared = new Set((info.frontend?.slashCommands ?? []).map((c) => c.trigger));
			const rawCommands = mod?.webCommands;
			if (rawCommands && typeof rawCommands === "object" && !Array.isArray(rawCommands)) {
				const commands: Record<string, PluginWebCommandHandler> = {};
				for (const [name, handler] of Object.entries(rawCommands as Record<string, unknown>)) {
					if (declared.has(name) && typeof handler === "function") commands[name] = handler as PluginWebCommandHandler;
				}
				if (Object.keys(commands).length > 0) webCommands.set(info.id, commands);
			}
			// 后端路由:仅 trusted 插件;segments 加插件 id 前缀(防跨插件冲突);
			// 非 trusted 插件的 routes 导出直接忽略(不注册,无攻击面)
			if (info.trusted) {
				const rawRoutes = mod?.routes;
				if (Array.isArray(rawRoutes)) {
					for (const r of rawRoutes as Array<Record<string, unknown>>) {
						if (
							typeof r?.method === "string" &&
							Array.isArray(r.segments) &&
							typeof r.handler === "function" &&
							r.segments.every((s) => typeof s === "string") &&
							// 保留段不注册(见 RESERVED_ROUTE_SEGMENTS)
							!r.segments.some((s) => RESERVED_ROUTE_SEGMENTS.has(String(s)))
						) {
							routes.push({
								method: r.method.toUpperCase(),
								segments: ["plugins", info.id, ...(r.segments as string[])],
								handler: r.handler as PluginRouteDef["handler"],
							});
						}
					}
				}
			}
		} catch (e) {
			info.error = `插件加载失败: ${e instanceof Error ? e.message : String(e)}`;
		}
	}
	return { factories, infos, webCommands, routes };
}

/**
 * 插件前端 JS 入口路径:manifest.frontend.frontend(相对路径,缺省 frontend.mjs)。
 * 不存在/逃逸返回 null。
 */
export function getPluginFrontendPath(id: string, rel?: string): string | null {
	if (!isValidPluginId(id)) return null;
	const base = resolve(getPluginsDir(), id);
	const abs = resolve(base, rel ?? "frontend.mjs");
	if (!abs.startsWith(base + sep)) return null;
	if (!existsSync(abs)) return null;
	return abs;
}

/**
 * 插件的全部可写设置字段:设置页 settingsItems 的字段 + 各浮窗 fields。
 *
 * 两者共用 `plugins/<id>/settings.json`(浮窗里的字段也要落盘 —— 此前只活在
 * React state 里,关窗即丢)。读写白名单统一以这里为准,同 key 只保留第一个。
 */
export function collectPluginFieldSpecs(info: PluginRuntimeInfo): PluginSettingsFieldSpec[] {
	const seen = new Set<string>();
	const out: PluginSettingsFieldSpec[] = [];
	const push = (f: PluginSettingsFieldSpec) => {
		if (seen.has(f.key)) return;
		seen.add(f.key);
		out.push(f);
	};
	for (const item of info.frontend?.ui?.settingsItems ?? []) for (const f of item.fields) push(f);
	for (const win of info.frontend?.ui?.windows ?? []) for (const f of win.fields) push(f);
	return out;
}

/**
 * 插件设置值文件读写(声明式设置菜单的持久化)。
 * 校验:写路径只收白名单字段(manifest 声明的 key 且类型匹配),未知键丢弃;
 * 文件损坏时按空设置对待(与 readState 同款容错)。
 */
export async function readPluginSettings(id: string): Promise<Record<string, unknown>> {
	try {
		const raw = JSON.parse(await readFile(getPluginSettingsPath(id), "utf8")) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		return raw;
	} catch {
		return {};
	}
}

/** 写插件设置值:仅收白名单字段(manifest 声明的 key 且类型匹配),未知键丢弃;
 *  布尔字段必须 boolean、数字字段必须 number(字符串数字不收,防误用)。 */
export async function writePluginSettings(id: string, values: Record<string, unknown>, fields: PluginSettingsFieldSpec[]): Promise<void> {
	const allowed = new Map(fields.map((f) => [f.key, f.type]));
	// 读旧值再合并:设置页与浮窗共用同一份 settings.json,两边各发自己渲染的字段,
	// 覆盖写会把另一边的值清空(保存设置 → 浮窗阈值丢失,反之亦然)。
	// 只保留仍在白名单里的旧键,插件升级删字段后不留下孤儿值。
	const prev = await readPluginSettings(id);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(prev)) {
		if (allowed.has(key)) out[key] = value;
	}
	for (const [key, value] of Object.entries(values)) {
		const type = allowed.get(key);
		if (!type) continue;
		if (type === "boolean" && typeof value !== "boolean") continue;
		if (type === "number" && typeof value !== "number") continue;
		if (type === "string" && typeof value !== "string") continue;
		if (type === "textarea" && typeof value !== "string") continue;
		if (type === "select" && typeof value !== "string") continue;
		out[key] = value;
	}
	await atomicWriteFile(getPluginSettingsPath(id), `${JSON.stringify(out, null, 2)}\n`);
}

/** 删除插件目录(仅 plugins/<id>;resolve 后必须仍在 plugins 根内,防逃逸)。 */
export async function removePlugin(id: string): Promise<void> {
	if (!isValidPluginId(id)) throw new Error(`非法插件 id: ${id}`);
	const dir = resolve(getPluginsDir(), id);
	const root = resolve(getPluginsDir());
	if (!dir.startsWith(root + sep)) throw new Error("插件路径逃逸,拒绝删除");
	if (!existsSync(dir)) throw new Error(`插件不存在: ${id}`);
	await rm(dir, { recursive: true, force: true });
	// 删除即撤销授权:同 id 重装(哪怕是别人打的包)不该继承上一次的 trusted
	await clearPluginState(id);
}

/** 插件是否已存在(安装前判断是全新安装还是覆盖;web/plugin-zip.ts 安装前调用)。 */
export function pluginExists(id: string): boolean {
	return isValidPluginId(id) && existsSync(join(getPluginsDir(), id));
}
