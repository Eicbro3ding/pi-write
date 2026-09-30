/**
 * 「UI 房」消息流分组(chat)—— 思考块 / 消息流 / 预览卡家族 / 确认卡 / 提问卡 /
 * 输入条 / 约束 / 备忘录 / 会话用量。
 *
 * 这一组回答的问题是「AI 说的话到底长什么样」:思考胶囊、动作行、摊开几十行输出的
 * 工具卡、预览与确认卡、问答记录,以及贴在对话旁边的三张面板。状态档渲染的都是各页
 * 真实在用的组件(同一个文件、同一套 props),演示数据照 DTO 形状手写。
 *
 * 四条边界:
 * 1. 写操作(onSend / onConfirm / onRevert / onEdit …)一律传空函数 —— 陈列室不许碰真实数据;
 * 2. 渲染期不读 window/document、不发请求:需要 client 的组件(NoticeBoard)由运行时给,
 *    数据走它自己的 effects(SSR 不跑 effect,渲染出的是「未打开书」那一态);
 * 3. 受控组件内部 state(输入框文字、斜杠面板)在 SSR 里进不去,那几档用
 *    `useSimulatedTyping` 在 effect 里模拟真实输入(渲染期依旧什么都不做);
 * 4. 唯一一个 `ssrSkip`(ask-user 的未回答浮层)是**真 DOM 独占** —— node 下既没有
 *    DOM 也没有 window 可量,理由写在那个展项的 note 里;其余每一档都真的在 node 下
 *    渲染过(契约测试的 SSR 冒烟)。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useUIRoomRuntime } from "../uiroom-runtime.tsx";
import type { UIRoomEntry, UIRoomSection } from "../uiroom-types.ts";
import type { AskQuestionView } from "../ask-user.ts";
import { buildDraftDiff, buildWorldDiff, type PreviewData, type WorldDiff } from "../preview.ts";
import {
	makeChapterCommand,
	makeCompactCommand,
	makeNodeCommand,
	type SlashCommand,
} from "../slash-commands.ts";
import type {
	ChatErrorInfo,
	ChatMessage,
	ContextUsageDto,
	SessionUsageStatsDto,
	StageScriptDto,
	StyleSampleDto,
	ToolCallInfo,
	WorldConstraintDto,
	WorldDataDto,
	WorldEntryDto,
	WorldRelationDto,
} from "../types.ts";
import { AskUserOverlay, AskUserRecord } from "../components/AskUserCard.tsx";
import { ConfirmCard, type ConfirmCardItem } from "../components/ConfirmCard.tsx";
import { ConstraintsPanel, CONSTRAINT_LIMIT, SAMPLE_LIMIT, StyleSamplePanel } from "../components/ConstraintsPanel.tsx";
import { InputBar } from "../components/InputBar.tsx";
import { MessageList, ThinkingBlock, ThinkingBody, ThinkingToggle, type PreviewCardSlot } from "../components/MessageList.tsx";
import { NoticeBoard } from "../components/NoticeBoard.tsx";
import { PreviewBody, PreviewCard, worldSummary } from "../components/PreviewCard.tsx";
import { PreviewEntryCard } from "../components/PreviewEntryCard.tsx";
import { PreviewGraph } from "../components/PreviewGraph.tsx";
import { UsagePanel, formatCost, formatCount } from "../components/UsagePanel.tsx";

/* ════════════════════════════════════════════════════════════════
   展示辅助
   ════════════════════════════════════════════════════════════════ */

/** 空操作:陈列室里所有回调都不许落到真实数据上。 */
const noop = () => {};
/** 输入条「页面收下这条」的语义(false 会把文字留在框里)。 */
const noopSend = () => true;
const noopEdit = () => {};
const noopRetry = () => {};

/**
 * 把一段文字「打进」受控输入框(effect 里跑,SSR 不执行)。
 *
 * 受控组件的文字是内部 state,没有对外 prop —— 陈列室要展示「有文字 / 斜杠面板 /
 * 引用菜单」就只能走真实用户路径:改 DOM 值 + 派发 input 事件,让 React 的 onChange
 * 跑起来。必须用**原型上的原生 value setter**:React 会在节点实例上自建 value 描述符
 * 做变更追踪,直接 `ta.value = x` 会被 tracker 判成「值没变」而静默吞掉这次 onChange。
 *
 * 只碰自己那个容器里的 textarea(页面里可能同时挂着别的输入条)。
 */
function useSimulatedTyping(typed: string | null) {
	const host = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (typed === null) return;
		const ta = host.current?.querySelector("textarea");
		if (!ta) return;
		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta) as object, "value")?.set;
		if (!setter) return;
		setter.call(ta, typed);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}, [typed]);
	return host;
}

/** 草稿预览数据:走真实的 buildDraftDiff(与页面同一条链路,不手搓 diff 行)。 */
function draftOf(path: string, before: string, after: string): PreviewData {
	return { kind: "draft", toolName: "edit", sections: [{ path, diff: buildDraftDiff(before, after) }] };
}

/** MessageList 的统一装配(陈列室只关心渲染形态,回调全是空转)。 */
function messageStream(props: {
	messages: ChatMessage[];
	streaming: boolean;
	compacting?: boolean;
	debug?: boolean;
	confirmCards?: ReadonlyArray<ConfirmCardItem>;
	previewCards?: ReadonlyMap<string, PreviewCardSlot>;
}): ReactNode {
	return (
		<MessageList
			messages={props.messages}
			streaming={props.streaming}
			compacting={props.compacting}
			debug={props.debug ?? false}
			confirmCards={props.confirmCards}
			previewCards={props.previewCards}
			onConfirmCard={noop}
			onRevertCard={noop}
			onEdit={noopEdit}
			onRetry={noopRetry}
			onOpenSettings={noop}
		/>
	);
}

/** 把文本补到至少 n 个字符:超限样本要真的越过上限,否则那一档名不副实。 */
function padTo(text: string, n: number): string {
	if (text.length >= n) return text;
	const unit = "\n附则:以上细则同样适用于舞台导演的即兴指令与编剧的分段建议。";
	return text + unit.repeat(Math.ceil((n - text.length) / unit.length));
}

/* ════════════════════════════════════════════════════════════════
   演示数据 —— 世界书 / 草稿 / 工具调用
   ════════════════════════════════════════════════════════════════ */

const T0 = 1_760_000_000_000;

/** 世界书条目:avatar 留 null(浏览器里走「首字头像」SVG data URL)。 */
function entry(o: Partial<WorldEntryDto> & { id: string; title: string }): WorldEntryDto {
	return {
		type: "world",
		keys: [],
		chapters: [],
		status: "",
		active: true,
		parent: null,
		tags: [],
		body: "",
		avatar: null,
		images: [],
		updatedAt: T0,
		...o,
	};
}

