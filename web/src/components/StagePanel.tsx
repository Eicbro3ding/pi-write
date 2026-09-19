import { useState, type ReactNode } from "react";
import type { ApiClient } from "../api/client.ts";
import type { ScriptPatchDto, StageSnapshotDto } from "../types.ts";
import { buildRevisePatch, castNameMap, emptyReviseForm, type ReviseFormState } from "../stage-web.ts";
import { NoticeBoard } from "./NoticeBoard.tsx";
import { Lu } from "./Lu.tsx";
import { StageAvatar } from "./StageAvatar.tsx";
import { ScriptView } from "./ScriptView.tsx";
import { ReviseScriptModal } from "./ReviseScriptModal.tsx";

/**
 * 舞台右侧面板(设计稿 01-主流程/04 右栏 + 02-模态与面板/02):
 * 剧本(内层胶囊 概要/节拍/演员指令)| 选角(演员池)| 修订(提交式入口 + 最近一次修订)|
 * 备忘录(待办清单)。
 *
 * 层级(2026 设计稿 02 的核心改动):现状是「外层胶囊 + 内层胶囊」两层同款 tab 控件,
 * 视觉分不清层级。现在**外层改为图标 + 下划线式**(琥珀色 + 2px 下划线,右上角收起钮),
 * **内层保留胶囊**(ScriptView 的 概要/节拍/演员指令)。
 *
 * 修订表单的 11 个字段与提交逻辑(buildRevisePatch)原样保留,但搬到 860px 模态
 * (ReviseScriptModal)里两栏摆放——320px 侧栏塞不下。
 */
export type StagePanelTab = "script" | "cast" | "revise" | "memo";

/** 页签顺序(内容滑入方向按它比较)。 */
const TAB_ORDER: readonly StagePanelTab[] = ["script", "cast", "revise", "memo"];
/** 页签索引(滑动指示块定位用)。 */
const TAB_INDEX: Record<StagePanelTab, number> = { script: 0, cast: 1, revise: 2, memo: 3 };

/** 页签图标(15px 线性;当前项随文字一起变琥珀色——currentColor)。 */
const TAB_ICONS: Record<StagePanelTab, ReactNode> = {
	// 剧本:文稿  选角:人物  修订:铅笔  备忘录:便签(设计稿里的 lucide 图标名)
	script: <Lu icon="file-text" size={15} className="stp-ico" />,
	cast: <Lu icon="users" size={15} className="stp-ico" />,
	revise: <Lu icon="pencil" size={15} className="stp-ico" />,
	memo: <Lu icon="sticky-note" size={15} className="stp-ico" />,
};

const TAB_LABELS: Record<StagePanelTab, string> = { script: "剧本", cast: "选角", revise: "修订", memo: "备忘录" };

