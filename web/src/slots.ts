/**
 * 槽位表(slot registry)—— 前端的「声明 = 渲染授权」内核。
 *
 * 借鉴 DeepSeek Harness 客户端那套:UI 不是一棵写死的组件树,而是一张**注册表**。
 * 宿主与插件都只做同一件事 —— 往**具名槽位**注册条目;渲染由一个薄桥
 * (`components/Slot.tsx`)读表完成。加一个界面不再需要改 import、改 JSX、重新构建。
 *
 * 三条硬规则(与 dsh 一致,顺序即优先级):
 *  1. **声明 = 授权**:`registerSlot()` 先声明槽位存在;`registerEntry()` 往未声明的
 *     槽位注册**直接抛错**。错拼槽名在开发期就现形,绝不静默消失。
 *  2. **`'root'` 是种子**:启动时唯一预声明的槽位,所有 UI 从它往下长。
 *  3. **注册表是模块级单例**:全局唯一。测试用 `resetSlots()` 清空。
 *
 * 纯数据 + 纯函数,零 React / 零 DOM 依赖 —— 这样它能被完全单测,也是整个机制
 * 唯一需要严格守住的边界。React 桥只读表、不写表。
 */

/** 一个槽位的组合形态:决定落在它上面的多个条目怎么共存。 */
export type SlotKind =
	/** 只坐一个。第二个注册即抛错(替换语义靠先 unregister,不靠静默覆盖)。 */
	| "single"
	/** 有序多个,按 order 升序叠加(默认 0;相同 order 按注册先后)。 */
	| "list"
	/** 按 key 分派 —— 每个 key 至多一个条目,`resolve` 时按 key 取。 */
	| "keyed"
	/** 组件自己「举手」参选:按 priority 降序问一遍,谁先返回非 null 就是谁。 */
	| "chain";

/** 槽位的可见范围。同一份注册表在多次渲染间共享,scope 只影响语义与告警。 */
export type SlotScope =
	/** 全局单例(顶栏、全局浮层这类)。 */
	| "app"
	/** 每本书一份(书库栏、世界书面板这类)。 */
	| "book"
	/** 每个页面/视图一份(view.* 下的内容槽)。 */
	| "view";

/** 声明一个槽位时给的元信息。 */
export interface SlotDeclaration {
	/** 槽位名,点分命名(`app.chrome`、`view.edit.header`)。 */
	name: string;
	kind: SlotKind;
	/** 缺省 `app`。 */
	scope?: SlotScope;
	/**
	 * 子槽位名。声明父槽时一并播下子槽 —— 这是「UI 从 root 往下长」的机制:
	 * `ui-layout` 一次 register 就宣布了 sidebar/conversation/details/overlay 四个子槽。
	 * 子槽继承父槽的 scope(list 之外的类型建议显式写 kind)。
	 */
	children?: Array<{ name: string; kind: SlotKind; scope?: SlotScope }>;
	/** 人类可读的说明(进 UI 房与模型可读的目录)。 */
	description?: string;
}

/** 一个已声明的槽位(内部表示)。 */
export interface RegisteredSlot {
	name: string;
	kind: SlotKind;
	scope: SlotScope;
	description?: string;
}

/**
 * 槽位条目。`render` 的形态由**谁渲染**决定:
 *  - 宿主条目:返回 React 元素(React 桥直接用);
 *  - 插件声明式条目:返回一个纯数据描述(`DeclarativeEntry`),由宿主渲染器画;
 *  - 插件 JS 条目:同宿主,返回 React 元素。
 * 这里刻意不 import React —— 用 `unknown` 收口,由桥那层做窄化。
 */
export interface SlotEntry<P = unknown> {
	/** 条目 id,同槽位内唯一(重复注册即抛错)。 */
	id: string;
	/**
	 * 归属者:`"core"` 表示宿主自带,否则是插件 id。用于「按来源批量回收」
	 * (插件禁用/取消信任时一次摘干净)。
	 */
	owner: string;
	/** list/chain 的排序权重。list 升序,chain 降序。缺省 0。 */
	order?: number;
	/** chain 形态的优先级(降序问询,第一个返回非 null 者中选)。缺省 0。 */
	priority?: number;
	/** keyed 形态的分派键。 */
	key?: string;
	/** 该条目的 payload:React 元素 / 声明式描述 / 任意数据。 */
	render: P;
	/** 可选的「是否适用」判定:返回 false 时该条目对本轮不参与(如只在某视图出现)。 */
	when?: () => boolean;
}

/* ------------------------------------------------------------------ *
 * 模块级单例
 * ------------------------------------------------------------------ */

