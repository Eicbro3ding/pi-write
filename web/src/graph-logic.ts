import type { WorldEntryDto, WorldRelationDto } from "./types.ts";

/** 断开某节点参与的全部连线:from/to 任一命中即移除(双向)。 */
export function disconnectEntry(relations: WorldRelationDto[], entryId: string): WorldRelationDto[] {
	return relations.filter((r) => r.from !== entryId && r.to !== entryId);
}

/** 删除节点:条目移除 + 子条目 parent 清空(转根条目)+ 相关连线一并移除。 */
export function deleteEntryWithRelations(
	entries: WorldEntryDto[],
	relations: WorldRelationDto[],
	entryId: string,
): { entries: WorldEntryDto[]; relations: WorldRelationDto[] } {
	return {
		entries: entries
			.filter((e) => e.id !== entryId)
			.map((e) => (e.parent === entryId ? { ...e, parent: null } : e)),
		relations: disconnectEntry(relations, entryId),
	};
}

/** XML 转义(SVG data URL 内文本防注入)。 */
function escapeXml(s: string): string {
	return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/**
 * 生成"白底 + 标题首字"文字头像 SVG data URL(无图条目的关系图节点回退;
 * 白底用纸色,首字用条目类型色;空标题回退 "?")。
 */
export function genAvatarDataUrl(title: string, color: string): string {
	const ch = escapeXml((title.trim() || "?").slice(0, 1));
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 88 88"><rect width="88" height="88" fill="#f5f0e6"/><text x="44" y="44" font-size="40" text-anchor="middle" dominant-baseline="central" fill="${escapeXml(color)}">${ch}</text></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