const E_SHEN = entry({
	id: "e-shen",
	type: "character",
	title: "守塔人 · 沈砚",
	keys: ["守塔人", "沈砚", "老沈"],
	chapters: ["ch01", "ch03"],
	status: "已登场",
	tags: ["主角", "海雾"],
	body: "六十三岁,在断崖灯塔守了十九年。左手虎口有一道旧缆绳勒出来的疤。每夜点灯三次:里屋、楼梯拐角、塔顶。话极少,答非所问是常态;他不承认自己在等人,只是把灯芯剪得越来越短。",
});
const E_SHEN_AFTER = entry({
	...E_SHEN,
	status: "动摇",
	body: `${E_SHEN.body}\n第三夜起,他开始把灯语写成账本:每一次长亮、每一次熄灭,都记在一册旧航海日志的背面。`,
});
const E_LIGHTHOUSE = entry({
	id: "e-lighthouse",
	type: "world",
	title: "断崖灯塔",
	keys: ["灯塔", "灯", "灯语"],
	chapters: ["ch01", "ch04"],
	status: "关键地点",
	tags: ["地标"],
	body: "立在断崖最北端,塔高十九丈,灯每十二秒扫过一次海面。灯语只有两种:长亮是「等」,熄灭是「别来」。塔下礁石会把汽笛送回来,所以守塔人从不承认自己听见了船。",
});
const E_HARBOR = entry({
	id: "e-harbor",
	type: "world",
	title: "雾港渡口",
	keys: ["渡口", "雾港", "栈桥"],
	chapters: ["ch03"],
	status: "已登场",
	body: "码头只有一盏灯,雾把光泡得发胀。夜航船每七天靠岸一次,下船的人从来不是守塔人等的那一个。",
});
const E_TIDE = entry({
	id: "e-tide",
	type: "timeline",
	title: "第三夜 · 退潮",
	keys: ["退潮"],
	chapters: ["ch03"],
	status: "进行中",
	body: "潮水退到第三道礁石,露出底下黑亮的石头;这一夜之后,守塔人不再数浪。",
});
const E_FOG = entry({
	id: "e-fog",
	type: "character",
	title: "雾中的少女",
	keys: ["少女", "雾"],
	chapters: ["ch03", "ch04"],
	status: "已登场",
	tags: ["新角色"],
	body: "衣服是干的,脚下没有水痕。用问句回答问题,从不回答关于船的问题。她说自己不是从船上下来的,但知道灯语的意思。",
});

const WORLD_ENTRIES: WorldEntryDto[] = [E_SHEN, E_LIGHTHOUSE, E_HARBOR, E_TIDE, E_FOG];
const WORLD_RELATIONS: WorldRelationDto[] = [
	{ id: "r-shen-light", from: "e-shen", to: "e-lighthouse", type: "守卫", label: "每夜点灯三次", emphasized: true, arrow: "single" },
	{ id: "r-light-harbor", from: "e-lighthouse", to: "e-harbor", type: "指引", label: "以灯指路", emphasized: false, arrow: "double" },
	{ id: "r-shen-harbor", from: "e-shen", to: "e-harbor", type: "往返", label: "七天去一次", emphasized: false, arrow: "double" },
	{ id: "r-fog-shen", from: "e-fog", to: "e-shen", type: "追问", label: "问他等了几年", emphasized: true, arrow: "single" },
];

function worldOf(entries: WorldEntryDto[], relations: WorldRelationDto[]): WorldDataDto {
	return {
		version: 1,
		entries,
		relations,
		constraints: [],
		styleSample: null,
		worldSummary: "",
		notice: { enabled: true, items: [] },
		storyline: { enabled: false, nodes: [] },
		timeline: [],
	};
}

const WORLD_BEFORE = worldOf([E_SHEN, E_LIGHTHOUSE, E_HARBOR, E_TIDE], WORLD_RELATIONS.slice(0, 3));
const WORLD_AFTER = worldOf(WORLD_ENTRIES, WORLD_RELATIONS);
const WORLD_DIFF: WorldDiff = buildWorldDiff(WORLD_BEFORE, WORLD_AFTER);
/** 无变更的对照(预览图「没有变化」那一档)。 */
const NO_DIFF: WorldDiff = {
	addedEntries: [],
	modifiedEntries: [],
	removedEntries: [],
	addedRelations: [],
	removedRelations: [],
	modifiedRelations: [],
};

/** 第三章原文:read 工具的真实结果,也是「小改」diff 的 before。 */
const CH03_LINES = [
	"第三章 · 归航",
	"",
	"夜航船靠岸的时候,天还没有亮。",
	"码头上的灯只剩一盏,雾把光泡得发胀。",
	"守塔人提着灯站在栈桥尽头,灯罩上结着一层盐霜。",
	"「你回来了。」他说。",
	"没有人回答他。",
	"船工把缆绳抛上木桩,绳子湿得发沉。",
	"他数了数船上下来的人,一共七个,没有一个是等他的那个。",
	"潮水退到第三道礁石,露出底下黑亮的石头。",
	"守塔人把灯抬高了一点,照见栈桥上自己的影子。",
	"「记错日子了。」他说,声音很轻。",
	"第七个人从他身边经过,回头看了他一眼。",
	"那是个很年轻的姑娘,衣服是干的。",
	"「老人家,」她说,「灯塔还亮着吗?」",
	"守塔人愣了一下,才说:「亮着。」",
	"「那就好。」",
	"她说完就往岸上走,再没有回头。",
	"守塔人在栈桥上站到天亮。",
	"天亮的时候,灯塔的光自动灭了。",
	"他把灯提回去,擦干净,放在原来的位置。",
	"这一夜他没有再数浪。",
];
const CH03_TEXT = CH03_LINES.join("\n");

/** 第四章原文:改到一半的长草稿(「大改」diff 与超限采样样本都取它)。 */
const BIG_BEFORE_LINES = [
	"第四章 · 灯语",
	"",
	"雾从半夜起就压得很低,压得灯塔顶上的铁皮一晚上都在响。",
	"守塔人把三盏灯依次点亮,先点里屋那盏,再点楼梯拐角那盏,最后才爬上塔顶。",
	"灯芯受潮,火苗抖了一下,像谁在玻璃罩里叹了口气。",
	"少女站在楼梯口,脚下没有水痕。",
	"「今晚不会有船。」她说。",
	"守塔人没有回头。",
	"他数着浪。",
	"第七次浪打上礁石的时候,他听见了铁链的声音。",
	"那是锚链,不是缆绳。",
	"他把手里的火钳放下,又拿起来,最后插回炉子里。",
	"「你数到第几次了?」少女问。",
	"「第三次。」",
	"「你刚才数的是第七次。」",
	"「海上的数字不作数。」",
	"雾更厚了。",
	"塔顶的光每十二秒扫过一次海面,扫过的地方白得像纸。",
	"守塔人忽然说:「灯灭之前,谁都别问船的名字。」",
	"少女没有再问。",
	"她走到窗边,伸手在玻璃上写了一个字,又擦掉。",
	"雾里传来一声很闷的汽笛,短,只有一下。",
	"守塔人的手停在灯罩上。",
	"「那是回音。」他说,「这边的礁石会把声音送回来。」",
	"「送回来的是谁的声音?」",
	"他没有回答。",
	"他把灯油加满,把灯罩擦干净,动作慢得像在拖延什么。",
	"少女看着他,看了很久。",
	"「你的手在抖。」",
	"「冷。」",
	"「屋里很热。」",
	"守塔人笑了一下,是那种很久没用过的笑法。",
	"「你到底是哪条船上下来的?」他终于问。",
	"少女没有回答这个问题,她问:「你等了几年?」",
	"灯塔的光扫过来,照见她脸上什么都没有。",
	"守塔人把眼睛闭上,数到第十二次扫过。",
	"「十九年。」他说。",
	"雾像退了一点,又压回来。",
	"少女说:「那你还记得船的名字。」",
	"这是一句陈述,不是提问。",
	"守塔人沉默了很久,久到炉子里的火只剩暗红。",
	"「记得。」",
	"海面上什么都没有。",
	"灯还亮着。",
];
const BIG_BEFORE = BIG_BEFORE_LINES.join("\n");