/** 已声明的槽位(name → 声明)。 */
const slots = new Map<string, RegisteredSlot>();
/** 各槽位上的条目(name → 条目列表,保持注册顺序)。 */
const entries = new Map<string, SlotEntry[]>();
/** 条目 id 去重用的索引(槽位名 → Set<entryId>)。 */
const entryIds = new Map<string, Set<string>>();

/** 根槽位名。启动时唯一预声明,所有 UI 从它往下长。 */
export const ROOT_SLOT = "root";

slots.set(ROOT_SLOT, { name: ROOT_SLOT, kind: "single", scope: "app", description: "应用根:所有 UI 的入口" });

/** 往未声明槽位注册时抛的错 —— 单独一个类,方便测试与上层区分。 */
export class UnknownSlotError extends Error {
	constructor(name: string, knownNames: string[]) {
		const hint = knownNames.length > 0 ? `已声明的槽位:${knownNames.join(", ")}` : "当前没有任何已声明槽位";
		super(`槽位 "${name}" 未声明 —— 先 registerSlot() 再注册条目。${hint}`);
		this.name = "UnknownSlotError";
	}
}

/**
 * 声明一个槽位。重复声明同一名字:
 *  - 声明**完全相同**(kind/scope 一致)→ 幂等,直接返回(允许模块被重复求值);
 *  - 否则抛错 —— 同名不同义是配置错误,不该静默让后来者覆盖先来者。
 */
export function registerSlot(decl: SlotDeclaration): RegisteredSlot {
	const scope = decl.scope ?? "app";
	const existing = slots.get(decl.name);
	if (existing) {
		if (existing.kind !== decl.kind || existing.scope !== scope) {
			throw new Error(
				`槽位 "${decl.name}" 重复声明且定义不一致(已声明 ${existing.kind}/${existing.scope},现声明 ${decl.kind}/${scope})`,
			);
		}
	} else {
		slots.set(decl.name, { name: decl.name, kind: decl.kind, scope, description: decl.description });
	}
	// 一并播下子槽位(声明父槽 = 宣布其子槽存在)
	for (const child of decl.children ?? []) {
		registerSlot({ name: child.name, kind: child.kind, scope: child.scope ?? scope });
	}
	return slots.get(decl.name) as RegisteredSlot;
}

/**
 * 往槽位注册一个条目。槽位未声明 → 抛 `UnknownSlotError`。
 *
 * `single` 形态下同槽位第二个条目抛错(不静默覆盖):要替换请先 `unregisterEntry`。
 * `keyed` 形态下同 key 第二个条目抛错。重复 id 一律抛错。
 */
export function registerEntry(slotName: string, entry: SlotEntry): void {
	const slot = slots.get(slotName);
	if (!slot) throw new UnknownSlotError(slotName, [...slots.keys()]);

	const ids = entryIds.get(slotName) ?? new Set<string>();
	if (ids.has(entry.id)) throw new Error(`槽位 "${slotName}" 上已有 id 为 "${entry.id}" 的条目(条目 id 须唯一)`);

	if (slot.kind === "single") {
		const existing = entries.get(slotName) ?? [];
		if (existing.length > 0) {
			throw new Error(`槽位 "${slotName}" 是 single 形态,已有条目 "${existing[0].id}",不能再注册 "${entry.id}"`);
		}
	}
	if (slot.kind === "keyed") {
		if (!entry.key) throw new Error(`槽位 "${slotName}" 是 keyed 形态,条目 "${entry.id}" 必须给 key`);
		const dup = (entries.get(slotName) ?? []).find((e) => e.key === entry.key);
		if (dup) throw new Error(`槽位 "${slotName}" 的 key "${entry.key}" 已被条目 "${dup.id}" 占用`);
	}

	const list = entries.get(slotName) ?? [];
	list.push(entry);
	entries.set(slotName, list);
	ids.add(entry.id);
	entryIds.set(slotName, ids);
}

/**
 * 摘掉一个条目(按 id)。用于插件禁用/取消信任时的回收;不存在则静默返回 false
 * (回收是「尽力而为」,不该因条目已不在而报错)。
 */
export function unregisterEntry(slotName: string, entryId: string): boolean {
	const list = entries.get(slotName);
	if (!list) return false;
	const i = list.findIndex((e) => e.id === entryId);
	if (i < 0) return false;
	list.splice(i, 1);
	entryIds.get(slotName)?.delete(entryId);
	return true;
}

