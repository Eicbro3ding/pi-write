/**
 * 长内容折叠块(diff / 命令输出共用)——按行数分档,见 fold.ts 的「高度分档」。
 *
 * 短内容原样铺开(不折叠、不给展开入口);中/长内容收到 12 行 + 底部渐隐,
 * 点「展开全部(共 N 行)」后最高 480px、块内滚动。
 *
 * 开合动画(2026-09-30 动效覆盖度审计):此前是「换文本 = 硬切」,而思考块/预览卡
 * 都用 framer 高度动画,同类折叠体三套做法。这里用同一套 framer 交叉淡入
 * (mode="wait",--dur-fast):折叠仍按行截断(保留 DOM 体量,不把整段长 diff 铺进
 * 页面),所以不做「高度从 12 行长到 480」那种真折叠——那需要先量出折叠高度。
 */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { collapsedText, countLines, FOLD_EXPANDED_MAX_PX, foldLabel, isFoldable } from "../fold.ts";
import { DUR, EASE } from "../motion.ts";

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
		<div
			className={`fold${open ? " open" : ""}${openClassName ? ` ${openClassName}` : ""}`}
			style={open ? { maxHeight: FOLD_EXPANDED_MAX_PX } : undefined}
		>
			<AnimatePresence initial={false} mode="wait">
				<motion.div
					key={open ? "open" : "closed"}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: DUR.fast, ease: EASE.out }}
				>
					<pre className={className}>{body}</pre>
				</motion.div>
			</AnimatePresence>
			{!open && <div className="fold-mask" aria-hidden="true" />}
			<button type="button" className="fold-more" onClick={() => setOpen((v) => !v)}>
				{open ? "收起" : foldLabel(lines)}
			</button>
		</div>
	);
}
