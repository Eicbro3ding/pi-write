/**
 * 消息版本切换器(「‹ 2 / 2 ›」)—— 参考微信多版本消息:同一条消息有多个版本时,
 * 在气泡下缘右对齐画一排「箭头 + 序号」,点箭头就地切到上/下一个版本。
 *
 * 为什么不做成下拉:分支栏(顶部的下拉)回答的是「整段对话有哪几条分支」,而用户
 * 真正想改的往往是**某一条消息** —— 编辑重发或重新生成之后,他想的是「换回上一版
 * 那句」,不是一个抽象的 leaf id。序号是「第几版 / 共几版」,与分支栏的分支数不是
 * 一回事(一条分支上可以有好几个多版本的位置)。
 *
 * 纯展示:index / total / onSelect 全由调用方给,自己不发请求、不读 window ——
 * UI 房契约要求(node 下能 SSR 渲染)。
 */
import { Lu } from "./Lu.tsx";

export function MessagePager({
	index,
	total,
	disabled = false,
	onSelect,
}: {
	/** 当前版本下标(0 起)。 */
	index: number;
	/** 版本总数;< 2 时整块不渲染(没有可切的东西就不画控件)。 */
	total: number;
	/** 禁用(流式中服务端拒绝 navigate;整条消息还没结束时也不该切)。 */
	disabled?: boolean;
	/** 切到第 i 个版本;调用方负责 navigate 到对应的分支终点。 */
	onSelect: (index: number) => void;
}) {
	if (total < 2) return null;
	const safe = Math.min(Math.max(index, 0), total - 1);
	return (
		<div className="msg-pager" role="group" aria-label={`消息版本 ${safe + 1} / ${total}`}>
			<button
				type="button"
				className="pager-btn"
				title="上一个版本"
				aria-label="上一个版本"
				disabled={disabled || safe <= 0}
				onClick={() => onSelect(safe - 1)}
			>
				<Lu icon="chevron-left" size={14} strokeWidth={1.8} />
			</button>
			<span className="pager-count" aria-hidden="true">
				{safe + 1} / {total}
			</span>
			<button
				type="button"
				className="pager-btn"
				title="下一个版本"
				aria-label="下一个版本"
				disabled={disabled || safe >= total - 1}
				onClick={() => onSelect(safe + 1)}
			>
				<Lu icon="chevron-right" size={14} strokeWidth={1.8} />
			</button>
		</div>
	);
}
