/**
 * 导航条目唯一真相源(手机端抽屉 / UI 房手机导航 / 桌面顶栏的页面集合)。
 *
 * 以前这份清单写在 `ChapterSidebar.tsx` 里(手机端抽屉主导航)。UI 房也要一条
 * 手机端导航(≤700px 顶栏下线),再抄一份必然漂移 —— 所以抽到这里,
 * 「哪些页存在」「经典模式去掉谁」「调试模式加谁」只写一次。
 *
 * 桌面顶栏(App.tsx)仍用自己的图标组件(IconStage 等)渲染同一组页面,
 * 但**筛选规则**同样走 `navItems()`:两边不一致会直接表现为「手机能点到的页
 * 桌面没有」。
 */
import type { LucideName } from "./components/Lu.tsx";

/** 顶层视图 id(与 App 的 View 联合类型一致;这里用字符串字面量,避免 pages 反向依赖 App)。 */
export type NavView = "stage" | "edit" | "world" | "settings" | "uiroom";

export interface NavItem {
	id: NavView;
	icon: LucideName;
	label: string;
}

/** 页面集合(顺序即导航顺序)。 */
export const PAGE_ITEMS: readonly NavItem[] = [
	{ id: "stage", icon: "clapperboard", label: "舞台" },
	{ id: "edit", icon: "square-pen", label: "编辑" },
	{ id: "world", icon: "globe", label: "世界书" },
	{ id: "settings", icon: "settings", label: "设置" },
];

/** 调试模式专属页:UI 房(组件陈列室,只有开发者会去)。 */
export const UIROOM_ITEM: NavItem = { id: "uiroom", icon: "layout-grid", label: "UI 房" };

/**
 * 页面列表。两条规则:
 * - 经典模式(单 agent)去掉舞台:StagePage 整个不挂载,点进去只会白屏;
 * - 调试模式追加 UI 房(它只在调试模式里可达,见 App.tsx / pages/UIRoom.tsx)。
 */
export function navItems(opts: { classicMode?: boolean; debugMode?: boolean } = {}): NavItem[] {
	const base = opts.classicMode ? PAGE_ITEMS.filter((i) => i.id !== "stage") : [...PAGE_ITEMS];
	return opts.debugMode ? [...base, UIROOM_ITEM] : base;
}
