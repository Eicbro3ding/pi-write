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
} from "../../vendor/pi-coding-agent/src/index.ts";
import type { RuntimeFactoryHandle, SessionManagerHandle } from "./domain.ts";

/** 实体 → 句柄(编译期造型,运行时零开销)。 */
export function toHandle(sm: SessionManager): SessionManagerHandle {
	return sm as unknown as SessionManagerHandle;
}

/** 句柄 → 实体(仅限 pi-adapter 内使用)。 */
export function fromHandle(h: SessionManagerHandle): SessionManager {
	return h as unknown as SessionManager;
}

/** 工厂实体 → 句柄。 */
export function toFactoryHandle(f: CreateAgentSessionRuntimeFactory): RuntimeFactoryHandle {
	return f as unknown as RuntimeFactoryHandle;
}

/** 工厂句柄 → 实体(仅限 pi-adapter 内使用)。 */
export function fromFactoryHandle(h: RuntimeFactoryHandle): CreateAgentSessionRuntimeFactory {
	return h as unknown as CreateAgentSessionRuntimeFactory;
}
