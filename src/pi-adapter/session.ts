/**
 * 会话装配的 vendor 接入点(T6,2026-10-04)。
 *
 * 两件事:
 * 1. **句柄转换** —— `toHandle` / `fromHandle`,把 vendor 的 `SessionManager`
 *    与自研的 `SessionManagerHandle` 互相造型。运行期零开销(同一个对象,
 *    只是类型视角不同)。
 * 2. **工厂签名检查** —— `assertRuntimeFactory`,把调用方给的
 *    `RuntimeFactoryHandle` 还原成 vendor 期望的函数类型。
 *
 * 为什么句柄方案值得:vendor 类型一旦泄漏到自研侧,上游重命名/挪包会让大量
 * 无关文件同时编译失败;句柄把「类型形状」这件事关在 adapter 内。
 *
 * 代价是两处 `as unknown as` 断言 —— 断言的风险边界完全在本文件内:只要
 * `toHandle` 的入参真来自 vendor,后面就永远成立。
 */

import type {
	CreateAgentSessionRuntimeFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeFactoryHandle, SessionManagerHandle } from "./domain.ts";

/**
 * 实体 → 句柄(编译期造型,运行时零开销)。
 *
 * **幂等**:入参若已是句柄,原样返回。`openSession` 直接产出句柄之后,调用点
 * 若习惯性地再包一层(历史写法),不会变成「句柄套句柄」—— 让两侧都安全,
 * 调用点可以逐步清理而不必同步改。
 */
export function toHandle(sm: SessionManager | SessionManagerHandle): SessionManagerHandle {
	return sm as unknown as SessionManagerHandle;
}

/** 句柄 → 实体(仅限 pi-adapter 内使用)。 */
export function fromHandle(h: SessionManagerHandle): SessionManager {
	return h as unknown as SessionManager;
}

/**
 * 会话实体的类型 —— **从 `fromHandle` 的返回类型推断**,不手工命名。
 *
 * 为什么这样写:`session-host.ts` 内部确实要持有实体(它把实体传给 vendor 的
 * 运行时、调 `.getEntries()` 取成本),但它**不该**从 adapter 的公开面拿到
 * 「`SessionManager`」这个名字 —— 那等于把 vendor 的类型名重新泄漏出去,
 * T6 建句柄的功夫就白费了。
 *
 * 用 `ReturnType<typeof fromHandle>` 的效果:
 * - 类型上它仍是 vendor 的那个结构(所以字段声明处能通过检查);
 * - 但自研侧没有「`SessionManager`」这个名字可用,只能写
 *   `SessionEntity`,读代码的人一眼看出「这是 adapter 交出来的东西」;
 * - 上游改名时,这里不需要动(推断自动跟随)。
 */
export type SessionEntity = ReturnType<typeof fromHandle>;

/**
 * 工厂实体 → 句柄。
 *
 * **幂等**:入参若已是句柄,原样返回。为什么要这样 —— `session-factory.ts` 的
 * `createSessionRuntimeFactory` 已在内部造型过(T7 批 2),调用点再包一次就会
 * 变成「句柄套句柄」。幂等让两侧都安全,调用点也可以逐步清理而不必同步改。
 */
export function toFactoryHandle(f: CreateAgentSessionRuntimeFactory | RuntimeFactoryHandle): RuntimeFactoryHandle {
	return f as unknown as RuntimeFactoryHandle;
}

/** 工厂句柄 → 实体(仅限 pi-adapter 内使用)。 */
export function fromFactoryHandle(h: RuntimeFactoryHandle): CreateAgentSessionRuntimeFactory {
	return h as unknown as CreateAgentSessionRuntimeFactory;
}
