/**
 * UI 房 · 「舞台与布局壳」分组。
 *
 * 展项:舞台右面板(四个页签)、剧本只读视图、修订剧本模态、书库栏(四形态)、
 * 正文工作区(三档)。契约在 `web/src/uiroom-types.ts`,其它分组文件各写各的。
 *
 * 两条本地约定(与 uiroom-runtime / 兄弟分组一致):
 * - **SSR 可渲染**:状态档在 node 里用 `renderToStaticMarkup` 逐档渲染,渲染期不读
 *   window/document、不发请求(所有取数都在组件的 effects 里,SSR 不跑)。所以五个展项
 *   都不需要 `ssrSkip`;没有 DOM 独占依赖(CodeMirror 的 EditorView 也只在 effect 里 new)。
 * - **数据用替身**:`draft-workspace` 的正文与保存状态是组件**内部 state**(经 effects 从
 *   client 取回),没有受控 prop 可传,所以这里给一个不触网的 `ApiClient` 子类摆出
 *   长文 / 空稿 / 失败三档(与 uiroom-runtime 的 `demoLibrary()` 同一思路)。
 *   `chapter-sidebar` 的数据源按约定用 `demoLibrary()`,写操作一律空函数。
 */
import { useState, type ReactNode } from "react";
import type { ActorTextDto, CastConfigDto, SharedTextDto, StageScriptDto, StageSnapshotDto } from "../types.ts";
import type { UIRoomEntry, UIRoomSection } from "../uiroom-types.ts";
import { demoLibrary, useUIRoomRuntime } from "../uiroom-runtime.tsx";
import { ApiClient, ApiError } from "../api/client.ts";
import { castNameMap, emptyReviseForm, type ReviseFormState } from "../stage-web.ts";
import { ChapterSidebar } from "../components/ChapterSidebar.tsx";
import { DraftWorkspace } from "../components/DraftWorkspace.tsx";
import { ReviseScriptModal } from "../components/ReviseScriptModal.tsx";
import { ScriptView } from "../components/ScriptView.tsx";
import { StagePanel, type StagePanelTab } from "../components/StagePanel.tsx";

/* ════════════════════════════════════════════════════════════════
   展项表(顺序即页面上的顺序)
   ════════════════════════════════════════════════════════════════ */

export const STAGE_ENTRIES: readonly UIRoomEntry[] = [
	{
		id: "stage-panel",
		group: "stage",
		title: "舞台右面板",
		module: "components/StagePanel.tsx",
		symbols: ["StagePanel"],
		note: "外层页签(图标 + 下划线)四档各一:剧本 / 选角 / 修订 / 备忘录,页签可点着切。",
		variants: ["剧本", "选角", "修订", "备忘录"],
	},
	{
		id: "script-view",
		group: "stage",
		title: "剧本只读视图",
		module: "components/ScriptView.tsx",
		symbols: ["ScriptView"],
		note: "3 名演员 + 8 个节拍的正常剧本,与 shared 全空的空剧本;内层胶囊(概要/节拍/演员指令)可点。",
		variants: ["正常", "空剧本"],
	},
	{
		id: "revise-script-modal",
		group: "stage",
		title: "修订剧本模态",
		module: "components/ReviseScriptModal.tsx",
		symbols: ["ReviseScriptModal"],
		note: "860px 两栏表单:全空(看 placeholder 回显)与填满(看长表单滚动);遮罩是固定定位 → frame: viewport。",
		variants: ["默认", "长表单"],
		frame: "viewport",
	},
	{
		id: "chapter-sidebar",
		group: "stage",
		title: "书库栏",
		module: "components/ChapterSidebar.tsx",
		symbols: ["ChapterSidebar"],
		note: "章节列表 / 56px 折叠条 / 工作区模式 / 手机抽屉(drawerOpen,固定定位抽屉 → frame: phone)。",
		variants: ["章节列表", "折叠", "工作区", "手机抽屉"],
		frame: "phone",
	},
	{
		id: "draft-workspace",
		group: "stage",
		title: "正文工作区",
		module: "components/DraftWorkspace.tsx",
		symbols: ["DraftWorkspace"],
		note: "长约两千字的 markdown / 空草稿 / 加载失败(.d-error + 重试加载);正文由替身 client 在 effect 里回填。",
		variants: ["有正文", "空草稿", "出错"],
	},
];

