/**
 * pi-adapter —— 自研代码与 pi 框架之间的**防腐层**。
 *
 * ## 三条铁律
 *
 * 1. **对外 API 必须是写作领域形状**,不是 vendor 形状的透传。
 *    例:成本拆分对外叫 `UsageCostRow`,不叫 vendor 的 `UsageCostBreakdown`。
 *
 * 2. **厚度控制**。这层只包「自研真的用到、且位置不稳定」的那部分 vendor 面
 *    (当下是 2 处深层路径 + 若干泄漏类型),不做无差别包裹。它不该变成第二个框架。
 *
 * 3. **单向依赖**:`自研 → pi-adapter → vendor`,不可回流。
 *    `pi-adapter/*` 里**禁止** import `../../src/` 下的业务模块(唯一例外是
 *    `../session-text.ts` 的纯类型,理由见 domain.ts 注释)。
 *
 * ## 检查方式
 *
 * ```bash
 * # 这两条应该都为空(即：除 pi-adapter 外无人直接碰 vendor 深层路径)
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
 * | 某个返回值多/少字段 | `domain.ts` 对应接口 |
 */

export * from "./domain.ts";
export * from "./guard.ts";
export * from "./session.ts";
export * from "./usage.ts";