/** 改写后的第四章:保留开头 12 行、重写中间 18 行、保留尾部并续写 14 行。 */
const BIG_REWRITTEN_MIDDLE = [
	"「你数到第几次了?」少女问。",
	"「第三次。」",
	"「你刚才数的是第七次。」",
	"「海上的数字不作数。」",
	"她把手指按在窗玻璃上,玻璃没有起雾。",
	"塔顶的光每十二秒扫过一次海面,扫过的地方白得像纸。",
	"守塔人忽然说:「灯灭之前,谁都别问船的名字。」",
	"少女没有再问,只是把手收回来,指尖上没有水。",
	"雾里传来一声很闷的汽笛,短,只有一下。",
	"守塔人的手停在灯罩上,掌心贴着铁皮,烫得他没有缩手。",
	"「那是回音。」他说,「这边的礁石会把声音送回来。」",
	"「送回来的是谁的声音?」",
	"他没有回答,只是把灯油加满,把灯罩擦干净。",
	"动作慢得像在拖延什么。",
	"少女看着他,看了很久,久到炉火只剩暗红。",
	"「你的手在抖。」",
	"「冷。」",
	"「屋里很热。」",
];
const BIG_APPENDED = [
	"守塔人笑了一下,是那种很久没用过的笑法。",
	"「你到底是哪条船上下来的?」他终于问。",
	"少女没有回答这个问题,她问:「你等了几年?」",
	"灯塔的光扫过来,照见她脸上什么都没有。",
	"守塔人把眼睛闭上,数到第十二次扫过。",
	"「十九年。」他说。",
	"雾像退了一点,又压回来。",
	"少女说:「那你还记得船的名字。」",
	"这是一句陈述,不是提问。",
	"守塔人沉默了很久,久到炉子里的火彻底暗了。",
	"「记得。」",
	"海面上什么都没有。",
	"灯塔的光又扫过一次,这一次照见了栈桥上的两个人。",
	"灯还亮着。",
];
const BIG_AFTER = [
	...BIG_BEFORE_LINES.slice(0, 12),
	...BIG_REWRITTEN_MIDDLE,
	...BIG_BEFORE_LINES.slice(30),
	...BIG_APPENDED,
].join("\n");

/** 小改:第三章开头四行。 */
const SMALL_BEFORE = CH03_LINES.slice(0, 5).join("\n");
const SMALL_AFTER = [
	"第三章 · 归航",
	"",
	"夜航船靠岸的时候,天还没有亮透。",
	"码头上的灯只剩一盏,雾把光泡得发胀。",
	"守塔人提着灯站在栈桥尽头,灯罩上结着一层盐霜,像谁在上面撒过一把盐。",
	"「你回来了。」他说,声音比雾还轻。",
].join("\n");

/** bash 卡要的那几十行输出:从这个数组推出来(不是另编一份输出)。 */
const BASH_MATCHES = BIG_BEFORE_LINES.map((line, i) => `${i + 1}:${line}`).filter((l) => /灯|雾|海|船|光/.test(l));
const BASH_RESULT = `${BASH_MATCHES.join("\n")}\n\n共 ${BASH_MATCHES.length} 行匹配`;
const BASH_STREAM = BASH_MATCHES.slice(0, 5).join("\n");

const TOOL_READ: ToolCallInfo = {
	id: "call-read-ch03",
	name: "read",
	args: JSON.stringify({ path: "draft/ch03.md", offset: 1, limit: 40 }),
	result: CH03_TEXT,
	isError: false,
};
const TOOL_EDIT: ToolCallInfo = {
	id: "call-edit-ch03",
	name: "edit",
	args: JSON.stringify({
		path: "draft/ch03.md",
		oldText: "夜航船靠岸的时候,天还没有亮。",
		newText: "夜航船靠岸的时候,天还没有亮透。",
	}),
	result: JSON.stringify({
		content: [{ type: "text", text: "已更新 draft/ch03.md(+1 -1)" }],
		details: { path: "draft/ch03.md", added: 1, removed: 1 },
	}),
	isError: false,
};
const TOOL_GREP: ToolCallInfo = {
	id: "call-grep-tide",
	name: "grep",
	args: JSON.stringify({ pattern: "潮", path: "draft", glob: "*.md" }),
	result: "draft/ch03.md:19:潮水退到第三道礁石,露出底下黑亮的石头。\ndraft/ch04.md:9:第七次浪打上礁石的时候,他听见了铁链的声音。\n\n共 2 处",
	isError: false,
};
const TOOL_FAIL: ToolCallInfo = {
	id: "call-edit-fail",
	name: "edit",
	args: JSON.stringify({ path: "draft/ch05.md", oldText: "灯塔的光", newText: "灯塔的光,像一根绷紧的线" }),
	result: "Error: ENOENT: no such file or directory, open 'draft/ch05.md'",
	isError: true,
};
const TOOL_BASH: ToolCallInfo = {
	id: "call-bash-grep",
	name: "bash",
	args: JSON.stringify({ command: 'grep -n "灯\\|雾\\|海\\|船\\|光" draft/ch04.md', timeout: 30000 }),
	result: BASH_RESULT,
	isError: false,
};
const TOOL_BASH_LIVE: ToolCallInfo = {
	id: "call-bash-live",
	name: "bash",
	args: JSON.stringify({ command: 'grep -n "灯\\|雾\\|海\\|船\\|光" draft/ch05.md', timeout: 30000 }),
	result: null,
	stream: `${BASH_STREAM}\n`,
	isError: false,
};

