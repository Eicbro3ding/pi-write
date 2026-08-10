import { useState } from "react";
import type { ChapterRef, TimelineEventDto } from "../types.ts";
import { newId } from "./id.ts";

interface TimelinePanelProps {
	events: TimelineEventDto[];
	chapters: ChapterRef[];
	chaptersOk: boolean;
	onChange: (next: TimelineEventDto[]) => void;
}

/**
 * 时间线面板:事件列表(chapter 标签 + 文本)+ 新增(chapter 下拉 + text)。
 * chapter 存章节 id;未知 id 原样显示。修改直接回调 onChange,整体保存。
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
		<section className="w-panel">
			<div className="s-head">时间线</div>
			{events.length === 0 && <div className="w-empty">暂无事件,在下方新增</div>}
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
						onClick={() => onChange(events.filter((x) => x.id !== ev.id))}
					>
						删
					</button>
				</div>
			))}
			{chaptersOk ? (
				<div className="w-timeline-add">
					<select
						className="w-input w-select"
						value={effChapter}
						onChange={(e) => setChapter(e.target.value)}
					>
						{chapters.map((c) => (
							<option key={c.id} value={c.id}>
								{c.title}
								{c.exists ? "" : " · 缺失"}
							</option>
						))}
					</select>
					<input
						className="w-input"
						value={text}
						placeholder="事件描述,如: 凯文在酒馆遇到神秘老者"
						onKeyDown={(e) => {
							if (e.key === "Enter") add();
						}}
						onChange={(e) => setText(e.target.value)}
					/>
					<button type="button" className="btn-ghost" disabled={text.trim() === ""} onClick={add}>
						添加
					</button>
				</div>
			) : (
				<div className="w-field-hint">章节列表不可用,暂无法新增事件</div>
			)}
		</section>
	);
}
