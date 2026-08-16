import type { WorldEntryDto } from "../types.ts";
// 条目类型与标签是命令面板/世界书页/关系图共用的唯一真相源(2026-08 收敛到 world-entry.ts)
import { ENTRY_TYPES, ENTRY_TYPE_LABELS } from "../world-entry.ts";
export { ENTRY_TYPES, ENTRY_TYPE_LABELS };

interface WorldTreeProps {
	/** null 表示尚未加载成功(树区留白,错误文案由页面呈现)。 */
	entries: WorldEntryDto[] | null;
	/** 当前选中条目 id。 */
	selId: string | null;
	onSelect: (id: string) => void;
}

/**
 * 世界书分类树:按 type 分组(人物/世界/时间线/大纲),组内用 parent 字段
 * 建层级(跨类型 parent 亦可),子条目按深度缩进;选中条目琥珀高亮,
 * 未激活条目(active=false)弱化显示。渲染带已访问集合防御 parent 环
 * (后端仅校验自引用,不校验环;前端 parent 下拉已禁止选后代)。
 */
export function WorldTree({ entries, selId, onSelect }: WorldTreeProps) {
	if (entries === null) return <aside className="world-tree" />;
	// id → 直接子条目(保持 entries 顺序)
	const childrenOf = new Map<string, WorldEntryDto[]>();
	const ids = new Set(entries.map((e) => e.id));
	for (const e of entries) {
		if (!e.parent || !ids.has(e.parent)) continue;
		const arr = childrenOf.get(e.parent) ?? [];
		arr.push(e);
		childrenOf.set(e.parent, arr);
	}
	return (
		<aside className="world-tree">
			{entries.length === 0 && <div className="w-empty-tree">世界书为空</div>}
			{ENTRY_TYPES.map((type) => {
				const group = entries.filter((e) => e.type === type);
				if (group.length === 0) return null;
				const roots = group.filter((e) => !e.parent || !ids.has(e.parent));
				return (
					<div className="w-group" key={type}>
						<div className="w-group-label">{ENTRY_TYPE_LABELS[type]}</div>
						{roots.map((e) => (
							<TreeBranch
								key={e.id}
								entry={e}
								depth={0}
								childrenOf={childrenOf}
								visited={new Set()}
								selId={selId}
								onSelect={onSelect}
							/>
						))}
					</div>
				);
			})}
		</aside>
	);
}

/** 单个条目分支:深度缩进的按钮;子条目递归渲染。 */
function TreeBranch({
	entry,
	depth,
	childrenOf,
	visited,
	selId,
	onSelect,
}: {
	entry: WorldEntryDto;
	depth: number;
	childrenOf: ReadonlyMap<string, WorldEntryDto[]>;
	visited: ReadonlySet<string>;
	selId: string | null;
	onSelect: (id: string) => void;
}) {
	const nextVisited = new Set(visited).add(entry.id);
	const children = (childrenOf.get(entry.id) ?? []).filter((c) => !visited.has(c.id) && c.id !== entry.id);
	const cls = [
		"w-node",
		entry.id === selId ? "active" : "",
		entry.active ? "" : "off",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<>
			<button
				type="button"
				className={cls}
				style={{ paddingLeft: `${10 + depth * 16}px` }}
				title={entry.active ? entry.id : `${entry.id}(未激活)`}
				onClick={() => onSelect(entry.id)}
			>
				{entry.title || "未命名"}
			</button>
			{children.map((c) => (
				<TreeBranch
					key={c.id}
					entry={c}
					depth={depth + 1}
					childrenOf={childrenOf}
					visited={nextVisited}
					selId={selId}
					onSelect={onSelect}
				/>
			))}
		</>
	);
}