/* ════════════════════════════════════════════════════════════════
   公共:替身与空函数
   ════════════════════════════════════════════════════════════════ */

/** 写操作一律空转(展项不许改真实数据)。 */
const noop = () => {};

/**
 * 展项里的「栏框」:真页面上书库栏 / 正文区都是三栏壳里 `flex: 1` 的子项,
 * 高度由壳给。孤立陈列时它们的高度链会断——`flex: 1` 的滚动区塌成 0,
 * 正文一行都看不见——所以这里给一个显式高度的框,只在展项内使用。
 */
function ShellBox({ height, children }: { height: number; children: ReactNode }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", height, minHeight: 0 }}>
			{children}
		</div>
	);
}

/* ════════════════════════════════════════════════════════════════
   演示数据:剧本 / 快照 / 书库 / 草稿
   ════════════════════════════════════════════════════════════════ */

/** 演示剧本:3 名演员 + 8 个节拍 + 上一版快照(修订页签的「最近一次修订」用它)。 */
function demoScript(): StageScriptDto {
	const shared: SharedTextDto = {
		setting: "夜里的渡口,江面浮着一层薄雾。栈桥尽头挂着一盏脱了漆的风灯,灯下停着一条没有桨的小船。",
		goal: "沈昭必须在天亮前说服老周开船过江;老周不信她手里那封从对岸寄来的信。",
		tone: "克制的悬念:对话短、停顿多,情绪不外露,用物件与天气推进。",
		beats: [
			"沈昭踩着湿滑的石阶下到渡口,风灯把她的影子拉长在水面上。",
			"老周在船头补网,头也不抬,说今夜不走船。",
			"沈昭把信放在船板上,信纸边缘已经被水汽浸软。",
			"老周认出了自己的字迹,补网的梭子停了一瞬。",
			"远处江心传来一声汽笛,比上一声近了许多。",
			"沈昭说出信里唯一一句没写完的话。",
			"老周解开缆绳,却把船头又拢回岸边。",
			"风灯灭了,江面只剩两道人影与一条越来越近的灯带。",
		],
		forbidden: [
			"不要写人物内心独白,用动作与停顿替代。",
			"不要出现「命运」「宿命」这类抽象词。",
			"不要让老周在第四拍之前回应信的内容。",
		],
	};
	const perActor: Record<string, ActorTextDto> = {
		"actor-1": {
			objective: "让老周相信信是真的,并且把他带上船。",
			state: "外冷内乱:手一直插在袖子里,说话前先吸气。",
			relation: "老周是她父亲生前的船工,欠沈家一条命。",
			voice: "句子短,不解释;只在关键处重复对方的话。",
			boundary: "不许哀求、不许落泪,最多在句尾停顿一次。",
			examples: ["「我不求你信我。」", "「你看看落款。」"],
		},
		"actor-2": {
			objective: "拖到天亮,等江上的灯带开过去。",
			state: "手指被网绳勒出红痕,补网的动作越来越慢。",
			relation: "他把沈昭当半个女儿,又怕她死在水里。",
			voice: "絮絮叨叨说天气、说水位,回避正题。",
			boundary: "不许正面回答「走不走」。",
			examples: ["「水太急,船出去要打横。」"],
		},
		"actor-3": {
			objective: "整场只做动作:递缆绳、挡风、看江面,一句话不说。",
			state: "赤脚站在船头,裤脚全湿。",
			voice: "(无台词)",
			examples: [],
		},
		"actor-4": {
			objective: "只写舞台指示与环境的冷描述,不评价人物、不替角色说话。",
			examples: ["风灯灭了。"],
		},
	};
	return {
		scene: "scene-03",
		chapter: "第一章 · 渡口",
		version: 3,
		definition: {
			cast: { "actor-1": ["沈昭"], "actor-2": ["老周"], "actor-3": ["阿枝"], "actor-4": [] },
			inject: {
				"actor-1": { characters: ["沈昭"], world: ["渡口"], budget: 900 },
				"actor-2": { characters: ["老周"], world: ["渡口", "灯带"], budget: 800 },
				"actor-3": { world: ["渡口"], budget: 500 },
				"actor-4": { budget: 300 },
			},
			rules: { minLines: 4, maxLines: 9, wrapUpWindow: 2, turn: "round-robin" },
		},
		text: { shared, perActor },
		previous: {
			version: 2,
			text: {
				shared: {
					setting: "夜里的渡口,栈桥尽头挂着一盏风灯。",
					goal: "沈昭要说服老周开船过江。",
					tone: "克制。",
					beats: ["沈昭下到渡口。", "老周说不走船。", "江心传来汽笛。", "老周解开缆绳。"],
					forbidden: ["不要写内心独白。"],
				},
				perActor: {
					"actor-1": { objective: "说服老周。", examples: [] },
					"actor-2": { objective: "拖到天亮。", examples: [] },
				},
			},
			rules: { minLines: 3, maxLines: 7, wrapUpWindow: 1 },
			at: Date.now() - 12 * 60 * 1000,
		},
	};
}

