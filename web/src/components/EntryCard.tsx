import { useEffect, useMemo, useRef, useState } from "react";
import type { WorldEntryDto, WorldRelationDto } from "../types.ts";
import type { ApiClient } from "../api/client.ts";
import { imageUrl } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { ENTRY_TYPE_LABELS } from "./WorldTree.tsx";
import { ENTRY_STATUS_OPTIONS } from "./EntryForm.tsx";
import { resolveKeysCommit } from "../keys.ts";
import { renderMarkdown } from "../markdown.ts";
import { snapshotFiles } from "./file-input.ts";

/**
 * 词条面板(维基百科式侧栏):顶部大图轮播(左右点击切换 + 计数器)+
 * 缩略图条(跳转/设主图/删除/上传);下方默认展示态(大标题、元信息行、
 * keys、正文 markdown、关系列表),点「编辑」切换到表单态。
 * 编辑回调 onChange,由父组件置脏并整体走 putWorld。
 */
interface EntryCardProps {
	entry: WorldEntryDto;
	/** 全部条目(用于关系对端标题解析)。 */
	entries: WorldEntryDto[];
	relations: WorldRelationDto[];
	/** 所属书 slug:拼图片访问 URL。 */
	slug: string;
	/** API 客户端(图片上传/删除)。 */
	client: ApiClient;
	/** 跳转到对端条目(父组件联动图上高亮)。 */
	onJump: (id: string) => void;
	onChange: (next: WorldEntryDto) => void;
	/** 关闭详情(关系图节点弹出的词条卡需要;世界书页普通面板不传)。 */
	onClose?: () => void;
}

/** 图库上限(与后端 world-data MAX_ENTRY_IMAGES 一致)。 */
const MAX_ENTRY_IMAGES = 9;

/** 条目状态 → 中文显示名(ENTRY_STATUS_OPTIONS 的 label 前缀,如 "在世 (alive)" → "在世")。 */
const STATUS_LABEL: Record<string, string> = Object.fromEntries(
	ENTRY_STATUS_OPTIONS.map((s) => [s.value, s.label.split(" (")[0]!]),
);

