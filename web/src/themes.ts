/**
 * 主题系统(资产文件驱动,零 ts 注册):
 * - 内置主题 = web/public/themes/<name>.css 资产文件,设置页经 GET /api/themes
 *   自动发现(无需在源码注册);night 例外——token 收敛在 styles.css :root
 *   (默认防闪基底),无资产文件,id 恒为 night;
 * - 用户自定义主题 = ~/.pi/writer/themes/<name>.css(后端伺服),id 记 `user:<name>`;
 * - id 解析按形状:裸安全名 → 内置资产 /themes/<name>.css;user: 前缀 → 用户目录。
 *   主题文件首行注释约定 `/* pi-writer 主题 · 名字(id) *\/` 供设置页取显示名。
 *
 * 运行时经 <link id="pi-theme"> 动态加载(见 theme.ts),`data-theme` 属性写入
 * <html>(供结构性规则与用户 CSS 定向)。主题文件自包含全部结构规则
 * (毛玻璃/圆角/浅色代码块等),styles.css 只留 night 基础与通用规则。
 */

/** 主题 id:night / 内置裸名(资产文件自动发现)/ user:<文件名>。 */
export type ThemeId = string;

/** 用户主题 id 前缀(区别于内置裸名)。 */
export const USER_THEME_PREFIX = "user:";

/**
 * 内置默认主题显示元数据(night 无资产文件——token 在 styles.css :root 防闪,
 * 只能留在这里;其余内置主题全部从资产文件自动发现,此处仅 night 一项)。
 */
export const NIGHT_THEME = {
	id: "night",
	label: "深夜书房",
	desc: "暗色 · 现代工艺",
	swatch: ["#0f0e0c", "#d9a84e", "#ede6da"],
} as const;

/** 用户主题 id 合法性:`user:` + 安全文件名(不含 .css 后缀,防路径穿越)。 */
const USER_ID_RE = /^user:[A-Za-z0-9._-]+$/;

/** 内置主题文件名安全形状(与后端 resolveThemeFile 同规则)。 */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** 是否为用户自定义主题。 */
export function isUserTheme(id: string): id is `user:${string}` {
	return id.startsWith(USER_THEME_PREFIX);
}

/** 用户主题 id → 文件名(带 .css);非用户主题返回 null。 */
export function userThemeFile(id: string): string | null {
	if (!isUserTheme(id)) return null;
	return `${id.slice(USER_THEME_PREFIX.length)}.css`;
}

/**
 * 主题 id → 资产文件 URL(供 <link> 加载):
 * night → null(styles.css :root 即默认);裸安全名 → /themes/<id>.css(文件缺失
 * 404 时浏览器忽略,回退 night 基底);用户主题 → /api/themes/<name>.css。
 * 非法/无法定位返回 null。
 */
export function themeCssUrl(id: string): string | null {
	if (id === "night") return null;
	if (SAFE_NAME_RE.test(id)) return `/themes/${id}.css`;
	const file = userThemeFile(id);
	return file ? `/api/themes/${file}` : null;
}

/** 校验主题 id:night / 内置安全名 / user:<安全名> 透传;否则回退 night。 */
export function sanitizeTheme(v: string | null | undefined): ThemeId {
	if (v === "night" || (v && (SAFE_NAME_RE.test(v) || USER_ID_RE.test(v)))) return v;
	return "night";
}

/** 主题系统覆盖的全部颜色 token(测试保证各主题 CSS 文件键集与此一致)。 */
export const THEME_TOKENS = [
	"--bg", "--bg-elev", "--bg-elev-2", "--ink", "--ink-2", "--muted", "--faint",
	"--line", "--line-strong", "--amber", "--green", "--red", "--err-soft", "--scrollbar",
	"--hover-tint", "--hover-tint-strong", "--amber-tint", "--amber-tint-strong",
	"--red-tint", "--red-tint-strong", "--green-tint", "--green-tint-strong",
	"--mask", "--shadow-1", "--shadow-2", "--shadow-3",
] as const;

/**
 * 从主题 CSS 首行注释取显示名。约定:`/* pi-writer 主题 · 名字(id) *\/`,
 * 兼容 `/* 名字 *\/`;解析失败回退文件名。
 */
export function themeLabelFromCss(css: string, file: string): string {
	const m = css.match(/\/\*\s*(?:pi-writer 主题 ·\s*)?([^()（*]+?)\s*[()（*\/]/);
	const label = m ? m[1]!.trim() : "";
	return label || file.replace(/\.css$/, "");
}

/** 新建用户主题的骨架 CSS(26 token 全量注释,便于用户改)。 */
export function themeStarterCss(): string {
	return `/* 自定义主题骨架:覆盖任意颜色 token(完整 26 色见 THEME_TOKENS)。 */
:root {
  --bg: #101010; --bg-elev: #161616; --bg-elev-2: #1d1d1d;
  --ink: #e8e6e1; --ink-2: #c6c2b9; --muted: #989287; --faint: #787266;
  --line: #2a2a2a; --line-strong: #3b3b3b;
  --amber: #d9a84e; --green: #8fb57f; --red: #db7e6c; --err-soft: #e8a294;
  --amber-tint: rgba(217, 168, 78, 0.09); --amber-tint-strong: rgba(217, 168, 78, 0.28);
  --red-tint: rgba(219, 126, 108, 0.08); --red-tint-strong: rgba(219, 126, 108, 0.3);
  --green-tint: rgba(143, 181, 127, 0.08); --green-tint-strong: rgba(143, 181, 127, 0.32);
  --hover-tint: rgba(255, 255, 255, 0.045); --hover-tint-strong: rgba(255, 255, 255, 0.07);
  --scrollbar: #3a342b; --mask: rgba(0, 0, 0, 0.55);
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 4px rgba(0, 0, 0, 0.18);
  --shadow-2: 0 4px 14px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.22);
  --shadow-3: 0 16px 44px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3);
}
`;
}
