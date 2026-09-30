/**
 * UI 房(组件陈列室)—— **只在调试模式里可达**(app 顶栏 / 手机抽屉的入口由
 * App.tsx 按 debugMode 决定,见 nav.ts)。
 *
 * 它要解决的问题很朴素:`web/src/components/` 下 40 多个组件散在四个页面里,
 * 想看某个组件的某个状态(空态 / 失败态 / 长内容 / 折叠态)得先把应用点进那个状态,
 * 有些状态还构造不出来(比如「供应商列表加载失败」)。于是:
 *
 * - 每个组件在这里有一格,格子里可以切 2-4 个状态档;
 * - 展项表是**契约**(web/src/uiroom-types.ts + 六个分组文件),`test/uiroom.test.ts`
 *   会扫 `web/src/components/` 的真实文件列表逐个核对:漏掉的组件、登记了却没渲染的展项、
 *   渲染期抛错的状态档,测试全红。所以这一页不会「慢慢烂掉」。
 * - 页头三个工具:搜索(id / 标题 / 模块 / 说明)、分组筛选、尺寸(只改带框格子里的
 *   固定层宽度 —— 媒体查询看的是真实窗口,手机端形态请把窗口缩到 ≤700px 或直接用
 *   devtools 设备模式)。
 *
 * 带框格子(`entry.frame`):`.dlg-overlay` / `.ask-layer` 这类 `position: fixed`
 * 的层在普通格子里会以视口为包含块,一展开就盖住整页。给格子套一层 `transform`
 * 容器(transformed ancestor 会成为 fixed 子元素的包含块)就能把它关回格子里 ——
 * 与「backdrop-filter 造包含块」是同一个 CSS 机制,这里反过来为我所用。
 */
