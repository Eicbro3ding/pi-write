import type { NoticeDto } from "../types.ts";

/** Notice 字数上限(与后端 world-data NOTICE_LIMIT 一致)。 */
export const NOTICE_LIMIT = 1000;

interface NoticePanelProps {
	notice: NoticeDto;
	onChange: (next: NoticeDto) => void;
}

/**
 * Notice 面板:textarea + enabled 开关 + 字数计数(超 1000 字红色提示,
 * 保存时后端会拒绝)。修改直接回调 onChange,由页面统一保存。
 */
export function NoticePanel({ notice, onChange }: NoticePanelProps) {
	const over = notice.text.length > NOTICE_LIMIT;
	return (
		<section className="w-panel">
			<div className="s-head">Notice</div>
			<div className="w-panel-row">
				<label className="w-switch">
					<input
						type="checkbox"
						checked={notice.enabled}
						onChange={(e) =>
							onChange({ ...notice, enabled: e.target.checked, updatedAt: Date.now() })
						}
					/>
					<span>每次会话注入 Notice</span>
				</label>
			</div>
			<textarea
				rows={5}
				value={notice.text}
				placeholder="书级 Notice:写作目标、世界观基调、禁止事项等,每次会话开头注入给模型"
				onChange={(e) => onChange({ ...notice, text: e.target.value, updatedAt: Date.now() })}
			/>
			<div className={over ? "w-count over" : "w-count"}>
				{notice.text.length} / {NOTICE_LIMIT} 字{over ? "(超限,保存将被拒绝)" : ""}
			</div>
		</section>
	);
}
