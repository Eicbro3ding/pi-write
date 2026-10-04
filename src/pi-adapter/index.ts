/**
 * pi-adapter —— 自研代码与 pi 框架之间的**防腐层**。
 *
 * ## 三条铁律
 *
 * 1. **对外 API 必须是写作领域形状**,不是 vendor 形状的透传。
 *    例:成本拆分对外叫 `UsageCostRow`,不叫 vendor 的 `UsageCostBreakdown`;
 *    打开会话对外叫 `openSession`,不叫 `SessionManager.open`。
 *
 * 2. **厚度控制**。这层只包「自研真的用到、且位置不稳定」的那部分 vendor 面
 *    (当下是 2 处深层路径 + 若干泄漏类型 + 会话装配入口),不做无差别包裹。
 *    它不该变成第二个框架。
 *
 * 3. **单向依赖**:`自研 → pi-adapter → vendor`,不可回流。
 *    `pi-adapter/*` 里**禁止** import `../../src/` 下的业务模块(唯一例外是
 *    `domain.ts` 对 `../session-text.ts` 的纯类型引用)。
 *
 * ## 五个模块的分工
 *
 * | 文件 | 承载 | vendor 依赖形态 |
 * |---|---|---|
 * | `domain.ts` | 自研自定义接口 + **不透明句柄**类型 | **零**(刻意的) |
 * | `types.ts` | **vendor 类型别名**(改名字,不改结构) | `import type` |
 * | `guard.ts` | 工具路径守卫 | **深层路径**(唯一) |
 * | `usage.ts` | 成本拆分投影 | **深层路径**(唯一) |
 * | `session.ts` | 句柄 ↔ 实体造型 | 包的 `index.ts` |
 * | `runtime.ts` | 会话**打开 / 装配**函数 | 包的 `index.ts` |
 *
 * ## 检查方式
 *
 * ```bash
 * # ① 自研侧不应直接碰 vendor(唯一允许的例外见各文件注释)
 * grep -rn "vendor/pi-" src/ --exclude-dir=pi-adapter
 * # ② 深层路径只应在 guard.ts / usage.ts
 * grep -rn "vendor/pi-.*src/core/" src/ --exclude-dir=pi-adapter
 * ```
 *
 * ## 上游升级时改哪里
 *
 * | 现象 | 改这个文件 |
 * |---|---|
 * | `core/tools/path-utils.ts` 找不到 | `guard.ts` |
 * | `core/usage-totals.ts` 找不到 | `usage.ts` |
 * | `SessionManager` 改名/挪包 | `session.ts`(只改 import 与两行断言) |
 * | `ToolDefinition` / `ThinkingLevel` 等**改名字** | `types.ts`(改一行别名) |
 * | `SessionManager.open` 签名变化 | `runtime.ts`(改 `openSession` 一处) |
 * | `createAgentSessionServices` 装配面变化 | `runtime.ts`(转发处)+ 各调用点 |
 * | 某个返回值多/少字段 | `domain.ts` 对应接口 |
 */

export * from "./domain.ts";
export * from "./guard.ts";
export * from "./runtime.ts";
export * from "./session.ts";
export * from "./types.ts";
export * from "./usage.ts";
