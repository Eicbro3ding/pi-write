import type { StyleSampleDto, WorldConstraintDto } from "../types.ts";
import { newId } from "./id.ts";

/** 约束/采样字数上限(与后端 world-data CONSTRAINT_LIMIT / SAMPLE_LIMIT 一致)。 */
export const CONSTRAINT_LIMIT = 800;
export const SAMPLE_LIMIT = 500;

interface ConstraintsPanelProps {
	constraints: WorldConstraintDto[];
	sample: StyleSampleDto | null;
	onConstraints: (next: WorldConstraintDto[]) => void;
	onSample: (next: StyleSampleDto | null) => void;
}

/**
 * 约束面板:约束条目列表(名称/内容/enabled 开关 + 启用数)+ 新建/删除,
 * 行内直接编辑;采样区:styleSample 来源展示 + 手动编辑 + 清空
 * (超 500 字红色提示,保存时后端会拒绝)。整体由页面统一保存。
 */
export function ConstraintsPanel({ constraints, sample, onConstraints, onSample }: ConstraintsPanelProps) {
	const enabledCount = constraints.filter((c) => c.enabled).length;

	function update(i: number, patch: Partial<WorldConstraintDto>) {
		onConstraints(constraints.map((c, j) => (j === i ? { ...c, ...patch } : c)));
	}

	function add() {
		const c: WorldConstraintDto = { id: newId("cst"), name: "新约束", text: "", enabled: true };
		onConstraints([...constraints, c]);
	}

	const sampleOver = sample !== null && sample.text.length > SAMPLE_LIMIT;

	return (
		<section className="w-panel">
			<div className="w-panel-head">
				<span className="s-head">约束</span>
				<span className="w-panel-count">
					启用 {enabledCount} / {constraints.length}
				</span>
				<button type="button" className="btn-ghost w-panel-add" onClick={add}>
					新建约束
				</button>
			</div>
			{constraints.length === 0 && <div className="w-empty">暂无约束</div>}
			{constraints.map((c, i) => (
				<div className="w-cst-row" key={c.id}>
					<input
						className="w-input"
						value={c.name}
						placeholder="约束名称"
						onChange={(e) => update(i, { name: e.target.value })}
					/>
					<input
						className="w-input"
						value={c.text}
						placeholder="约束内容(如: 角色对话要口语化)"
						onChange={(e) => update(i, { text: e.target.value })}
					/>
					<span
						className={c.text.length > CONSTRAINT_LIMIT ? "w-count over" : "w-count"}
						title={c.text.length > CONSTRAINT_LIMIT ? "超限,保存将被拒绝" : "字数上限"}
					>
						{c.text.length} / {CONSTRAINT_LIMIT}
					</span>
					<label className="w-switch" title={c.enabled ? "已启用" : "已停用"}>
						<input
							type="checkbox"
							checked={c.enabled}
							onChange={(e) => update(i, { enabled: e.target.checked })}
						/>
						<span>{c.enabled ? "启用" : "停用"}</span>
					</label>
					<button
						type="button"
						className="w-ibtn danger"
						title="删除约束"
						onClick={() => onConstraints(constraints.filter((_, j) => j !== i))}
					>
						删
					</button>
				</div>
			))}

			<div className="s-head">采样</div>
			<div className="w-panel-note">供模型参考的文风样本;来源由服务端标注</div>
			{sample === null ? (
				<div className="w-empty">未设置采样文本</div>
			) : (
				<>
					<div className="w-sample-src">
						来源: {sample.source || "未知"}
						{sample.updatedAt > 0 ? ` · ${new Date(sample.updatedAt).toLocaleString()}` : ""}
					</div>
					<textarea
						rows={4}
						value={sample.text}
						placeholder="采样文本(正文风格片段,不超过 500 字)"
						onChange={(e) => onSample({ ...sample, text: e.target.value, updatedAt: Date.now() })}
					/>
					<div className={sampleOver ? "w-count over" : "w-count"}>
						{sample.text.length} / {SAMPLE_LIMIT} 字{sampleOver ? "(超限,保存将被拒绝)" : ""}
					</div>
					<div className="w-sample-clear">
						<button type="button" className="btn-ghost danger" onClick={() => onSample(null)}>
							清空采样
						</button>
					</div>
				</>
			)}
		</section>
	);
}