const ASK_QUESTIONS: AskQuestionView[] = [
	{
		question: "这一场的「沉默」写到什么程度?",
		options: ["守塔人整场不开口,只用灯语", "只保留最后一句台词", "保留疑问句,去掉所有陈述句"],
		multiple: true,
	},
	{
		question: "新角色怎么进世界书?",
		options: ["新建「雾中的少女」词条", "挂到「断崖灯塔」下当子条目", "先只记在时间线里"],
	},
];
const ASK_ANSWERS = ["守塔人整场不开口,只用灯语、只保留最后一句台词", "新建「雾中的少女」词条"];
const TOOL_ASK: ToolCallInfo = {
	id: "call-ask-scene",
	name: "ask_user",
	args: JSON.stringify({ questions: ASK_QUESTIONS }),
	result: JSON.stringify({
		content: [{ type: "text", text: "用户已回答 2 个问题" }],
		details: { answers: ASK_ANSWERS.map((answer) => ({ answer })) },
	}),
	isError: false,
};
const TOOL_WORLD_UPDATE: ToolCallInfo = {
	id: "call-world-update",
	name: "world_update",
	args: JSON.stringify({
		op: "add-entry",
		entry: {
			id: "e-fog",
			type: "character",
			title: "雾中的少女",
			keys: ["少女", "雾"],
			status: "已登场",
			body: E_FOG.body,
		},
		relations: [{ from: "e-fog", to: "e-shen", type: "追问", label: "问他等了几年", arrow: "single", emphasized: true }],
	}),
	result: JSON.stringify({
		content: [{ type: "text", text: "已写入世界书:新增词条「雾中的少女」,新增关系 1 条" }],
		details: { op: "add-entry", id: "e-fog" },
	}),
	isError: false,
};
const TOOL_WRITE: ToolCallInfo = {
	id: "call-write-ch04",
	name: "write",
	args: JSON.stringify({ path: "draft/ch04.md", content: `${BIG_AFTER}\n` }),
	result: JSON.stringify({
		content: [{ type: "text", text: "已写入 draft/ch04.md(共 60 行)" }],
		details: { path: "draft/ch04.md", lines: 60 },
	}),
	isError: false,
};

/* ════════════════════════════════════════════════════════════════
   演示数据 —— 预览 / 确认 / 剧本 / 消息流
   ════════════════════════════════════════════════════════════════ */

const SMALL_DRAFT = draftOf("draft/ch03.md", SMALL_BEFORE, SMALL_AFTER);
const BIG_DRAFT = draftOf("draft/ch04.md", BIG_BEFORE, BIG_AFTER);
const WORLD_GRAPH: PreviewData = {
	kind: "world",
	toolName: "world_update",
	slug: "demo-book",
	mode: "graph",
	afterWorld: WORLD_AFTER,
	worldDiff: WORLD_DIFF,
};
const PREVIEW_ERROR: PreviewData = { kind: "draft", error: true, toolName: "write", path: "draft/ch09.md" };
const SCRIPT: StageScriptDto = {
	scene: "sc-3",
	chapter: "ch03",
	version: 4,
	definition: {
		cast: { "a-shen": ["守塔人 · 沈砚"], "a-girl": ["雾中的少女"] },
		inject: { "a-shen": { characters: ["e-shen"], world: ["e-lighthouse"], budget: 1200 } },
		rules: { minLines: 6, maxLines: 14, wrapUpWindow: 2, turn: "round-robin" },
	},
	text: {
		shared: {
			setting: "夜半,雾压着海面,灯塔的光每十二秒扫过一次甲板。",
			goal: "让守塔人第一次承认他在等一艘不会来的船。",
			beats: ["少女问起灯语", "守塔人数错浪次", "灯塔忽然熄灭", "他说出船名", "少女说出自己不是那艘船上的人"],
			tone: "克制、潮湿、不解释",
			forbidden: ["直接说出「他其实在等女儿」", "写成一场争吵"],
		},
		perActor: {
			"a-shen": {
				objective: "守住灯语,不让任何人看出他在等谁",
				state: "手上有旧伤,灯芯换了三次",
				relation: "对少女警惕,但没赶她走",
				voice: "短句,答非所问",
				boundary: "不主动提船名",
				examples: ["灯灭之前,谁都别问。"],
			},
			"a-girl": {
				objective: "确认守塔人还记得那艘船的名字",
				state: "衣服是干的,脚下没有水痕",
				voice: "用问句回答问题",
				examples: ["你数到第几次了?"],
			},
		},
	},
};
const SCRIPT_PREVIEW: PreviewData = { kind: "script", toolName: "script_confirm", sceneId: "sc-3", script: SCRIPT };

const CONFIRM_CARDS: ReadonlyArray<ConfirmCardItem> = [
	{
		id: "cc-ch03",
		kind: "draft",
		path: "draft/ch03.md",
		before: SMALL_BEFORE,
		data: SMALL_DRAFT,
		toolCallId: TOOL_EDIT.id,
		auto: false,
	},
];

const PREVIEW_SLOTS: ReadonlyMap<string, PreviewCardSlot> = new Map([
	[TOOL_WRITE.id, { data: SMALL_DRAFT }],
	[TOOL_WORLD_UPDATE.id, { data: WORLD_GRAPH }],
]);

const THINKING_TEXT = [
	"先把这一场的目标钉住:守塔人第一次承认他在等一艘不会来的船,但不能让他说出来。",
	"能用的只有三样东西——灯、潮水、他的手。灯是「等」,熄灭是「别来」,所以灯的每一次状态变化都是一句台词。",
	"少女的设定有个坑:她衣服是干的、脚下没有水痕,这已经足够说明她不是从船上下来的,如果让她自己解释就废了。所以她对所有关于船的问题都用问句挡回去。",
	"第三节的汽笛是个诱饵。守塔人一定会把锚链听成缆绳,他的辩解(「那是回音」)本身就是他要藏的东西。这里不写他的心理,只写他掌心贴着灯罩、烫得没缩手。",
	"结尾按章节大纲要停在「灯还亮着」——不是景物收尾,是把灯的两种灯语同时摆在读者面前:他还等,所以灯不灭。",
].join("\n\n");

const CHAT_MESSAGES: ChatMessage[] = [
	{
		id: "m-1",
		entryId: "e-101",
		role: "user",
		done: true,
		startedAt: T0,
		endedAt: T0 + 9_000,
		blocks: [
			{
				kind: "text",
				text: "第四章重写一下:守塔人先别开口,让灯语替他说。顺手把新出场的少女补进世界书。",
			},
		],
	},
	{
		id: "m-2",
		entryId: "e-102",
		role: "assistant",
		done: true,
		startedAt: T0 + 9_000,
		endedAt: T0 + 182_000,
		blocks: [
			{ kind: "thinking", text: THINKING_TEXT },
			{ kind: "tool", call: TOOL_READ },
			{ kind: "text", text: "先看一遍现有开头,再决定动哪几句。" },
			{ kind: "tool", call: TOOL_EDIT },
			{ kind: "tool", call: TOOL_ASK },
			{ kind: "tool", call: TOOL_GREP },
			{ kind: "tool", call: TOOL_WORLD_UPDATE },
			{ kind: "tool", call: TOOL_BASH },
			{ kind: "tool", call: TOOL_WRITE },
			{
				kind: "text",
				text: [
					"## 第四章 · 灯语(重写)",
					"",
					"改了三处:",
					"",
					"- **守塔人的台词**从 11 句压到 2 句,剩下的交给灯语与潮水;",
					"- 少女**不再解释自己的来历**,她对所有关于船的问题都用问句回答;",
					"- 结尾停在 `灯还亮着`——「等」与「别来」两种灯语同时摆在读者面前。",
					"",
					"> 灯灭之前,谁都别问船的名字。",
					"",
					"世界书那边新增了「雾中的少女」,并挂了一条指向守塔人的关系;`draft/ch03.md` 的开头也顺手补了「亮透」两个字。",
				].join("\n"),
			},
		],
	},
];