const DEMO_SCRIPT = demoScript();

/** 空剧本:shared 全空、没有节拍、没有 perActor(− 剧本视图没有空态,这一档就是那一档)。 */
const EMPTY_SCRIPT: StageScriptDto = {
	scene: "scene-01",
	chapter: "第一章 · 渡口",
	version: 1,
	definition: {
		cast: {},
		inject: {},
		rules: { minLines: 1, maxLines: 3, wrapUpWindow: 1, turn: "round-robin" },
	},
	text: {
		shared: { setting: "", goal: "", tone: "", beats: [], forbidden: [] },
		perActor: {},
	},
};

/** 演示演员池(选角页签):named / pool / narrator 三类各一枚 + 一个未选角槽位。 */
const DEMO_CAST: CastConfigDto = {
	version: 2,
	actors: [
		{ id: "actor-1", type: "named", character: "沈昭", model: "claude-sonnet-4-5", thinking: "high" },
		{ id: "actor-2", type: "named", character: "老周", model: "gpt-5" },
		{ id: "actor-3", type: "pool", character: "船工" },
		{ id: "actor-4", type: "narrator", character: "叙述者" },
	],
};

/** 演出中的舞台快照(面板四档共用;开演中 + 有剧本 + 有上一版修订记录)。 */
const DEMO_SNAPSHOT: StageSnapshotDto = {
	slug: "demo-book",
	chapterFile: "ch01.jsonl",
	sceneId: "scene-03",
	phase: "running",
	status: "normal",
	mode: "directing",
	script: DEMO_SCRIPT,
	cast: DEMO_CAST,
	transcript: [
		{
			id: "entry-1",
			scene: "scene-03",
			turn: 3,
			actor: "actor-2",
			character: "老周",
			content: [{ type: "text", text: "水太急,船出去要打横。" }],
			ts: Date.now() - 4 * 60 * 1000,
		},
	],
	counts: { lines: 27, perActor: { "actor-1": 9, "actor-2": 9, "actor-3": 4, "actor-4": 5 }, perCharacter: { 沈昭: 9, 老周: 9, 阿枝: 4, 叙述者: 5 }, cnChars: 1834, turn: 9 },
	directorLast: undefined,
	directorChat: [],
	avatars: {},
	directorUsage: null,
	pendingScript: null,
};

/** 书库替身(与 SSR 冒烟用的同一份 demoLibrary;模块级常量,引用稳定)。 */
const LIBRARY = demoLibrary();

