/**
 * 会话模式:每轮先判断「这一轮用户到底要不要我动笔」(2026-10-05)。
 *
 * 为什么需要(真实会话 `writer-c-v05ij1` 复盘):
 *
 *   L118 模型数到 2824 字 → **L121 用户说「我还没叫你开始写」**
 *   → L123 立刻 `write(draft/ch02.md, content="")` 把那一章清零。
 *
 * 同样的事一轮里发生了 **5 次**:用户喊停,模型照跑。根子不是「没听见」——那些话就在
 * 上一条消息里——而是**没有地方写着这一轮处在什么状态**。模型每次都要靠通读上下文
 * 重新推断「现在能不能写」,而上下文越长越推不准。
 *
 * 所以这里把它做成**显式状态**:每轮开始根据用户的原话判定一个模式,写进记忆锚第一行。
 * 模型不必回忆,抬头看见就是了。和 InkOS / StoryEngine 那套「阶段显式可查询」是同一个
 * 思路 —— 模式必须是能读到的状态,不能藏在语境里。
 *
 * 为什么**不**做成工具拦截(只在提示词 + 记忆锚层做):
 *   判错了代价不对称 —— 把用户正常的写作拦下来,远比让它多跑一个工具糟糕。所以这里
 *   只做「提醒」,不做「禁止」。真正会造成不可逆损失的那一条(空内容覆盖)已经由
 *   `tool-rails.ts` 在工具层拦住 —— 那是零误判的硬事实,不需要猜意图。
 */

/** 会话模式。**讨论态**是默认值:判不出来时就按最保守的来。 */
export type SessionMode = "discussing" | "writing" | "revising";

/**
 * 喊停信号(优先级最高)。
 *
 * 全部来自真实会话里用户说过的原话。命中任一条就是讨论轮 —— 用户明确说了不要写,
 * 此时任何写文件的动作都是越界。
 */
const STOP_SIGNALS = [
	"还没叫你",
	"没让你写",
	"没叫你写",
	"先不急着写",
	"不急着写",
	"先别写",
	"别急着写",
	"不要写文件",
	"不用写",
	"先不要写",
	"先放一放",
	"先放到一边",
	"先暂停",
	"暂停一下",
	"停一下",
	"先等等",
	"先讨论",
	"我们先处理",
	"我们先把",
	"先把设定",
	"别动草稿",
	"别改正文",
];

/** 讨论信号:用户在征询意见、聊方向,不是在下达写作指令。 */
const DISCUSS_SIGNALS = [
	"你觉得",
	"你认为",
	"你觉得呢",
	"怎么样",
	"如何",
	"怎么看",
	"有没有可能",
	"要是",
	"假如说",
	"先聊聊",
	"讨论一下",
	"商量",
	"举个例子",
	"为什么",
	"是指",
	"什么意思",
];

/** 修订信号:已经有稿了,要改它。 */
const REVISE_SIGNALS = [
	"重写",
	"改写",
	"改一下",
	"帮我改",
	"修改",
	"精简",
	"压缩一下",
	"删掉这段",
	"删去这段",
	"润色",
	"打磨",
	"太 ai",
	"太ai",
	"换个说法",
	"这句不好",
	"这段不对",
	"哪里不对",
	"读起来",
	"顺一下",
	"批注",
];

/** 写作信号:明确了要产出新正文。 */
const WRITE_SIGNALS = [
	"开始写",
	"继续写",
	"接着写",
	"往下写",
	"写下去",
	"续写",
	"动笔",
	"起笔",
	"这一幕",
	"下一幕",
	"写出来",
	"写成正文",
	"落到正文",
	"写完",
	"补写",
	"扩写",
];

/**
 * 判定这一轮的模式。
 *
 * 优先级:**喊停 > 修订 > 写作 > 讨论**。
 * 喊停排第一是刻意的 —— 「先别写,我们先讨论剧情」里同时含讨论与写作两类词,
 * 而用户的意思只有一个:先别写。
 */
export function detectSessionMode(prompt: string): SessionMode {
	const text = (prompt ?? "").toLowerCase();
	if (!text.trim()) return "discussing";

	if (STOP_SIGNALS.some((s) => text.includes(s))) return "discussing";
	// 修订优先于写作:「这段重写一下」里的「写」不该被当成起新稿
	if (REVISE_SIGNALS.some((s) => text.includes(s))) return "revising";
	if (WRITE_SIGNALS.some((s) => text.includes(s))) return "writing";
	if (DISCUSS_SIGNALS.some((s) => text.includes(s))) return "discussing";

	// 判不出来 → 讨论态。这一步的默认选得保守:讨论轮最坏的结果是少写一段话,
	// 写作轮判错最坏的结果是悄悄改坏正文。两者不对等。
	return "discussing";
}

/** 模式的中文名,给提示词与记忆锚用。 */
export function modeLabel(mode: SessionMode): string {
	switch (mode) {
		case "writing":
			return "写作态";
		case "revising":
			return "修订态";
		default:
			return "讨论态";
	}
}

/**
 * 记忆锚里的模式行。
 *
 * 每个模式都写明**能不能写文件**,不给模型自己发挥的余地 —— 「讨论态」三个字
 * 本身不携带约束,「讨论态:不要写文件」才携带。
 */
export function modeAnchorLine(mode: SessionMode): string {
	switch (mode) {
		case "writing":
			return `【当前模式】${modeLabel(mode)} —— 用户这一轮要产出新正文。可以按场景节奏动手写草稿(read_chapter 读全文 → write/edit),一轮一个场景,写完停下等确认。`;
		case "revising":
			return `【当前模式】${modeLabel(mode)} —— 用户要改已经有了的正文。先用 read_chapter 读全文,再外科式地改(read_chapter → edit);不要急于重写未提及的段落。`;
		default:
			return `【当前模式】${modeLabel(mode)} —— 用户这一轮没有要你动笔。**不要创建、写入、清空或覆盖任何文件**(含 draft/ 草稿);直接回答或接着讨论,需要沉淀的结论用 world_update 落盘。`;
	}
}