/** 按 owner 批量回收(插件禁用 / 取消信任时一次摘干净)。返回摘掉的条数。 */
export function unregisterOwner(owner: string): number {
	let removed = 0;
	for (const [slotName, list] of entries) {
		const kept = list.filter((e) => e.owner !== owner);
		removed += list.length - kept.length;
		if (kept.length !== list.length) {
			entries.set(slotName, kept);
			const ids = entryIds.get(slotName);
			if (ids) for (const e of list) if (e.owner === owner) ids.delete(e.id);
		}
	}
	return removed;
}

/** 查一个槽位的声明(未声明返回 undefined)。 */
export function getSlot(name: string): RegisteredSlot | undefined {
	return slots.get(name);
}

/** 列出全部已声明槽位(按名字排序)。UI 房与「槽位目录」用。 */
export function listSlots(): RegisteredSlot[] {
	return [...slots.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 查某槽位上的条目(未经 when 过滤的原始列表,按注册顺序)。 */
export function listEntries(slotName: string): SlotEntry[] {
	return [...(entries.get(slotName) ?? [])];
}

/** 统计:槽位总数与条目总数(UI 房/调试面板展示用)。 */
export function slotStats(): { slots: number; entries: number } {
	let n = 0;
	for (const list of entries.values()) n += list.length;
	return { slots: slots.size, entries: n };
}

/* ------------------------------------------------------------------ *
 * 解析:把一个槽位的条目组合成「本轮该渲染什么」
 * ------------------------------------------------------------------ */

/** `resolve` 的第二返回值:chain 形态中选的条目(其他形态恒 null)。 */
export interface ResolvedSlot<P = unknown> {
	/** 该渲染的条目(已按 kind 排好序 / 已过 when 过滤)。 */
	items: SlotEntry<P>[];
	/** chain 形态:中选的那个条目(未命中为 null)。 */
	picked: SlotEntry<P> | null;
}

/**
 * 解析一个槽位,返回本轮该渲染的条目。
 *
 *  - `single`:至多一条;
 *  - `list`:按 order 升序(相同 order 按注册先后);
 *  - `keyed`:全部返回,调用方按 `key` 自取(`pickKeyed()` 是便捷版);
 *  - `chain`:按 priority 降序逐个问 `when()`,第一个返回 true 的中选 —— 只返回它。
 *
 * `when` 返回 false 的条目一律跳过(`when` 缺省视为 true)。未声明槽位返回空
 * —— **渲染期不抛错**:一个插件没加载时宿主照样要能画出来,失败只该是「槽位空着」。
 */
export function resolve<P = unknown>(slotName: string): ResolvedSlot<P> {
	const slot = slots.get(slotName);
	if (!slot) return { items: [], picked: null };
	const raw = (entries.get(slotName) ?? []) as SlotEntry<P>[];
	const live = raw.filter((e) => (e.when ? safeWhen(e) : true));

	if (slot.kind === "chain") {
		const sorted = [...live].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
		// chain 的「参选」由 when() 表达:第一个通过的就是中选者
		const picked = sorted.find((e) => (e.when ? safeWhen(e) : true)) ?? null;
		return { items: picked ? [picked] : [], picked };
	}
	if (slot.kind === "list") {
		const sorted = [...live].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		return { items: sorted, picked: null };
	}
	return { items: live, picked: null };
}

/** chain 的 `when` 可能被作者用来「举手」,返回非布尔值时按真值判——但抛错要隔离。 */
function safeWhen(entry: SlotEntry): boolean {
	try {
		return entry.when ? Boolean(entry.when()) : true;
	} catch {
		// 一个条目的 when 抛错不该拖垮整个槽位:视为「不参与」
		return false;
	}
}

/** keyed 槽位的便捷取用:按 key 取单个条目(不存在返回 undefined)。 */
export function pickKeyed<P = unknown>(slotName: string, key: string, key2?: string): SlotEntry<P> | undefined {
	const list = (entries.get(slotName) ?? []) as SlotEntry<P>[];
	const k = key2 ?? key;
	return list.find((e) => e.key === k && (e.when ? safeWhen(e) : true));
}

/* ------------------------------------------------------------------ *
 * 测试与热重载
 * ------------------------------------------------------------------ */

/**
 * 清空注册表并重新播种 `'root'`。**只给测试与热重载用** ——
 * 正常运行时不该调用(它会让所有已注册的 UI 消失)。
 */
export function resetSlots(): void {
	slots.clear();
	entries.clear();
	entryIds.clear();
	slots.set(ROOT_SLOT, { name: ROOT_SLOT, kind: "single", scope: "app", description: "应用根:所有 UI 的入口" });
}
