import type { WorldEntryDto, WorldRelationDto } from "../types.ts";
import { imageUrl } from "../api/client.ts";
import { genAvatarDataUrl } from "../graph-logic.ts";
import { ENTRY_TYPE_LABELS } from "./WorldTree.tsx";
import { themeVar, TYPE_TOKENS, TYPE_FALLBACKS } from "../graph-styles.ts";

/**
 * 紧凑只读「百科」卡片:单个词条的变更预览(类型徽标/标题/状态/触发词/正文/关联关系)。
 * 只读,不带编辑与图片上传(与 WorldPage 的完整 EntryCard 区分)。
 */
export function PreviewEntryCard({
	entry,
	allEntries,
	relations,
	slug,
}: {
	entry: WorldEntryDto;
	allEntries: WorldEntryDto[];
	relations: WorldRelationDto[];
	slug: string | null;
}) {
	const avatar =
		entry.avatar && slug
			? imageUrl(slug, entry.avatar)
			: genAvatarDataUrl(entry.title, themeVar(TYPE_TOKENS[entry.type], TYPE_FALLBACKS[entry.type]));
	const myRels = relations.filter((r) => r.from === entry.id || r.to === entry.id);
	const titleOf = (id: string) => allEntries.find((e) => e.id === id)?.title ?? id;
	return (
		<div className="preview-entry">
			<img className="preview-entry-avatar" src={avatar} alt="" />
			<div className="preview-entry-main">
				<div className="preview-entry-title">{entry.title}</div>
				<div className="preview-entry-meta">
					{ENTRY_TYPE_LABELS[entry.type]}
					{entry.status ? ` · ${entry.status}` : ""}
					{entry.keys.length > 0 ? ` · 触发:${entry.keys.join("、")}` : ""}
				</div>
				{entry.body.trim().length > 0 && <div className="preview-entry-body">{entry.body}</div>}
				{myRels.length > 0 && (
					<div className="preview-entry-rels">
						{myRels.map((r) => {
							const other = r.from === entry.id ? r.to : r.from;
							return (
								<span key={r.id} className="preview-entry-rel">
									{titleOf(other)} · {r.label || r.type || "关系"}
								</span>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
