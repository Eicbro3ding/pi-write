/**
 * UUID 生成(T7 批 4,2026-10-04)。
 *
 * ## 为什么单开这个文件,而不是塞进 pi-adapter
 *
 * 自研侧原先写的是:
 * ```ts
 * import { uuidv7 } from "../vendor/pi-ai/src/index.ts";
 * ```
 *
 * 但 `uuidv7` **不是 AI 能力** —— 它是一个通用标识符生成器,恰好被 pi-ai
 * 的 index 顺手再导出了。把它收进 `pi-adapter` 会违反铁律 1(adapter 的对外
 * API 必须是**写作领域形状**):自研侧管一个 UUID 生成器叫「兼容层」,读代码
 * 的人会以为这里藏着模型调用。
 *
 * 正确的归属是「自研自己的工具函数」—— 于是有 `src/util/`。
 *
 * ## 为什么是转发而不是自己实现
 *
 * UUID v7 的规范细节(时间戳高 48 位、版本位、变体位、单调递增的随机尾)
 * 实现起来不难但容易写错,而且**换一个实现会让既有 id 的排序语义悄悄改变**。
 * vendor 这份已经在用、已经验证过,直接转发最稳。
 *
 * 上游若挪走 / 改名 `uuidv7`,只改这一行。
 *
 * ## 与 adapter 的关系
 *
 * 本文件**不是** adapter 的一部分(不做形状转换、不隔离 vendor 的不稳定面)。
 * 它是一次**归属修正**:把「被误当成 AI 能力」的通用工具挪回它该在的地方。
 * 因此它不遵守「自研 → adapter → vendor」的方向约束 —— 它是自研自己的模块,
 * 直接依赖 vendor 的一个稳定工具函数是合理的。
 */

// ★ 唯一的 vendor 引用 —— 上游若移动该函数,只改这一行
import { uuidv7 as vendorUuidv7 } from "@earendil-works/pi-ai";

/** 时间有序的 UUID(v7):按生成时间自然排序,适合做会话/条目标识。 */
export const uuidv7: typeof vendorUuidv7 = vendorUuidv7;
