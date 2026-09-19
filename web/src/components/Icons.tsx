/**
 * 应用图标门面(导航 / 侧栏 / 通用动作)。
 *
 * 全部改走设计稿同源:设计稿(Pen 文档)里的图标是 `library: "lucide"` 的 icon 节点,
 * 这里的每个名字都对应设计稿里那个节点名(见 `Lu.tsx` 的 vendored 路径数据):
 *   IconStage → clapperboard(场记板 = 舞台)
 *   IconEdit  → square-pen(编辑页 / 写作)
 *   IconGlobe → globe(世界书)
 *   IconGear  → settings(设置)
 *   IconBook  → book(书)          IconDoc → file-text(草稿文件)
 *   IconX     → x                 IconPlus → plus       IconTrash → trash-2
 * 需要新图标:先在 Pen 文档里看那个节点叫什么,再从 lucide 取同名路径加进 Lu.tsx。
 */
import { Lu, type LucideName } from "./Lu.tsx";

interface IconProps {
	size?: number;
	className?: string;
}

/** 门面:把旧的 `IconXxx` 名字映射到设计稿里的 lucide 图标名。 */
function make(icon: LucideName, defaultSize = 18) {
	return function Icon({ size = defaultSize, className }: IconProps) {
		return <Lu icon={icon} size={size} className={className} />;
	};
}

export const IconStage = make("clapperboard");
export const IconEdit = make("square-pen");
export const IconGlobe = make("globe");
export const IconGear = make("settings");
export const IconBook = make("book");
export const IconDoc = make("file-text");
export const IconX = make("x");
export const IconPlus = make("plus");
export const IconTrash = make("trash-2");