/** 长表单档:填满 11 个字段(节拍 10 行 / 禁区 5 行),看两栏滚动与 textarea 高度。 */
function longReviseForm(): ReviseFormState {
	return {
		setting: "夜里的渡口,江面浮着一层薄雾;栈桥尽头那盏风灯脱了一角漆,火苗被风掰成两半又合上,灯下停着一条没有桨的小船。",
		goal: "沈昭必须在天亮前说服老周开船过江;老周不信她手里那封从对岸寄来的信,而江心的灯带正一盏接一盏地靠近。",
		tone: "克制的悬念:对话短、停顿多,情绪不外露;用物件(网、缆绳、灯)与天气推进,不用形容词堆情绪。",
		beats: [
			"沈昭踩着湿滑的石阶下到渡口,风灯把她的影子拉长在水面上。",
			"老周在船头补网,头也不抬,说今夜不走船。",
			"沈昭把信放在船板上,信纸边缘已经被水汽浸软。",
			"老周认出了自己的字迹,补网的梭子停了一瞬。",
			"远处江心传来一声汽笛,比上一声近了许多。",
			"沈昭说出信里唯一一句没写完的话。",
			"老周站起来解缆绳,两下没解开,索性用牙咬住绳头。",
			"第二声汽笛响起,江面尽头浮起一条灯带。",
			"老周解开了缆绳,却把船头又拢回岸边。",
			"风灯灭了,江面只剩两道人影。",
		].join("\n"),
		forbidden: [
			"不要写人物内心独白,用动作与停顿替代。",
			"不要出现「命运」「宿命」这类抽象词。",
			"不要让老周在第四拍之前回应信的内容。",
			"不要出现现代科技词汇(手机、电话、汽车)。",
			"不要写血腥描写。",
		].join("\n"),
		minLines: "4",
		maxLines: "12",
		wrapUpWindow: "3",
		actorId: "actor-1",
		objective: "让老周相信信是真的,并且把他带上船;越接近天亮,越要少说话。",
		boundary: "不许哀求、不许落泪,最多在句尾停顿一次;不许提「父亲」两个字。",
		voice: "句子短,不解释;只在关键处重复对方的话,重复时不改一个字。",
	};
}