const STREAMING_MESSAGES: ChatMessage[] = [
	CHAT_MESSAGES[0]!,
	{
		id: "m-2s",
		entryId: "e-102",
		role: "assistant",
		done: false,
		startedAt: T0 + 9_000,
		blocks: [{ kind: "tool", call: TOOL_BASH_LIVE }, { kind: "text", text: "雾里那声汽笛又响了一次——" }],
	},
];

const ERROR_INFO: ChatErrorInfo = {
	raw: '429 {"error":{"message":"Rate limit reached for deepseek-chat: too many requests in 1 min. Limit: 60, Used: 61. Please retry after 3s.","type":"rate_limit_error","code":"rate_limit_exceeded"}}',
	title: "请求过于频繁",
	code: 429,
	kind: "rate",
	hint: "等几秒再试;持续触发就换一个模型,或者把并发降下来。",
	meta: "provider: deepseek · model: deepseek-chat",
};

const ERROR_MESSAGES: ChatMessage[] = [
	CHAT_MESSAGES[0]!,
	{
		id: "m-err-1",
		entryId: "e-103",
		role: "assistant",
		done: true,
		startedAt: T0 + 9_000,
		endedAt: T0 + 20_000,
		blocks: [{ kind: "tool", call: TOOL_FAIL }],
	},
	{ id: "m-err-2", role: "error", done: true, blocks: [], error: ERROR_INFO },
];

const DEBUG_MESSAGES: ChatMessage[] = [
	CHAT_MESSAGES[0]!,
	{
		id: "m-dbg",
		entryId: "e-104",
		role: "assistant",
		done: true,
		startedAt: T0 + 9_000,
		endedAt: T0 + 182_000,
		blocks: [
			{ kind: "thinking", text: THINKING_TEXT },
			{ kind: "tool", call: TOOL_READ },
			{ kind: "tool", call: TOOL_WRITE },
			{ kind: "tool", call: TOOL_BASH },
			{ kind: "tool", call: TOOL_FAIL },
			{ kind: "tool", call: TOOL_ASK },
		],
	},
];

/* ════════════════════════════════════════════════════════════════
   演示数据 —— 面板(约束 / 采样 / 用量)
   ════════════════════════════════════════════════════════════════ */

const CONSTRAINTS_OK: WorldConstraintDto[] = [
	{ id: "cst-talk", name: "对话口语化", text: "角色对话一律口语化,不用「因此」「然而」这类书面连接词。", enabled: true, target: "main" },
	{ id: "cst-god", name: "禁用上帝视角", text: "任何角色不得知道未在场的信息,包括读者已经知道的部分。", enabled: true, target: "director" },
	{ id: "cst-dash", name: "旧版:保留破折号", text: "对话里保留破折号表示打断。", enabled: false, target: "all" },
];

/** 超限约束样本:真实的规则包会比这更长,这里写到 800 字以上。 */
const CONSTRAINTS_OVER: WorldConstraintDto[] = [
	{
		id: "cst-pack",
		name: "《灯语十条》全文",
		enabled: true,
		target: "all",
		text: padTo(
			[
				"一、凡写海雾,不写「白茫茫」三字,要写它压住了什么:压住灯、压住铁皮、压住人的声音。",
				"二、凡写灯,必写灯的毛病——受潮、跳火、油不够;灯不能只是道具,它得有一个正在坏的地方。",
				"三、人物对话一律不许解释自己的动机:想说「我等你很久了」,就写他把灯芯剪短了一截。",
				"四、禁止「仿佛」「似乎」「大概」这类含糊词;不确定就用具体动作表示,不用副词修饰。",
				"五、每一节结尾留一个未落地的动作(手停在灯罩上、话说到一半),不要用景物描写收尾。",
				"六、时间线只在潮汐与灯次上做标记,不用「三天前」「很多年以后」这类叙述性时间。",
				"七、凡涉及身体状态,只写手、眼、呼吸三处,不写心情形容词,由读者自己得出情绪结论。",
				"八、全文不许出现感叹号;需要重音就用短句与断行,标点只保留逗号、句号、问号与引号。",
			].join("\n"),
			CONSTRAINT_LIMIT + 64,
		),
	},
];

const SAMPLE_OK: StyleSampleDto = {
	text: "雾从半夜起就压得很低,压得灯塔顶上的铁皮一晚上都在响。守塔人把三盏灯依次点亮,先点里屋那盏,再点楼梯拐角那盏,最后才爬上塔顶。",
	source: "第四章 · 灯语(节选)",
	updatedAt: T0,
};
/** 超限采样:整章草稿贴进采样框(远超 SAMPLE_LIMIT)。 */
const SAMPLE_OVER: StyleSampleDto = { text: BIG_BEFORE, source: "第四章 · 灯语(整章草稿)", updatedAt: T0 };

const USAGE_IDLE: SessionUsageStatsDto = {
	userMessages: 12,
	assistantMessages: 14,
	toolCalls: 31,
	toolResults: 31,
	totalMessages: 26,
	tokens: { input: 18_402, output: 6_120, cacheRead: 12_800, cacheWrite: 0, total: 37_322 },
	cost: 0.0184,
	contextUsage: { tokens: 21_400, contextWindow: 128_000, percent: 17 },
	breakdown: [{ key: "deepseek-chat", cost: 0.0184, tokens: 37_322 }],
};
const USAGE_HEAVY: SessionUsageStatsDto = {
	userMessages: 96,
	assistantMessages: 118,
	toolCalls: 402,
	toolResults: 402,
	totalMessages: 214,
	tokens: { input: 1_284_900, output: 96_300, cacheRead: 1_102_400, cacheWrite: 41_200, total: 1_422_400 },
	cost: 4.87,
	contextUsage: { tokens: 117_800, contextWindow: 128_000, percent: 92 },
	breakdown: [
		{ key: "deepseek-reasoner", cost: 3.41, tokens: 902_100 },
		{ key: "deepseek-chat", cost: 1.28, tokens: 468_300 },
		{ key: "Tools/summaries", cost: 0.18, tokens: 52_000 },
	],
};
/** 有 token 但算不出钱:该模型在目录里价格全是 0。 */
const USAGE_NO_PRICE: SessionUsageStatsDto = {
	userMessages: 8,
	assistantMessages: 9,
	toolCalls: 14,
	toolResults: 14,
	totalMessages: 17,
	tokens: { input: 96_400, output: 22_700, cacheRead: 0, cacheWrite: 0, total: 119_100 },
	cost: 0,
	contextUsage: { tokens: 31_200, contextWindow: 128_000, percent: 24 },
	breakdown: [{ key: "local-mock", cost: 0, tokens: 119_100 }],
};
const USAGE_RING: ContextUsageDto = { tokens: 112_600, contextWindow: 128_000, percent: 88 };

