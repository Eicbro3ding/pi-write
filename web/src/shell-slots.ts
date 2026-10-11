/**
 * 宿主壳层的槽位声明 —— 「UI 从 root 往下长」的那棵树在这里定形。
 *
 * 这个模块**只声明槽位名与形态**,不注册任何条目,也不 import 任何页面组件:
 * 把「有哪些座位」与「谁坐在上面」分开,是本机制的关键。声明是纯数据,
 * 可以被 UI 房、文档、乃至模型读的槽位目录共用。
 *
 * 树形(与 App.tsx 的骨架一一对应):
 *
 *   root                                  single  应用根:唯一预声明的种子
 *   └ app.chrome                          single  顶栏 + 主区的外框
 *       ├ app.chrome.brand                single  品牌位
 *       ├ app.chrome.nav                  list    导航条目(舞台/编辑/世界书/设置/…)
 *       ├ app.chrome.status               list    右状态位(保存状态、连接状态)
 *       └ app.chrome.overlay              list    全局浮层(浮窗、插件自有界面)
 *   └ app.view                            single  当前视图的容器
 *       └ app.view.edit                   single  编辑页
 *       └ app.view.stage                  single  舞台页
 *       └ app.view.world                  single  世界书页
 *       └ app.view.settings               single  设置页
 *           └ app.view.settings.plugin    keyed   各插件设置卡内的扩展位(key = 插件 id)
 *   └ app.wizard                          single  首启向导(覆盖层)
 *
 * 为什么 view 槽位是 single:页面是「当前在哪」,同时只能有一个;插件想往页面上
 * 加东西应该往页面**内部**的槽位注册(如 app.view.settings.plugin),而不是替换整个页面。
 */
import { registerSlot } from "./slots.ts";

/** 顶栏与全局层。 */
export const SLOT_CHROME = "app.chrome";
export const SLOT_BRAND = "app.chrome.brand";
export const SLOT_NAV = "app.chrome.nav";
export const SLOT_STATUS = "app.chrome.status";
export const SLOT_OVERLAY = "app.chrome.overlay";
/** 视图容器与四个页面。 */
export const SLOT_VIEW = "app.view";
export const SLOT_VIEW_EDIT = "app.view.edit";
export const SLOT_VIEW_STAGE = "app.view.stage";
export const SLOT_VIEW_WORLD = "app.view.world";
export const SLOT_VIEW_SETTINGS = "app.view.settings";
/** 设置页插件卡内的扩展位(keyed:key = 插件 id)。插件往这里注册自己的界面。 */
export const SLOT_SETTINGS_PLUGIN = "app.view.settings.plugin";
/** 首启向导。 */
export const SLOT_WIZARD = "app.wizard";

/** 声明全部宿主槽位。幂等,可被重复调用(模块被重复求值时安全)。 */
export function declareShellSlots(): void {
	registerSlot({
		name: "app.chrome",
		kind: "single",
		description: "顶栏 + 主区的外框",
		children: [
			{ name: SLOT_BRAND, kind: "single" },
			{ name: SLOT_NAV, kind: "list" },
			{ name: SLOT_STATUS, kind: "list" },
			{ name: SLOT_OVERLAY, kind: "list" },
		],
	});
	registerSlot({
		name: "app.view",
		kind: "single",
		description: "当前视图的容器",
		children: [
			{ name: SLOT_VIEW_EDIT, kind: "single" },
			{ name: SLOT_VIEW_STAGE, kind: "single" },
			{ name: SLOT_VIEW_WORLD, kind: "single" },
			{
				name: SLOT_VIEW_SETTINGS,
				kind: "single",
				// 设置页内部的插件扩展位:keyed,key = 插件 id,每个插件卡渲染自己的那一格
				// (声明用 registerSlot 而不是再嵌套 children —— SlotDeclaration.children 是
				//  一次性的字面量结构,这里按需在同一处把它声明齐)
			},
			{ name: SLOT_SETTINGS_PLUGIN, kind: "keyed" },
		],
	});
	registerSlot({ name: SLOT_WIZARD, kind: "single", description: "首启向导" });
}
