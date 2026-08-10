import { useEffect, useMemo, useState } from "react";
import type { ChapterRef, WorldEntryDto } from "../types.ts";
import { imageUrl } from "../api/client.ts";
import { ENTRY_TYPE_LABELS } from "./WorldTree.tsx";
import { resolveKeysCommit } from "../keys.ts";

/** 条目状态选项(与后端 world-data ENTRY_STATUSES 对齐)。 */
export const ENTRY_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "alive", label: "在世 (alive)" },
	{ value: "dead", label: "已故 (dead)" },
	{ value: "unknown", label: "未知 (unknown)" },
	{ value: "active", label: "活跃 (active)" },
	{ value: "archived", label: "已归档 (archived)" },
	{ value: "draft", label: "草稿 (draft)" },
];

interface EntryFormProps {
	/** 当前选中条目(由父组件保证非 null)。 */
	entry: WorldEntryDto;
	/** 全部条目(用于父条目下拉)。 */
	entries: WorldEntryDto[];
	/** 当前书章节(多选关联章节)。 */
	chapters: ChapterRef[];
	/** 章节列表是否加载成功(false 时禁用章节选择)。 */
	chaptersOk: boolean;
	/** 所属书 slug(主图缩略 URL)。 */
	slug: string;
	onChange: (next: WorldEntryDto) => void;
	onDelete: () => void;
}

/**
 * 条目编辑表单:title / id(只读)/ type(只读徽标)/ status / active /
 * keys(逗号分隔转数组)/ chapters(章节多选)/ parent(同类型其它条目,
 * 排除自身与后代防环)/ body(textarea)。修改直接回调 onChange,
 * 由页面统一置脏并整体保存。
 */
export function EntryForm({ entry, entries, chapters, chaptersOk, slug, onChange, onDelete }: EntryFormProps) {
	const [confirming, setConfirming] = useState(false);

	/** 父条目候选:同类型其它条目,排除自身与自身后代(防环);跨类型的当前 parent 保留兜底。 */
	const parentOptions = useMemo(() => {
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
	}, [entries, entry.id, entry.type, entry.parent]);

	const set = (patch: Partial<WorldEntryDto>) => onChange({ ...entry, ...patch });

	/**
	 * keys 输入草稿:受控值独立于 entry.keys 保存,逐字键入不立即解析
	 * (旧实现按 join(", ") 派生 + onChange 即解析,会吞掉尾部分隔符),
	 * blur 时才按逗号分隔解析提交。
	 */
	const [keysDraft, setKeysDraft] = useState(entry.keys.join(", "));
	// 条目切换(父组件以 key=entry.id 重挂载,此处兜底)时同步草稿
	useEffect(() => {
		setKeysDraft(entry.keys.join(", "));
	}, [entry.id]);

	/**
	 * 提交 keys 草稿:真空输入(trim 后为空)提交 [] 以清空 keys(spec 允许 keys: []);
	 * 仅含分隔符等解析结果为空的情况回退显示原值,不提交。
	 */
	function commitKeys() {
		const outcome = resolveKeysCommit(keysDraft, entry.keys);
		setKeysDraft(outcome.draft);
		if (outcome.keys !== null) set({ keys: outcome.keys });
	}

	return (
		<div className="w-entry">
			<div className="w-entry-head">
				<span className="s-head">条目</span>
				{confirming ? (
					<span className="w-entry-confirm">
						<span>删除后其子条目转为根条目,相关关系一并移除,确认?</span>
						<button type="button" className="btn-ghost danger" onClick={onDelete}>
							确认删除
						</button>
						<button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
							取消
						</button>
					</span>
				) : (
					<button type="button" className="btn-ghost danger w-entry-del" onClick={() => setConfirming(true)}>
						删除条目
					</button>
				)}
			</div>
			{entry.avatar && (
				<div className="w-entry-avatar">
					<img src={imageUrl(slug, entry.avatar)} alt={entry.title} title="主图(图库编辑在关系图页词条卡片)" />
				</div>
			)}
			<div className="w-grid">
				<label className="w-field">
					<span className="w-field-label">标题</span>
					<input
						type="text"
						value={entry.title}
						placeholder="未命名"
						onChange={(e) => set({ title: e.target.value })}
					/>
				</label>
				<label className="w-field">
					<span className="w-field-label">ID</span>
					<input className="mono" type="text" value={entry.id} readOnly title="稳定 id,不可修改" />
				</label>
				<label className="w-field">
					<span className="w-field-label">类型</span>
					<span className="w-type">{ENTRY_TYPE_LABELS[entry.type]}</span>
				</label>
				<label className="w-field">
					<span className="w-field-label">状态</span>
					<select value={entry.status} onChange={(e) => set({ status: e.target.value })}>
						{ENTRY_STATUS_OPTIONS.map((s) => (
							<option key={s.value} value={s.value}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				<label className="w-field w-field-wide">
					<span className="w-field-label">Keys(逗号分隔)</span>
					<input
						type="text"
						value={keysDraft}
						placeholder="别名、触发词,如: 凯文, 老 K"
						onChange={(e) => setKeysDraft(e.target.value)}
						onBlur={commitKeys}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
					/>
				</label>
				<label className="w-field w-field-wide">
					<span className="w-field-label">关联章节(多选,空 = 全部章节生效)</span>
					{chaptersOk ? (
						<select
							className="w-multi"
							multiple
							size={Math.min(6, Math.max(2, chapters.length))}
							value={entry.chapters}
							onChange={(e) =>
								set({ chapters: Array.from(e.target.selectedOptions, (o) => o.value) })
							}
						>
							{chapters.map((c) => (
								<option key={c.id} value={c.id} title={`${c.file}${c.exists ? "" : "(文件缺失)"}`}>
									{c.title}
									{c.label ? ` · ${c.label}` : ""}
									{c.exists ? "" : " · 缺失"}
								</option>
							))}
						</select>
					) : (
						<div className="w-field-hint">章节列表不可用,无法选择关联章节</div>
					)}
				</label>
				<label className="w-field w-field-wide">
					<span className="w-field-label">父条目</span>
					<select
						value={entry.parent ?? ""}
						onChange={(e) => set({ parent: e.target.value === "" ? null : e.target.value })}
					>
						<option value="">无(根条目)</option>
						{parentOptions.map((o) => (
							<option key={o.id} value={o.id}>
								{o.title || "未命名"}
							</option>
						))}
					</select>
				</label>
				<label className="w-field w-field-wide">
					<span className="w-field-label">激活</span>
					<span className="w-switch">
						<input
							type="checkbox"
							checked={entry.active}
							onChange={(e) => set({ active: e.target.checked })}
						/>
						<span>{entry.active ? "注入上下文" : "不注入"}</span>
					</span>
				</label>
				<label className="w-field w-field-wide">
					<span className="w-field-label">正文</span>
					<textarea
						rows={6}
						value={entry.body}
						placeholder="条目正文(如人物外貌、性格、背景故事…)"
						onChange={(e) => set({ body: e.target.value })}
					/>
				</label>
			</div>
		</div>
	);
}