import { createElement, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import type { Library } from "../library.ts";
import { UIROOM_GROUPS, isLiveModule, uiroomStats, type UIRoomEntry, type UIRoomGroupId, type UIRoomSection, type UIRoomVariant } from "../uiroom-types.ts";
import { ATOMS_ENTRIES, ATOMS_SECTION } from "../uiroom/atoms.tsx";
import { CHAT_ENTRIES, CHAT_SECTION } from "../uiroom/chat.tsx";
import { WORLD_ENTRIES, WORLD_SECTION } from "../uiroom/world.tsx";
import { SETTINGS_ENTRIES, SETTINGS_SECTION } from "../uiroom/settings.tsx";
import { STAGE_ENTRIES, STAGE_SECTION } from "../uiroom/stage.tsx";
import { TOKENS_ENTRIES, TOKENS_SECTION } from "../uiroom/tokens.tsx";
import { UIRoomRuntimeProvider, stubClient, type UIRoomRuntime } from "../uiroom-runtime.tsx";
import { MobileHeader } from "../components/MobileHeader.tsx";
import { Lu } from "../components/Lu.tsx";
import { navItems } from "../nav.ts";
import { useIsPhone } from "../useMediaQuery.ts";

/** 六个分组文件合起来就是完整的展项表(顺序即页面顺序,取自 UIROOM_GROUPS)。 */
const SECTION: UIRoomSection = {
	...ATOMS_SECTION,
	...CHAT_SECTION,
	...WORLD_SECTION,
	...SETTINGS_SECTION,
	...STAGE_SECTION,
	...TOKENS_SECTION,
};

const ALL_ENTRIES: readonly UIRoomEntry[] = [
	...ATOMS_ENTRIES,
	...CHAT_ENTRIES,
	...WORLD_ENTRIES,
	...SETTINGS_ENTRIES,
	...STAGE_ENTRIES,
	...TOKENS_ENTRIES,
];

/** 带框格子的宽度档(只影响固定层演示,不改媒体查询)。 */
type FrameSize = "auto" | "phone" | "tablet";

const FRAME_SIZES: ReadonlyArray<{ id: FrameSize; label: string; width: number | null }> = [
	{ id: "auto", label: "自适应", width: null },
	{ id: "phone", label: "393 手机", width: 393 },
	{ id: "tablet", label: "820 平板", width: 820 },
];

/** 搜索命中:id / 标题 / 模块 / 说明 / 状态档文案都算。 */
function matchesQuery(entry: UIRoomEntry, variants: readonly UIRoomVariant[], q: string): boolean {
	if (!q) return true;
	const hay = [entry.id, entry.title, entry.module, entry.note ?? "", ...entry.symbols, ...variants.map((v) => v.label)].join(" ").toLowerCase();
	return hay.includes(q.toLowerCase());
}

function ExhibitCell({
	entry,
	variants,
	frameSize,
	isolated,
}: {
	entry: UIRoomEntry;
	variants: readonly UIRoomVariant[];
	frameSize: FrameSize;
	isolated: boolean;
}) {
	const [picked, setPicked] = useState(0);
	const current = variants[picked] ?? variants[0];
	const width = entry.frame ? (FRAME_SIZES.find((s) => s.id === frameSize)?.width ?? null) : null;
	return (
		<article className="uiroom-cell" id={`exhibit-${entry.id}`}>
			<header className="uiroom-cell-head">
				<div className="uiroom-cell-title">
					<h3>{entry.title}</h3>
					<code>{entry.id}</code>
				</div>
				<span className="uiroom-cell-module">
					{entry.module}
					{entry.symbols.length > 0 ? ` · ${entry.symbols.join(", ")}` : ""}
				</span>
				{entry.note ? <p className="uiroom-cell-note">{entry.note}</p> : null}
				{/* 只有一个状态档时没有段控件,它的 note 也要有地方显示 */}
				{variants.length <= 1 && current?.note ? <p className="uiroom-cell-note">{current.note}</p> : null}
				{entry.ssrSkip ? <p className="uiroom-cell-skip">SSR 冒烟跳过:{entry.ssrSkip}</p> : null}
				{isLiveModule(entry.module) ? (
					<p className={isolated ? "uiroom-cell-live" : "uiroom-cell-live uiroom-cell-live--armed"}>
						{isolated
							? "● 已隔离:这个组件连的是真实服务,当前所有请求被拦下(不会改你的配置 / 不会导出文件)"
							: "⚠ 连的是真实服务:格子里点按钮会真的生效(删凭据 / 改配置 / 导出书 / 写文件)"}
					</p>
				) : null}
			</header>
			{variants.length > 1 ? (
				<div className="uiroom-tabs" role="tablist" aria-label={`${entry.title} 状态`}>
					{variants.map((v, i) => (
						<button
							key={v.label}
							type="button"
							role="tab"
							aria-selected={i === picked}
							className={i === picked ? "uiroom-tab active" : "uiroom-tab"}
							onClick={() => setPicked(i)}
						>
							{v.label}
						</button>
					))}
					{current?.note ? <span className="uiroom-tab-note">{current.note}</span> : null}
				</div>
			) : null}
			<div
				className={entry.frame ? "uiroom-stage uiroom-stage--fixed" : "uiroom-stage"}
				style={width === null ? undefined : { width, maxWidth: "100%" }}
			>
				{variants.length === 0 ? (
					<div className="uiroom-missing">
						展项未接线:{entry.id} 在 uiroom-types.ts 里登记了,但没有任何分组文件渲染它(见 test/uiroom.test.ts)。
					</div>
				) : (
					current && createElement(current.render)
				)}
			</div>
		</article>
	);
}

export function UIRoom({
	client,
	slug,
	library,
	nav,
	classicMode = false,
}: {
	client: ApiClient;
	slug: string | null;
	library: Library;
	nav?: { view: string; onNavigate: (view: string) => void };
	classicMode?: boolean;
}) {
	const isPhone = useIsPhone();
	const [query, setQuery] = useState("");
	const [group, setGroup] = useState<"all" | UIRoomGroupId>("all");
	const [frameSize, setFrameSize] = useState<FrameSize>("auto");
	/**
	 * 数据来源:**默认隔离**(stubClient 把所有请求打回,失败态也顺带陈列)。
	 * 这不是洁癖 —— 这一页里有一批组件直接拿 client 干活(删供应商凭据、改 MCP 配置、
	 * 停用插件、导出整本书、写文件),调试页不该因为一次误点改掉真实数据。
	 */
	const [isolated, setIsolated] = useState(true);

	/** 展项的运行时:客户端(真实或隔离)+ 真实书库(App 下发),展项按需取(见 uiroom-runtime.tsx)。 */
	const runtime = useMemo<UIRoomRuntime>(
		() => ({ client: isolated ? stubClient() : client, slug, library, navigate: (view) => nav?.onNavigate(view) }),
		[client, isolated, slug, library, nav],
	);

	const stats = uiroomStats(ALL_ENTRIES);
	const unwired = ALL_ENTRIES.filter((e) => (SECTION[e.id]?.length ?? 0) === 0);
	const visible = ALL_ENTRIES.filter((e) => (group === "all" || e.group === group) && matchesQuery(e, SECTION[e.id] ?? [], query));

	return (
		<div className="uiroom">
			{isPhone && (
				<MobileHeader
					title="UI 房"
					tone="ok"
					subtitle={`${stats.exhibits} 个展项 · ${stats.variants} 个状态档`}
					actions={[]}
				/>
			)}
			<header className="uiroom-head">
				<div className="uiroom-title">
					<h1>UI 房</h1>
					<span className="uiroom-badge">调试模式</span>
				</div>
				<p className="uiroom-sub">
					{stats.exhibits} 个展项 / {stats.variants} 个状态档 / {stats.modules} 个模块 / {stats.groups} 组
					{unwired.length > 0 ? ` · 未接线 ${unwired.length}` : ""}
					{unwired.length > 0 ? `(${unwired.map((e) => e.id).join(", ")})` : ""}
				</p>
				{/* 手机端顶栏下线(≤700px),这一页自带一条导航 —— 条目与桌面顶栏同源(nav.ts) */}
				{isPhone && nav ? (
					<div className="uiroom-chips" role="navigation" aria-label="主导航">
						{navItems({ classicMode, debugMode: true }).map((item) => (
							<button
								key={item.id}
								type="button"
								className={nav.view === item.id ? "uiroom-chip active" : "uiroom-chip"}
								aria-current={nav.view === item.id ? "page" : undefined}
								onClick={() => nav.onNavigate(item.id)}
							>
								<Lu icon={item.icon} size={13} /> {item.label}
							</button>
						))}
					</div>
				) : null}
				<div className="uiroom-tools">
					<label className="uiroom-search">
						<Lu icon="search" size={13} />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="搜组件 / 展项 / 状态"
							aria-label="搜索展项"
						/>
					</label>
					<div className="uiroom-chips">
						<button type="button" className={group === "all" ? "uiroom-chip active" : "uiroom-chip"} onClick={() => setGroup("all")}>
							全部
						</button>
						{UIROOM_GROUPS.map((g) => (
							<button key={g.id} type="button" className={group === g.id ? "uiroom-chip active" : "uiroom-chip"} onClick={() => setGroup(g.id)}>
								{g.label}
							</button>
						))}
					</div>
					<div className="uiroom-sizes" role="group" aria-label="数据来源">
						<button type="button" className={isolated ? "uiroom-chip active" : "uiroom-chip"} onClick={() => setIsolated(true)}>
							数据:隔离演示
						</button>
						<button type="button" className={isolated ? "uiroom-chip" : "uiroom-chip active"} onClick={() => setIsolated(false)}>
							数据:真实服务
						</button>
					</div>
					<div className="uiroom-sizes" role="group" aria-label="带框格子宽度">
						{FRAME_SIZES.map((s) => (
							<button key={s.id} type="button" className={frameSize === s.id ? "uiroom-chip active" : "uiroom-chip"} onClick={() => setFrameSize(s.id)}>
								{s.label}
							</button>
						))}
					</div>
				</div>
				<p className="uiroom-runtime-note">
					尺寸只改「带框格子」(弹层演示)的宽度;手机端布局由媒体查询决定,把窗口缩到 ≤700px 或用 devtools 设备模式才看得到。数据型组件默认走「隔离演示」(请求被拦下,顺便看它们的失败态),要在格子里点真实按钮就切「真实服务」。当前书:{slug ?? "未打开"}。
				</p>
			</header>
			<div className="uiroom-body">
				{UIROOM_GROUPS.map((g) => {
					const entries = visible.filter((e) => e.group === g.id);
					if (entries.length === 0) return null;
					return (
						<section className="uiroom-group" key={g.id}>
							<h2>{g.label}</h2>
							<p className="uiroom-group-note">{g.note}</p>
							<div className="uiroom-grid">
								{entries.map((entry) => (
									<UIRoomRuntimeProvider key={entry.id} value={runtime}>
										<ExhibitCell entry={entry} variants={SECTION[entry.id] ?? []} frameSize={frameSize} isolated={isolated} />
									</UIRoomRuntimeProvider>
								))}
							</div>
						</section>
					);
				})}
				{visible.length === 0 ? <div className="uiroom-empty">没有匹配的展项(清空搜索或换分组看看)。</div> : null}
			</div>
		</div>
	);
}
