import { useMemo, useState } from "react";
import type { StageScriptDto } from "../types.ts";

type ScriptTab = "summary" | "beats" | "actors";
const TAB_INDEX: Record<ScriptTab, number> = { summary: 0, beats: 1, actors: 2 };

/**
 * 剧本只读展示(共享):右侧「剧本」面板(StagePanel)与剧本确认预览卡
 * (PreviewBody 的 script 分支)共用——一套渲染,零副本(2026-08-11 抽象)。
 * 内容按类别分标签页(概要 / 节拍 / 演员指令)+ 表格形式;演员指令按角色分块,
 * 中文标签 + 示例逐条成行(标签列窄宽,与概要页的宽标签区分)。
 */
export function ScriptView({ script }: { script: StageScriptDto }) {
	const [tab, setTab] = useState<ScriptTab>("summary");
	/** 演员 id → 角色名(definition.cast 首名;perActor 同键)——仅展示用。 */
	const names = useMemo(() => {
		const m: Record<string, string> = {};
		for (const [actorId, chars] of Object.entries(script.definition.cast)) {
			m[actorId] = chars[0] ?? actorId;
		}
		return m;
	}, [script]);
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
			<div className="s-head">
				剧本 v{script.version} · {script.chapter}
			</div>
			{tab === "summary" && (
				<table className="sc-table">
					<tbody>
						<tr>
							<td className="k">场景意象</td>
							<td>{script.text.shared.setting}</td>
						</tr>
						<tr>
							<td className="k">本幕任务</td>
							<td>{script.text.shared.goal}</td>
						</tr>
						<tr>
							<td className="k">基调</td>
							<td>{script.text.shared.tone}</td>
						</tr>
						<tr>
							<td className="k">规则</td>
							<td>
								{script.definition.rules.minLines}-{script.definition.rules.maxLines} 条 · 收尾窗口 {script.definition.rules.wrapUpWindow}
							</td>
						</tr>
						{script.text.shared.forbidden.length > 0 && (
							<tr>
								<td className="k">禁区</td>
								<td>{script.text.shared.forbidden.map((f) => `· ${f}`).join("\n")}</td>
							</tr>
						)}
					</tbody>
				</table>
			)}
			{tab === "beats" && (
				<table className="sc-table">
					<tbody>
						{script.text.shared.beats.map((b, i) => (
							<tr key={i}>
								<td className="k">{i + 1}</td>
								<td>{b}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{tab === "actors" && (
				<div>
					{Object.entries(script.text.perActor).map(([actorId, a]) => (
						<div key={actorId} className="pa-block">
							<div className="pa-name">{names[actorId] ?? actorId}</div>
							<table className="sc-table">
								<tbody>
									<tr>
										<td className="k">欲望</td>
										<td>{a.objective}</td>
									</tr>
									{a.state && (
										<tr>
											<td className="k">状态</td>
											<td>{a.state}</td>
										</tr>
									)}
									{a.relation && (
										<tr>
											<td className="k">关系</td>
											<td>{a.relation}</td>
										</tr>
									)}
									{a.voice && (
										<tr>
											<td className="k">声口</td>
											<td>{a.voice}</td>
										</tr>
									)}
									{a.boundary && (
										<tr>
											<td className="k">边界</td>
											<td>{a.boundary}</td>
										</tr>
									)}
									{a.examples.length > 0 && (
										<tr>
											<td className="k">示例</td>
											<td className="st-examples">
												{a.examples.map((ex, i) => (
													<div key={i} className="pa-ex">
														{ex}
													</div>
												))}
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>
					))}
				</div>
			)}
		</>
	);
}
