/**
 * UI 房 · 「动效与主题 token」分组。
 *
 * 这一组不看组件,看**它们共用的底层约定**:
 * - 时长/缓动/位移三档是否真的同源同值(`motion.ts` ↔ styles.css 的变量,
 *   契约测试 test/motion.test.ts 守着,这里给人看);
 * - 三套主题的色板与切换(主题资产是 `:root` 级的 CSS 文件,不存在局部换肤,
 *   所以「对照」是并列展示各主题资产的首屏三色,「切换」是真的切全局主题);
 * - 退场动画(`useExitPresence` + `styles/presence.css`)的现场:进场有、退场不再硬切。
 *
 * 演示动画的重播靠改 key 重挂载 —— CSS animation 只在元素插入时跑一次,
 * 不重挂载就没法反复看同一段。
 */
import { useEffect, useState } from "react";
import type { UIRoomEntry, UIRoomSection } from "../uiroom-types.ts";
import { useUIRoomRuntime } from "../uiroom-runtime.tsx";
import { DUR, EASE, EDGE_SLIDE, STAGGER } from "../motion.ts";
import { NIGHT_THEME, THEME_TOKENS, swatchFromCss, themeLabelFromCss } from "../themes.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { closingClass, useExitPresence } from "../use-exit-presence.ts";

export const TOKENS_ENTRIES: readonly UIRoomEntry[] = [
	{
		id: "motion-tokens",
		group: "tokens",
		title: "动效档位",
		module: "motion.ts",
		symbols: ["DUR", "EASE", "STAGGER", "EDGE_SLIDE"],
		note: "三档时长 / 两条缓动曲线 / 边缘位移与错峰,都带重播按钮 —— 同屏比快慢。",
		variants: ["时长档", "缓动曲线", "位移与错峰"],
	},
	{
		id: "theme-tokens",
		group: "tokens",
		title: "主题色板",
		module: "themes.ts",
		symbols: ["THEME_TOKENS", "swatchFromCss"],
		note: "26 个颜色 token 的现场取值 + 各主题资产首屏三色对照 + 一键切全局主题。",
		variants: ["当前主题色板", "内置主题对照", "切主题"],
	},
	{
		id: "overlay-exit",
		group: "tokens",
		title: "退场动画",
		module: "use-exit-presence.ts",
		symbols: ["useExitPresence", "closingClass"],
		note: "三种弹层的关闭过程(淡出 / 缩回 / 下沉),都走 useExitPresence + presence.css。",
		variants: ["居中弹窗", "修订模态", "提问卡片"],
		frame: "viewport",
	},
];

/** 重播:改 key 让元素重挂载,CSS animation 才会重新跑。 */
function useReplay(): [number, () => void] {
	const [n, setN] = useState(0);
	return [n, () => setN((v) => v + 1)];
}

/** 时长档:同样的位移,只换时长。 */
const DUR_ROWS: ReadonlyArray<{ name: string; seconds: number }> = [
	{ name: "fast", seconds: DUR.fast },
	{ name: "base", seconds: DUR.base },
	{ name: "slow", seconds: DUR.slow },
];

function DurationDemo() {
	const [n, replay] = useReplay();
	return (
		<div className="uiroom-demo">
			{DUR_ROWS.map((row) => (
				<div key={row.name} className="uiroom-demo-row">
					<code>{`--dur-${row.name}`}</code>
					<span className="uiroom-demo-val">{Math.round(row.seconds * 1000)}ms</span>
					<span key={`${row.name}-${n}`} className={`uiroom-anim uiroom-anim--${row.name}`} />
				</div>
			))}
			<button type="button" className="btn" onClick={replay}>
				重播
			</button>
		</div>
	);
}

