import { useMemo, useState, type ReactNode } from "react";
import type { StageScriptDto } from "../types.ts";
import { castNameMap } from "../stage-web.ts";
import { Lu } from "./Lu.tsx";

type ScriptTab = "summary" | "beats" | "actors";
const TAB_INDEX: Record<ScriptTab, number> = { summary: 0, beats: 1, actors: 2 };

/** 字段行右端铅笔(15px 线性图标)。 */
function PenIcon() {
	return (
		<Lu icon="pencil" size={13} />
	);
}

/**
 * 剧本只读展示(共享):右侧「剧本」面板(StagePanel)与剧本确认预览卡
 * (PreviewBody 的 script 分支)共用——一套渲染,零副本(2026-08-11 抽象)。
 *
 * 设计稿 02-模态与面板/02:外层舞台面板已改下划线式,这一层**保留胶囊分段控件**
 * (概要 / 节拍 / 演员指令,两层不再同款,层级看得出区别);内容从表格改成
 * **卡片化字段行**(标签 + 值 + 右端铅笔)。
 *
 * 铅笔是**编辑入口提示,不是就地编辑**:点击落到「修订」页签(整幕修订走提交式
 * 表单,版本 +1)。故用 button + aria-label 表达可达性,不假装有就地编辑。
 */
export function ScriptView({ script, onEdit }: { script: StageScriptDto; onEdit?: () => void }) {
	const [tab, setTab] = useState<ScriptTab>("summary");
	/** 演员 id → 角色名(definition.cast 首名;perActor 同键)——仅展示用。 */
	const names = useMemo(() => castNameMap(script.definition.cast), [script]);
	/** 字段行右端铅笔:onEdit 缺省(预览卡场景,只读)时降级为不可点的纯图标。 */
	const pencil = (label: string) =>
		onEdit ? (
			<button type="button" className="sf-pen" title={`修订「${label}」`} aria-label={`修订${label}`} onClick={onEdit}>
				<PenIcon />
			</button>
		) : (
			<span className="sf-pen quiet" aria-hidden="true">
				<PenIcon />
			</span>
		);
	/** 卡片化字段行(标签 + 值 + 铅笔)。 */
	const row = (label: string, value: ReactNode, key?: string) => (
		<div className="sf-row" key={key ?? label}>
			<span className="sf-k">{label}</span>
			<span className="sf-v">{value}</span>
			{pencil(label)}
		</div>
	);

	return (
		<>
			{/* tabs-equal:标签文案不等长(演员指令 4 字),指示块位移前提是等宽——
			    按钮 flex 均分 + 指示块宽度按 flex 布局重算(styles.css) */}
			<div className="st-tabs tabs-equal" data-active={TAB_INDEX[tab]}>
				<button type="button" className={tab === "summary" ? "st-tab active" : "st-tab"} onClick={() => setTab("summary")}>
					概要
				</button>
				<button type="button" className={tab === "beats" ? "st-tab active" : "st-tab"} onClick={() => setTab("beats")}>
					节拍
				</button>
				<button type="button" className={tab === "actors" ? "st-tab active" : "st-tab"} onClick={() => setTab("actors")}>
					演员指令
				</button>
			</div>

			<div className="sf-card">
				<div className="sf-head">
					剧本 v{script.version} · {script.chapter}
				</div>
				{tab === "summary" && (
					<>
						{row("场景意象", script.text.shared.setting)}
						{row("本幕任务", script.text.shared.goal)}
						{row("基调", script.text.shared.tone)}
						{row(
							"规则",
							`${script.definition.rules.minLines}-${script.definition.rules.maxLines} 条 · 收尾窗口 ${script.definition.rules.wrapUpWindow}`,
						)}
						{script.text.shared.forbidden.length > 0 &&
							row(
								"禁区",
								<span className="sf-list">
									{script.text.shared.forbidden.map((f, i) => (
										<span key={i}>· {f}</span>
									))}
								</span>,
							)}
					</>
				)}
				{tab === "beats" &&
					script.text.shared.beats.map((b, i) => row(String(i + 1), b, `beat-${i}`))}
				{tab === "actors" &&
					Object.entries(script.text.perActor).map(([actorId, a]) => (
						<div key={actorId} className="pa-block">
							<div className="pa-name">{names[actorId] ?? actorId}</div>
							{row("欲望", a.objective)}
							{a.state && row("状态", a.state)}
							{a.relation && row("关系", a.relation)}
							{a.voice && row("声口", a.voice)}
							{a.boundary && row("边界", a.boundary)}
							{a.examples.length > 0 &&
								row(
									"示例",
									<span className="sf-list">
										{a.examples.map((ex, i) => (
											<span key={i} className="pa-ex">
												{ex}
											</span>
										))}
									</span>,
								)}
						</div>
					))}
			</div>
		</>
	);
}
