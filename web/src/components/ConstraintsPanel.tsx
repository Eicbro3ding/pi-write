import { useRef, useState } from "react";
import type { StyleSampleDto, WorldConstraintDto } from "../types.ts";
import { newId } from "./id.ts";

/** 约束/采样字数上限(与后端 world-data CONSTRAINT_LIMIT / SAMPLE_LIMIT 一致)。 */
export const CONSTRAINT_LIMIT = 800;
export const SAMPLE_LIMIT = 500;

/** 约束 target 取值(与后端 ConstraintTarget 一致)。 */
const TARGET_OPTIONS: Array<{ value: WorldConstraintDto["target"] | "all"; label: string }> = [
	{ value: "all", label: "全部 agent" },
	{ value: "main", label: "主会话" },
	{ value: "director", label: "导演" },
	{ value: "writer", label: "编剧" },
];

/** 规则包 JSON 结构(导入文件的解析目标)。 */
type RulePackJson = { name?: string; rules?: Array<{ name: string; text: string; target?: WorldConstraintDto["target"] }> };

interface ConstraintsPanelProps {
	constraints: WorldConstraintDto[];
	sample: StyleSampleDto | null;
	onConstraints: (next: WorldConstraintDto[]) => void;
	onSample: (next: StyleSampleDto | null) => void;
}

/**
 * 约束面板(2026-08-12 酒馆式规则包):约束条目列表(名称/内容/enabled 开关/
 * target 生效范围 + 启用数)+ 新建/删除 + 规则包导入(内置预制包,2026-08-12 起
 * 不再提供 JSON 大文本框)+ 采样区。点击面板头可折叠/展开;整体由页面统一保存。
 */
export function ConstraintsPanel({ constraints, sample, onConstraints, onSample }: ConstraintsPanelProps) {
	const enabledCount = constraints.filter((c) => c.enabled).length;
	/** 折叠态:点击面板头切换(新建约束按钮不触发展开)。 */
	const [collapsed, setCollapsed] = useState(false);
	/** 规则包导入提示(去重/解析失败等)。 */
	const [packErr, setPackErr] = useState<string | null>(null);
	/** 隐藏文件选择器(「导入 JSON 规则包」按钮触发,系统原生选择器选 .json)。 */
	const fileRef = useRef<HTMLInputElement>(null);

	function update(i: number, patch: Partial<WorldConstraintDto>) {
		onConstraints(constraints.map((c, j) => (j === i ? { ...c, ...patch } : c)));
	}

	function add() {
		const c: WorldConstraintDto = { id: newId("cst"), name: "新约束", text: "", enabled: true };
		onConstraints([...constraints, c]);
	}

	/** 批量导入规则(去重:同 name 已存在则跳过)。 */
	function importRules(rules: Array<{ name: string; text: string; target?: WorldConstraintDto["target"] }>) {
		const existing = new Set(constraints.map((c) => c.name));
		const fresh = rules.filter((r) => !existing.has(r.name));
		if (fresh.length === 0) {
			setPackErr("没有新规则(同名规则已存在)");
			return;
		}
		onConstraints([
			...constraints,
			...fresh.map((r) => ({ id: newId("cst"), name: r.name, text: r.text, enabled: true, ...(r.target ? { target: r.target } : {}) })),
		]);
		setPackErr(null);
	}

	/** 系统文件选择器选中的 .json → 解析规则包导入。 */
	function importJsonFile(file: File) {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const parsed = JSON.parse(String(reader.result)) as RulePackJson;
				const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
				if (rules.length === 0) {
					setPackErr("JSON 需要 { name, rules: [{name, text, target?}] } 结构");
					return;
				}
				importRules(rules);
			} catch (e) {
				setPackErr(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		reader.readAsText(file);
	}

	const sampleOver = sample !== null && sample.text.length > SAMPLE_LIMIT;

	return (
		<section className="w-panel">
			<div
				className={collapsed ? "w-panel-head collapsible collapsed" : "w-panel-head collapsible"}
				title={collapsed ? "展开约束面板" : "折叠约束面板"}
				onClick={() => setCollapsed((v) => !v)}
			>
				<span className="s-head">约束</span>
				<span className="w-panel-count">
					启用 {enabledCount} / {constraints.length}
				</span>
				<button type="button" className="btn-ghost w-panel-add" onClick={(e) => { e.stopPropagation(); add(); }}>
					新建约束
				</button>
			</div>
			{!collapsed && (
				<>
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
							{/* 生效范围(谁注入这条约束) */}
							<select
								className="w-input"
								value={c.target ?? "all"}
								title="生效范围(谁注入这条约束)"
								onChange={(e) => update(i, { target: e.target.value as WorldConstraintDto["target"] })}
							>
								{TARGET_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
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
								className="btn-ghost danger"
								title="删除约束"
								onClick={() => onConstraints(constraints.filter((_, j) => j !== i))}
							>
								删除
							</button>
						</div>
					))}

					<div className="s-head">导入规则包</div>
					<div className="w-panel-note">酒馆式规则包:选择 JSON 文件导入一组预制规则(导入后可逐条开关/改生效范围)</div>
					<div className="w-pack-btns">
						{/* 隐藏文件框 + 按钮:触发系统原生文件选择器选 .json(2026-08-12) */}
						<input
							ref={fileRef}
							type="file"
							accept=".json,application/json"
							style={{ display: "none" }}
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) importJsonFile(f);
								e.target.value = "";
							}}
						/>
						<button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
							导入 JSON 规则包
						</button>
					</div>
					{packErr && <div className="w-count over">{packErr}</div>}

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
				</>
			)}
		</section>
	);
}
