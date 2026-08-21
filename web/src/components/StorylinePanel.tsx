import { useState } from "react";
import type { StoryNodeDto, StorylineDto } from "../types.ts";
import { newId } from "./id.ts";

/** 发展线节点状态选项(与后端 world-data STORY_STATUSES 对齐)。 */
const STORY_STATUS_OPTIONS: ReadonlyArray<{ value: StoryNodeDto["status"]; label: string }> = [
	{ value: "pending", label: "待办" },
	{ value: "in-progress", label: "进行中" },
	{ value: "done", label: "完成" },
	{ value: "shelved", label: "搁置" },
];

const STATUS_LABEL: Record<StoryNodeDto["status"], string> = {
	pending: "待办",
	"in-progress": "进行中",
	done: "完成",
	shelved: "搁置",
};

interface StorylinePanelProps {
	storyline: StorylineDto;
	onChange: (next: StorylineDto) => void;
}

/**
 * 发展线面板:节点列表(状态徽标)+ 状态下拉 + goal/next 编辑 +
 * 新增节点 + 上移/下移/删除。置为「进行中」时其余进行中节点自动降为
 * 「待办」(后端限制至多一个 in-progress)。整体由页面统一保存。
 */
export function StorylinePanel({ storyline, onChange }: StorylinePanelProps) {
	const [newTitle, setNewTitle] = useState("");
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
	}

	return (
		<section className="w-panel">
			<div className="s-head">发展线</div>
			<div className="w-panel-note">节点按序推进故事；「进行中」节点至多一个</div>
			{nodes.length === 0 && <div className="w-empty">暂无节点，在下方新增</div>}
			{nodes.map((n, i) => (
				<div className="w-story" key={n.id}>
					<span className={`w-badge ${n.status}`}>{STATUS_LABEL[n.status]}</span>
					<input
						className="w-input"
						value={n.title}
						placeholder="节点标题"
						onChange={(e) => update(i, { title: e.target.value })}
					/>
					<select
						className="w-input w-select"
						value={n.status}
						onChange={(e) => setStatus(i, e.target.value as StoryNodeDto["status"])}
					>
						{STORY_STATUS_OPTIONS.map((s) => (
							<option key={s.value} value={s.value}>
								{s.label}
							</option>
						))}
					</select>
					<input
						className="w-input"
						value={n.goal}
						placeholder="目标 goal"
						onChange={(e) => update(i, { goal: e.target.value })}
					/>
					<input
						className="w-input"
						value={n.next ?? ""}
						placeholder="下一步(该节点完成后的剧情走向，而非节点编号)"
						onChange={(e) => update(i, { next: e.target.value.trim() === "" ? null : e.target.value })}
					/>
					<span className="w-ibtn-row">
						<button type="button" className="w-ibtn" disabled={i === 0} title="上移" aria-label="上移" onClick={() => move(i, -1)}>
							↑
						</button>
						<button
							type="button"
							className="w-ibtn"
							disabled={i === nodes.length - 1}
							title="下移" aria-label="下移"
							onClick={() => move(i, 1)}
						>
							↓
						</button>
						<button type="button" className="w-ibtn danger" title="删除节点" aria-label="删除节点" onClick={() => setNodes(nodes.filter((_, j) => j !== i))}>
							删
						</button>
					</span>
				</div>
			))}
			<div className="w-story-add">
				<input
					className="w-input"
					value={newTitle}
					placeholder="新节点标题"
					onKeyDown={(e) => {
						if (e.key === "Enter") add();
					}}
					onChange={(e) => setNewTitle(e.target.value)}
				/>
				<button type="button" className="btn-ghost" disabled={newTitle.trim() === ""} onClick={add}>
					新增节点
				</button>
			</div>
		</section>
	);
}
