import type { WorldEntryDto, WorldRelationDto } from "../types.ts";
import { imageUrl } from "../api/client.ts";
import { ENTRY_TYPE_LABELS } from "./WorldTree.tsx";
import { ENTRY_STATUS_LABELS, EntryTypeIcon } from "./EntryForm.tsx";
import { renderMarkdown } from "../markdown.ts";
import { Lu } from "./Lu.tsx";

/**
 * 词条详情卡(设计稿 10 关系图右侧栏):圆形类型色环头像(有图用图,无图用首字)
 * + 名字 + 类型胶囊 + 状态行(在世 · 活跃)、关键词 chips、关系列表(方向图标 +
 * 关系类型胶囊 + 对方名字 + ›)、简介 markdown,底部「在「条目」中编辑 →」+
 * 删除。本体只读——编辑统一在条目视图的表单里(inline 编辑已按设计稿撤掉)。
 */
interface EntryCardProps {
	entry: WorldEntryDto;
	/** 全部条目(用于关系对端标题解析)。 */
	entries: WorldEntryDto[];
	relations: WorldRelationDto[];
	/** 所属书 slug:拼图片访问 URL。 */
	slug: string;
	/** 跳转到对端条目(父组件联动图上高亮)。 */
	onJump: (id: string) => void;
	/** 关闭详情(关系图节点弹出的词条卡需要;世界书页普通面板不传)。 */
	onClose?: () => void;
	/** 切到条目视图编辑当前条目。 */
	onEdit?: () => void;
	/** 删除当前条目(由页面弹出确认模态)。 */
	onDelete?: () => void;
}

/** 关系方向图标:text 形式的箭头(与图上箭头语义一致)。 */
function relIcon(arrow: WorldRelationDto["arrow"], outgoing: boolean): string {
	if (arrow === "none") return "—";
	if (arrow === "double") return "⇄";
	return outgoing ? "→" : "←";
}

export function EntryCard({ entry, entries, relations, slug, onJump, onClose, onEdit, onDelete }: EntryCardProps) {
	/** 本条目参与的关系(含方向);对端条目被删时 other 为 undefined(禁用跳转)。 */
	const rels: Array<{ rel: WorldRelationDto; other: WorldEntryDto | undefined; outgoing: boolean }> = [];
	for (const r of relations) {
		if (r.from === entry.id) rels.push({ rel: r, other: entries.find((e) => e.id === r.to), outgoing: true });
		else if (r.to === entry.id) rels.push({ rel: r, other: entries.find((e) => e.id === r.from), outgoing: false });
	}

	const status = ENTRY_STATUS_LABELS[entry.status] ?? entry.status;

	return (
		<aside className="entry-card">
			<div className="entry-card-head">
				<span className={`entry-card-av type-${entry.type}`}>
					{entry.avatar ? (
						<img src={imageUrl(slug, entry.avatar)} alt={entry.title} />
					) : (
						(entry.title.trim() || "?").slice(0, 1)
					)}
				</span>
				<span className="entry-card-idbox">
					<span className="entry-card-nameline">
						<span className="entry-card-name">{entry.title || "未命名"}</span>
						<span className="w-pill">{ENTRY_TYPE_LABELS[entry.type]}</span>
					</span>
					<span className="entry-card-status">
						{status} · {entry.active ? "活跃" : "未激活"}
					</span>
				</span>
				{onClose && (
					<button type="button" className="entry-card-close" onClick={onClose} title="关闭详情" aria-label="关闭详情">
						✕
					</button>
				)}
			</div>

			<div className="entry-card-sec">
				<span className="w-field-label">关键词</span>
			</div>
			{entry.keys.length === 0 ? (
				<div className="entry-card-empty">暂无关键词</div>
			) : (
				<div className="entry-card-keys">
					{entry.keys.map((k) => (
						<span key={k} className="entry-card-key">
							{k}
						</span>
					))}
				</div>
			)}

			<div className="entry-card-sec">
				<span className="w-field-label">关系 · {rels.length}</span>
			</div>
			{rels.length === 0 ? (
				<div className="entry-card-empty">暂无关系,在图中点击「连线」创建</div>
			) : (
				<ul className="entry-card-rels">
					{rels.map(({ rel, other, outgoing }) => (
						<li key={rel.id}>
							<button
								type="button"
								className={rel.emphasized ? "entry-rel-item emph" : "entry-rel-item"}
								disabled={!other}
								title={`${other ? other.title : "(已删除条目)"} — ${rel.label || rel.type}${outgoing ? " →" : " ←"}`}
								onClick={() => other && onJump(other.id)}
							>
								<span className="entry-rel-icon">{relIcon(rel.arrow ?? "double", outgoing)}</span>
								<span className="entry-rel-label">{rel.type || rel.label || "关系"}</span>
								<span className="entry-rel-title">{other ? other.title || "未命名" : "(已删除)"}</span>
								<span className="entry-rel-go">›</span>
							</button>
						</li>
					))}
				</ul>
			)}

			<div className="entry-card-sec">
				<span className="w-field-label">简介</span>
			</div>
			{entry.body.trim() === "" ? (
				<div className="entry-card-empty">暂无正文</div>
			) : (
				<div className="entry-card-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }} />
			)}

			<div className="entry-card-foot">
				{onEdit && (
					<button type="button" className="entry-card-edit" onClick={onEdit}>
						<EntryTypeIcon type={entry.type} size={13} /> 在「条目」中编辑 →
					</button>
				)}
				{onDelete && (
					<button type="button" className="entry-card-del" onClick={onDelete} title="删除条目" aria-label="删除条目">
						<Lu icon="trash-2" size={15} />
					</button>
				)}
			</div>
		</aside>
	);
}
