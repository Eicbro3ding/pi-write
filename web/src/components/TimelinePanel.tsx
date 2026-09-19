import { useState } from "react";
import type { ChapterRef, TimelineEventDto } from "../types.ts";
import { newId } from "./id.ts";
import { Select } from "./Select.tsx";

interface TimelinePanelProps {
	events: TimelineEventDto[];
	chapters: ChapterRef[];
	chaptersOk: boolean;
	onChange: (next: TimelineEventDto[]) => void;
}

/**
 * 时间线卡片(设计稿 09 右栏):事件行 = 章节胶囊 + 文本 + 删除;底部为新增行
 * (章节下拉 + 事件描述 + 琥珀「添加」)。chapter 存章节 id;未知 id 原样显示。
 * 修改直接回调 onChange,整体保存。
 */
export function TimelinePanel({ events, chapters, chaptersOk, onChange }: TimelinePanelProps) {
	const [chapter, setChapter] = useState<string>("");
	const [text, setText] = useState("");
	/** 未手动选择时默认第一章。 */
	const effChapter = chapter !== "" ? chapter : chapters[0]?.id ?? "";

	function add() {
		const t = text.trim();
		if (t === "" || effChapter === "") return;
		onChange([...events, { id: newId("evt"), chapter: effChapter, text: t }]);
		setText("");
	}

	function chapterTitle(id: string): string {
		return chapters.find((c) => c.id === id)?.title ?? id;
	}

	return (
		<section className="w-card">
			<div className="w-card-head">
				<span className="w-card-title">时间线</span>
				<span className="w-card-ops">
					<span className="w-card-count">{events.length} 条</span>
				</span>
			</div>
			{events.length === 0 && <div className="w-card-empty">暂无事件，在下方新增</div>}
			{events.map((ev) => (
				<div className="w-timeline-row" key={ev.id}>
					<span className="w-chapter-tag" title={ev.chapter}>
						{chapterTitle(ev.chapter)}
					</span>
					<span className="w-timeline-text">{ev.text}</span>
					<button
						type="button"
						className="w-ibtn danger"
						title="删除事件"
						aria-label="删除事件"
						onClick={() => onChange(events.filter((x) => x.id !== ev.id))}
					>
						✕
					</button>
				</div>
			))}
			{chaptersOk ? (
				chapters.length === 0 ? (
					<div className="w-field-hint">当前书没有章节，暂无法新增事件</div>
				) : (
					<div className="w-timeline-add">
						<Select
							className="sel-inline"
							value={effChapter}
							title="所属章节"
							onChange={(v) => setChapter(v)}
							options={chapters.map((c) => ({
								value: c.id,
								label: `${c.title}${c.exists ? "" : " · 缺失"}`,
							}))}
						/>
						<input
							className="w-timeline-input"
							value={text}
							placeholder="事件描述…"
							onKeyDown={(e) => {
								if (e.key === "Enter") add();
							}}
							onChange={(e) => setText(e.target.value)}
						/>
						<button type="button" className="w-btn-amber" disabled={text.trim() === ""} onClick={add}>
							添加
						</button>
					</div>
				)
			) : (
				<div className="w-field-hint">章节列表不可用，暂无法新增事件</div>
			)}
		</section>
	);
}