/** 演示正文:一篇约两千字的 markdown(标题 / 引用 / 列表 / 小标题,供滚动与排版对照)。 */
const DRAFT_TEXT = `# 第一章 · 渡口

## 一

腊月的江风是从水面爬上来的,先湿了裤脚,再往骨头里钻。沈昭在石阶上站了半刻,才看清栈桥尽头那盏风灯——灯罩脱了一角漆,火苗被风掰成两半,又合上。

栈桥下停着一条没有桨的小船。船头坐着个人,背对着岸,手里一张网,梭子进进出出,像在数什么。

「周叔。」

那人没回头,只把网往膝盖上拢了拢。「今夜不走船。」

沈昭踩着湿木板上船,船身晃了一下,水面把灯影揉碎了。她没坐下,站在船尾,袖口里捏着那封信,指节硌得生疼。

「对岸来信了。」她说。

梭子停了一瞬。老周把网线咬断,吐掉线头,才慢慢转过身来。他脸上没有表情,眼睛却先落在她袖口上,又移开。

「信是死的。」他说,「水是活的。」

沈昭把那封信放在船板上。信纸边缘被水汽浸软,折痕处已经起了毛。落款那三个字写得很慢,笔画中间有停顿,像是写字的人手在抖。

老周的手停在半空。

> 老周说过:江上的人不看钟,看灯。

远处江心传来一声汽笛。声音闷,像是从水底翻上来的。两人都没说话,直到那声音散尽,老周才低头去看落款。

「谁给你的。」

「渡口西边的茶馆。」沈昭说,「他让我天亮前一定要交到你手上。」

老周笑了一下,不是笑她。「他要是还活着,不会让你走夜路。」

「所以他让你走。」

补网的梭子搁在船板上,发出一声轻响。老周站起来,伸手去解缆绳。绳子被水泡得发涨,他解了两下没解开,索性用牙咬住绳头。

沈昭看着他,一动不动。

## 二

第二声汽笛来了,比上一声近。江面尽头浮起一条灯带,一盏接一盏,像谁在水上撒了一把火。

船上的东西不多,数得出:

- 一张补了一半的网,网眼里卡着一片枯叶;
- 一根泡了一冬的缆绳,咬开会尝到铁锈味;
- 一盏风灯,灯罩上的漆掉了一角,火苗被风掰成两半;
- 一封信,折痕处起了毛,最后一句话没有写完。

老周解开了缆绳,却没有推船下水。他把船头往岸上又拢了拢,伸手把风灯从钩子上取下来,搁在船板正中——像是怕它被风吹灭,又像是怕它照见什么。

「上去。」他说,「站在灯下。」

「你走不走。」

老周没答。他把网从膝盖上拿开,压在船板正中,又把那封信折好,塞进自己怀里。做完这些,他才抬眼看她,眼神跟刚才不一样了。

「信里最后一句没写完。」他说,「你替我说完。」

沈昭张了张嘴。风从江心吹过来,把她的头发吹到脸上。她抬手拨开,手心里全是冷汗。

「他写的是——」

第三声汽笛截断了她的话。这一声很近,近到能听见机器下面的水声。灯带已经铺满了半边江面,一盏一盏地亮,亮得没有温度。

老周把缆绳绕在手腕上,绕了两圈,忽然问:「你会水吗。」

「不会。」

「那就坐着,别站起来。」他把风灯吹灭了,「黑一点,好走。」

小船离岸的时候,沈昭回头看了一眼栈桥。石阶上没有人,只有风把那盏灭了的灯吹得轻轻晃。江面很宽,宽到对岸的灯要走上很久才能到。

她把手放进袖子里,捏住了那封信的另一半——那半张纸她一直没拿出来。上面只有一行字,是写给老周的。

## 三

船到江心,雾反而淡了。老周不说话,只是撑;他撑船的姿势像在跟水较劲,每一下都很重。

沈昭坐在船尾,数着灯。数到第三十七盏的时候,她听见老周开口了,声音很低,像说给自己听:

「他当年也是这么说的——黑一点,好走。」

沈昭没有回头。她把手里的半张纸攥紧了,纸边被她自己的手汗泡软。江风吹过,她闻到了铁锈味,混着一点旧纸的味道。

再往前,江面就宽得没有边了。
`;

/**
 * 演示用正文 client:`DraftWorkspace` 的正文/保存状态是**内部 state**(effect 里
 * `getDraft` 回填),没有受控 prop,所以只能换 client 摆状态。构造不触网(ApiClient
 * 构造函数只存 baseUrl),失败档抛 404 让界面走 `friendlyError` 的产品文案。
 */
class DemoDraftClient extends ApiClient {
	/** effect 里 getDraft 返回的正文。 */
	private readonly seed: string;
	/** true = 每次都抛 404,展示 `.d-error` 失败态与「重试加载」。 */
	private readonly failing: boolean;

	constructor(seed: string, failing = false) {
		super();
		this.seed = seed;
		this.failing = failing;
	}

	async getDraft(): Promise<{ text: string; mtime: number }> {
		if (this.failing) throw new ApiError(404, "演示:草稿文件不存在");
		return { text: this.seed, mtime: Date.now() };
	}

	async putDraft(): Promise<number> {
		return Date.now();
	}
}

/** 三档各自的 client(模块级单例:client 换新实例会让 DraftWorkspace 重新加载)。 */
const DRAFT_CLIENT = new DemoDraftClient(DRAFT_TEXT);
const EMPTY_DRAFT_CLIENT = new DemoDraftClient("");
const ERROR_DRAFT_CLIENT = new DemoDraftClient("", true);

/* ════════════════════════════════════════════════════════════════
   状态档
   ════════════════════════════════════════════════════════════════ */

/**
 * 舞台右面板:四个页签各一档。页签是真交互(`onTab` 由展项自己的 state 接管),
 * 面板容器沿用 StagePage 的 `.stage-panel`(宽度与高度在那里由轨宽/壳高给,
 * 这里显式给一份,否则 `flex: 1` 的滚动区没有高度)。
 */
