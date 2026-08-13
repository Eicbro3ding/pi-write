import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

interface InputBarProps {
	/** 是否正在流式生成;为 true 时按钮变为「中断」。 */
	streaming: boolean;
	onSend: (text: string) => void;
	onAbort: () => void;
	/** 占位文案;缺省保持现有对话提示。 */
	placeholder?: string;
	/** textarea 的可访问名称;缺省为「消息输入」。 */
	ariaLabel?: string;
}

/** 输入框暴露的命令句柄:供外部按钮触发同一发送路径(如编剧「选中文本自动填入」)。 */
export interface InputBarHandle {
	/** 提交当前输入文本(trim 后为空则忽略);成功发送后清空输入框。 */
	submit: () => void;
	/** 外部预填(编剧「选中文本自动填入」):仅当输入框当前为空时填入并聚焦(光标在末尾);
	 *  已有输入不覆盖,返回是否填入。 */
	prefillIfEmpty: (text: string) => boolean;
}

/** textarea 自动增高的最大高度(px),超过后内部滚动。 */
const MAX_HEIGHT = 160;

/**
 * 输入框:单行自动增高的 textarea,Ctrl+Enter 发送、Enter 换行;
 * 流式中输入保持可用(可插话),按钮切换为「中断」。
 * 可选 placeholder / ariaLabel;ref 暴露 submit 句柄,供外部按钮触发同一发送路径。
 */
export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(
	{
		streaming,
		onSend,
		onAbort,
		placeholder = "向 pi 发一句话(Ctrl+Enter 发送,Enter 换行,流式中可插话)",
		ariaLabel = "消息输入",
	},
	ref,
) {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement>(null);

	// textarea 自动增高(受 MAX_HEIGHT 约束)。
	// 注意:双常驻标签(伙伴栏对话/批注)下,隐藏标签内的输入条在 display:none 容器中
	// 挂载,scrollHeight 为 0——仅靠 [text] 依赖会把 textarea 钉成 0 高度,切换标签后
	// 输入条塌陷直到用户输入才恢复。ResizeObserver 在容器恢复显示(尺寸 0 → 实际)
	// 时重算,标签切换后输入条立即回到正常高度。
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		const resize = () => {
			ta.style.height = "auto";
			ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT)}px`;
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(ta);
		return () => ro.disconnect();
	}, [text]);

	function send() {
		const t = text.trim();
		if (t.length === 0) return;
		setText("");
		onSend(t);
	}

	// 无依赖数组:每次渲染重建句柄,保证闭包读到最新 text
	useImperativeHandle(ref, () => ({
		submit: () => send(),
		prefillIfEmpty: (t: string) => {
			if (text.trim().length > 0) return false;
			setText(t);
			requestAnimationFrame(() => {
				const ta = taRef.current;
				if (ta) {
					ta.focus();
					ta.setSelectionRange(t.length, t.length);
				}
			});
			return true;
		},
	}));

	function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.ctrlKey && e.key === "Enter") {
			e.preventDefault();
			send();
		}
	}

	return (
		<div className="inputbar">
			<div className="inputbar-inner">
				<textarea
					ref={taRef}
					rows={1}
					value={text}
					placeholder={placeholder}
					aria-label={ariaLabel}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={handleKey}
				/>
				{streaming ? (
					<button className="btn-abort" aria-label="停止生成" onClick={onAbort}>
						中断
					</button>
				) : (
					<button className="btn-send" aria-label="发送" disabled={text.trim().length === 0} onClick={send}>
						发送
					</button>
				)}
			</div>
		</div>
	);
});
