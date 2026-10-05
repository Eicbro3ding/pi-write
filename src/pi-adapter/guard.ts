/**
 * 路径守卫的 vendor 接入点(T6,2026-10-04)。
 *
 * **这是全项目唯一 import vendor 深层路径 `core/tools/path-utils.ts` 的地方。**
 *
 * 为什么必须收口:`setToolPathGuard` / `clearToolPathGuard` 这两个符号**不在
 * `vendor/pi-coding-agent/src/index.ts` 的导出面上**。自研代码直接按相对源码路径
 * import 时,上游一旦移动或重命名该文件,TypeScript 给不出"这个符号本该从别处来"
 * 的提示 —— 只在运行时报错,或被误判成业务逻辑问题。收进本文件后,上游改动
 * 只需改这一行 import。
 *
 * 本层只做**转发**,不做任何策略:守卫该拦什么由 `src/tool-guard.ts` 决定。
 * 换句话说这里是「管道」,不是「阀门」。
 */

// ★ 唯一的深层路径 import —— 上游若移动该文件,只改这一行
import { clearToolPathGuard, setToolPathGuard } from "@earendil-works/pi-coding-agent/core/tools/path-utils";

/**
 * 工具路径操作模式。
 *
 * 与 vendor 内部对齐:`"read"` 覆盖 read/grep/find/ls 等只读工具,
 * `"write"` 覆盖 write/edit 等写入工具。
 */
export type ToolPathMode = "read" | "write";

/**
 * 路径守卫函数:解析出绝对路径后、真正操作文件前调用。
 * 抛错 = 拒绝;正常返回 = 放行。
 *
 * 注意本类型是**自研定义**,不 re-export vendor 的同名类型 —— 这样上游即使把
 * 签名参数改名(如 `mode` → `op`),也只有本文件的断言会红,自研侧零感知。
 */
export type ToolPathGuardFn = (absPath: string, mode: ToolPathMode) => void;

/**
 * 安装工具路径守卫。签名与 vendor 对齐,但类型由本层定义。
 *
 * 用 `as` 断言而非直接赋值:两边的 `ToolPathMode` 是结构相同的独立类型,
 * 直接传参 TS 会因「名义不同」报错;断言的代价被限制在这一行内。
 */
export function installToolPathGuard(fn: ToolPathGuardFn): void {
	setToolPathGuard(fn as Parameters<typeof setToolPathGuard>[0]);
}

/** 卸载守卫,恢复 vendor 默认行为(测试或进程复用前清理用)。 */
export function uninstallToolPathGuard(): void {
	clearToolPathGuard();
}
