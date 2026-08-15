/**
 * AI 工具路径守卫:把文件工具(read/write/edit/grep/find/ls/word_count)的
 * 可访问路径限制在书目录内,防止提示注入等场景下工具读取书目录外的
 * 敏感文件(如 ~/.pi/writer/agent/auth.json 中的 provider API key)。
 *
 * vendor 的路径解析(resolveToCwd)支持 ~ 展开与 ../ 上溯,本身无边界;
 * 本模块通过 vendor 的 setToolPathGuard 钩子(见
 * vendor/pi-coding-agent/src/core/tools/path-utils.ts)在解析后统一拦截。
 * 守卫未安装时 vendor 行为完全不变,不影响 pi 其他使用方。
 */

import { relative, resolve, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { clearToolPathGuard, setToolPathGuard } from "../vendor/pi-coding-agent/src/core/tools/path-utils.ts";

/** 工具路径守卫的会话上下文:SessionHost 在 prompt 调用期间写入。 */
export interface ToolGuardContext {
	bookDir: string;
	readOnlyDirs: string[];
	draftFile?: string;
}

/**
 * 当前会话的工具守卫上下文。
 * 进程内同时存在多个会话(主会话/编剧/舞台)时,不能再用模块级全局变量
 * 保存「当前书目录」;SessionHost 每次 sendMessage 前把书目录/只读目录/
 * 正文白名单写入 ALS,自定义工具与路径守卫从这里读取。
 */
export const toolGuardContext = new AsyncLocalStorage<ToolGuardContext>();

/** 判定绝对路径是否落在 root 内(root 本身与 root/ 前缀均放行)。 */
export function pathWithinRoot(absPath: string, root: string): boolean {
	// Windows 文件系统大小写不敏感,字符串比较必须跟随该语义:
	// 路径可能来自不同源头(agent 配置手写路径 / readdirSync 磁盘大小写 /
	// resolveSkillsDir),大小写差异会把合法读误判为越界
	// (2026-08-09:模型读 skill 文件被误拦的根因)。
	if (process.platform === "win32") {
		const a = absPath.toLowerCase();
		const r = root.toLowerCase();
		return a === r || a.startsWith(r + sep);
	}
	return absPath === root || absPath.startsWith(root + sep);
}

/** 校验绝对路径在 root 内,否则抛中文错误(与 pi-writer UI 文案约定一致)。 */
export function assertPathWithinRoot(absPath: string, root: string): void {
	if (!pathWithinRoot(absPath, root)) {
		throw new Error("工具路径越界:只能访问书目录内的文件");
	}
}

/**
 * 安装工具路径守卫:书目录外的路径(绝对路径、~ 展开、../ 上溯)一律拒绝;
 * readOnlyDirs 中的目录仅放行读操作(read/grep/find/ls),写操作(write/edit)
 * 依旧拒绝——内置技能文件(skills/)因此可读但不可被 AI 篡改。
 * 会话工厂每次创建运行时调用(切书时 cwd 变化,守卫随新书目录重建)。
 * draftFile(如 "ch01.md")启用正文目录白名单:write/edit 只允许写该文件,
 * 防止 agent 自由发挥文件名导致正文写到 draft/第一章.md,前端按约定路径
 * 读 draft/ch01.md 读到空(2026-08-11,编剧正文乱写文件名根因)。
 */
export function installToolPathGuard(bookDir: string, readOnlyDirs: string[] = [], draftFile?: string): void {
	const fallbackRoot = resolve(bookDir);
	const fallbackReadOnly = readOnlyDirs.map((d) => resolve(d));
	setToolPathGuard((absPath, mode) => {
		// 优先取 SessionHost 写入的会话上下文;TUI/CLI 等未写 ALS 的路径回退到
		// 最近一次 installToolPathGuard 传入的目录。
		const ctx = toolGuardContext.getStore();
		const root = ctx ? resolve(ctx.bookDir) : fallbackRoot;
		const readOnly = ctx ? ctx.readOnlyDirs.map((d) => resolve(d)) : fallbackReadOnly;
		const currentDraftFile = ctx?.draftFile ?? draftFile;
		// 世界书文件禁直写(write/edit):world_update 是唯一变更通道(校验 + 原子写 +
		// 视图生成 + 回滚保护),AI 工具直写会绕过全部保护(2026-08-11,编剧统一方案)
		if (mode === "write") {
			const rel = relative(root, absPath);
			if (rel === "world.json" || rel.startsWith(`.writer${sep}`)) {
				throw new Error("世界书文件只能经 world_update 工具修改,禁止直写");
			}
			// 正文目录白名单:只允许当前章节文件(agent 无章节上下文时按约定路径创建,
			// 而不是自创文件名——自由发挥会把正文写到前端读不到的路径)
			if (currentDraftFile && rel.startsWith(`draft${sep}`) && rel !== `draft${sep}${currentDraftFile}`) {
				throw new Error(`正文目录只允许写当前章节文件 draft/${currentDraftFile}`);
			}
		}
		// 书目录内:读写均放行
		if (pathWithinRoot(absPath, root)) return;
		// 额外只读目录:仅读操作放行
		if (mode === "read" && readOnly.some((d) => pathWithinRoot(absPath, d))) return;
		throw new Error("工具路径越界:只能访问书目录内的文件");
	});
}

/** 卸载守卫(vendor 行为恢复原样);测试或复用进程时清理用。 */
export function uninstallToolPathGuard(): void {
	clearToolPathGuard();
}
