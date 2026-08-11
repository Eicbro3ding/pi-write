import { useState } from "react";
import type { ScriptPatchDto, StageSnapshotDto } from "../types.ts";
import { buildRevisePatch, emptyReviseForm, type ReviseFormState } from "../stage-web.ts";
import { StageAvatar } from "./StageAvatar.tsx";
import { ScriptView } from "./ScriptView.tsx";

/**
 * 舞台右侧面板:剧本(版本 + shared 全字段 + perActor 折叠块)| 选角(cast 表)|
 * 修订(buildRevisePatch 表单 → /revise)。开演前(script=null)剧本/修订为空态。
 */
export type StagePanelTab = "script" | "cast" | "revise";

/** 剧本/选角/修订 标签索引(滑动指示块定位用)。 */
const TAB_INDEX: Record<StagePanelTab, number> = { script: 0, cast: 1, revise: 2 };

export function StagePanel({
	slug,
	snapshot,
	tab,
	onTab,
	onRevise,
}: {
	slug: string;
	snapshot: StageSnapshotDto | null;
	tab: StagePanelTab;
	onTab(t: StagePanelTab): void;
	onRevise(patch: ScriptPatchDto): void;
}) {
	const script = snapshot?.script ?? null;
	const cast = snapshot?.cast ?? null;
	/** 本幕选角来源:开演中 = snapshot.script;待确认 = pendingScript.script
	 *  (选角页据此显示角色名,而非只显示裸槽位 actor-1/2/3/4)。 */
	const activeScript = script ?? snapshot?.pendingScript?.script ?? null;
	/** 标签切换方向(内容滑入跟随分段控件指示器:向右切从右滑入,向左切从左滑入)。 */
	const [dir, setDir] = useState<"left" | "right">("right");
	/** 修订表单(提交后清空——patch 只含非空字段,不清空会把旧值反复带上)。 */
	const [form, setForm] = useState<ReviseFormState>(emptyReviseForm);

	function selectTab(t: StagePanelTab) {
		if (t !== tab) setDir(TAB_INDEX[t] > TAB_INDEX[tab] ? "right" : "left");
		onTab(t);
	}

	/** 剧本定义段:演员 id → 角色名(修订表单演员下拉用;perActor 同键)。 */
	const castNames: Record<string, string> = {};
	if (script) {
		for (const [actorId, chars] of Object.entries(script.definition.cast)) {
			castNames[actorId] = chars[0] ?? actorId;
		}
	}

	function submit() {
		onRevise(buildRevisePatch(form));
		setForm(emptyReviseForm());
	}

	return (
		<>
			<div className="st-tabs" data-active={TAB_INDEX[tab]}>
				<button type="button" className={tab === "script" ? "st-tab active" : "st-tab"} onClick={() => selectTab("script")}>
					剧本
				</button>
				<button type="button" className={tab === "cast" ? "st-tab active" : "st-tab"} onClick={() => selectTab("cast")}>
					选角
				</button>
				<button type="button" className={tab === "revise" ? "st-tab active" : "st-tab"} onClick={() => selectTab("revise")}>
					修订
				</button>
			</div>
			{/* 标签内容按 tab key 重挂载;方向跟随指示器(slide-left = 指示块向左滑,
			   内容从左滑入;缺省向右滑入),触发 st-panel-anim 的卡片级滑入动画 */}
				<div className="st-panel-scroll">
					<div key={tab} className={dir === "left" ? "st-panel-anim slide-left" : "st-panel-anim"}>
					{tab === "script" &&
						(script ? (
							<ScriptView script={script} />
						) : (
							<div className="st-empty">
							还没有剧本。
							<br />
							讨论到火候后示意「写剧本」,导演会用 stage_script 工具开演。
						</div>
					))}

				{tab === "cast" &&
					(cast && cast.actors.length > 0 ? (
						<>
							<div className="s-head">演员池(cast.json v{cast.version})</div>
							{cast.actors.map((a) => {
								// 本幕选角优先:actor-1 → 沈昭;无选角时退回槽位 id
								const assigned = activeScript?.definition.cast[a.id]?.[0];
								const name = assigned ?? a.character ?? a.id;
								return (
									<div key={a.id} className="st-cast-row">
										<StageAvatar slug={slug} name={name} narrator={a.type === "narrator"} size="sm" />
										<span className="st-cast-name">{name}</span>
										<span className="st-cast-meta">
											{a.id} · {a.type}
										</span>
										<span className="st-cast-role">
											{a.model ?? "缺省模型"}
											{a.thinking ? ` · ${a.thinking}` : ""}
										</span>
									</div>
								);
							})}
						</>
					) : (
						<div className="st-empty">导演尚未编制演员池(讨论期导演会用工具维护 cast.json)</div>
					))}

				{tab === "revise" &&
					(script ? (
						<div className="st-revise-form">
							<div className="s-head">修订剧本(下一轮生效,版本 +1)</div>
							<label>
								场景意象
								<input value={form.setting} onChange={(e) => setForm({ ...form, setting: e.target.value })} />
							</label>
							<label>
								本幕任务
								<input value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
							</label>
							<label>
								基调
								<input value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} />
							</label>
							<label>
								节拍(每行一拍)
								<textarea value={form.beats} onChange={(e) => setForm({ ...form, beats: e.target.value })} />
							</label>
							<label>
								禁区(每行一条)
								<textarea value={form.forbidden} onChange={(e) => setForm({ ...form, forbidden: e.target.value })} />
							</label>
							<div className="st-revise-rules">
								<label>
									下限条数
									<input
										type="number"
										value={form.minLines}
										onChange={(e) => setForm({ ...form, minLines: e.target.value })}
									/>
								</label>
								<label>
									上限条数
									<input
										type="number"
										value={form.maxLines}
										onChange={(e) => setForm({ ...form, maxLines: e.target.value })}
									/>
								</label>
							</div>
							<div className="s-head">演员指令</div>
							<label>
								演员
								<select value={form.actorId} onChange={(e) => setForm({ ...form, actorId: e.target.value })}>
									<option value="">(不改演员指令)</option>
									{Object.entries(castNames).map(([actorId, name]) => (
										<option key={actorId} value={actorId}>
											{name}
										</option>
									))}
								</select>
							</label>
							<label>
								objective(本幕欲望)
								<input value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} />
							</label>
							<label>
								boundary(演出边界)
								<input value={form.boundary} onChange={(e) => setForm({ ...form, boundary: e.target.value })} />
							</label>
							<label>
								voice(说话方式)
								<input value={form.voice} onChange={(e) => setForm({ ...form, voice: e.target.value })} />
							</label>
							<button type="button" className="btn st-submit" onClick={submit}>
								提交修订
							</button>
						</div>
						) : (
							<div className="st-empty">开演后才可修订(修订 = 下一轮生效,版本 +1)</div>
						))}
				</div>
			</div>
		</>
	);
}