function StagePanelDemo({ initial }: { initial: StagePanelTab }) {
	const rt = useUIRoomRuntime();
	const [tab, setTab] = useState<StagePanelTab>(initial);
	return (
		<aside className="stage-panel" style={{ width: 360, height: 470 }}>
			<StagePanel
				client={rt.client}
				slug={rt.slug ?? "demo-book"}
				snapshot={DEMO_SNAPSHOT}
				tab={tab}
				onTab={setTab}
				onRevise={noop}
				onToggleCollapse={noop}
			/>
		</aside>
	);
}

/** 修订模态:表单由父级(StagePanel)持有,展项里用自己的 useState 让输入能落字。 */
function ReviseModalDemo({ long }: { long: boolean }) {
	const [form, setForm] = useState<ReviseFormState>(() => (long ? longReviseForm() : emptyReviseForm()));
	return (
		<ReviseScriptModal
			script={DEMO_SCRIPT}
			castNames={castNameMap(DEMO_SCRIPT.definition.cast)}
			form={form}
			onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
			onSubmit={noop}
			onClose={noop}
			busy={false}
		/>
	);
}

/** 工作区模式的演示内容(真页面注入 WorkspacePanel;展项只放静态条目,不发请求)。 */
function DemoWorkspace() {
	return (
		<>
			<div className="ws-group">
				<div className="ws-group-head">
					<span>草稿</span>
					<span className="ws-count">3</span>
					<span className="ws-lock" title="草稿在编辑页里直接编辑">编辑页</span>
				</div>
				<div className="ws-group-desc">章节正文的 markdown 原稿,按章节顺序列出。</div>
				<button type="button" className="ws-row" title="draft/ch01.md" onClick={noop}>
					<span className="ws-row-name">第一章 · 渡口<em>4.2 KB</em></span>
					<span className="ws-row-meta">draft/ch01.md · 12 分钟前</span>
				</button>
				<button type="button" className="ws-row" title="draft/ch02.md" onClick={noop}>
					<span className="ws-row-name">第二章 · 灯塔<em>3.1 KB</em></span>
					<span className="ws-row-meta">draft/ch02.md · 3 小时前</span>
				</button>
			</div>
			<div className="ws-group">
				<div className="ws-group-head">
					<span>资料与笔记</span>
					<span className="ws-count">1</span>
				</div>
				<div className="ws-group-desc">收集来的背景材料与随手的笔记。</div>
				<button type="button" className="ws-row" title="notes/渡口.md" onClick={noop}>
					<span className="ws-row-name">渡口的旧照片与记录<em>18.4 KB</em></span>
					<span className="ws-row-meta">notes/渡口.md · 昨天</span>
				</button>
			</div>
		</>
	);
}

/** 手机抽屉的假主导航(view 固定为舞台,只展示选中态)。 */
const DEMO_NAV = { view: "stage", onNavigate: noop };

/**
 * 书库栏:数据来自 `demoLibrary()`(替身书库),写操作全空函数。
 * 四档靠 props 分:常宽 / 折叠 56px / 工作区模式 / 手机抽屉(drawerOpen)。
 */
function ChapterSidebarDemo({
	collapsed = false,
	railMode = "chapters",
	drawerOpen = false,
}: {
	collapsed?: boolean;
	railMode?: "chapters" | "workspace";
	drawerOpen?: boolean;
}) {
	return (
		<ShellBox height={430}>
			<ChapterSidebar
				books={LIBRARY.books}
				slug={LIBRARY.bookDetail?.slug ?? null}
				chapters={LIBRARY.bookDetail?.chapters ?? []}
				currentFile={LIBRARY.currentChapter?.file ?? null}
				onSelectChapter={noop}
				onNewChapter={noop}
				onSelectBook={noop}
				onNewBook={noop}
				onExportBook={noop}
				onRenameBook={noop}
				onDeleteBook={noop}
				onImportBook={noop}
				onRenameChapter={noop}
				width={drawerOpen ? 360 : LIBRARY.sidebarWidth}
				onResize={noop}
				collapsed={collapsed}
				onToggleCollapse={noop}
				drawerOpen={drawerOpen}
				onClose={drawerOpen ? noop : undefined}
				railMode={railMode}
				onRailModeChange={noop}
				workspace={railMode === "workspace" ? <DemoWorkspace /> : undefined}
				nav={drawerOpen ? DEMO_NAV : undefined}
				words={drawerOpen ? 1834 : null}
			/>
		</ShellBox>
	);
}

