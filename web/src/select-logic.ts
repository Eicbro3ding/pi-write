/**
 * 统一下拉(Select)的纯逻辑——键盘导航、分组扁平化、搜索过滤、弹层翻转。
 * 组件(Select.tsx)只负责渲染与 DOM 事件,判定全部在这里,便于单测。
 *
 * 规范见设计稿 03-组件规范/01:闭合态 4 态(默认/悬停/聚焦/禁用)、展开态
 * 2 型(分组列表 / 带搜索)、选项行 高 30 圆角 8、分组标题 11 号 $faint。
 */

/** 选项(值为字符串;dot 为可选色点,如词条类型色)。 */
export interface SelectOption {
	value: string;
	label: string;
	/** 右侧次要说明(如 provider 名、模型 id)。 */
	hint?: string;
	/** 左侧色点颜色(不传则不画)。 */
	dot?: string;
	disabled?: boolean;
}

/** 选项分组(带标题的一簇选项)。 */
export interface SelectGroup {
	label: string;
	options: readonly SelectOption[];
}

/** 扁平化后的一行:分组标题行或选项行。 */
export type SelectRow =
	| { kind: "group"; label: string }
	| { kind: "option"; option: SelectOption };

/** 汇总选项与分组为扁平行序列(分组标题插在组内第一项之前;空组不出现)。 */
export function flattenSelectRows(options: readonly SelectOption[] = [], groups: readonly SelectGroup[] = []): SelectRow[] {
	const rows: SelectRow[] = [];
	if (options.length > 0) for (const o of options) rows.push({ kind: "option", option: o });
	for (const g of groups) {
		if (g.options.length === 0) continue;
		if (g.label) rows.push({ kind: "group", label: g.label });
		for (const o of g.options) rows.push({ kind: "option", option: o });
	}
	return rows;
}

/** 搜索过滤:命中 label/hint/value;分组标题在其组内无命中时一并省略。 */
export function filterSelectRows(rows: readonly SelectRow[], query: string): SelectRow[] {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return [...rows];
	const out: SelectRow[] = [];
	/** 待定的分组标题:只有后续真有命中选项时才落进结果。 */
	let pendingGroup: SelectRow | null = null;
	for (const row of rows) {
		if (row.kind === "group") {
			pendingGroup = row;
			continue;
		}
		const o = row.option;
		const hit =
			o.label.toLowerCase().includes(q) ||
			o.value.toLowerCase().includes(q) ||
			(o.hint ?? "").toLowerCase().includes(q);
		if (!hit) continue;
		if (pendingGroup) {
			out.push(pendingGroup);
			pendingGroup = null;
		}
		out.push(row);
	}
	return out;
}

/** 当前值 → 选中项所在的可选行下标(不在列表里返回 -1)。 */
export function selectedRowIndex(rows: readonly SelectRow[], value: string): number {
	return rows.findIndex((r) => r.kind === "option" && r.option.value === value && !r.option.disabled);
}

/**
 * 方向键移动:从 from 出发朝 dir(+1/-1)找下一个可选(非标题、非禁用)行;
 * 循环到另一端。全不可选返回 -1。
 */
export function stepSelectRow(rows: readonly SelectRow[], from: number, dir: 1 | -1): number {
	const n = rows.length;
	if (n === 0) return -1;
	let i = from;
	for (let k = 0; k < n; k++) {
		i = (i + dir + n) % n;
		const row = rows[i]!;
		if (row.kind === "option" && !row.option.disabled) return i;
	}
	return -1;
}

/** 列表首个可选行下标(打开弹层时的初始高亮;找不到返回 -1)。 */
export function firstSelectableRow(rows: readonly SelectRow[]): number {
	return stepSelectRow(rows, -1, 1);
}

/**
 * 弹层定位:与触发器等宽,默认向下偏移 6;下方空间不足时向上翻转。
 * 返回视口坐标(组件用 position: fixed 渲染,免疫祖先 overflow 裁剪)。
 */
export function selectPopupPlacement(
	trigger: { top: number; left: number; width: number; height: number },
	popupHeight: number,
	viewport: { width: number; height: number },
	gap = 6,
	edge = 8,
): { top: number; left: number; width: number; flip: boolean } {
	const below = trigger.top + trigger.height + gap;
	const flip = below + popupHeight > viewport.height - edge && trigger.top - gap - popupHeight >= edge;
	const top = flip ? trigger.top - gap - popupHeight : below;
	const width = trigger.width;
	const maxLeft = Math.max(edge, viewport.width - width - edge);
	const left = Math.min(Math.max(trigger.left, edge), maxLeft);
	return { top: Math.max(edge, top), left, width, flip };
}

/** 分组选择器的搜索输入是否需要出现(选项够多才值得给搜索框)。 */
export function searchableByDefault(rowCount: number): boolean {
	return rowCount > 12;
}
