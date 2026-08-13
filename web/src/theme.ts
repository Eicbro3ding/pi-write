import { sanitizeTheme, themeCssUrl, type ThemeId } from "./themes.ts";

const STORAGE_KEY = "pi-writer-theme";
/** 主题 CSS 加载 link 的 id(applyTheme 切换其 href)。 */
const LINK_ID = "pi-theme";

/** 当前主题(读 localStorage,非法/缺省回退 night)。 */
export function currentTheme(): ThemeId {
	return sanitizeTheme(localStorage.getItem(STORAGE_KEY));
}

/**
 * 应用主题:写 <html data-theme>、持久化,并加载对应主题 CSS(资产文件)。
 * 主题文件自包含全部结构规则(毛玻璃等),无需额外属性。
 */
export function applyTheme(id: ThemeId): void {
	document.documentElement.dataset.theme = id;
	localStorage.setItem(STORAGE_KEY, id);
	syncThemeLink(id);
}

/**
 * 同步主题 CSS link:nigh 无额外文件(styles.css :root 即默认),其余主题经
 * <link id="pi-theme"> 加载。切换时先注入新 link、后移除旧 link(同一同步栈内
 * 完成,无主题色空窗),避免移除瞬间闪回默认色。
 */
function syncThemeLink(id: ThemeId): void {
	const href = themeCssUrl(id);
	const existing = document.getElementById(LINK_ID) as HTMLLinkElement | null;
	if (!href) {
		existing?.remove();
		return;
	}
	if (existing) {
		if (existing.getAttribute("href") === href) return;
		const next = document.createElement("link");
		next.id = LINK_ID;
		next.rel = "stylesheet";
		next.href = href;
		existing.after(next);
		existing.remove();
		return;
	}
	const link = document.createElement("link");
	link.id = LINK_ID;
	link.rel = "stylesheet";
	link.href = href;
	document.head.appendChild(link);
}

/** 启动时调用一次:首帧即应用持久化主题,避免闪烁。 */
export function initTheme(): void {
	applyTheme(currentTheme());
}
