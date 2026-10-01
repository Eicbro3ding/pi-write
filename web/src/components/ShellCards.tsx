/**
 * 「执行命令(shell)」两选一(保持关闭 / 开启)。
 *
 * **唯一实现**:首启向导「执行命令」步用;设置页那一处是常驻开关(`ToggleSwitch`,
 * 页面上还带着胶囊与警示块),形态不同但**风险确认文案共用** —— `SHELL_CONFIRM_TEXT`
 * 只有一份,改口径时两处一起变。
 *
 * 值就是服务端 `~/.pi/writer/settings.json` 的 `enableShell`(默认 false)。
 * 组件本身**不落盘**:调用方负责写服务端 + 失败回滚,并且**开启必须先过风险确认条**
 * (关不需要)。骨架(卡片 DOM 与样式)在 `ChoiceCards.tsx`,这里只有数据。
 */
import type { ChoiceOption } from "./ChoiceCards.tsx";
import { ChoiceCards } from "./ChoiceCards.tsx";
import { IconLock, IconWrench } from "./Icons.tsx";

/**
 * 开启前的风险确认条正文(向导与设置页共用一份)。
 * 口径:命令与 pi-writer 同权限、能读写整台磁盘与网络、路径限制无效;
 * 唯一的约束是「看得见」——每条命令与输出都实时显示在对话里。
 */
export const SHELL_CONFIRM_TEXT =
	"开启后,命令以与 pi-writer 相同的权限在真实 shell 里运行:可以读写整台磁盘、访问网络,书目录的路径限制对它无效。它只能被「看得见」约束——每条命令与输出都会实时显示在对话里。确认开启吗?";

/**
 * 两个选项的差别(与 src/tools.ts 的 shell 工具装配、设置页「执行命令」卡对齐):
 * 关闭时内置工具(编辑器、世界书、大纲)照常可用,只是没有本机命令;
 * 开启才多出在真实 shell 里执行命令的能力。
 */
export type ShellChoice = ChoiceOption<boolean>;

export const SHELL_CHOICES: readonly ShellChoice[] = [
	{
		value: false,
		Icon: IconLock,
		title: "保持关闭",
		tag: "默认",
		sub: "不给 AI 本机命令权限",
		points: [
			"编辑器、世界书、大纲、章节这些内置工具照常可用",
			"AI 不能执行 pandoc、git、构建脚本这类本机命令",
			"随时可在「设置 → 高级 → 执行命令」里打开",
		],
	},
	{
		value: true,
		Icon: IconWrench,
		title: "开启 shell",
		tag: "需确认",
		sub: "AI 可执行本机命令与脚本",
		points: [
			"能调 pandoc、git、构建脚本这类外部工具",
			"命令与输出实时显示在对话里,你能全程看见",
			"危险:与 pi-writer 同权限,可读写整台磁盘、访问网络",
		],
	},
];

export function ShellCards({
	enabled,
	onPick,
	busy = false,
	disabled = false,
}: {
	/** 当前是否已放开外部命令(服务端 enableShell)。 */
	enabled: boolean;
	/** 选中另一个选项;**点「开启 shell」时调用方要先弹风险确认条**。 */
	onPick: (enabled: boolean) => void;
	/** 切换请求进行中(卡片进入禁用态,避免连点)。 */
	busy?: boolean;
	/** 外部原因禁用(如向导正在完成)。 */
	disabled?: boolean;
}) {
	return (
		<ChoiceCards
			ariaLabel="执行命令"
			options={SHELL_CHOICES}
			value={enabled}
			onPick={onPick}
			busy={busy}
			disabled={disabled}
		/>
	);
}
