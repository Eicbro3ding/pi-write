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
 *  - 其他 → 交给调用方给的 `renderEntry`(声明式条目的宿主渲染器走这条);
 *    插件 JS 条目的 `kind: "plugin-dom"` payload 另有内置渲染器(见 PluginDomNode)。
 */
import { Fragment, useEffect, isValidElement, useSyncExternalStore, useRef, type ReactNode } from "react";
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
	// 插件 JS 条目:payload 是 { kind:"plugin-dom", factory } —— 由内置渲染器落 DOM
	if (typeof payload === "object" && payload !== null && (payload as { kind?: string }).kind === "plugin-dom") {
		return <PluginDomNode entryId={entry.id} factory={(payload as { factory: () => Node }).factory} />;
	}
	return undefined;
}

/**
 * 插件 JS 条目的渲染器:把插件给的 DOM 节点挂进来。
 *
 * 插件不在 React 树里,给的是节点工厂。这里用一个**空的宿主 div**,在 effect 里把
 * 工厂产出的节点 append 进去 —— 插件拿到的是一块完全属于自己的 DOM 领地,
 * 它怎么改内部都行;卸载时 `replaceChildren()` 清干净,没有残留。
 *
 * 为什么 effect 里做而不是渲染期:渲染必须是纯的,append 是副作用;而且 effect 的
 * 清理时机正好对应挂载/卸载,天然管好生命周期。工厂只在挂载时调用一次(依赖 entryId),
 * 之后插件自己管内部更新。
 */
function PluginDomNode({ entryId, factory }: { entryId: string; factory: () => Node }) {
	const hostRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let node: Node | null = null;
		try {
			node = factory();
		} catch (e) {
			// 插件工厂抛错不该拖垮整个槽位:留一个可读的提示,别白屏
			console.error(`[pi-writer] 插件槽位条目 "${entryId}" 的节点工厂抛错:`, e);
			host.textContent = "插件界面加载失败";
			return;
		}
		if (node) host.replaceChildren(node);
		return () => {
			// 卸载:清掉插件塞进来的节点(插件自己的 effect/定时器由它自身负责)
			host.replaceChildren();
		};
	}, [entryId, factory]);
	return <div ref={hostRef} className="plugin-slot-host" />;
}

export interface SlotProps {
	/** 槽位名。未声明时渲染 `fallback`(不抛错 —— 渲染期容错策略)。 */
	name: string;
	/**
	 * keyed 形态的分派键:只渲染 key 匹配的那一个条目。
	 * 用于「同一个槽位按 id 分给多个宿主位置」的场景(如设置页每个插件卡渲染自己那一格)。
	 * 非 keyed 槽位上给 key 会被忽略(仍按 kind 组合)。
	 */
	key?: string;
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
export function Slot({ name, key: dispatchKey, fallback = null, renderEntry, wrap }: SlotProps): ReactNode {
	useSlotsVersion();
	const slot = getSlot(name);
	if (!slot) return fallback;
	const { items } = resolve(name);
	// keyed 槽位给了 key:只取那一个(每个宿主位置画自己那一格)
	const chosen = dispatchKey !== undefined && slot.kind === "keyed" ? items.filter((e) => e.key === dispatchKey) : items;
	if (chosen.length === 0) return fallback;

	const nodes: ReactNode[] = [];
	for (const entry of chosen) {
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
