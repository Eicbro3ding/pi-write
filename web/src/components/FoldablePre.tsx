/**
 * 长内容折叠块(diff / 命令输出共用)——按行数分档,见 fold.ts 与设计稿
 * 03-组件规范/04「高度分档」。
 *
 * 短内容原样铺开(不折叠、不给展开入口);中/长内容收到 12 行 + 底部渐隐,
 * 点「展开全部(共 N 行)」后最高 480px、块内滚动。
 */
import { useMemo, useState } from "react";
import { collapsedText, countLines, FOLD_EXPANDED_MAX_PX, foldLabel, isFoldable } from "../fold.ts";

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
	const body = open ? text : collapsedText(text);
	return (
		<div className={`fold${open ? " open" : ""}${openClassName ? ` ${openClassName}` : ""}`} style={open ? { maxHeight: FOLD_EXPANDED_MAX_PX } : undefined}>
			<pre className={className}>{body}</pre>
			{!open && <div className="fold-mask" aria-hidden="true" />}
			<button type="button" className="fold-more" onClick={() => setOpen((v) => !v)}>
				{open ? "收起" : foldLabel(lines)}
			</button>
		</div>
	);
}
