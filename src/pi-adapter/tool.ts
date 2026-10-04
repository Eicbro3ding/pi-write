/**
 * pi-adapter 的**工具定义入口**(T7 批 3,2026-10-04)。
 *
 * `defineTool` 是 vendor 提供的「声明式工具定义」工厂:自研侧 5 个文件
 * (`tools.ts` / `mcp/tools.ts` / `stage/stage-extension.ts` / `extension.ts` …)
 * 用它造 `ToolDefinition`。它是**值**(不是类型),所以类型别名区救不了它 ——
 * 必须有这样一个薄壳。
 *
 * 这一层薄到什么程度:一个函数、一行转发。**这是刻意的** —— 铁律 2 说
 * 「厚度控制」,它不该变成第二个框架。它的全部价值在于:
 * 自研侧 import 的是 `pi-adapter` 的 `defineTool`,而不是
 * `../../vendor/pi-coding-agent/src/index.ts` —— 上游若把这个工厂换个名字
 * 或挪个位置,改动点在这里一行,而不是散在 5 个文件里。
 */

import { defineTool as vendorDefineTool } from "../../vendor/pi-coding-agent/src/index.ts";

/**
 * 定义一个工具。
 *
 * 用法与 vendor 的 `defineTool` 完全一致(签名由 vendor 类型驱动),
 * 这里只做转发 —— 保持签名不变才能让 5 个调用点无需改动实现。
 */
export const defineTool: typeof vendorDefineTool = vendorDefineTool;