/** 正文工作区三档共用的壳(替身 client + demoLibrary 的当前章)。 */
function DraftDemo({ client }: { client: ApiClient }) {
	const rt = useUIRoomRuntime();
	return (
		<ShellBox height={430}>
			<DraftWorkspace
				client={client}
				slug={rt.slug ?? "demo-book"}
				file="draft/ch01.md"
				chapterFile="ch01.jsonl"
				title="第一章 · 渡口"
			/>
		</ShellBox>
	);
}

function DraftWithText() {
	return <DraftDemo client={DRAFT_CLIENT} />;
}

function DraftEmpty() {
	return <DraftDemo client={EMPTY_DRAFT_CLIENT} />;
}

function DraftError() {
	return <DraftDemo client={ERROR_DRAFT_CLIENT} />;
}

/* ════════════════════════════════════════════════════════════════
   分组渲染表(标签与顺序必须与 STAGE_ENTRIES[i].variants 逐字一致)
   ════════════════════════════════════════════════════════════════ */

export const STAGE_SECTION: UIRoomSection = {
	"stage-panel": [
		{ label: "剧本", note: "开演中:概要/节拍/演员指令三档都点得到", render: () => <StagePanelDemo initial="script" /> },
		{ label: "选角", note: "演员池 4 名 + 本幕选角后的角色名", render: () => <StagePanelDemo initial="cast" /> },
		{ label: "修订", note: "提交入口 + 上一版修订卡片", render: () => <StagePanelDemo initial="revise" /> },
		{ label: "备忘录", note: "NoticeBoard 的 minimal 形态", render: () => <StagePanelDemo initial="memo" /> },
	],
	"script-view": [
		{ label: "正常", note: "3 名演员 / 8 个节拍,铅笔可点(onEdit 已注入)", render: () => <ScriptView script={DEMO_SCRIPT} onEdit={noop} /> },
		{ label: "空剧本", note: "shared 全空、无节拍、无 perActor;后两档页签会是空的", render: () => <ScriptView script={EMPTY_SCRIPT} /> },
	],
	"revise-script-modal": [
		{ label: "默认", note: "全空表单,字段里的灰字是剧本现值", render: () => <ReviseModalDemo long={false} /> },
		{ label: "长表单", note: "11 个字段全填满(节拍 10 行 / 禁区 5 行)", render: () => <ReviseModalDemo long /> },
	],
	"chapter-sidebar": [
		{ label: "章节列表", note: "2 本书 + 3 章,右缘可拖宽", render: () => <ChapterSidebarDemo /> },
		{ label: "折叠", note: "56px 图标条,只留当前书首字", render: () => <ChapterSidebarDemo collapsed /> },
		{ label: "工作区", note: "railMode=workspace(内容由页面注入)", render: () => <ChapterSidebarDemo railMode="workspace" /> },
		{ label: "手机抽屉", note: "drawerOpen=true;窄视口才长成手机端品牌头 + 主导航", render: () => <ChapterSidebarDemo drawerOpen /> },
	],
	"draft-workspace": [
		{ label: "有正文", note: "约两千字 markdown(标题/引用/列表),编辑器内滚动", render: DraftWithText },
		{ label: "空草稿", note: "加载成功但正文为空的编辑器", render: DraftEmpty },
		{ label: "出错", note: "加载失败 → .d-error + 「重试加载」", render: DraftError },
	],
};
