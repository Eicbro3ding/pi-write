/**
 * 「对话与章节」两选一(绑定章节 / 分离)。
 *
 * **唯一实现**:设置页「高级 → 对话与章节」卡与首启向导「对话范围」步共用,
 * 两处对这两种关系的说法必须一字不差地一致 —— 与 CreationModeCards 同一套约定。
 *
 * 值就是服务端 `~/.pi/writer/settings.json` 的 `conversationScope`(见
 * src/writer-settings.ts);组件本身**不落盘**:调用方负责写服务端 + 失败回滚
 * (见 App.changeConversationScope)。骨架(卡片 DOM 与样式)在 `ChoiceCards.tsx`,
 * 这里只有数据。
 */
import type { ConversationScopeDto } from "../types.ts";
import type { ChoiceOption } from "./ChoiceCards.tsx";
import { ChoiceCards } from "./ChoiceCards.tsx";
import { IconBook, IconChat } from "./Icons.tsx";

/**
 * 两种关系的差异(与 src/web/writer-host.ts 的 resolveRef / writerDraftFile 逐条对齐):
 * - 绑定章节:章节即会话,一节一段对话,编剧只改当前章节的正文;
 * - 分离:对话与章节各聊各的,对话里的 AI 能编辑任意章节(需求原话)。
 *
 * ⚠️ 「默认」标签跟着**服务端默认值**走(见 `src/writer-settings.ts` 的
 * `defaultWriterSettings().conversationScope` 与 `web/src/settings.ts` 的
 * `parseConversationScope`)。默认值再翻转时,标签要跟着搬到另一张上。
 */
export type ConversationScopeOption = ChoiceOption<ConversationScopeDto>;

export const CONVERSATION_SCOPES: readonly ConversationScopeOption[] = [
	{
		value: "chapter",
		Icon: IconBook,
		title: "绑定章节",
		tag: "默认",
		sub: "新章节 = 新对话",
		points: [
			"每章一段独立对话,切章节即切对话",
			"编剧只改当前章节的正文,上下文跟着章节走",
			"章节侧栏就是切换器,界面最简",
		],
	},
	{
		value: "book",
		Icon: IconChat,
		title: "分离",
		tag: "自由",
		sub: "对话与章节各聊各的,AI 可编辑任意章节",
		points: [
			"对话可以自由新建、切换、删除,数量不限",
			"章节也可以自由新建,切章节不切对话",
			"对话里的 AI 能编辑任意章节的正文",
		],
	},
];

export function ConversationScopeCards({
	scope,
	onPick,
	busy = false,
	disabled = false,
}: {
	/** 当前的关系(服务端 conversationScope)。 */
	scope: ConversationScopeDto;
	/** 选中另一种关系;写服务端与失败回滚由调用方负责。 */
	onPick: (scope: ConversationScopeDto) => void;
	/** 切换请求进行中(卡片进入禁用态,避免连点)。 */
	busy?: boolean;
	/** 外部原因禁用(如向导正在完成)。 */
	disabled?: boolean;
}) {
	return (
		<ChoiceCards
			ariaLabel="对话与章节"
			options={CONVERSATION_SCOPES}
			value={scope}
			onPick={onPick}
			busy={busy}
			disabled={disabled}
		/>
	);
}
