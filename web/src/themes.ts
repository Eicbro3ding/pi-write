export type ThemeId = "night" | "paper" | "parchment";

export interface ThemeDef {
	id: ThemeId;
	label: string;
	desc: string;
	/** [背景, 强调色, 文字] 三色色板,供设置页卡片预览。 */
	swatch: [string, string, string];
	/** 覆盖的颜色变量;默认主题(night)为空(= :root 全部定义)。 */
	vars: Record<string, string>;
}

/** 主题系统覆盖的全部颜色 token(测试保证 :root 与覆盖块键集与此一致)。 */
export const THEME_TOKENS = [
	"--bg", "--bg-elev", "--bg-elev-2", "--ink", "--ink-2", "--muted", "--faint",
	"--line", "--line-strong", "--amber", "--green", "--red", "--err-soft", "--scrollbar",
	"--hover-tint", "--hover-tint-strong", "--amber-tint", "--amber-tint-strong",
	"--red-tint", "--red-tint-strong", "--green-tint", "--green-tint-strong",
	"--mask", "--shadow-1", "--shadow-2", "--shadow-3",
] as const;

/** 三套签名主题(深夜书房设计语言的明暗与色温变体):
 *  night 暗色默认(颜色收敛进 styles.css :root,vars 为空);
 *  paper/parchment 亮色与暖色(经 [data-theme] 覆盖块全量覆盖 token)。 */
export const THEMES: ThemeDef[] = [
	{
		id: "night",
		label: "深夜书房",
		desc: "暗色 · 现代工艺",
		swatch: ["#0f0e0c", "#d9a84e", "#ede6da"],
		vars: {},
	},
	{
		id: "paper",
		label: "纸上书房",
		desc: "亮色 · 米纸晨光",
		swatch: ["#f4f0e8", "#9a6524", "#26221c"],
		vars: {
			"--bg": "#f4f0e8", "--bg-elev": "#fdfaf4", "--bg-elev-2": "#efe9de",
			"--ink": "#26221c", "--ink-2": "#4a443a", "--muted": "#6f6759", "--faint": "#7a7162",
			"--line": "#dcd4c4", "--line-strong": "#b9af9c",
			"--amber": "#9a6524", "--green": "#5f7d4e", "--red": "#ad5038", "--err-soft": "#c26a55",
			"--amber-tint": "rgba(154,101,36,.1)", "--amber-tint-strong": "rgba(154,101,36,.24)",
			"--red-tint": "rgba(173,80,56,.07)", "--red-tint-strong": "rgba(173,80,56,.28)",
			"--green-tint": "rgba(95,125,78,.08)", "--green-tint-strong": "rgba(95,125,78,.3)",
			"--hover-tint": "rgba(0,0,0,.045)", "--hover-tint-strong": "rgba(0,0,0,.07)",
			"--scrollbar": "#c4b9a4", "--mask": "rgba(60,52,40,.35)",
			"--shadow-1": "0 1px 2px rgba(60,52,40,.08), 0 1px 4px rgba(60,52,40,.05)",
			"--shadow-2": "0 4px 14px rgba(60,52,40,.14), 0 1px 3px rgba(60,52,40,.08)",
			"--shadow-3": "0 16px 44px rgba(60,52,40,.24), 0 4px 12px rgba(60,52,40,.14)",
		},
	},
	{
		id: "parchment",
		label: "羊皮灯下",
		desc: "暖色 · 灯下书写",
		swatch: ["#efe6d2", "#965f1f", "#3a3226"],
		vars: {
			"--bg": "#efe6d2", "--bg-elev": "#f7f0e0", "--bg-elev-2": "#e8dcc2",
			"--ink": "#3a3226", "--ink-2": "#554b3a", "--muted": "#6d6248", "--faint": "#7a6d52",
			"--line": "#d6c9a8", "--line-strong": "#b3a47e",
			"--amber": "#965f1f", "--green": "#6d8a58", "--red": "#a85038", "--err-soft": "#c2705c",
			"--amber-tint": "rgba(150,95,31,.12)", "--amber-tint-strong": "rgba(150,95,31,.26)",
			"--red-tint": "rgba(168,80,56,.08)", "--red-tint-strong": "rgba(168,80,56,.3)",
			"--green-tint": "rgba(109,138,88,.08)", "--green-tint-strong": "rgba(109,138,88,.3)",
			"--hover-tint": "rgba(80,60,20,.05)", "--hover-tint-strong": "rgba(80,60,20,.08)",
			"--scrollbar": "#bfb088", "--mask": "rgba(70,55,30,.4)",
			"--shadow-1": "0 1px 2px rgba(70,55,30,.09), 0 1px 4px rgba(70,55,30,.06)",
			"--shadow-2": "0 4px 14px rgba(70,55,30,.15), 0 1px 3px rgba(70,55,30,.09)",
			"--shadow-3": "0 16px 44px rgba(70,55,30,.26), 0 4px 12px rgba(70,55,30,.15)",
		},
	},
];

/** 非法/缺省值一律回退 night。 */
export function sanitizeTheme(v: string | null | undefined): ThemeId {
	return v === "paper" || v === "parchment" ? v : "night";
}
