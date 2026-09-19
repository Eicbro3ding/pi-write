import { useEffect, useRef, useState } from "react";
import type { ChapterRef, WorldEntryDto } from "../types.ts";
import { imageUrl, type ApiClient } from "../api/client.ts";
import { ENTRY_TYPE_LABELS } from "./WorldTree.tsx";
import { snapshotFiles } from "./file-input.ts";
import { friendlyError } from "../errors.ts";
import { Select } from "./Select.tsx";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { Lu } from "./Lu.tsx";

/** 条目状态选项(值与后端 world-data ENTRY_STATUSES 对齐;设计稿 05 下拉只列中文名)。 */
export const ENTRY_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "alive", label: "在世" },
	{ value: "dead", label: "已故" },
	{ value: "unknown", label: "未知" },
	{ value: "active", label: "活跃" },
	{ value: "archived", label: "已归档" },
	{ value: "draft", label: "草稿" },
];

/** 条目状态 → 中文短名(胶囊/状态行用)。 */
export const ENTRY_STATUS_LABELS: Record<string, string> = Object.fromEntries(
	ENTRY_STATUS_OPTIONS.map((s) => [s.value, s.label]),
);

/** 图库上限(与后端 world-data MAX_ENTRY_IMAGES 一致)。 */
const MAX_ENTRY_IMAGES = 9;

/** 条目类型图标(头部圆形图标 + 条目卡头像兜底)。 */
export function EntryTypeIcon({ type, size = 16 }: { type: WorldEntryDto["type"]; size?: number }) {
	const common = {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.5,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		"aria-hidden": true,
	};
	if (type === "world") {
		return (
			<Lu icon="globe" size={14} />
		);
	}
	if (type === "timeline") {
		return (
			<Lu icon="activity" size={14} />
		);
	}
	if (type === "outline") {
		return (
			<Lu icon="file-text" size={14} />
		);
	}
	return (
		<Lu icon="user-round" size={14} />
	);
}

interface EntryFormProps {
	/** 当前选中条目(由父组件保证非 null)。 */
	entry: WorldEntryDto;
	onChange: (next: WorldEntryDto) => void;
	/** 请求删除(二次确认模态由页面统一承载)。 */
	onRequestDelete: () => void;
}

/**
 * 条目表单(设计稿 08 中栏):头部 = 类型图标 + 标题 + 类型胶囊 + 状态胶囊 + 删除;
 * 正文区 = 标题(大输入)/ 关键词 chips / 正文 textarea(右下字数)。
 * 右侧信息栏(主图 / ID / 类型 / 状态 / 激活 / 关联章节 / 父条目)见 EntryInfoPanel。
 * 修改直接回调 onChange,由页面统一置脏并整体保存。
 */
export function EntryForm({ entry, onChange, onRequestDelete }: EntryFormProps) {
	const set = (patch: Partial<WorldEntryDto>) => onChange({ ...entry, ...patch });
	const [addingKey, setAddingKey] = useState(false);
	const [keyDraft, setKeyDraft] = useState("");

	// 条目切换(父组件以 key=entry.id 重挂载,此处兜底)时收起关键词输入
	useEffect(() => {
		setAddingKey(false);
		setKeyDraft("");
	}, [entry.id]);

	function addKey() {
		const t = keyDraft.trim();
		if (t !== "" && !entry.keys.includes(t)) set({ keys: [...entry.keys, t] });
		setKeyDraft("");
		setAddingKey(false);
	}

	return (
		<div className="w-form">
			<div className="w-form-head">
				<span className={`w-entry-icon type-${entry.type}`}>
					<EntryTypeIcon type={entry.type} />
				</span>
				<h2 className="w-form-title">{entry.title || "未命名"}</h2>
				<span className="w-pill">{ENTRY_TYPE_LABELS[entry.type]}</span>
				<span className="w-pill status">{ENTRY_STATUS_LABELS[entry.status] ?? entry.status}</span>
				<button type="button" className="btn-ghost danger w-form-del" onClick={onRequestDelete}>
					删除
				</button>
			</div>

			<label className="w-field w-field-wide">
				<span className="w-field-label">标题</span>
				<span className="w-title-wrap">
					<input
						className="w-title-input"
						type="text"
						value={entry.title}
						placeholder="未命名"
						onChange={(e) => set({ title: e.target.value })}
					/>
					{entry.title !== "" && (
						<button type="button" className="w-title-clear" title="清空标题" aria-label="清空标题" onClick={() => set({ title: "" })}>
							✕
						</button>
					)}
				</span>
			</label>

			<div className="w-field w-field-wide">
				<span className="w-field-label">关键词</span>
				<div className="w-keys">
					{entry.keys.map((k) => (
						<span key={k} className="w-key-chip">
							{k}
							<button
								type="button"
								title={`移除关键词 ${k}`}
								aria-label={`移除关键词 ${k}`}
								onClick={() => set({ keys: entry.keys.filter((x) => x !== k) })}
							>
								✕
							</button>
						</span>
					))}
					{addingKey ? (
						<input
							className="w-key-input"
							type="text"
							autoFocus
							value={keyDraft}
							placeholder="关键词,回车添加"
							onChange={(e) => setKeyDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") addKey();
								else if (e.key === "Escape") {
									setKeyDraft("");
									setAddingKey(false);
								}
							}}
							onBlur={() => (keyDraft.trim() === "" ? setAddingKey(false) : addKey())}
						/>
					) : (
						<button type="button" className="w-key-add" onClick={() => setAddingKey(true)}>
							<Lu icon="plus" size={13} /> 添加关键词
						</button>
					)}
				</div>
			</div>

			<div className="w-field w-field-wide w-body-field">
				<span className="w-field-label w-body-label">
					<span>正文</span>
					<span className="w-body-count">{entry.body.length} 字</span>
				</span>
				<textarea
					className="w-body-input"
					value={entry.body}
					placeholder="条目正文(如人物外貌、性格、背景故事…)"
					onChange={(e) => set({ body: e.target.value })}
				/>
			</div>
		</div>
	);
}