/* ════════════════════════════════════════════════════════════════
   展项表(顺序即页面上的顺序)
   ════════════════════════════════════════════════════════════════ */

export const CHAT_ENTRIES: readonly UIRoomEntry[] = [
	{
		id: "thinking-block",
		group: "chat",
		title: "思考块",
		module: "components/MessageList.tsx",
		symbols: ["ThinkingToggle", "ThinkingBody", "ThinkingBlock"],
		note: "流式中展开 / 结束后立刻折叠;胶囊上是字数,流式中多一个秒数(历史消息没有计时起点,不显示秒)。",
		variants: ["流式中", "已完成收起", "已展开"],
	},
	{
		id: "message-stream",
		group: "chat",
		title: "消息流",
		module: "components/MessageList.tsx",
		symbols: ["MessageList"],
		note: "一个真实回合的完整形态:思考胶囊 + 动作行 + 摊开几十行输出的工具卡 + 预览卡 + 确认卡 + 问答记录 + markdown 正文;另有流式、空态、压缩、报错、调试原始卡。",
		variants: ["对话", "流式中", "空态", "压缩中", "报错卡", "调试原始卡"],
	},
	{
		id: "preview-card",
		group: "chat",
		title: "预览卡",
		module: "components/PreviewCard.tsx",
		symbols: ["PreviewCard"],
		note: "默认开合由内容体量决定(fold.ts:超过 60 权重才收起),收起时不渲染 body 并补一行「共 N 行 diff」摘要。",
		variants: ["小改", "大改", "世界书", "剧本", "加载失败"],
	},
	{
		id: "preview-body",
		group: "chat",
		title: "预览正文",
		module: "components/PreviewCard.tsx",
		symbols: ["PreviewBody", "worldSummary"],
		note: "预览卡体内那一层(确认卡与预览卡共用,零副本):草稿 diff 分档折叠 / 世界树变更摘要行。",
		variants: ["草稿 diff", "世界 diff"],
	},
	{
		id: "preview-entry-card",
		group: "chat",
		title: "词条百科卡",
		module: "components/PreviewEntryCard.tsx",
		symbols: ["PreviewEntryCard"],
		note: "只读词条卡:类型徽标 / 状态 / 触发词 / 正文 / 关联关系。无头像时走首字头像——themeVar 取不到 DOM 时回退类型色,所以 SSR 下也能渲染。",
		variants: ["普通词条", "长正文"],
	},
	{
		id: "preview-graph",
		group: "chat",
		title: "世界树迷你图",
		module: "components/PreviewGraph.tsx",
		symbols: ["PreviewGraph"],
		note: "cytoscape 实例在 effect 里创建,所以节点里 SSR 只出一个空容器(不用 ssrSkip);浏览器里看新增条目彩色粗描边 / 修改条目虚线。",
		variants: ["有变更", "无变更"],
	},
	{
		id: "confirm-card",
		group: "chat",
		title: "编剧确认卡",
		module: "components/ConfirmCard.tsx",
		symbols: ["ConfirmCard"],
		note: "待确认(确认 / 回退两颗按钮)与免确认模式下的已应用态;体内复用预览正文,不再有第二套渲染。",
		variants: ["待确认", "已归档"],
	},
	{
		id: "ask-user",
		group: "chat",
		title: "提问卡",
		module: "components/AskUserCard.tsx",
		symbols: ["AskUserOverlay", "AskUserRecord"],
		note: "第一档给「已回答记录」:未回答态是固定定位的模态浮层(已加框),默认铺开会把格子盖住;页面壳的 SSR 用例也只渲染第一档,浮层那一档渲染期就要量出可见输入条的包围盒,SSR(node)下既没有 DOM 也没有 window 可量 → 跳过冒烟(见 ssrSkip)。",
		variants: ["已回答记录", "待回答"],
		frame: "viewport",
		ssrSkip:
			"未回答态必须量出可见输入条的包围盒(getBoundingClientRect + window.innerWidth/innerHeight),node 里既没有 document 也没有 window,组件自身没有兜底。这是真 DOM 独占的定位逻辑(与 CodeMirror / cytoscape 同类),不改组件就绕不过去。",
	},
	{
		id: "input-bar",
		group: "chat",
		title: "输入条",
		module: "components/InputBar.tsx",
		symbols: ["InputBar"],
		note: "受控文本框的文字是组件内部 state:有文字 / 斜杠面板 / 引用菜单三档在 effect 里模拟真实输入才进得去(SSR 渲染的是初始态);斜杠与 @ 菜单都是绝对定位,不会盖住整页。",
		variants: ["空", "有文字", "斜杠面板", "引用菜单", "生成中", "上下文满"],
	},
	{
		id: "constraints-panel",
		group: "chat",
		title: "约束与采样",
		module: "components/ConstraintsPanel.tsx",
		symbols: ["ConstraintsPanel", "StyleSamplePanel"],
		note: "约束行(开关 + 名称 + 作用域 + 正文 + 字数)与采样卡(来源 + 字数 + 清空);超限档把两个上限(CONSTRAINT_LIMIT 800 / SAMPLE_LIMIT 500)同时越过。",
		variants: ["正常", "超限"],
	},
	{
		id: "notice-board",
		group: "chat",
		title: "备忘录板",
		module: "components/NoticeBoard.tsx",
		symbols: ["NoticeBoard"],
		note: "待办清单:方形勾选框(完成 = 不再注入上下文)+ 「记一条待办…」输入行;完整档多一个「注入全部 agent 上下文」总开关。数据由运行时给(未开书时是空态)。",
		variants: ["完整", "紧凑"],
	},
	{
		id: "usage-panel",
		group: "chat",
		title: "会话用量卡",
		module: "components/UsagePanel.tsx",
		symbols: ["UsagePanel", "formatCount", "formatCost"],
		note: "累计 token / 成本 / 按模型拆分(含被压缩掉的历史);成本为 0 但有 token 时写明「该模型未配价格」,非有限数与 0 都走「—」。",
		variants: ["空闲", "高占用", "未计价", "统计中", "无数据"],
	},
];

/* ════════════════════════════════════════════════════════════════
   状态档(函数组件:页面用 createElement 挂载,里面可以正常调 hook)
   ════════════════════════════════════════════════════════════════ */

/* —— 思考块 ——
   「流式中」这一档不用 ThinkingBlock:它挂载时要读 localStorage(设置项
   autoExpandThinkingEnabled)决定是否展开,node 下 localStorage 是 undefined。这里
   直接演它的两个组成部分(ThinkingToggle + ThinkingBody),也正好是展项登记的三个
   导出符号里的两个;另外两档用 ThinkingBlock(done=true,不会走到那次读取)。 */
