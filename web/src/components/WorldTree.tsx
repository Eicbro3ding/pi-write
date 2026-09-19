import { useState } from "react";
import type { WorldEntryDto, WorldRelationDto } from "../types.ts";
// 条目类型与标签是命令面板/世界书页/关系图共用的唯一真相源(2026-08 收敛到 world-entry.ts)
import { ENTRY_TYPES, ENTRY_TYPE_LABELS } from "../world-entry.ts";
import { Select } from "./Select.tsx";
import { Lu } from "./Lu.tsx";
export { ENTRY_TYPES, ENTRY_TYPE_LABELS };

interface WorldTreeProps {
	/** null 表示尚未加载成功(树区留白,错误文案由页面呈现)。 */
	entries: WorldEntryDto[] | null;
	/** 当前选中条目 id。 */
	selId: string | null;
	onSelect: (id: string) => void;
	/** 全部关系(条目行右侧显示关系条数)。 */
	relations: WorldRelationDto[];
	/** 新建条目:入口在树底(设计稿 08),点击展开内联创建行。 */
	creating: boolean;
	onCreatingChange: (v: boolean) => void;
	createType: WorldEntryDto["type"];
	onCreateType: (t: WorldEntryDto["type"]) => void;
	createTitle: string;
	onCreateTitle: (t: string) => void;
	onCreate: () => void;
}

/** 未激活条目的眼睛关闭图标(类型/状态弱化的唯一标记)。 */
function IconEyeOff() {
	return <Lu icon="eye-off" size={13} className="w-node-off" />;
}

/** 空分组提示行的收件箱图标。 */
function IconInbox() {
	return <Lu icon="inbox" size={13} />;
}

/**
 * 世界书分类树(设计稿 08):按 type 分组(人物/世界/时间线/大纲),组标题右侧显示
 * 条数;组内用 parent 字段建层级(跨类型 parent 亦可),子条目收进带竖向导线的
 * 子块;条目行显示名称 + 右侧关系条数(未激活再加一个眼睛关闭图标)。
 * 选中行:琥珀左竖条 + --amber-tint 底。树底部为新建条目入口(琥珀实心按钮,
 * 点击展开内联创建行:类型 + 标题 + 添加),不再占用中间表单区。
 * 渲染带已访问集合防御 parent 环(后端仅校验自引用,不校验环)。
 */
export function WorldTree({
	entries,
	selId,
	onSelect,
	relations,
	creating,
	onCreatingChange,
	createType,
	onCreateType,
	createTitle,
	onCreateTitle,
	onCreate,
}: WorldTreeProps) {
	/** 折叠的父条目 id(仅前端展示态)。 */
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
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
	/** 条目 id → 关系条数(图上的关系条数同源)。 */
	const relCountOf = (id: string) => relations.filter((r) => r.from === id || r.to === id).length;

	return (
		<aside className="world-tree">
			<div className="w-tree-groups">
				{ENTRY_TYPES.map((type) => {
					const group = entries.filter((e) => e.type === type);
					const roots = group.filter((e) => !e.parent || !ids.has(e.parent));
					return (
						<div className="w-group" key={type}>
							<div className="w-group-head">
								<span className="w-group-label">{ENTRY_TYPE_LABELS[type]}</span>
								<span className="w-group-count">{group.length}</span>
							</div>
							{group.length === 0 && (
								<div className="w-group-empty">
									<IconInbox />
									<span>暂无条目 · 点击下方新建</span>
								</div>
							)}
							{roots.map((e) => (
								<TreeBranch
									key={e.id}
									entry={e}
									childrenOf={childrenOf}
									visited={new Set()}
									selId={selId}
									onSelect={onSelect}
									relCountOf={relCountOf}
									collapsed={collapsed}
									onToggle={(id) =>
										setCollapsed((prev) => {
											const next = new Set(prev);
											if (next.has(id)) next.delete(id);
											else next.add(id);
											return next;
										})
									}
								/>
							))}
						</div>
					);
				})}
			</div>
			<div className="w-tree-foot">
				{creating && (
					<div className="w-create">
						<Select
							className="sel-block"
							value={createType}
							onChange={(v) => onCreateType(v as WorldEntryDto["type"])}
							title="条目类型"
							options={ENTRY_TYPES.map((t) => ({ value: t, label: ENTRY_TYPE_LABELS[t] }))}
						/>
						<input
							type="text"
							autoFocus
							value={createTitle}
							placeholder="条目标题"
							onChange={(e) => onCreateTitle(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") onCreate();
								if (e.key === "Escape") onCreatingChange(false);
							}}
						/>
						<div className="w-create-actions">
							<button type="button" className="w-btn-ghost" onClick={() => onCreatingChange(false)}>
								取消
							</button>
							<button type="button" className="w-btn-amber" disabled={createTitle.trim() === ""} onClick={onCreate}>
								添加
							</button>
						</div>
					</div>
				)}
				<button
					type="button"
					className={creating ? "w-new-entry on" : "w-new-entry"}
					title={creating ? "收起新建" : "新建条目"}
					onClick={() => onCreatingChange(!creating)}
				>
					<Lu icon="plus" size={15} className="w-new-entry-plus" /> 新建条目
				</button>
			</div>
		</aside>
	);
}

