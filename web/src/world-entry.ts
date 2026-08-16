import type { WorldEntryDto } from "./types.ts";

/** 条目类型;顺序即世界书页左侧分组展示顺序。 */
export const ENTRY_TYPES: ReadonlyArray<WorldEntryDto["type"]> = ["character", "world", "timeline", "outline"];

/** 条目类型 → 显示名(世界树/命令面板共用)。 */
export const ENTRY_TYPE_LABELS: Record<WorldEntryDto["type"], string> = {
	character: "人物",
	world: "世界",
	timeline: "时间线",
	outline: "大纲",
};