function ThinkingStreaming() {
	const [open, setOpen] = useState(true);
	return (
		<div className="think">
			<ThinkingToggle text={THINKING_TEXT} done={false} open={open} onToggle={() => setOpen((v) => !v)} />
			<ThinkingBody text={THINKING_TEXT} open={open} />
		</div>
	);
}

function ThinkingDone() {
	return <ThinkingBlock text={THINKING_TEXT} done />;
}

function ThinkingExpanded() {
	const [open, setOpen] = useState(true);
	return (
		<div className="think">
			<ThinkingToggle text={THINKING_TEXT} done open={open} onToggle={() => setOpen((v) => !v)} />
			<ThinkingBody text={THINKING_TEXT} open={open} />
		</div>
	);
}

/* —— 消息流 —— */
function StreamConversation() {
	return messageStream({ messages: CHAT_MESSAGES, streaming: false, confirmCards: CONFIRM_CARDS, previewCards: PREVIEW_SLOTS });
}

function StreamLive() {
	return messageStream({ messages: STREAMING_MESSAGES, streaming: true, previewCards: PREVIEW_SLOTS });
}

function StreamEmpty() {
	return messageStream({ messages: [], streaming: false });
}

function StreamCompacting() {
	return messageStream({ messages: CHAT_MESSAGES, streaming: false, compacting: true, confirmCards: CONFIRM_CARDS, previewCards: PREVIEW_SLOTS });
}

function StreamError() {
	return messageStream({ messages: ERROR_MESSAGES, streaming: false });
}

function StreamDebugRaw() {
	return messageStream({ messages: DEBUG_MESSAGES, streaming: false, debug: true });
}

/* —— 预览卡 —— */
function PreviewSmall() {
	return <PreviewCard data={SMALL_DRAFT} />;
}

function PreviewBig() {
	return <PreviewCard data={BIG_DRAFT} />;
}

function PreviewWorld() {
	return <PreviewCard data={WORLD_GRAPH} />;
}

function PreviewScript() {
	return <PreviewCard data={SCRIPT_PREVIEW} />;
}

function PreviewBroken() {
	return <PreviewCard data={PREVIEW_ERROR} />;
}

/* —— 预览正文 —— */
function BodyDraft() {
	return <PreviewBody data={BIG_DRAFT} />;
}

function BodyWorld() {
	return (
		<>
			<PreviewBody data={WORLD_GRAPH} />
			<div className="s-note">
				摘要行的三种取值:本次 = {worldSummary(WORLD_DIFF)};无变更 = {worldSummary(NO_DIFF) ?? "null(整行不渲染)"}
			</div>
		</>
	);
}

/* —— 词条百科卡 —— */
function EntryNormal() {
	return <PreviewEntryCard entry={E_SHEN_AFTER} allEntries={WORLD_ENTRIES} relations={WORLD_RELATIONS} slug="demo-book" />;
}

function EntryLong() {
	const long = entry({
		id: "e-long",
		type: "world",
		title: "灯语表(全文)",
		keys: ["灯语", "长明", "熄灭"],
		status: "参考",
		body: [
			"灯语只有两种,但每一种都有三层读法。",
			"",
			"**长亮 = 等。**第一层读法给船:灯塔在,航道就还在,可以靠岸。第二层读法给岸上的人:灯没灭,说明守塔人还愿意点。第三层只有守塔人自己知道——长亮是给自己看的,证明这一夜他还没认输。",
			"",
			"**熄灭 = 别来。**第一层读法依然是给船:礁石在灯下,进港会碎。第二层是给等在岸上的人:今夜不必来。第三层是守塔人对自己的判决——这一夜不再等。",
			"",
			"十九年里他只熄过两次灯。第一次是船沉的那一夜,第二次还没有发生。",
			"",
			"账本记在旧航海日志的背面:每一次长亮、每一次熄灭,后面都跟着一个数字。数字不是灯的次数,是他数过的浪。",
			"",
			"海上的数字不作数,但账本上的作数。",
		].join("\n"),
	});
	return <PreviewEntryCard entry={long} allEntries={WORLD_ENTRIES} relations={WORLD_RELATIONS} slug="demo-book" />;
}

/* —— 世界树迷你图 —— */
function GraphChanged() {
	return <PreviewGraph world={WORLD_AFTER} diff={WORLD_DIFF} slug="demo-book" />;
}

function GraphUnchanged() {
	return <PreviewGraph world={WORLD_AFTER} diff={NO_DIFF} slug="demo-book" />;
}

/* —— 编剧确认卡 —— */
function ConfirmPending() {
	return <ConfirmCard data={BIG_DRAFT} onConfirm={noop} onRevert={noop} />;
}

function ConfirmApplied() {
	return <ConfirmCard data={SMALL_DRAFT} onConfirm={noop} onRevert={noop} auto />;
}

/* —— 提问卡 —— */
function AskPending() {
	return <AskUserOverlay questions={ASK_QUESTIONS} onSubmit={noop} onCancel={noop} />;
}

function AskAnswered() {
	return <AskUserRecord questions={ASK_QUESTIONS} answers={ASK_ANSWERS} />;
}

/* —— 输入条 —— */

/** 两条插件形态的命令(真实来源是 makePluginCommand,这里只摆 renderer 侧的形态)。 */
const DEMO_PLUGIN_COMMANDS: SlashCommand[] = [
	{ trigger: "outline", hint: "按大纲推进本幕(插件命令)", run: async () => {} },
	{ trigger: "recap", hint: "小结本章已写内容(插件命令)", run: async () => {} },
];

const DEMO_COMMANDS: ReadonlyArray<SlashCommand> = [
	makeNodeCommand({ loadWorld: async () => WORLD_AFTER }),
	makeChapterCommand(),
	makeCompactCommand({ run: async () => {} }),
	...DEMO_PLUGIN_COMMANDS,
];

/** 输入条的一档:commands / context 按真实页面的方式装配(client 由运行时给,不触网)。 */
function DemoInputBar({
	typed = null,
	streaming = false,
	disabled = false,
	usage = null,
	onUsageClick,
}: {
	typed?: string | null;
	streaming?: boolean;
	disabled?: boolean;
	usage?: ContextUsageDto | null;
	onUsageClick?: () => void;
}) {
	const rt = useUIRoomRuntime();
	const host = useSimulatedTyping(typed);
	return (
		<div ref={host}>
			<InputBar
				streaming={streaming}
				sendDisabled={disabled}
				onSend={noopSend}
				onAbort={noop}
				commands={DEMO_COMMANDS}
				context={{
					client: rt.client,
					slug: rt.slug ?? "demo-book",
					bookDetail: rt.library.bookDetail,
					currentChapterFile: rt.library.currentChapter?.file ?? null,
				}}
				usage={usage}
				onUsageClick={onUsageClick}
			/>
		</div>
	);
}

function InputEmpty() {
	return <DemoInputBar />;
}

function InputTyped() {
	return <DemoInputBar typed="第三章开头再压一压:守塔人先别开口,让灯语替他说。" />;
}

function InputSlash() {
	return <DemoInputBar typed="/" />;
}