/** 单个条目分支:条目行 + (未折叠时)子条目块(带竖向引导线);子条目递归渲染。 */
function TreeBranch({
	entry,
	childrenOf,
	visited,
	selId,
	onSelect,
	relCountOf,
	collapsed,
	onToggle,
}: {
	entry: WorldEntryDto;
	childrenOf: ReadonlyMap<string, WorldEntryDto[]>;
	visited: ReadonlySet<string>;
	selId: string | null;
	onSelect: (id: string) => void;
	relCountOf: (id: string) => number;
	collapsed: ReadonlySet<string>;
	onToggle: (id: string) => void;
}) {
	const nextVisited = new Set(visited).add(entry.id);
	const children = (childrenOf.get(entry.id) ?? []).filter((c) => !visited.has(c.id) && c.id !== entry.id);
	const isCollapsed = collapsed.has(entry.id);
	const cls = ["w-node", entry.id === selId ? "active" : "", entry.active ? "" : "off"].filter(Boolean).join(" ");
	const relCount = relCountOf(entry.id);
	return (
		<>
			<div className={cls} data-type={entry.type}>
				{children.length > 0 ? (
					<button
						type="button"
						className={isCollapsed ? "w-node-caret collapsed" : "w-node-caret"}
						title={isCollapsed ? "展开子条目" : "折叠子条目"}
						aria-label={isCollapsed ? "展开子条目" : "折叠子条目"}
						onClick={(e) => {
							e.stopPropagation();
							onToggle(entry.id);
						}}
					>
						<Lu icon="chevron-down" size={12} strokeWidth={1.6} />
					</button>
				) : (
					<span className="w-node-caret-space" />
				)}
				<button
					type="button"
					className="w-node-main"
					title={entry.active ? entry.id : `${entry.id}(未激活)`}
					onClick={() => onSelect(entry.id)}
				>
					<span className="w-node-title">{entry.title || "未命名"}</span>
					{relCount > 0 && <span className="w-node-rel">{relCount}</span>}
					{!entry.active && <IconEyeOff />}
				</button>
			</div>
			{children.length > 0 && !isCollapsed && (
				<div className="w-children">
					{children.map((c) => (
						<TreeBranch
							key={c.id}
							entry={c}
							childrenOf={childrenOf}
							visited={nextVisited}
							selId={selId}
							onSelect={onSelect}
							relCountOf={relCountOf}
							collapsed={collapsed}
							onToggle={onToggle}
						/>
					))}
				</div>
			)}
		</>
	);
}
