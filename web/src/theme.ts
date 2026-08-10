import { sanitizeTheme, type ThemeId } from "./themes.ts";

const STORAGE_KEY = "pi-writer-theme";

/** 当前主题(读 localStorage,非法/缺省回退 night)。 */
export function currentTheme(): ThemeId {
	return sanitizeTheme(localStorage.getItem(STORAGE_KEY));
}

/** 应用主题:写 <html data-theme> 并持久化。 */
export function applyTheme(id: ThemeId): void {
	document.documentElement.dataset.theme = id;
	localStorage.setItem(STORAGE_KEY, id);
}

/** 启动时调用一次:首帧即应用持久化主题,避免闪烁。 */
export function initTheme(): void {
	applyTheme(currentTheme());
}