/** 缓动曲线:同时长,只换曲线。 */
function EasingDemo() {
	const [n, replay] = useReplay();
	const rows: ReadonlyArray<{ label: string; cls: string; value: string }> = [
		{ label: "var(--ease-out)", cls: "uiroom-anim--out", value: EASE.out.join(", ") },
		{ label: "var(--ease-inout)", cls: "uiroom-anim--inout", value: EASE.inOut.join(", ") },
		{ label: "linear", cls: "uiroom-anim--linear", value: "对照(无缓动)" },
	];
	return (
		<div className="uiroom-demo">
			{rows.map((row) => (
				<div key={row.cls} className="uiroom-demo-row">
					<code>{row.label}</code>
					<span className="uiroom-demo-val">{row.value}</span>
					<span key={`${row.cls}-${n}`} className={`uiroom-anim uiroom-anim--base ${row.cls}`} />
				</div>
			))}
			<button type="button" className="btn" onClick={replay}>
				重播
			</button>
		</div>
	);
}

/** 边缘位移与列表错峰。 */
function EdgeStaggerDemo() {
	const [n, replay] = useReplay();
	return (
		<div className="uiroom-demo">
			<div className="uiroom-demo-row">
				<code>EDGE_SLIDE</code>
				<span className="uiroom-demo-val">{EDGE_SLIDE}px(左 / 右各一)</span>
				<span key={`l${n}`} className="uiroom-anim uiroom-anim--base uiroom-anim--edge-left" />
				<span key={`r${n}`} className="uiroom-anim uiroom-anim--base uiroom-anim--edge-right" />
			</div>
			<div className="uiroom-demo-row">
				<code>STAGGER</code>
				<span className="uiroom-demo-val">{STAGGER}s × 6</span>
			</div>
			<ul className="uiroom-stagger">
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<li key={`${n}-${i}`} className="uiroom-anim uiroom-anim--base" style={{ animationDelay: `${i * STAGGER}s` }}>
						第 {i + 1} 条
					</li>
				))}
			</ul>
			<button type="button" className="btn" onClick={replay}>
				重播
			</button>
		</div>
	);
}

/** 当前主题色板:纯 CSS 变量取值,不需要 js 就能跟着主题变。 */
function PaletteDemo() {
	return (
		<div className="uiroom-palette">
			{THEME_TOKENS.map((token) => (
				<div key={token} className="uiroom-swatch">
					<i style={{ background: `var(${token})` }} />
					<code>{token}</code>
				</div>
			))}
		</div>
	);
}

interface ThemeRow {
	id: string;
	label: string;
	swatch: readonly string[];
}

/** 各主题资产的首屏三色(背景/强调/文字)并列对照。 */
function ThemeAssetsDemo() {
	const { client } = useUIRoomRuntime();
	const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; rows: ThemeRow[] }>({ kind: "loading" });
	useEffect(() => {
		let cancelled = false;
		client
			.getThemes()
			.then((manifest) => {
				if (cancelled) return;
				setState({
					kind: "ready",
					rows: manifest.builtin.map((t) => ({
						id: t.file.replace(/\.css$/, ""),
						label: themeLabelFromCss(t.css, t.file),
						swatch: swatchFromCss(t.css),
					})),
				});
			})
			.catch((e: unknown) => {
				if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
			});
		return () => {
			cancelled = true;
		};
	}, [client]);
	const night: ThemeRow = { id: NIGHT_THEME.id, label: `${NIGHT_THEME.label}(styles.css :root)`, swatch: NIGHT_THEME.swatch };
	return (
		<div className="uiroom-themes">
			{[night, ...(state.kind === "ready" ? state.rows : [])].map((row) => (
				<div key={row.id} className="uiroom-theme-row">
					<span className="uiroom-theme-name">{row.label}</span>
					<span className="uiroom-theme-swatches">
						{row.swatch.map((c, i) => (
							<i key={`${row.id}-${i}`} style={{ background: c }} />
						))}
					</span>
				</div>
			))}
			{state.kind === "loading" && <p className="uiroom-hint">正在读取主题清单(GET /api/themes)…</p>}
			{state.kind === "error" && <p className="uiroom-hint uiroom-hint--err">读取失败:{state.message}</p>}
		</div>
	);
}

