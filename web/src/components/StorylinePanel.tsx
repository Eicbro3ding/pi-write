import { useState } from "react";
import type { StoryNodeDto, StorylineDto } from "../types.ts";
import { newId } from "./id.ts";
import { Select } from "./Select.tsx";
import { Lu } from "./Lu.tsx";

/** 发展线节点状态选项(与后端 world-data STORY_STATUSES 对齐)。 */
const STORY_STATUS_OPTIONS: ReadonlyArray<{ value: StoryNodeDto["status"]; label: string }> = [
	{ value: "pending", label: "待办" },
	{ value: "in-progress", label: "进行中" },
	{ value: "done", label: "完成" },
	{ value: "shelved", label: "搁置" },
];

interface StorylinePanelProps {
	storyline: StorylineDto;
	onChange: (next: StorylineDto) => void;
}

/** 小图标按钮(上移/下移/删除)。 */
function IconBtn({ label, disabled, danger, onClick, children }: { label: string; disabled?: boolean; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			className={danger ? "w-ibtn danger" : "w-ibtn"}
			disabled={disabled}
			title={label}
			aria-label={label}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

/**
 * 发展线卡片(设计稿 09 左栏):节点行 = 序号 + 标题 + 状态胶囊 + 上移/下移/删除,
 * 次级行 = 目标 / 下一步;头部右上角为节点数与「＋ 新节点」(点击展开内联新增行)。
 * 置为「进行中」时其余进行中节点自动降为「待办」(后端限制至多一个 in-progress)。
 * 整体由页面统一保存。
 */
export function StorylinePanel({ storyline, onChange }: StorylinePanelProps) {
	const [newTitle, setNewTitle] = useState("");
	const [adding, setAdding] = useState(false);
	const nodes = storyline.nodes;
	const setNodes = (next: StoryNodeDto[]) => onChange({ ...storyline, nodes: next });

	function update(i: number, patch: Partial<StoryNodeDto>) {
		setNodes(nodes.map((n, j) => (j === i ? { ...n, ...patch } : n)));
	}

	function setStatus(i: number, status: StoryNodeDto["status"]) {
		setNodes(
			nodes.map((n, j) =>
				j === i
					? { ...n, status }
					: status === "in-progress" && n.status === "in-progress"
						? { ...n, status: "pending" }
						: n,
			),
		);
	}

	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= nodes.length) return;
		const next = [...nodes];
		[next[i]!, next[j]!] = [next[j]!, next[i]!];
		setNodes(next);
	}

	function add() {
		const title = newTitle.trim();
		if (!title) return;
		const node: StoryNodeDto = { id: newId("story"), title, status: "pending", goal: "", next: null };
		setNodes([...nodes, node]);
		setNewTitle("");
		setAdding(false);
	}

	return (
		<section className="w-card">
			<div className="w-card-head">
				<span className="w-card-title">发展线</span>
				<span className="w-card-note">至多一个进行中</span>
				<span className="w-card-ops">
					<span className="w-card-count">{nodes.length} 个节点</span>
					<button type="button" className="w-card-add" onClick={() => setAdding((v) => !v)}>
						<Lu icon="plus" size={14} /> 新节点
					</button>
				</span>
			</div>

			{nodes.length === 0 && !adding && <div className="w-card-empty">暂无节点，点右上角「＋ 新节点」新增</div>}
			{nodes.map((n, i) => (
				<div className="w-story" key={n.id}>
					<div className="w-story-row">
						<span className="w-story-no">{String(i + 1).padStart(2, "0")}</span>
						<input
							className="w-story-title"
							value={n.title}
							placeholder="节点标题"
							onChange={(e) => update(i, { title: e.target.value })}
						/>
						<span className="w-story-status" data-status={n.status}>
							<Select
								className="sel-pill"
								value={n.status}
								onChange={(v) => setStatus(i, v as StoryNodeDto["status"])}
								title="推进状态"
								options={STORY_STATUS_OPTIONS}
							/>
						</span>
						<span className="w-ibtn-row">
							<IconBtn label="上移" disabled={i === 0} onClick={() => move(i, -1)}>
								↑
							</IconBtn>
							<IconBtn label="下移" disabled={i === nodes.length - 1} onClick={() => move(i, 1)}>
								↓
							</IconBtn>
							<IconBtn label="删除节点" danger onClick={() => setNodes(nodes.filter((_, j) => j !== i))}>
								✕
							</IconBtn>
						</span>
					</div>
					<div className="w-story-sub">
						<label className="w-sub-field">
							<span className="w-sub-label">目标</span>
							<input value={n.goal} placeholder="这一节要推进到什么" onChange={(e) => update(i, { goal: e.target.value })} />
						</label>
						<label className="w-sub-field">
							<span className="w-sub-label">下一步</span>
							<input
								value={n.next ?? ""}
								placeholder="该节点完成后的剧情走向(不是节点编号)"
								onChange={(e) => update(i, { next: e.target.value.trim() === "" ? null : e.target.value })}
							/>
						</label>
					</div>
				</div>
			))}

			{adding && (
				<div className="w-card-form">
					<input
						autoFocus
						value={newTitle}
						placeholder="新节点标题"
						onKeyDown={(e) => {
							if (e.key === "Enter") add();
							if (e.key === "Escape") setAdding(false);
						}}
						onChange={(e) => setNewTitle(e.target.value)}
					/>
					<button type="button" className="w-btn-ghost" onClick={() => setAdding(false)}>
						取消
					</button>
					<button type="button" className="w-btn-amber" disabled={newTitle.trim() === ""} onClick={add}>
						新增节点
					</button>
				</div>
			)}
		</section>
	);
}
