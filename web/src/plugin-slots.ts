/**
 * 插件侧的槽位 API(全局 `window.piWriter`)—— trusted 插件前端 JS 往里注册 UI 的**唯一入口**。
 *
 * 在这之前,插件 `frontend.mjs` 想加东西只能 `querySelector` 猜宿主的 DOM、
 * 再 `appendChild`(见 dice 插件早期的「掷骰历史」)—— 宿主一改结构插件就瞎。
 * 槽位树把这条路堵掉:插件读**槽位目录**(有哪些座位)再往**具名槽位**注册条目,
 * 不碰 DOM 结构。宿主换布局,注册代码一行不改。
 *
 * 对外形状(挂在 window.piWriter.slots 上):
 *  - `list()`           → 已声明槽位名(插件据此知道自己能往哪儿放)
 *  - `register(name, entry)` → 注册一个条目(未声明槽位**直接抛错**——与内核同一条铁律)
 *  - `unregister(name, id)`  → 摘掉自己的条目
 *  - `describe()`       → 槽位树的可读快照(调试/自检用)
 *
 * `entry.render` 的形态:插件给的是 **DOM 节点工厂**(`() => Node`),因为插件 JS 不在
 * React 树里。宿主桥渲染时把它塞进一个容器节点 —— 插件拿到的就是一块自己的地。
 * 也接受直接给一个 Node(见 normalizeRenderable)。
 *
 * 安全边界:这个 API **只在插件 JS 已加载时存在**(trusted 才加载,见 plugin-scripts.ts),
 * 所以「能被调用」本身就是「已被用户完全信任」。它不做额外授权,但仍守住
 * 「声明 = 授权」——不让插件往没声明的槽位乱塞。
 */
import { getSlot, listSlots, registerEntry, unregisterEntry, type SlotEntry } from "./slots.ts";
import { bumpSlots } from "./components/Slot.tsx";

/** 插件条目在注册表里的 render payload 形状(由宿主桥识别并落到 DOM)。 */
export interface PluginDomEntryPayload {
	kind: "plugin-dom";
	/** 条目归属(插件 id;由调用方传入,回收时按它整批摘)。 */
	owner: string;
	/** 产出 DOM 的工厂;宿主会在挂载/重渲染时调用一次,取其返回的节点。 */
	factory: () => Node;
}

/** 插件可注册的条目(对外的窄形态;order/priority/when 都允许)。 */
export interface PluginSlotEntryInput {
	/** 条目 id 在同槽位内唯一;**必须带插件前缀**避免撞车(宿主会校验非空)。 */
	id: string;
	/** 目标槽位是 keyed 形态时的分派键(如设置页插件卡扩展位 key=插件 id)。 */
	key?: string;
	/** list 升序 / chain 降序的权重。 */
	order?: number;
	/** chain 参选优先级。 */
	priority?: number;
	/** 条件:返回 false 时本轮不参与。 */
	when?: () => boolean;
	/** 产出内容的节点工厂(或直接给节点)。 */
	render: (() => Node) | Node;
}

/** `window.piWriter.slots` 的形状。 */
export interface PluginSlotsApi {
	list(): string[];
	register(slotName: string, entry: PluginSlotEntryInput): void;
	unregister(slotName: string, entryId: string): void;
	describe(): Array<{ name: string; kind: string; scope: string }>;
}

/** 把插件给的 render 归一成「返回节点」的工厂(直接给 Node 就包一层)。 */
function normalizeRenderable(render: (() => Node) | Node): () => Node {
	if (typeof render === "function") return render as () => Node;
	const node = render;
	return () => node;
}

/**
 * 构造 API 对象。抽成函数(而不是直接挂 window)是为了**可单测** ——
 * 测试里拿一个干净的 api,不必依赖 window 全局。
 */
export function createPluginSlotsApi(): PluginSlotsApi {
	return {
		list: () => listSlots().map((s) => s.name),
		describe: () =>
			listSlots().map((s) => ({ name: s.name, kind: s.kind, scope: s.scope })),
		register: (slotName, entry) => {
			if (typeof slotName !== "string" || slotName.length === 0) throw new Error("槽位名不能为空");
			if (!entry || typeof entry !== "object") throw new Error("条目必须是对象");
			if (typeof entry.id !== "string" || entry.id.trim().length === 0) throw new Error("条目 id 不能为空");
			// owner 从 id 的前缀推断(约定 `pluginId:...`),缺失则记为 "plugin"
			const owner = entry.id.includes(":") ? entry.id.split(":")[0] : "plugin";
			const payload: PluginDomEntryPayload = { kind: "plugin-dom", owner, factory: normalizeRenderable(entry.render) };
			const slotEntry: SlotEntry = {
				id: entry.id,
				owner,
				render: payload,
				...(entry.key !== undefined ? { key: entry.key } : {}),
				...(entry.order !== undefined ? { order: entry.order } : {}),
				...(entry.priority !== undefined ? { priority: entry.priority } : {}),
				...(entry.when ? { when: entry.when } : {}),
			};
			// 未声明槽位 → UnknownSlotError(内核抛);这里不 catch,让插件作者当场看到
			registerEntry(slotName, slotEntry);
			bumpSlots();
		},
		unregister: (slotName, entryId) => {
			if (unregisterEntry(slotName, entryId)) bumpSlots();
		},
	};
}

/** 该槽位是否已声明(插件侧探测用)。 */
export function hasSlot(name: string): boolean {
	return getSlot(name) !== undefined;
}