export function StagePanel({
	client,
	slug,
	snapshot,
	tab,
	onTab,
	onRevise,
	collapsed = false,
	onToggleCollapse,
	busy = false,
}: {
	client: ApiClient;
	slug: string;
	snapshot: StageSnapshotDto | null;
	tab: StagePanelTab;
	onTab(t: StagePanelTab): void;
	onRevise(patch: ScriptPatchDto): void;
	/** 面板收起态(48px 竖条;收起时只渲染竖条,页签/内容都不挂载)。 */
	collapsed?: boolean;
	onToggleCollapse(): void;
	/** 长命令进行中(修订提交按钮禁用)。 */
	busy?: boolean;
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
	/** 修订模态开关(表单仍在,只有该模态打开时才渲染 860px 窗口)。 */
	const [reviseOpen, setReviseOpen] = useState(false);
	/** 备忘录条数(NoticeBoard 上报「添加/删除」后的条目数,头部说明行用)。 */
	const [memoCount, setMemoCount] = useState<number | null>(null);

	function selectTab(t: StagePanelTab) {
		// 交互约定(设计稿「再点一次已选中的项 = 执行它的第二动作」):
		// 当前页签再点一次 = 收起面板;切到别的页签才换内容。省掉面板上的收起钮依赖
		if (t === tab) {
			onToggleCollapse();
			return;
		}
		setDir(TAB_INDEX[t] > TAB_INDEX[tab] ? "right" : "left");
		onTab(t);
	}

	/** 剧本定义段:演员 id → 角色名(修订表单演员下拉用;perActor 同键)。 */
	const castNames: Record<string, string> = script ? castNameMap(script.definition.cast) : {};

	/** 提交修订(buildRevisePatch 只含非空字段)→ 清空表单 + 关窗。 */
	function submit() {
		onRevise(buildRevisePatch(form));
		setForm(emptyReviseForm());
		setReviseOpen(false);
	}

	/**
	 * 收起态:整栏收成 48px 的**图标栏**(设计稿 04 右缘):四个页签变成
	 * 「图标 + 小标签」的竖排按钮,当前项带琥珀圆角底。
	 *
	 * 交互沿用设计稿的「再点一次已选中的项 = 第二动作」:点别的页签只换选中
	 * (栏仍是收起的,不打断阅读),点当前页签才展开。
	 */
	if (collapsed) {
		return (
			<div className="stp-rail" role="tablist" aria-label="舞台面板(已收起)">
				{TAB_ORDER.map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						className={tab === t ? "stp-rail-item active" : "stp-rail-item"}
						title={tab === t ? `展开${TAB_LABELS[t]}` : TAB_LABELS[t]}
						aria-label={tab === t ? `展开${TAB_LABELS[t]}` : TAB_LABELS[t]}
						onClick={() => selectTab(t)}
					>
						{TAB_ICONS[t]}
						<span className="stp-rail-label">{TAB_LABELS[t]}</span>
					</button>
				))}
			</div>
		);
	}

	return (
		<>
			{/* 外层页签:图标 + 下划线式(当前项琥珀色 + 2px 下划线);右上角收起钮 */}
			<div className="stp-head" role="tablist" aria-label="舞台面板">
				{TAB_ORDER.map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						className={tab === t ? "stp-tab active" : "stp-tab"}
						onClick={() => selectTab(t)}
					>
						{TAB_ICONS[t]}
						<span>{TAB_LABELS[t]}</span>
					</button>
				))}
				<span className="stp-head-spacer" />
				<button type="button" className="companion-collapse" onClick={onToggleCollapse} title="收起舞台面板" aria-label="收起舞台面板">
					<Lu icon="chevrons-right" size={14} />
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
								讨论到火候后示意「写剧本」,导演就会开演。
							</div>
						))}

					{tab === "cast" &&
						(cast && cast.actors.length > 0 ? (
							<>
								<div className="stp-cap">演员池 · cast.json v{cast.version}</div>
								{cast.actors.map((a) => {
									// 本幕选角优先:actor-1 → 沈昭;无选角时退回槽位 id
									const assigned = activeScript?.definition.cast[a.id]?.[0];
									const name = assigned ?? a.character ?? a.id;
									return (
										<div key={a.id} className="st-cast-row">
											<StageAvatar slug={slug} name={name} narrator={a.type === "narrator"} />
											<div className="st-cast-main">
												<span className="st-cast-name">{name}</span>
												{/* 槽位 id + 模型(mono 小字)——设计稿:两行式,模型下沉到名字下面 */}
												<span className="st-cast-meta">
													{a.id}
													{a.model ? ` · ${a.model}` : ""}
													{a.thinking ? ` · ${a.thinking}` : ""}
												</span>
											</div>
											<span className="stp-pill">{a.type === "named" ? "角色" : a.type === "pool" ? "群演" : "旁白"}</span>
										</div>
									);
								})}
								<div className="stp-foot-note">模型可选个演员覆盖;缺省则跟「设置 → 模型」。</div>
							</>
						) : (
							<div className="st-empty">导演尚未编制演员池(讨论期导演会用工具维护 cast.json)</div>
						))}

					{tab === "revise" &&
						(script ? (
							<div className="stp-revise">
								<p className="stp-note">修订是提交式表单——改完点提交,下一轮生效、版本 +1。它有 11 个字段,塞在 320px 的侧栏里要两三屏,所以独立成一个窗口。</p>
								<button type="button" className="btn primary stp-revise-btn" disabled={busy} onClick={() => setReviseOpen(true)}>
									✎ 修订剧本…
								</button>
								<div className="stp-card">
									<div className="stp-card-label">最近一次修订</div>
									{script.previous ? (
										<>
											{/* 只展示磁盘上确有的数据:v{过去版本} → v{当前版本} + 时间。
											    不编造「改了什么」——previous 只存上一版文本/规则快照,
											    StageScriptDto 没有提交说明字段(stage-store.ts) */}
											<div className="stp-card-ver">
												v{script.previous.version} → v{script.version}
											</div>
											<div className="stp-card-text">
												<span>上一版:条数 {script.previous.rules.minLines}-{script.previous.rules.maxLines} · 收尾窗口 {script.previous.rules.wrapUpWindow}</span>
												<span>现行:条数 {script.definition.rules.minLines}-{script.definition.rules.maxLines} · 收尾窗口 {script.definition.rules.wrapUpWindow}</span>
											</div>
											<div className="stp-card-foot">
												<span>{relativeTime(script.previous.at)}</span>
												<span className="stp-card-ok">· 已生效</span>
											</div>
										</>
									) : (
										<div className="stp-card-text">本幕还没有修订记录——提交第一次修订后在这里留档。</div>
									)}
								</div>
							</div>
						) : (
							<div className="st-empty">开演后才可修订(修订 = 下一轮生效,版本 +1)</div>
						))}

					{tab === "memo" && (
						<>
							<div className="stp-cap">备忘录{memoCount !== null ? ` · ${memoCount} 条` : ""}　未完成项会注入所有 agent</div>
							<NoticeBoard client={client} slug={slug} variant="minimal" onItemsChange={(items) => setMemoCount(items.length)} />
							<div className="stp-foot-note">勾选即完成,已完成项不再注入上下文。</div>
						</>
					)}
				</div>
			</div>

			{/* 修订模态:860px 独立窗口(设计稿 02-模态与面板/01) */}
			{reviseOpen && script && (
				<ReviseScriptModal
					script={script}
					castNames={castNames}
					form={form}
					busy={busy}
					onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
					onSubmit={submit}
					onClose={() => setReviseOpen(false)}
				/>
			)}
		</>
	);
}

/** 「最近一次修订」时间戳 → 「12 分钟前」(只到分钟/小时/天,超过 7 天显示日期)。 */
function relativeTime(at: number): string {
	const diff = Date.now() - at;
	if (!Number.isFinite(diff) || diff < 0) return "刚刚";
	const min = Math.floor(diff / 60000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour} 小时前`;
	const day = Math.floor(hour / 24);
	if (day <= 7) return `${day} 天前`;
	const d = new Date(at);
	return `${d.getMonth() + 1}/${d.getDate()}`;
}
