/**
 * Built-in editor entry points for pi-writer.
 */

import type { ExtensionContext } from "../../vendor/pi-coding-agent/src/index.ts";
import { VimFileEditor, type VimFileEditorOptions, type VimFileEditorResult } from "./vim-file-editor.ts";

export type { EditArgs } from "./args.ts";
export { parseEditArgs } from "./args.ts";
export type { ChatApi, ChatMessage } from "./chat.ts";
export type { SgrMouseEvent } from "./mouse.ts";
export { parseSgrMouse } from "./mouse.ts";
export type { VimFileEditorResult } from "./vim-file-editor.ts";

/**
 * Open the built-in editor as a full-screen overlay.
 *
 * Resolves with the editor result when the user quits. The caller is
 * responsible for persisting content when `saved` is true.
 */
export function openFileEditor(ctx: ExtensionContext, options: VimFileEditorOptions): Promise<VimFileEditorResult> {
	return ctx.ui.custom((tui, theme, _keybindings, done) => new VimFileEditor(tui, theme, options, done), {
		overlay: true,
		overlayOptions: {
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		},
	});
}
