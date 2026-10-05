/**
 * pi-adapter 的 **TUI 接入点**(T7 批 3,2026-10-04)。
 *
 * ## 为什么单开一个文件,而不是塞进 types.ts
 *
 * `types.ts` 收的是 `pi-coding-agent` / `pi-agent-core` / `pi-ai` 三个包的别名 ——
 * 那是「会话引擎」的包。而这里收的是 **`pi-tui`**:一个独立的终端 UI 框架,
 * 职责不同、升级节奏也不同(它有自己的组件库、键盘协议、渲染管线)。
 *
 * 分开的收益:上游升级时,`pi-tui` 的破坏性变更只需看这一个文件,不会淹没在
 * 会话引擎的类型别名里。
 *
 * ## 厚度控制
 *
 * `pi-tui/src/index.ts` 有 138 行导出(几十个组件 + 键盘 + 布局工具)。这里
 * **只收自研真的用到的 13 个符号** —— 不做无差别转发。多收一个符号,将来上游
 * 改它时你就多一处要跟着动,而那个符号你根本没用过。
 *
 * 需要新符号时:在这里显式加一行,并顺手想一下「是不是可以直接用 TUI 自带的」。
 *
 * ## 与 vendor 的关系
 *
 * 本文件**只 import vendor**,不 import 任何 `src/` 业务模块(铁律 3)。
 */

import {
	type Component as VendorComponent,
	CURSOR_MARKER as VENDOR_CURSOR_MARKER,
	type Focusable as VendorFocusable,
	Markdown,
	matchesKey as vendorMatchesKey,
	sliceByColumn as vendorSliceByColumn,
	type TUI as VendorTUI,
	truncateToWidth as vendorTruncateToWidth,
	visibleWidth as vendorVisibleWidth,
	wrapTextWithAnsi as vendorWrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// `Theme` 实际上住在 pi-coding-agent 里(它是「主题」而不是通用 UI 原语),
// 但用途纯粹是 TUI 渲染 —— 收在这里比收在 types.ts 更贴切。
import {
	copyToClipboard as vendorCopyToClipboard,
	getMarkdownTheme as vendorGetMarkdownTheme,
	Theme,
	type ThemeColor as VendorThemeColor,
} from "@earendil-works/pi-coding-agent";

// —— 类型 ——

/** TUI 组件接口(`render(width) => string[]` / `invalidate()`)。 */
export type Component = VendorComponent;

/** 可聚焦组件(声明自己能接收键盘)。 */
export type Focusable = VendorFocusable;

/** 终端 UI 句柄(渲染循环 + 输入分发)。 */
export type TUI = VendorTUI;

/** 主题的前景色键名(如 `"text"` / `"accent"`)。 */
export type ThemeColor = VendorThemeColor;

// —— 值 ——
//
// ⚠️ 下面这些符号里,`Theme` 与 `Markdown` 是 **class** —— 它们同时占据
// **值通道**和**类型通道**(既能 `new Theme(...)`,也能 `x: Theme`)。
//
// 搬它们**必须**用 re-export(`export { X } from ...`),不能用
// `export const X: typeof VendorX = VendorX` —— 后者只搬值通道,自研侧写
// `x: Theme` 会报 `TS2749: 'Theme' refers to a value, but is being used
// as a type here`。这是 T7 批 3 实际踩到的坑,写在这里免得下次再犯。
//
// 判据:`export { X }` 用于 class / enum / namespace(双身份);
// `export const X: typeof VendorX = VendorX` 用于函数与常量(仅值)。

/** 主题(前景/背景色表 + 色彩模式)。**class,双通道**。 */
export { Theme };

/** markdown 渲染组件(消息气泡 / 帮助面板用)。**class,双通道**。 */
export { Markdown };

/** 把文本复制到系统剪贴板(编辑器 `y` 之类走的路径)。 */
export const copyToClipboard: typeof vendorCopyToClipboard = vendorCopyToClipboard;

/** markdown 渲染用的主题(与 `Markdown` 组件配套)。 */
export const getMarkdownTheme: typeof vendorGetMarkdownTheme = vendorGetMarkdownTheme;

/** 光标标记(组件输出里插一个,框架会把真实光标移过去)。 */
export const CURSOR_MARKER: typeof VENDOR_CURSOR_MARKER = VENDOR_CURSOR_MARKER;

/** 判断按键事件是否匹配某个键位名(如 `"escape"` / `"ctrl+c"`)。 */
export const matchesKey: typeof vendorMatchesKey = vendorMatchesKey;

/** 按**显示列**截取字符串(正确处理 CJK 宽字符)。 */
export const sliceByColumn: typeof vendorSliceByColumn = vendorSliceByColumn;

/** 按**显示列**截断字符串,超长时补省略号。 */
export const truncateToWidth: typeof vendorTruncateToWidth = vendorTruncateToWidth;

/** 字符串的**显示宽度**(CJK 字符算 2 列)。 */
export const visibleWidth: typeof vendorVisibleWidth = vendorVisibleWidth;

/** 按显示列对**带 ANSI 转义**的文本折行(转义序列不计入宽度)。 */
export const wrapTextWithAnsi: typeof vendorWrapTextWithAnsi = vendorWrapTextWithAnsi;
