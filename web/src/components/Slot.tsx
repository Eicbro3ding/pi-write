/**
 * 槽位桥(`<Slot>`)—— 槽位表与 React 之间唯一的结合点。
 *
 * 职责刻意收得很窄:**只读表,不写表**。注册由 `slots.ts` 的 `registerSlot/registerEntry`
 * 完成(宿主在启动时、插件在加载时),桥只负责把某个槽位解析出来的条目渲染出来。
 *
 * 为什么要一个订阅机制:注册可能发生在渲染之后(插件脚本异步加载、信任开关切换),
 * 表变了界面得跟上。这里用一个模块级版本号 + `useSyncExternalStore` 做最小订阅 ——
 * 不改 slots.ts 的纯函数性质,也不引入 React 依赖到核心。
 *
 * 三类 `render` payload 的窄化:
 *  - React 元素(`ReactElement`)→ 直接渲染;
 *  - 函数(`() => ReactNode`)→ 调用后渲染(延迟到渲染期,可读 props);
 *  - 其他 → 交给调用方给的 `renderEntry`(声明式条目的宿主渲染器走这条)。
 */
import { Fragment, isValidElement, useSyncExternalStore, type ReactNode } from "react";
import { getSlot, resolve, type SlotEntry } from "../slots.ts";

/* ------------------------------------------------------------------ *
 * 订阅:注册表版本号
 * ------------------------------------------------------------------ */

let version = 0;
const listeners = new Set<() => void>();

/**
 * 通知 React 侧「表变了,重渲染」。注册表本身是模块级单例,这里只维护一个版本号。
 *
 * **调用点约定**:任何改变注册表内容的操作(registerSlot / registerEntry /
 * unregisterEntry / unregisterOwner / resetSlots)之后,由调用方触发一次。
 * 核心保持纯函数、零 React 依赖,这个通知放在外面。
 */
export function bumpSlots(): void {
	version += 1;
	for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 当前注册表版本(测试可达)。 */
export function slotsVersion(): number {
	return version;
}

/**
 * `useSyncExternalStore` 的 getSnapshot:返回版本号。版本一变,所有 `<Slot>` 重渲染。
 * 用一个数字做快照是刻意的 —— 比序列化整张表便宜,也不会因为对象身份而抖动。
 */
function useSlotsVersion(): number {
	return useSyncExternalStore(
		subscribe,
		() => version,
		() => version,
	);
}

/* ------------------------------------------------------------------ *
 * 桥
 * ------------------------------------------------------------------ */

/** 把条目的 `render` payload 窄化成 ReactNode。返回 undefined 表示「不认识,交给 fallback」。 */
function toReactNode(entry: SlotEntry): ReactNode | undefined {
	const payload = entry.render;
	if (isValidElement(payload)) return payload;
	if (typeof payload === "function") return (payload as () => ReactNode)();
	return undefined;
}

export interface SlotProps {
	/** 槽位名。未声明时渲染 `fallback`(不抛错 —— 渲染期容错策略)。 */
	name: string;
	/** 该槽位无条目时渲染什么(通常是 null,或一个占位)。 */
	fallback?: ReactNode;
	/**
	 * 自定义渲染器:收到一个条目,返回 ReactNode。给「声明式条目」用 ——
	 * 那种条目的 `render` 是纯数据,得由宿主渲染器画。返回 `undefined` 表示
	 * 这个渲染器不认识该条目,会退回默认窄化。
	 */
	renderEntry?: (entry: SlotEntry) => ReactNode | undefined;
	/** 把多个条目包一层(如 list 形态的容器)。缺省直接拼数组。 */
	wrap?: (children: ReactNode[], slotName: string) => ReactNode;
}

/**
 * 渲染一个槽位。条目按槽位的 kind 组合好之后逐个渲染。
 *
 * 未声明槽位 → `fallback`(不抛错)。这是刻意的:插件没加载时宿主照样要能画出来,
 * 失败只该是「槽位空着」,不该是白屏。**注册期的严格 + 渲染期的宽容**是一对:
 * 错误在注册那一刻就报出来,渲染时不再有人为的错误买单。
 */
export function Slot({ name, fallback = null, renderEntry, wrap }: SlotProps): ReactNode {
	useSlotsVersion();
	if (!getSlot(name)) return fallback;
	const { items } = resolve(name);
	if (items.length === 0) return fallback;

	const nodes: ReactNode[] = [];
	for (const entry of items) {
		const custom = renderEntry?.(entry);
		const node = custom !== undefined ? custom : toReactNode(entry);
		if (node === undefined || node === null) continue;
		// 每个条目包一层带 key 的 Fragment:slot 内的条目可以任意增删/重排,
		// React 靠这个 key 正确复用。条目 id 在槽位内唯一(注册期已校验)。
		nodes.push(<Fragment key={entry.id}>{node}</Fragment>);
	}
	if (nodes.length === 0) return fallback;
	return wrap ? wrap(nodes, name) : nodes;
}