function InputAt() {
	return <DemoInputBar typed="@" />;
}

function InputStreaming() {
	return <DemoInputBar typed="那我把少女的名字放到第四章末尾,可以吗?" streaming />;
}

function InputUsageHigh() {
	return <DemoInputBar usage={USAGE_RING} onUsageClick={noop} />;
}

/* —— 约束与采样 —— */
function ConstraintsNormal() {
	return (
		<>
			<ConstraintsPanel constraints={CONSTRAINTS_OK} onConstraints={noop} />
			<StyleSamplePanel sample={SAMPLE_OK} onSample={noop} />
		</>
	);
}

function ConstraintsOver() {
	return (
		<>
			<ConstraintsPanel constraints={CONSTRAINTS_OVER} onConstraints={noop} />
			<StyleSamplePanel sample={SAMPLE_OVER} onSample={noop} />
		</>
	);
}

/* —— 备忘录板 —— */
function NoticeFull() {
	const rt = useUIRoomRuntime();
	return <NoticeBoard client={rt.client} slug={rt.slug} />;
}

function NoticeMinimal() {
	const rt = useUIRoomRuntime();
	return <NoticeBoard client={rt.client} slug={rt.slug} variant="minimal" />;
}

/* —— 会话用量卡 —— */
function UsageIdle() {
	return <UsagePanel stats={USAGE_IDLE} loading={false} err={null} onClose={noop} />;
}

function UsageHeavy() {
	return <UsagePanel stats={USAGE_HEAVY} loading={false} err={null} onClose={noop} />;
}

function UsageNoPrice() {
	return (
		<>
			<UsagePanel stats={USAGE_NO_PRICE} loading={false} err={null} onClose={noop} />
			<div className="s-note">
				口径(同一模块里的两个纯函数):formatCount(1234567) = {formatCount(1_234_567)} · formatCount(NaN) ={" "}
				{formatCount(Number.NaN)} · formatCost(0) = {formatCost(0)} · formatCost(0.00042) = {formatCost(0.00042)}
			</div>
		</>
	);
}

function UsageLoading() {
	return <UsagePanel stats={null} loading err={null} onClose={noop} />;
}

function UsageEmpty() {
	return <UsagePanel stats={null} loading={false} err={null} onClose={noop} />;
}

/* ════════════════════════════════════════════════════════════════
   状态档渲染表(标签与顺序必须与上面 ENTRIES.variants 逐字一致)
   ════════════════════════════════════════════════════════════════ */

export const CHAT_SECTION: UIRoomSection = {
	"thinking-block": [
		{ label: "流式中", note: "output 期间自动展开,胶囊上有秒数", render: ThinkingStreaming },
		{ label: "已完成收起", note: "done → 立刻折叠(组件自己的行为)", render: ThinkingDone },
		{ label: "已展开", note: "用户手动点开后的形态", render: ThinkingExpanded },
	],
	"message-stream": [
		{ label: "对话", note: "含工具卡 + 预览卡 + 确认卡", render: StreamConversation },
		{ label: "流式中", note: "工具运行中(输出快照)+ 尾部状态提示", render: StreamLive },
		{ label: "空态", note: "没有消息也没有卡片", render: StreamEmpty },
		{ label: "压缩中", note: "compacting → 压缩提示卡", render: StreamCompacting },
		{ label: "报错卡", note: "失败工具行 + 模型报错原文卡", render: StreamError },
		{ label: "调试原始卡", note: "debug=true:全部退回原始卡(名称 + 参数 + 完整结果)", render: StreamDebugRaw },
	],
	"preview-card": [
		{ label: "小改", note: "9 行 diff → 权重 < 60,默认展开", render: PreviewSmall },
		{ label: "大改", note: "65 行 diff > 阈值 60 → 默认收起 + 摘要行", render: PreviewBig },
		{ label: "世界书", note: "图模式 + 变更摘要行", render: PreviewWorld },
		{ label: "剧本", note: "剧本确认门(体内是节拍/演员指令)", render: PreviewScript },
		{ label: "加载失败", note: "预览数据取不到 → 占位", render: PreviewBroken },
	],
	"preview-body": [
		{ label: "草稿 diff", note: "多段文件 diff,超 12 行分档折叠", render: BodyDraft },
		{ label: "世界 diff", note: "图 + 摘要行(无变更时摘要为 null)", render: BodyWorld },
	],
	"preview-entry-card": [
		{ label: "普通词条", note: "人物 + 状态 + 触发词 + 关系条", render: EntryNormal },
		{ label: "长正文", note: "上千字正文:卡片内换行与滚动", render: EntryLong },
	],
	"preview-graph": [
		{ label: "有变更", note: "新增粗描边 / 修改虚线", render: GraphChanged },
		{ label: "无变更", note: "同一个世界,空 diff", render: GraphUnchanged },
	],
	"confirm-card": [
		{ label: "待确认", note: "确认 / 回退两颗按钮", render: ConfirmPending },
		{ label: "已归档", note: "auto:编辑已落盘,只读展示", render: ConfirmApplied },
	],
	"ask-user": [
		{ label: "已回答记录", note: "折在工具块里的问答(两问两答)", render: AskAnswered },
		{ label: "待回答", note: "模态浮层:多选 + 其他补充 + 翻页 1/2(固定定位,已加框)", render: AskPending },
	],
	"input-bar": [
		{ label: "空", note: "占位文案 + 禁用发送钮", render: InputEmpty },
		{ label: "有文字", note: "长句自动增高(≤160px)", render: InputTyped },
		{ label: "斜杠面板", note: "输入 / 打开命令选择(绝对定位)", render: InputSlash },
		{ label: "引用菜单", note: "输入 @ 一次搜世界书与章节", render: InputAt },
		{ label: "生成中", note: "流式中:输入仍可用,按钮变中断", render: InputStreaming },
		{ label: "上下文满", note: "88% → 圆环转红,可点开用量", render: InputUsageHigh },
	],
	"constraints-panel": [
		{ label: "正常", note: "启用计数 + 作用域胶囊 + 采样来源", render: ConstraintsNormal },
		{ label: "超限", note: `正文 > ${CONSTRAINT_LIMIT} / 采样 > ${SAMPLE_LIMIT}:字数转红`, render: ConstraintsOver },
	],
	"notice-board": [
		{ label: "完整", note: "带「注入全部 agent 上下文」总开关", render: NoticeFull },
		{ label: "紧凑", note: "variant=minimal(舞台面板用的形态)", render: NoticeMinimal },
	],
	"usage-panel": [
		{ label: "空闲", note: "十万以内的会话", render: UsageIdle },
		{ label: "高占用", note: "140 万 token + 无缓存命中 + 三行拆分", render: UsageHeavy },
		{ label: "未计价", note: "有 token 但成本为 0 → 写明原因", render: UsageNoPrice },
		{ label: "统计中", note: "loading", render: UsageLoading },
		{ label: "无数据", note: "这一章还没有会话记录", render: UsageEmpty },
	],
};
