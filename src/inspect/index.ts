/**
 * `/inspect` 入口(2026-10-04,T5)。
 */

import type { ExtensionContext } from "../../src/pi-adapter/index.ts";
import { InspectPanel, type InspectPanelOptions } from "./panel.ts";

export type { InspectBudgetRow, InspectReport, InspectSectionRow, InspectTrimRow } from "./report.ts";
export { buildInspectReport, budgetItems, inspectHeadline } from "./report.ts";
export { InspectPanel } from "./panel.ts";

/** 以全屏 overlay 打开上下文检视面板;用户退出时 resolve。 */
export function openInspectPanel(ctx: ExtensionContext, options: InspectPanelOptions): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => new InspectPanel(tui, theme, options, () => done()), {
		overlay: true,
		overlayOptions: {
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		},
	});
}
