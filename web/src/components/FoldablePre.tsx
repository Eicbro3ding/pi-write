/**
 * 长内容折叠块(diff / 命令输出共用)——按行数分档,见 fold.ts 的「高度分档」。
 *
 * 短内容原样铺开(不折叠、不给展开入口);长内容收到**一行**,
 * 点「展开全部(共 N 行)」后最高 480px、块内滚动。
 * 底部渐隐遮罩已随「收到一行」删除(见 fold.ts):一行就是全部可见内容,
 * 再罩渐变等于把它糊掉。
 *
 * 开合动画(2026-10-17 重做):此前是「换文本 = 硬切」——裁到 12 行再换一份全文,
 * 而 `mode="wait"` 的 opacity 交叉中途还有一帧空白,看着像闪一下。现在**保留全量
 * 文本**,折叠由 `.fold-body` 的 max-height 过渡表达(12 行 ↔ 480px);行数与上限
 * 来自 fold.ts 的常量,经 CSS 变量注入,不在样式表里另写一份。折叠态靠 overflow
 * 裁切而不是截断文本:截断会让收起动画的第一帧就少几百行,看起来是塌陷不是收起。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { countLines, FOLD_COLLAPSED_LINES, FOLD_EXPANDED_MAX_PX, foldLabel, isFoldable } from "../fold.ts";

export function FoldablePre({
	text,
	className,
	/** 附加在展开态容器上的类(便于不同卡片微调)。 */
	openClassName,
}: {
	text: string;
	className?: string;
	openClassName?: string;
}) {
	const lines = useMemo(() => countLines(text), [text]);
	const [open, setOpen] = useState(false);
	const foldable = isFoldable(lines);

	if (!foldable) {
		return <pre className={className}>{text}</pre>;
	}
	const vars = {
		"--fold-lines": FOLD_COLLAPSED_LINES,
		"--fold-max": `${FOLD_EXPANDED_MAX_PX}px`,
	} as CSSProperties;
	return (
		<div className={`fold${open ? " open" : ""}${openClassName ? ` ${openClassName}` : ""}`} style={vars}>
			{/* 折叠体就是 <pre> 本身:1lh 必须取命令输出自己的行高(11px/1.55),
			    外面再套一层 div 会继承 14px/1.65,12 行会被算成 23px 一行。 */}
			<pre className={`${className ?? ""} fold-body`}>{text}</pre>
			<button type="button" className="fold-more" onClick={() => setOpen((v) => !v)}>
				{open ? "收起" : foldLabel(lines)}
			</button>
		</div>
	);
}
