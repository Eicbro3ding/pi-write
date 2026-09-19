/**
 * 主题卡(浅深合并)——设置页「界面」与首启向导「界面偏好」共用的唯一实现。
 *
 * 规范见设计稿 03-组件规范/02:同一主题的浅色/深色合并成一张卡——点未选中的
 * 卡取浅色(没有浅色版取深色),再点已选中的卡在浅 ⇄ 深之间切换。这样省掉了
 * 卡上的明暗开关,也把 7 张卡收敛成 5 张。配对/落点判定在 themes.ts(有单测)。
 */
import { buildThemeFamilies, type ThemeId, themeFamilyPick, type ThemeFamily } from "../themes.ts";
import { Lu } from "./Lu.tsx";

/** 主题清单形状(内置与用户主题同构;只用到 file + css)。 */
export interface ThemeAsset {
	file: string;
	css: string;
}

export function ThemeCards({
	families,
	current,
	onPick,
}: {
	/** 家族列表(经 buildThemeFamilies 生成;设置页与向导各自拉清单后传入)。 */
	families: readonly ThemeFamily[];
	current: ThemeId;
	onPick: (id: ThemeId) => void;
}) {
	return (
		<div className="theme-cards">
			{families.map((f) => {
				// 已选中的家族:卡片色板与胶囊跟随当前变体;未选中则预览浅色
				const active = current === f.light.id ? f.light : f.dark && current === f.dark.id ? f.dark : null;
				const shown = active ?? f.light;
				const isLight = active === f.light;
				const isDark = !!f.dark && active === f.dark;
				return (
					<button
						type="button"
						key={f.key}
						className={`theme-card${active ? " active" : ""}`}
						onClick={() => onPick(themeFamilyPick(f, current))}
						title={f.dark ? "未选中时取浅色;再点一次切换深浅" : "单变体主题"}
					>
						<span className="theme-swatch">
							{shown.swatch.map((c, i) => (
								<i key={i} style={{ background: c }} />
							))}
						</span>
						<span className="theme-label">{f.label}</span>
						<span className="theme-modes">
							<span className={`theme-mode${isLight ? " on" : ""}`}>
								<SunIcon /> 浅色
							</span>
							{f.dark && (
								<span className={`theme-mode${isDark ? " on" : ""}`}>
									<MoonIcon /> 深色
								</span>
							)}
						</span>
						{active && (
							<Lu icon="check" size={14} className="theme-check" />
						)}
					</button>
				);
			})}
		</div>
	);
}

/** 由主题清单直接渲染(调用方只给清单,分组规则不重复实现)。 */
export function ThemeCardsFromManifest({
	builtin,
	user,
	current,
	onPick,
}: {
	builtin: readonly ThemeAsset[];
	user: readonly ThemeAsset[];
	current: ThemeId;
	onPick: (id: ThemeId) => void;
}) {
	return <ThemeCards families={buildThemeFamilies(builtin, user)} current={current} onPick={onPick} />;
}

function SunIcon() {
	return (
		<Lu icon="sun" size={11} strokeWidth={1.6} />
	);
}

function MoonIcon() {
	return (
		<Lu icon="moon" size={11} strokeWidth={1.6} />
	);
}
