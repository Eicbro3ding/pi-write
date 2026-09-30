/**
 * 世界书条目详情(只读)——手机端「世界书 · 条目详情」页。
 *
 * 为什么单独一个只读视图:桌面端点条目直接进表单(左边分类树一直在,改完即存),
 * 手机端没有树、屏幕只够一件事——先看清楚这条设定是什么,再决定要不要改。
 * 所以手机端是「详情 → 编辑条目 → 表单」两级,一致。
 *
 * 数据全部来自条目本身 + 页面传入的章节表与关系数,不额外取数:
 * 主图走 imageUrl(与世界书条目图/图片端点同源),章节 id 用章节表映射成标题。
 */
import { imageUrl } from "../api/client.ts";
import type { ChapterRef, WorldEntryDto } from "../types.ts";
import { Lu } from "./Lu.tsx";
import { ENTRY_TYPE_LABELS } from "../world-entry.ts";
import { ENTRY_STATUS_OPTIONS } from "./EntryForm.tsx";

export function WorldEntryDetail({
	entry,
	slug,
	chapters,
	relationCount,
	onEdit,
	onDelete,
	onChangeAvatar,
}: {
	entry: WorldEntryDto;
	slug: string;
	chapters: ReadonlyArray<ChapterRef>;
	/** 该条目的关系条数(「3 关系」)。 */
	relationCount: number;
	/** 进入编辑(表单)。 */
	onEdit: () => void;
	onDelete: () => void;
	/** 更换配图(手机端直接走页面持有的图片上传入口,不再复制一份上传逻辑)。 */
	onChangeAvatar: () => void;
}) {
	/** 章节 id → 标题(条目里存的是章节 id;拿不到就原样显示 id)。 */
	const chapterTitle = (id: string) => chapters.find((c) => c.id === id)?.title ?? id;
	const statusLabel = ENTRY_STATUS_OPTIONS.find((s) => s.value === entry.status)?.label ?? entry.status;
	const typeLabel = ENTRY_TYPE_LABELS[entry.type];
	const body = entry.body.trim();

	return (
		<div className="m-detail">
			{/* 配图:点击更换 */}
			<button type="button" className="m-detail-photo" onClick={onChangeAvatar} aria-label="更换配图">
				{entry.avatar ? (
					<img src={imageUrl(slug, entry.avatar)} alt={entry.title} />
				) : (
					<span className="m-detail-photo-empty">
						<Lu icon="image" size={22} />
						<span>添加配图</span>
					</span>
				)}
			</button>

			<div className="m-detail-head">
				<span className="m-detail-name">{entry.title || "未命名"}</span>
				<span className="m-detail-meta">
					<i className="m-wdot" style={{ background: `var(--type-${entry.type})` }} />
					<span style={{ color: `var(--type-${entry.type})` }}>{typeLabel}</span>
					<span className="m-detail-sep">·</span>
					<span>{relationCount} 关系</span>
					{entry.images.length > 0 && (
						<>
							<span className="m-detail-sep">·</span>
							<span>{entry.images.length} 张图</span>
						</>
					)}
				</span>
			</div>

			{body.length > 0 ? (
				<p className="m-detail-body">{body}</p>
			) : (
				<p className="m-detail-body empty">还没有正文。点下方「编辑条目」写点设定。</p>
			)}

			{entry.tags.length > 0 && (
				<div className="m-detail-tags">
					{entry.tags.map((t) => (
						<span key={t} className="m-wtag">
							{t}
						</span>
					))}
				</div>
			)}

			{/* 元信息 */}
			<div className="m-detail-card">
				<div className="m-detail-row">
					<span className="m-detail-k">条目 ID</span>
					<span className="m-detail-v mono">{entry.id}</span>
				</div>
				<div className="m-detail-row">
					<span className="m-detail-k">类型</span>
					<span className="m-detail-v">{typeLabel}</span>
				</div>
				<div className="m-detail-row">
					<span className="m-detail-k">状态</span>
					<span className="m-detail-v">{statusLabel}</span>
				</div>
				<div className="m-detail-row">
					<span className="m-detail-k">是否激活</span>
					<span className="m-detail-v">{entry.active ? "激活(注入上下文)" : "未激活"}</span>
				</div>
				<div className="m-detail-row">
					<span className="m-detail-k">关联章节</span>
					<span className="m-detail-v">
						{entry.chapters.length === 0 ? "全部章节" : entry.chapters.map(chapterTitle).join(" · ")}
					</span>
				</div>
				{entry.keys.length > 0 && (
					<div className="m-detail-row">
						<span className="m-detail-k">关键词</span>
						<span className="m-detail-v">{entry.keys.join(" · ")}</span>
					</div>
				)}
				<div className="m-detail-row">
					<span className="m-detail-k">更新时间</span>
					<span className="m-detail-v mono">{new Date(entry.updatedAt).toLocaleString("zh-CN")}</span>
				</div>
			</div>

			{/* 底部动作:编辑条目(主)+ 删除 */}
			<div className="m-detail-actions">
				<button type="button" className="m-detail-edit" onClick={onEdit}>
					<Lu icon="square-pen" size={15} />
					<span>编辑条目</span>
				</button>
				<button type="button" className="m-detail-del" onClick={onDelete} aria-label="删除条目" title="删除条目">
					<Lu icon="trash-2" size={15} />
				</button>
			</div>
		</div>
	);
}
