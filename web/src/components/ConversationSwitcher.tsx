/**
 * 对话切换器(book 模式:对话与章节各聊各的)—— AI 伙伴栏头部显示**当前对话标题** +
 * 切换入口,展开后可以切换 / 新建 / 删除。
 *
 * 纯展示组件:`conversations` 与三个回调都由 WritePage 注入,它自己不拿 client、
 * 不发请求、渲染期不读 window/document —— 所以 node 下能 SSR(UI 房契约要求)。
 *
 * 两套形态同一个实现:
 * - 桌面:`position: absolute` 的下拉浮层,挂在触发按钮下方;
 * - 手机(`phone`):`position: fixed` 的底部抽屉(类名带 `m-` 前缀,样式在 mobile.css)。
 * 两者都是条件挂载,退场走 `useExitPresence`(见 web/src/styles/presence.css)。
 *
 * 删除是**两步内联确认**(点 ✕ 后原地变成「删除 / 取消」):删一段对话不可恢复,
 * 直接删掉太容易误触,而这一层不值得为它拉一个模态对话框。
 */
import { useEffect, useRef, useState } from "react";
import { Lu } from "./Lu.tsx";
import { useExitPresence } from "../use-exit-presence.ts";
import { formatConversationTime } from "../writer-scope.ts";
import type { ConversationDto } from "../types.ts";

export function ConversationSwitcher({
	conversations,
	selectedId,
	onSelect,
	onCreate,
	onDelete,
	busy = false,
	disabled = false,
	phone = false,
}: {
	conversations: readonly ConversationDto[];
	/** 当前选中的对话 id(null = 还没就位,一般只出现在列表首次拉取的那一瞬)。 */
	selectedId: string | null;
	onSelect: (id: string) => void;
	onCreate: () => void;
	onDelete: (id: string) => void;
	/** 新建 / 删除请求进行中(禁用入口,避免连点)。 */
	busy?: boolean;
	/** 外部原因禁用(流式中等)。 */
	disabled?: boolean;
	/** 手机形态:浮层换成底部抽屉(类名 m- 前缀)。 */
	phone?: boolean;
}) {
	const [open, setOpen] = useState(false);
	/** 正在二次确认删除的对话 id(null = 无)。 */
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const presence = useExitPresence(open);
	const rootRef = useRef<HTMLDivElement>(null);
	const current = conversations.find((c) => c.id === selectedId) ?? conversations[0] ?? null;
	/** 相对时间的参照点:每次渲染取当下(列表本来就会随对话刷新重渲染)。 */
	const now = Date.now();

	/** 点浮层外面 / 按 Esc 关闭(只在打开时挂监听;SSR 下 effect 不跑)。 */
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// 关掉浮层时清掉二次确认态:下次打开不该还停在「删除?」上
	useEffect(() => {
		if (!open) setConfirmId(null);
	}, [open]);

	return (
		<div className={phone ? "cv m-cv" : "cv"} ref={rootRef}>
			<button
				type="button"
				className="cv-current"
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				title="切换对话"
				onClick={() => setOpen((v) => !v)}
			>
				<Lu icon="message-square" size={14} />
				<span className="cv-current-title">{current ? current.title : "新对话"}</span>
				{conversations.length > 1 && <span className="cv-count">{conversations.length}</span>}
				<Lu icon={open ? "chevron-up" : "chevron-down"} size={14} />
			</button>

			{presence.mounted && (
				<div className={`cv-menu${phone ? " m-cv-menu" : ""}${presence.closing ? " is-closing" : ""}`} role="listbox" aria-label="选择对话">
					<div className="cv-menu-head">
						<span className="cv-menu-title">对话</span>
						<span className="cv-menu-sub">与章节各聊各的</span>
						<button type="button" className="cv-new" disabled={busy || disabled} onClick={onCreate}>
							<Lu icon="plus" size={13} />
							新建对话
						</button>
						{phone && (
							<button type="button" className="cv-close" aria-label="关闭" title="关闭" onClick={() => setOpen(false)}>
								<Lu icon="x" size={16} />
							</button>
						)}
					</div>
					<div className="cv-list">
						{conversations.length === 0 && <div className="cv-empty">还没有对话,点「新建对话」开始</div>}
						{conversations.map((c) => {
							const on = c.id === selectedId;
							return (
								<div key={c.id} className={`cv-row${on ? " on" : ""}`}>
									{confirmId === c.id ? (
										<div className="cv-confirm">
											<span className="cv-confirm-text">删除「{c.title}」?</span>
											<button
												type="button"
												className="cv-confirm-del"
												disabled={busy}
												onClick={() => {
													setConfirmId(null);
													onDelete(c.id);
												}}
											>
												删除
											</button>
											<button type="button" className="cv-confirm-cancel" onClick={() => setConfirmId(null)}>
												取消
											</button>
										</div>
									) : (
										<>
											<button
												type="button"
												role="option"
												aria-selected={on}
												className="cv-opt"
												title={c.title}
												onClick={() => {
													onSelect(c.id);
													setOpen(false);
												}}
											>
												<span className="cv-opt-title">{c.title}</span>
												{on && <span className="cv-opt-now">当前</span>}
												<span className="cv-opt-time">{formatConversationTime(c.updatedAt, now)}</span>
											</button>
											<button
												type="button"
												className="cv-del"
												aria-label={`删除对话「${c.title}」`}
												title="删除这段对话"
												disabled={busy || disabled}
												onClick={() => setConfirmId(c.id)}
											>
												<Lu icon="trash-2" size={13} />
											</button>
										</>
									)}
								</div>
							);
						})}
					</div>
					<div className="cv-menu-foot">删除对话不会删掉任何章节正文;卡片按章节保存。</div>
				</div>
			)}
		</div>
	);
}
