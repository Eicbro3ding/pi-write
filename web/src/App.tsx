import { useMemo, useState } from "react";
import { ApiClient } from "./api/client.ts";
import { useLibrary } from "./library.ts";
import { IconEdit, IconGear, IconGlobe, IconStage } from "./components/Icons.tsx";
import { WritePage, type HeaderInfo } from "./pages/WritePage.tsx";
import { StagePage } from "./pages/StagePage.tsx";
import { WorldPage } from "./pages/WorldPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import {
	autoConfirmEditsEnabled,
	autoExpandThinkingEnabled,
	setAutoConfirmEdits as persistAutoConfirmEdits,
	setAutoExpandThinking as persistAutoExpandThinking,
	setSimplifiedTools as persistSimplifiedTools,
	simplifiedToolsEnabled,
} from "./settings.ts";

/** 顶层视图:舞台(默认,导演讨论室/演出现场)| 编辑(正文 + 编剧)| 世界书 | 设置。 */
type View = "stage" | "edit" | "world" | "settings";

/** 顶栏保存状态 → 图标与颜色 class(文案来自 WritePage 上报的 SAVE_LABELS)。 */
const SAVE_STYLE: Record<string, { icon: string; cls: string }> = {
	"已保存": { icon: "✓", cls: "ok" },
	"未保存": { icon: "●", cls: "dirty" },
	"保存中": { icon: "…", cls: "busy" },
	"保存失败": { icon: "!", cls: "err" },
	"加载中": { icon: "", cls: "loading" },
};

export function App() {
	const client = useMemo(() => new ApiClient(), []);
	const [view, setView] = useState<View>("stage");
	const [header, setHeader] = useState<HeaderInfo | null>(null);
	/** 简化输出(隐藏工具卡片),缺省开启;切换经设置页持久化并同步 state。 */
	const [simplifiedTools, setSimplifiedToolsState] = useState<boolean>(() => simplifiedToolsEnabled());
	const setSimplifiedTools = (v: boolean) => {
		persistSimplifiedTools(v);
		setSimplifiedToolsState(v);
	};
	/** 当前打开的书 slug(由书库状态上报;世界书页据此判断有无会话并加载世界书)。 */
	const [currentSlug, setCurrentSlug] = useState<string | null>(null);
	/** 书库状态唯一真相源:舞台页与编辑页共用,书库栏两页常驻且状态同步。 */
	const library = useLibrary(client, setCurrentSlug);
	/** 自动展开思考(思考块默认展开),缺省开启;切换经设置页持久化。 */
	const [autoExpandThinking, setAutoExpandThinkingState] = useState<boolean>(() => autoExpandThinkingEnabled());
	const setAutoExpandThinking = (v: boolean) => {
		persistAutoExpandThinking(v);
		setAutoExpandThinkingState(v);
	};
	/** 编辑免确认(编剧编辑落盘即归档),缺省关闭;切换经设置页持久化。 */
	const [autoConfirmEdits, setAutoConfirmEditsState] = useState<boolean>(() => autoConfirmEditsEnabled());
	const setAutoConfirmEdits = (v: boolean) => {
		persistAutoConfirmEdits(v);
		setAutoConfirmEditsState(v);
	};
	return (
		<div className="app">
			<header className="topbar">
				<div className="brand">
					pi<i>·writer</i>
				</div>
				<div className="book">
					{header
						? `《${header.bookTitle}》${header.bookSlug ? ` · ${header.bookSlug}` : ""}${header.chapterTitle ? ` · ${header.chapterTitle}` : ""}`
						: "《未命名》"}
				</div>
				<div className="right">
					{header ? (
						<span className={!header.connected ? "stat err" : `stat ${SAVE_STYLE[header.save]?.cls ?? ""}`}>
							{header.connected ? (
								<>
									{/* 保存状态文案变化时柔和淡入;字数数字保持静态,避免逐字闪烁 */}
									<span className={`stat-icon ${SAVE_STYLE[header.save]?.cls ?? ""}`}>
										{SAVE_STYLE[header.save]?.icon ?? ""}
									</span>
									<span key={header.save} style={{ transition: "opacity 140ms" }}>
										{header.save}
									</span>
									<span> · {header.words} 字</span>
								</>
							) : (
								"连接失败"
							)}
						</span>
					) : (
						<span className="stat">未连接</span>
					)}
					<span className="top-divider" />
					<button
						type="button"
						className={view === "stage" ? "top-entry active" : "top-entry"}
						onClick={() => setView(view === "stage" ? "edit" : "stage")}
					>
						<IconStage size={15} />
						<span className="top-entry-label">舞台</span>
					</button>
					<button
						type="button"
						className={view === "edit" ? "top-entry active" : "top-entry"}
						onClick={() => setView(view === "edit" ? "stage" : "edit")}
					>
						<IconEdit size={15} />
						<span className="top-entry-label">编辑</span>
					</button>
					<button
						type="button"
						className={view === "world" ? "top-entry active" : "top-entry"}
						onClick={() => setView(view === "world" ? "edit" : "world")}
					>
						<IconGlobe size={15} />
						<span className="top-entry-label">世界书</span>
					</button>
					<button
						type="button"
						className={view === "settings" ? "top-entry active" : "top-entry"}
						onClick={() => setView(view === "settings" ? "edit" : "settings")}
					>
						<IconGear size={15} />
						<span className="top-entry-label">设置</span>
					</button>
				</div>
			</header>
			<div className="main">
				{/* 四页常驻挂载,切换只改 hidden:写作/会话/舞台的流式状态不能随卸载丢失
				    (流式增量只在客户端,卸载后重水合会丢未完成消息);隐藏页不再重播
				    入场动画,换取状态连续性 */}
				<section className={`view ${view === "stage" ? "" : "hidden"}`}>
					<StagePage client={client} library={library} active={view === "stage"} onGoEdit={() => setView("edit")} simplifiedTools={simplifiedTools} />
				</section>
					<section className={`view ${view === "edit" ? "" : "hidden"}`}>
						<WritePage
							client={client}
							library={library}
							onHeader={setHeader}
							simplifiedTools={simplifiedTools}
							autoConfirmEdits={autoConfirmEdits}
						/>
					</section>
				<section className={`view ${view === "world" ? "" : "hidden"}`}>
					<WorldPage client={client} slug={currentSlug} active={view === "world"} />
				</section>
					<section className={`view ${view === "settings" ? "" : "hidden"}`}>
						<SettingsPage
							client={client}
							simplifiedTools={simplifiedTools}
							onSimplifiedToolsChange={setSimplifiedTools}
							autoExpandThinking={autoExpandThinking}
							onAutoExpandThinkingChange={setAutoExpandThinking}
							autoConfirmEdits={autoConfirmEdits}
							onAutoConfirmEditsChange={setAutoConfirmEdits}
						/>
					</section>
			</div>
		</div>
	);
}
