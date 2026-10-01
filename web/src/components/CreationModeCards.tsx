/**
 * 创作方式卡(多 Agent / 单 Agent 两张大选项卡)。
 *
 * **唯一实现**:首启向导「创作方式」步与设置页「Agent 形态」卡共用,两处对
 * 「多 Agent / 单 Agent」的说法必须一字不差地一致 —— 早先只有设置页「高级」里
 * 一个不显眼的开关,用户既看不到差别也找不到它(2026-10-02)。
 *
 * 值就是服务端 `~/.pi/writer/settings.json` 的 `classicMode`(单 Agent = true),
 * 组件本身**不落盘**:调用方负责写服务端 + 失败回滚(见 App.changeClassicMode)。
 * 骨架(卡片 DOM 与样式)在 `ChoiceCards.tsx`,这里只有数据。
 */
import type { ChoiceOption } from "./ChoiceCards.tsx";
import { ChoiceCards } from "./ChoiceCards.tsx";
import { IconEdit, IconStage } from "./Icons.tsx";

/**
 * 两种方式的差异(与 src/web/writer-host.ts 的装配逐条对齐):
 * 多 Agent = 舞台共演 + 受限常驻编剧;单 Agent = 只有编辑页 + 全量写作 agent。
 * 世界书页与设置页两种模式都在。
 *
 * ⚠️ 「默认」标签跟着**服务端默认值**走(2026-10-02 起默认 = 单 Agent,见
 * `src/writer-settings.ts` 的 `defaultWriterSettings()` 与 `web/src/settings.ts`
 * 的 `parseClassicMode`)。默认值再翻转时,标签要跟着搬到另一张卡上。
 */
export type CreationMode = ChoiceOption<boolean>;

export const CREATION_MODES: readonly CreationMode[] = [
	{
		value: false,
		Icon: IconStage,
		title: "多 Agent 协作",
		tag: "多角色",
		sub: "舞台共演 + 常驻编剧",
		points: [
			"舞台:导演、演员、旁白多角色即兴演出",
			"编辑:章节正文配一位常驻编剧,随章切换对话",
			"编剧只改当前章节,世界书改动写进 advice.md",
			"世界书:人物、设定、时间线与关系图",
		],
	},
	{
		value: true,
		Icon: IconEdit,
		title: "单 Agent 写作",
		tag: "默认",
		sub: "经典模式:一个写作 agent 包办",
		points: [
			"没有舞台:去掉导演、演员、旁白那一套",
			"编辑页换成完整写作 agent,工具全开",
			"可自由读写大纲、备忘与任意章节",
			"世界书页与设置照常保留",
		],
	},
];

export function CreationModeCards({
	classic,
	onPick,
	busy = false,
	disabled = false,
}: {
	/** 当前是不是单 Agent(服务端 classicMode)。 */
	classic: boolean;
	/** 选中另一种方式;写服务端与失败回滚由调用方负责。 */
	onPick: (classic: boolean) => void;
	/** 切换请求进行中(卡片进入禁用态,避免连点)。 */
	busy?: boolean;
	/** 外部原因禁用(如向导正在完成)。 */
	disabled?: boolean;
}) {
	return (
		<ChoiceCards
			ariaLabel="创作方式"
			options={CREATION_MODES}
			value={classic}
			onPick={onPick}
			busy={busy}
			disabled={disabled}
		/>
	);
}
