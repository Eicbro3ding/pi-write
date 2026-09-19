import { useRef, useState } from "react";
import type { StyleSampleDto, WorldConstraintDto } from "../types.ts";
import { newId } from "./id.ts";
import { Select } from "./Select.tsx";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { Lu } from "./Lu.tsx";

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
	onConstraints: (next: WorldConstraintDto[]) => void;
}

/**
 * 约束卡片(设计稿 09 右栏):头部 = 标题 + 「启用 N / M」+ ＋(新建);约束行 =
 * 开关 + 名称(无边框输入)+ 作用域胶囊 + 删除,下一行为约束正文(无边框输入 + 字数)。
 * 规则包导入保留在卡片底部(酒馆式规则包:选 JSON 文件导入一组预制规则)。
 * 整体由页面统一保存。
 */
export function ConstraintsPanel({ constraints, onConstraints }: ConstraintsPanelProps) {
	const enabledCount = constraints.filter((c) => c.enabled).length;
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

	return (
		<section className="w-card">
			<div className="w-card-head">
				<span className="w-card-title">约束</span>
				<span className="w-card-ops">
					<span className="w-card-count">
						启用 {enabledCount} / {constraints.length}
					</span>
					<button type="button" className="w-card-iconbtn" title="新建约束" aria-label="新建约束" onClick={add}>
						<Lu icon="plus" size={14} />
					</button>
				</span>
			</div>

			{constraints.length === 0 && <div className="w-card-empty">暂无约束，点右上角 ＋ 新建</div>}
			{constraints.map((c, i) => (
				<div className="w-cst-row" key={c.id}>
					<div className="w-cst-line">
						<ToggleSwitch checked={c.enabled} onChange={(v) => update(i, { enabled: v })} ariaLabel={c.enabled ? "已启用" : "已停用"} />
						<input
							className="w-cst-name"
							value={c.name}
							placeholder="约束名称"
							onChange={(e) => update(i, { name: e.target.value })}
						/>
						<span className="w-cst-scope">
							<Select
								className="sel-pill"
								value={c.target ?? "all"}
								title="生效范围(谁注入这条约束)"
								onChange={(v) => update(i, { target: v as WorldConstraintDto["target"] })}
								options={TARGET_OPTIONS.map((o) => ({ value: o.value!, label: o.label }))}
							/>
						</span>
						<button
							type="button"
							className="w-ibtn danger"
							title="删除约束"
							aria-label="删除约束"
							onClick={() => onConstraints(constraints.filter((_, j) => j !== i))}
						>
							✕
						</button>
					</div>
					<textarea
						className="w-cst-text"
						rows={2}
						value={c.text}
						placeholder="约束内容(如: 角色对话要口语化)"
						onChange={(e) => update(i, { text: e.target.value })}
					/>
					<div className={c.text.length > CONSTRAINT_LIMIT ? "w-count over" : "w-count"}>
						{c.text.length} / {CONSTRAINT_LIMIT}
						{c.text.length > CONSTRAINT_LIMIT ? "(超限,保存将被拒绝)" : ""}
					</div>
				</div>
			))}

			<div className="w-card-foot">
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
				<button type="button" className="btn-ghost w-card-foot-btn" onClick={() => fileRef.current?.click()}>
					导入 JSON 规则包
				</button>
				{packErr && <span className="w-count over">{packErr}</span>}
			</div>
		</section>
	);
}

interface StyleSamplePanelProps {
	sample: StyleSampleDto | null;
	onSample: (next: StyleSampleDto | null) => void;
}

/**
 * 采样卡片(设计稿 09 左栏):文风样本 textarea + 字数(上限 500)+ 清空。
 * 说明文案与旧版一致(供模型参考的文风样本;来源由服务端标注)。
 */
export function StyleSamplePanel({ sample, onSample }: StyleSamplePanelProps) {
	const over = sample !== null && sample.text.length > SAMPLE_LIMIT;
	return (
		<section className="w-card">
			<div className="w-card-head">
				<span className="w-card-title">采样</span>
				<span className="w-card-note">供模型参考</span>
			</div>
			{sample === null ? (
				<div className="w-card-empty">未设置采样文本</div>
			) : (
				<>
					<div className="w-sample-src">
						来源: {sample.source || "未知"}
						{sample.updatedAt > 0 ? ` · ${new Date(sample.updatedAt).toLocaleString()}` : ""}
					</div>
					<textarea
						className="w-sample-text"
						rows={6}
						value={sample.text}
						placeholder="采样文本(正文风格片段,不超过 500 字)"
						onChange={(e) => onSample({ ...sample, text: e.target.value, updatedAt: Date.now() })}
					/>
					<div className="w-sample-foot">
						<button type="button" className="btn-ghost danger w-card-foot-btn" onClick={() => onSample(null)}>
							清空采样
						</button>
						<div className={over ? "w-count over" : "w-count"}>
							{sample.text.length} / {SAMPLE_LIMIT} 字{over ? "(超限,保存将被拒绝)" : ""}
						</div>
					</div>
				</>
			)}
		</section>
	);
}