export function EntryCard({ entry, entries, relations, slug, client, onJump, onChange, onClose }: EntryCardProps) {
	const set = (patch: Partial<WorldEntryDto>) => onChange({ ...entry, ...patch });
	const [editing, setEditing] = useState(false);
	const [currentIdx, setCurrentIdx] = useState(0);
	const [uploading, setUploading] = useState(false);
	const [uploadErr, setUploadErr] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const [keysDraft, setKeysDraft] = useState(entry.keys.join(", "));
	// 条目切换(父组件以 key=entry.id 重挂载,此处兜底)时重置展示态
	useEffect(() => {
		setEditing(false);
		setCurrentIdx(0);
	}, [entry.id]);

	/** 当前展示图索引:删除/切换后越界自动收敛到最后一张。 */
	const safeIdx = entry.images.length === 0 ? 0 : Math.min(currentIdx, entry.images.length - 1);
	const currentFile = entry.images[safeIdx] ?? null;

	/** 轮播:上一张/下一张(循环;无图时不动——按钮只在多图时渲染,防御式兜底)。 */
	const prevImage = () => {
		if (entry.images.length === 0) return;
		setCurrentIdx((entry.images.length + safeIdx - 1) % entry.images.length);
	};
	const nextImage = () => {
		if (entry.images.length === 0) return;
		setCurrentIdx((safeIdx + 1) % entry.images.length);
	};

	/** 提交 keys 草稿:决策逻辑与 EntryForm 共用(resolveKeysCommit)。 */
	function commitKeys() {
		const outcome = resolveKeysCommit(keysDraft, entry.keys);
		setKeysDraft(outcome.draft);
		if (outcome.keys !== null) set({ keys: outcome.keys });
	}

	/** 多选上传:逐张上传,单张失败跳过并提示,成功引用追加;无主图时第一张自动设为主图。
	 *  按剩余槽位截断:累加器达到图库上限后停止上传余下文件,并提示跳过的张数。 */
	async function onFiles(list: FileList | File[] | null) {
		if (!list) return;
		const files = Array.from(list);
		if (files.length === 0 || uploading) return;
		setUploading(true);
		setUploadErr(null);
		try {
			let next = entry;
			let skipped = 0;
			let errMsg: string | null = null;
			for (const f of files) {
				if (next.images.length >= MAX_ENTRY_IMAGES) {
					skipped++;
					continue;
				}
				try {
					const { file } = await client.uploadImage(slug, f);
					const images = next.images.includes(file) ? next.images : [...next.images, file];
					next = { ...next, images, avatar: next.avatar ?? file, updatedAt: Date.now() };
				} catch (err) {
					errMsg = `「${f.name}」上传失败: ${friendlyError(err)}`;
				}
			}
			if (skipped > 0) {
				const skipMsg = `图库最多 ${MAX_ENTRY_IMAGES} 张,已跳过 ${skipped} 张`;
				setUploadErr(errMsg ? `${errMsg}\n${skipMsg}` : skipMsg);
			} else if (errMsg) {
				setUploadErr(errMsg);
			}
			if (next !== entry) onChange(next);
		} finally {
			setUploading(false);
		}
	}

	/** 删除图片:先移除引用(删主图则回退图库下一张),再删文件;删文件失败不阻塞。 */
	async function removeImage(file: string) {
		if (uploading) return; // 上传进行中禁止删除(与上传按钮一致的 disabled 语义)
		const images = entry.images.filter((x) => x !== file);
		const avatar = entry.avatar === file ? (images[0] ?? null) : entry.avatar;
		onChange({ ...entry, images, avatar, updatedAt: Date.now() });
		try {
			await client.deleteImage(slug, file);
		} catch {
			/* 孤儿文件无害,引用已移除 */
		}
	}

	/** 本条目参与的关系(含方向);对端条目被删时 other 为 undefined(禁用跳转)。 */
	const rels = useMemo(() => {
		const out: Array<{ rel: WorldRelationDto; other: WorldEntryDto | undefined; outgoing: boolean }> = [];
		for (const r of relations) {
			if (r.from === entry.id) out.push({ rel: r, other: entries.find((e) => e.id === r.to), outgoing: true });
			else if (r.to === entry.id) out.push({ rel: r, other: entries.find((e) => e.id === r.from), outgoing: false });
		}
		return out;
	}, [entry.id, relations, entries]);

	return (
		<aside className="entry-card">
			<div className="entry-card-head">
				<span className="entry-card-title">词条</span>
				<span className="entry-card-type">{ENTRY_TYPE_LABELS[entry.type]}</span>
				{!entry.active && <span className="entry-card-off">未激活</span>}
				{onClose && (
					<button type="button" className="entry-card-close" onClick={onClose} title="关闭详情" aria-label="关闭详情">
						✕
					</button>
				)}
			</div>

			{/* 图片查看器(维基风:大图轮播 + 计数器 + 缩略图条) */}
			<div className="entry-viewer-wrap">
				<div className="entry-viewer">
					{currentFile ? (
						<img src={imageUrl(slug, currentFile)} alt={entry.title} />
					) : (
						<div className="entry-viewer-empty">暂无图片</div>
					)}
					{currentFile && entry.images.length > 1 && (
						<>
							<button type="button" className="entry-viewer-zone left" onClick={prevImage} title="上一张" aria-label="上一张">
								<span className="entry-viewer-arrow">‹</span>
							</button>
							<button type="button" className="entry-viewer-zone right" onClick={nextImage} title="下一张" aria-label="下一张">
								<span className="entry-viewer-arrow">›</span>
							</button>
							<span className="entry-viewer-counter">
								{safeIdx + 1} / {entry.images.length}
							</span>
						</>
					)}
				</div>
				<div className="entry-viewer-caption">
					<span className="entry-viewer-caption-text">
						{currentFile ? (currentFile === entry.avatar ? "★ 主图" : "图片") : "未设置图片"}
					</span>
					<span className="entry-viewer-total">共 {entry.images.length} 张</span>
				</div>
				<div className="entry-thumbs">
					{entry.images.map((f, i) => (
						<div key={f} className={i === safeIdx ? "entry-thumb on" : "entry-thumb"}>
							<button
								type="button"
								className="entry-thumb-img"
								title={f === entry.avatar ? "主图 · 点击查看" : "点击查看"} aria-label={f === entry.avatar ? "主图 · 点击查看" : "点击查看"}
								onClick={() => setCurrentIdx(i)}
							>
								<img src={imageUrl(slug, f)} alt="" />
							</button>
							{f === entry.avatar && <span className="entry-img-tag">主图</span>}
							<span className="entry-img-ops">
								<button type="button" title="设为主图" aria-label="设为主图" disabled={f === entry.avatar} onClick={() => set({ avatar: f, updatedAt: Date.now() })}>◎</button>
								<button type="button" title="删除" aria-label="删除" disabled={uploading} onClick={() => void removeImage(f)}>✕</button>
							</span>
						</div>
					))}
					<button
						type="button"
						className="entry-thumb-add"
						title="上传图片" aria-label="上传图片"
						disabled={uploading || entry.images.length >= MAX_ENTRY_IMAGES}
						onClick={() => fileRef.current?.click()}
					>
						{uploading ? "…" : "+"}
					</button>
					<input
						ref={fileRef}
						type="file"
						multiple
						accept="image/png,image/jpeg,image/webp,image/gif"
						hidden
						onChange={(e) => {
							// 先复制文件再清值:FileList 是 input 的实时对象,清空 value 会使引用同步变空
							const files = snapshotFiles(e.target.files);
							e.target.value = "";
							void onFiles(files);
						}}
					/>
				</div>
				{uploadErr && <div className="entry-upload-err">{uploadErr}</div>}
			</div>

			{editing ? (
				<div className="entry-edit-form">
					<div className="entry-edit-head">
						<span className="entry-field-label">编辑词条</span>
						<button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
							完成
						</button>
					</div>
					<label className="entry-field">
						<span className="entry-field-label">标题</span>
						<input
							type="text"
							value={entry.title}
							placeholder="未命名"
							onChange={(e) => set({ title: e.target.value })}
						/>
					</label>
					<div className="entry-grid">
						<label className="entry-field">
							<span className="entry-field-label">状态</span>
							<select value={entry.status} onChange={(e) => set({ status: e.target.value })}>
								{ENTRY_STATUS_OPTIONS.map((s) => (
									<option key={s.value} value={s.value}>
										{s.label}
									</option>
								))}
							</select>
						</label>
						<label className="entry-field">
							<span className="entry-field-label">激活</span>
							<span className="w-switch">
								<input
									type="checkbox"
									checked={entry.active}
									onChange={(e) => set({ active: e.target.checked })}
								/>
								<span>{entry.active ? "注入上下文" : "不注入"}</span>
							</span>
						</label>
					</div>
					<label className="entry-field">
						<span className="entry-field-label">Keys(逗号分隔)</span>
						<input
							type="text"
							value={keysDraft}
							placeholder="别名、触发词"
							onChange={(e) => setKeysDraft(e.target.value)}
							onBlur={commitKeys}
							onKeyDown={(e) => {
								if (e.key === "Enter") e.currentTarget.blur();
							}}
						/>
					</label>
					<label className="entry-field">
						<span className="entry-field-label">正文</span>
						<textarea
							rows={8}
							value={entry.body}
							placeholder="条目正文(如人物外貌、性格、背景故事…)"
							onChange={(e) => set({ body: e.target.value })}
						/>
					</label>
				</div>
			) : (
				<div className="entry-show">
					<div className="entry-show-head">
						<h2 className="entry-title-big">{entry.title || "未命名"}</h2>
						<button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
							编辑
						</button>
					</div>
					<div className="entry-meta">
						<span className="entry-meta-item">{ENTRY_TYPE_LABELS[entry.type]}</span>
						<span className="entry-meta-item">{STATUS_LABEL[entry.status] ?? entry.status}</span>
						<span className="entry-meta-item">{entry.active ? "已激活" : "未激活"}</span>
					</div>
					{entry.keys.length > 0 && (
						<div className="entry-keys-line">
							<span className="entry-field-label">Keys:</span>
							{entry.keys.map((k) => (
								<span key={k} className="entry-key-chip">
									{k}
								</span>
							))}
						</div>
					)}
					<div className="entry-body-show">
						{entry.body.trim() === "" ? (
							<div className="entry-body-empty">暂无正文</div>
						) : (
							<div className="entry-body prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }} />
						)}
					</div>
				</div>
			)}

			<div className="entry-rel-head">
				<span className="entry-field-label">关系({rels.length})</span>
			</div>
			{rels.length === 0 ? (
				<div className="entry-rel-empty">暂无关系,在图中点击「连线」创建</div>
			) : (
				<ul className="entry-rel-list">
					{rels.map(({ rel, other, outgoing }) => (
						<li key={rel.id}>
							<button
								type="button"
								className="entry-rel-item"
								disabled={!other}
								title={`${other ? other.title : "(已删除条目)"} — ${rel.label || rel.type}${outgoing ? " →" : " ←"}`}
								onClick={() => other && onJump(other.id)}
							>
								<span className="entry-rel-dir">{outgoing ? "→" : "←"}</span>
								<span className="entry-rel-title">{other ? other.title || "未命名" : "(已删除)"}</span>
								<span className="entry-rel-label">{rel.label || rel.type || "关系"}</span>
								{rel.emphasized && <span className="entry-rel-star">★</span>}
							</button>
						</li>
					))}
				</ul>
			)}
		</aside>
	);
}