/** 真的切全局主题(主题资产是 :root 级的,没有局部换肤这回事)。 */
function ThemeSwitchDemo() {
	const { client } = useUIRoomRuntime();
	const [ids, setIds] = useState<readonly string[]>([]);
	const [current, setCurrent] = useState<string>(() => (typeof localStorage === "undefined" ? "night" : currentTheme()));
	useEffect(() => {
		let cancelled = false;
		client
			.getThemes()
			.then((manifest) => {
				if (!cancelled) setIds(manifest.builtin.map((t) => t.file.replace(/\.css$/, "")));
			})
			.catch(() => {
				/* 读不到清单就只留 night:切主题本身不依赖它 */
			});
		return () => {
			cancelled = true;
		};
	}, [client]);
	const pick = (id: string) => {
		applyTheme(id);
		setCurrent(id);
	};
	const all = ["night", ...ids];
	return (
		<div className="uiroom-demo">
			<div className="uiroom-theme-picks">
				{all.map((id) => (
					<button key={id} type="button" className={id === current ? "btn primary" : "btn"} onClick={() => pick(id)}>
						{id}
					</button>
				))}
			</div>
			<p className="uiroom-hint">当前:{current}(切换的是整个应用的主题,退出 UI 房后依然生效)</p>
		</div>
	);
}

/** 弹窗退场:遮罩淡出 + 面板原路缩回。 */
function DialogExitDemo() {
	const [open, setOpen] = useState(true);
	const { mounted, closing } = useExitPresence(open);
	return (
		<div className="uiroom-exit">
			<button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
				{open ? "关闭弹窗" : "打开弹窗"}
			</button>
			{mounted && (
				<div className={closingClass("dlg-overlay", closing)}>
					<div className="dlg-panel">
						<div className="dlg-head">
							<span className="dlg-title">UI 房 · 演示弹窗</span>
						</div>
						<div className="dlg-body">
							<p>点上面的按钮看退场:遮罩淡出、面板缩回 6px 并淡出(200ms,与入场对偶)。</p>
						</div>
						<div className="dlg-foot">
							<button type="button" className="btn" onClick={() => setOpen(false)}>
								关闭
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 修订模态退场(.rsm-mask / .rsm-panel)。 */
function ReviseMaskExitDemo() {
	const [open, setOpen] = useState(true);
	const { mounted, closing } = useExitPresence(open);
	return (
		<div className="uiroom-exit">
			<button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
				{open ? "关闭修订模态" : "打开修订模态"}
			</button>
			{mounted && (
				<div className={closingClass("rsm-mask", closing)}>
					<div className="rsm-panel">
						<div className="rsm-head">
							<span className="rsm-title">修订剧本</span>
							<span className="rsm-ver">v3</span>
						</div>
						<div className="dlg-body">
							<p>这是舞台页的修订模态壳,退场同样由 presence.css 接管(缩回 + 淡出)。</p>
						</div>
						<div className="dlg-foot">
							<button type="button" className="btn" onClick={() => setOpen(false)}>
								关闭
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 提问卡片退场(.ask-layer / .ask-card):小幅下沉。 */
function AskExitDemo() {
	const [open, setOpen] = useState(true);
	const { mounted, closing } = useExitPresence(open);
	return (
		<div className="uiroom-exit">
			<button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
				{open ? "关闭提问" : "打开提问"}
			</button>
			{mounted && (
				<div className={closingClass("ask-layer", closing)}>
					<div className="ask-scrim" />
					<div className="ask-card" style={{ left: 16, bottom: 16, width: 300 }}>
						<div className="ask-head">
							<span className="ask-question">要在这一章补一场雨戏吗?</span>
						</div>
						<div className="ask-options">
							<button type="button" className="ask-option">
								补一场(推荐)
							</button>
							<button type="button" className="ask-option">
								先不动
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export const TOKENS_SECTION: UIRoomSection = {
	"motion-tokens": [
		{ label: "时长档", render: DurationDemo },
		{ label: "缓动曲线", render: EasingDemo },
		{ label: "位移与错峰", render: EdgeStaggerDemo },
	],
	"theme-tokens": [
		{ label: "当前主题色板", render: PaletteDemo },
		{ label: "内置主题对照", render: ThemeAssetsDemo },
		{ label: "切主题", render: ThemeSwitchDemo },
	],
	"overlay-exit": [
		{ label: "居中弹窗", render: DialogExitDemo },
		{ label: "修订模态", render: ReviseMaskExitDemo },
		{ label: "提问卡片", render: AskExitDemo },
	],
};