interface EntryInfoPanelProps {
	entry: WorldEntryDto;
	/** 全部条目(用于父条目下拉)。 */
	entries: WorldEntryDto[];
	/** 当前书章节(多选关联章节)。 */
	chapters: ChapterRef[];
	/** 章节列表是否加载成功(false 时禁用章节选择)。 */
	chaptersOk: boolean;
	/** 所属书 slug(图片访问 URL 与上传)。 */
	slug: string;
	/** API 客户端(图片上传/删除)。 */
	client: ApiClient;
	onChange: (next: WorldEntryDto) => void;
}

/**
 * 条目信息栏(设计稿 08 右栏,300px 卡片):主图(+ 更换/图库)、条目 ID(mono +
 * 复制)、类型(只读胶囊)、状态(Select)、是否激活(ToggleSwitch)、关联章节
 * (复选清单)、父条目(Select),底部「修改会自动保存」小字。
 * ids/章节多选的数组语义与提交逻辑与旧版完全一致(entry.chapters: string[])。
 */
export function EntryInfoPanel({ entry, entries, chapters, chaptersOk, slug, client, onChange }: EntryInfoPanelProps) {
	const set = (patch: Partial<WorldEntryDto>) => onChange({ ...entry, ...patch });
	const [uploading, setUploading] = useState(false);
	const [uploadErr, setUploadErr] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const fileRef = useRef<HTMLInputElement | null>(null);

	/** 父条目候选:同类型其它条目,排除自身与自身后代(防环);跨类型的当前 parent 保留兜底。 */
	const parentOptions = (() => {
		const childrenOf = new Map<string, WorldEntryDto[]>();
		for (const e of entries) {
			if (!e.parent) continue;
			const arr = childrenOf.get(e.parent) ?? [];
			arr.push(e);
			childrenOf.set(e.parent, arr);
		}
		const banned = new Set([entry.id]);
		const stack = [entry.id];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			for (const c of childrenOf.get(cur) ?? []) {
				if (!banned.has(c.id)) {
					banned.add(c.id);
					stack.push(c.id);
				}
			}
		}
		const opts = entries
			.filter((e) => e.type === entry.type && !banned.has(e.id))
			.map((e) => ({ id: e.id, title: e.title }));
		// 当前 parent 不在候选(如跨类型指向)时也保留,避免下拉丢失当前值
		if (entry.parent && !opts.some((o) => o.id === entry.parent)) {
			const p = entries.find((e) => e.id === entry.parent);
			if (p) opts.unshift({ id: p.id, title: `${p.title}(跨类型)` });
		}
		return opts;
	})();

	async function copyId() {
		try {
			await navigator.clipboard?.writeText(entry.id);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			/* 剪贴板不可用(非安全上下文):忽略,id 仍在页面上可见 */
		}
	}

	/**
	 * 多选上传:逐张上传,单张失败跳过并提示,成功引用追加;无主图时第一张自动设为主图。
	 * 按剩余槽位截断:累加器达到图库上限后停止上传余下文件,并提示跳过的张数。
	 * (逻辑与旧词条卡一致,2026-08 设计稿把主图管理移到条目信息栏)
	 */
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
		if (uploading) return;
		const images = entry.images.filter((x) => x !== file);
		const avatar = entry.avatar === file ? (images[0] ?? null) : entry.avatar;
		onChange({ ...entry, images, avatar, updatedAt: Date.now() });
		try {
			await client.deleteImage(slug, file);
		} catch {
			/* 孤儿文件无害,引用已移除 */
		}
	}

	/** 关联章节勾选切换(数组语义不变:全不勾 = 全部章节生效)。 */
	function toggleChapter(id: string) {
		set({ chapters: entry.chapters.includes(id) ? entry.chapters.filter((x) => x !== id) : [...entry.chapters, id] });
	}

	return (
		<aside className="w-info">
			<div className="w-info-row w-info-photo">
				<div className="w-info-head">
					<span className="w-field-label">主图</span>
					<button type="button" className="w-info-link" disabled={uploading} onClick={() => fileRef.current?.click()}>
						{uploading ? "上传中…" : entry.avatar ? "更换" : "上传"}
					</button>
				</div>
				<div className="w-photo">
					{entry.avatar ? (
						<img src={imageUrl(slug, entry.avatar)} alt={entry.title} />
					) : (
						<span className="w-photo-empty">暂无主图</span>
					)}
				</div>
				{entry.images.length > 1 && (
					<div className="entry-images-grid w-photo-grid">
						{entry.images.map((f) => (
							<div key={f} className={f === entry.avatar ? "entry-img-cell avatar" : "entry-img-cell"}>
								<img src={imageUrl(slug, f)} alt="" />
								{f === entry.avatar && <span className="entry-img-tag">主图</span>}
								<span className="entry-img-ops">
									<button type="button" title="设为主图" aria-label="设为主图" disabled={f === entry.avatar} onClick={() => set({ avatar: f, updatedAt: Date.now() })}>
										◎
									</button>
									<button type="button" title="删除" aria-label="删除" disabled={uploading} onClick={() => void removeImage(f)}>
										✕
									</button>
								</span>
							</div>
						))}
					</div>
				)}
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
				{uploadErr && <div className="entry-upload-err">{uploadErr}</div>}
			</div>

			<div className="w-info-row">
				<span className="w-field-label">条目 ID</span>
				<span className="w-info-value">
					<span className="w-info-mono" title={entry.id}>
						{entry.id}
					</span>
					<button type="button" className="w-info-copy" title="复制 ID" aria-label="复制 ID" onClick={() => void copyId()}>
						{copied ? <Lu icon="check" size={13} /> : <Lu icon="copy" size={13} />}
					</button>
				</span>
			</div>

			<div className="w-info-row">
				<span className="w-field-label">类型</span>
				<span className="w-info-value">
					<span className={`w-pill type-${entry.type}`}>{ENTRY_TYPE_LABELS[entry.type]}</span>
				</span>
			</div>

			<div className="w-info-row">
				<span className="w-field-label">状态</span>
				<Select className="sel-block" value={entry.status} onChange={(v) => set({ status: v })} options={ENTRY_STATUS_OPTIONS} />
			</div>

			<div className="w-info-row w-info-switch">
				<span className="w-field-label">是否激活</span>
				<ToggleSwitch checked={entry.active} onChange={(v) => set({ active: v })} ariaLabel="是否注入上下文" />
			</div>

			<div className="w-info-row">
				<span className="w-field-label">关联章节</span>
				{chaptersOk ? (
					chapters.length === 0 ? (
						<div className="w-field-hint">当前书没有章节</div>
					) : (
						<div className="w-chapters">
							{chapters.map((c, i) => {
								const on = entry.chapters.includes(c.id);
								return (
									<label key={c.id} className={on ? "w-chapter on" : "w-chapter"} title={`${c.file}${c.exists ? "" : "(文件缺失)"}`}>
										<input type="checkbox" checked={on} onChange={() => toggleChapter(c.id)} />
										<span className="w-chapter-no">{String(i + 1).padStart(2, "0")}</span>
										<span className="w-chapter-title">
											{c.title}
											{c.exists ? "" : " · 缺失"}
										</span>
									</label>
								);
							})}
						</div>
					)
				) : (
					<div className="w-field-hint">章节列表不可用,无法选择关联章节</div>
				)}
			</div>

			<div className="w-info-row">
				<span className="w-field-label">父条目</span>
				<Select
					className="sel-block"
					value={entry.parent ?? ""}
					onChange={(v) => set({ parent: v === "" ? null : v })}
					options={[{ value: "", label: "无(根条目)" }, ...parentOptions.map((o) => ({ value: o.id, label: o.title || "未命名" }))]}
				/>
			</div>

			<div className="w-info-foot">修改会自动保存</div>
		</aside>
	);
}
