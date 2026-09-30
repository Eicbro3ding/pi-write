/**
 * 「UI 房」世界书分组展项(调试模式下的组件陈列室)。
 *
 * 这一格把世界书的十个面摆在一起:分类树 → 条目卡 / 表单 / 信息栏 / 只读详情 →
 * 关系图 → 时间线 / 发展线 → 工作区面板 → 简要世界观编辑体。
 *
 * 约定(与 uiroom-types.ts / uiroom-runtime.tsx 一致):
 * - `WORLD_ENTRIES[i].variants` 与 `WORLD_SECTION[id]` 的 label **逐字同序**;
 * - 状态档是**函数组件**(页面用 createElement 挂载),所以 hook 写在各自函数体里,
 *   交互档自己 useState,展项之间不共享可变状态;
 * - 写操作一律传空函数,展项不碰真实数据;数据全是常量(不随机、不读 window);
 * - 需要 client/slug/章节表的展项走 `useUIRoomRuntime()`,数据读取都在渲染期完成,
 *   组件自己要发的请求留在它们自己的 effects 里(SSR 不跑 effect,因此不触网)。
 */
import { useState, type ComponentProps } from "react";
import { EntryCard } from "../components/EntryCard.tsx";
import { EntryForm, EntryInfoPanel, EntryTypeIcon } from "../components/EntryForm.tsx";
import { RelationGraph } from "../components/RelationGraph.tsx";
import { StorylinePanel } from "../components/StorylinePanel.tsx";
import { TimelinePanel } from "../components/TimelinePanel.tsx";
import { WorkspacePanel, formatAgo, formatBytes } from "../components/WorkspacePanel.tsx";
import { WorldEntryDetail } from "../components/WorldEntryDetail.tsx";
import { WorldTree } from "../components/WorldTree.tsx";
import { WorldSummaryPanel, SUMMARY_LIMIT } from "../components/WorldSummaryPanel.tsx";
import type { RelationArrowDto, StorylineDto, TimelineEventDto, WorldEntryDto, WorldRelationDto } from "../types.ts";
import { useUIRoomRuntime } from "../uiroom-runtime.tsx";
import type { UIRoomEntry, UIRoomSection } from "../uiroom-types.ts";
import { ENTRY_TYPES, ENTRY_TYPE_LABELS } from "../world-entry.ts";

// —— 造数据的小工具(展项数据是常量:id 手写,渲染两次结果一致) ——

/** 条目构造:只写关心的字段,其余走默认;不参与任何真实写入。 */
function entry(seed: { id: string; title: string } & Partial<WorldEntryDto>): WorldEntryDto {
	return {
		type: "character",
		keys: [],
		chapters: [],
		status: "alive",
		active: true,
		parent: null,
		tags: [],
		body: "",
		avatar: null,
		images: [],
		updatedAt: 1_760_000_000_000,
		...seed,
	};
}

/** 关系构造(id 手写而不是随机,SSR 渲染可重复)。 */
function rel(
	id: string,
	from: string,
	to: string,
	type: string,
	label: string,
	arrow: RelationArrowDto = "double",
	emphasized = false,
): WorldRelationDto {
	return { id, from, to, type, label, arrow, emphasized };
}

/**
 * 真实量级的条目正文:约 1100 字,九段。条目卡走 markdown、表单走 textarea、
 * 只读详情走 pre-wrap,同一份长文能把三处的换行/滚动/字数统计一起压出来。
 */
const LONG_BODY = [
	"林砚第一次登上白鲸灯塔是在初雾之年的冬天。那年他二十一岁,从雾港的钟表匠行会手里接过一串生锈的钥匙,行会的人只留下一句话:灯不能灭。他沿着礁石上凿出来的九十九级台阶往上走,海风把雨丝吹成横的,打在脸上像细砂。塔门开了三次才推开,门轴里的盐结成了白霜。",
	"塔里的灯是二百年前的老式鲸油灯,铜座比人还高,灯芯要用双手才能拨动。第一夜他没敢合眼,坐在灯座下面听海浪撞礁石的声音,一下一下,像有人在门外数数。天快亮的时候他发现自己数到了两千三百下,而灯还亮着。",
	"十四年里他学会了很多事:看云的颜色判断雾什么时候进港,听钟声判断行会的人有没有换班,用手背贴灯座的温度判断灯油还剩多少。他也学会了不说话——雾里的声音传得远,说一句就有一句回来,回来的那一句总不太像自己的。",
	"阿澈来的那个春天,雾比往年薄。少年是被渡船的水手从跳板上推下来的,背着一只破了口的麻袋,在码头上睡了两夜,然后顺着礁石上的台阶一路爬上来,敲响了塔门。林砚拉开门,看见一个瘦得只剩眼睛的孩子,手里攥着一把湿透的干粮。",
	"他本想把孩子赶下去。可那天夜里起了风,礁石上的浪打到第三级台阶,他关上门,把干粮分了一半。阿澈吃得很慢,像在数米粒。吃完之后少年问他:灯会不会灭?林砚说不会。这是他十四年里说得最像谎的一句话。",
	"灯油是按月由行会供的:每月初一,柳三娘的伙计摇着小船靠上礁石,把两桶油和一包盐递上来,顺手记一笔账。柳三娘的账本上,林砚的名字底下有一行小字,写着他欠的七顿饭。那是初雾之年的旧账,行会的人早忘了,她没忘。",
	"韩渠死前最后一次上礁,带着半张画到一半的海图。他说雾港外海的暗礁每年都会挪一点位置,像活的东西。他把图摊在灯座上,用炭笔圈出三处,说这三处最凶,船撞上去连声音都听不见。半年后他自己在第四处撞了船。",
	"行会的账房锁着韩渠的全部海图,钥匙在会长腰上。每年开春,行会要派人来验一次灯:量灯油的数目,擦一遍铜座,再让林砚在册子上按一个手印。验灯的人换过五个,册子换了三本,手印的位置一次比一次低。",
	"灯塔熄灭的那一夜没有风,雾却浓得能拧出水。林砚守着灯,添了两次油,第三次伸手的时候听见灯芯发出一声很轻的爆响,然后整座塔就黑了。他摸黑走到塔顶,看见港口的方向有一点一点的白光在雾里挪动——七条船,一条跟着一条,全撞在了韩渠圈出来的第一处暗礁上。",
].join("\n\n");

// —— 常量数据:雾港世界(多类型 / 父子层级 / 未激活 / 跨类型父条目) ——

const ENTRY_HARBOR = entry({
	id: "world-harbor",
	type: "world",
	title: "雾港",
	keys: ["雾港", "港口"],
	tags: ["地点", "主城"],
	body: "常年被海雾笼罩的港口城市。城里以钟表业为生,每到初雾之月,全城的钟会同时停摆一刻钟。",
});

const ENTRY_LIGHTHOUSE = entry({
	id: "world-lighthouse",
	type: "world",
	title: "白鲸灯塔",
	parent: "world-harbor",
	keys: ["灯塔", "白鲸"],
	tags: ["地点"],
	body: "立在雾港外礁上的石塔,塔身涂成鲸白色。灯油由钟表匠行会按月供给。",
});

const ENTRY_GUILD = entry({
	id: "world-guild",
	type: "world",
	title: "钟表匠行会",
	parent: "world-harbor",
	keys: ["行会", "钟表"],
	tags: ["组织"],
	body: "雾港真正的掌权者。行会的账簿上记着每一盏灯、每一口钟的时辰。",
});

const ENTRY_LINYAN = entry({
	id: "ch-linyan",
	title: "守夜人 林砚",
	keys: ["林砚", "守夜人"],
	chapters: ["ch01", "ch02"],
	tags: ["主角"],
	body: "三十五岁,寡言。十四年前接过白鲸灯塔的钥匙,再没离开过礁石。左手小指缺了一节。",
});

const ENTRY_ACHE = entry({
	id: "ch-ache",
	title: "少年水手 阿澈",
	parent: "ch-linyan",
	keys: ["阿澈"],
	tags: ["配角"],
	body: "十六岁,从南方漂来的孤儿,赖在灯塔下不走,替林砚背灯油换一顿饭。",
});

const ENTRY_LIUSAN = entry({
	id: "ch-liusan",
	title: "客栈老板娘 柳三娘",
	keys: ["柳三娘", "客栈"],
	tags: ["配角"],
	body: "雾港唯一一家昼夜不关门的客栈的老板,记性极好,能报出十年前的账。",
});

const ENTRY_HANQU = entry({
	id: "ch-hanqu",
	title: "已故制图师 韩渠",
	active: false,
	status: "dead",
	tags: ["已故"],
	body: "生前画尽了雾港外海的每一处暗礁。死后海图被行会锁进账房。",
});

const ENTRY_FIRST_FOG = entry({
	id: "tl-first-fog",
	type: "timeline",
	title: "初雾之年",
	status: "unknown",
	tags: ["纪年"],
	body: "海雾第一次漫进港内的那一年,此后成为雾港的纪年起点。",
});

const ENTRY_DARK_NIGHT = entry({
	id: "tl-dark-night",
	type: "timeline",
	title: "灯塔熄灭之夜",
	tags: ["纪年"],
	body: "白鲸灯塔熄了一整夜,七条船撞上暗礁。那一夜的记录被行会剪掉了。",
});

const ENTRY_ACT1 = entry({
	id: "out-act1",
	type: "outline",
	title: "第一幕 · 渡口",
	status: "draft",
	tags: ["幕"],
	body: "阿澈在渡口被赶下船,遇见来取灯油的林砚。",
});

const ENTRY_ACT2 = entry({
	id: "out-act2",
	type: "outline",
	title: "第二幕 · 灯塔",
	parent: "out-act1",
	status: "draft",
	tags: ["幕"],
	body: "两人守着灯塔过冬,灯油耗尽,林砚第一次讲起十四年前。",
});

/** 分类树 / 条目卡 / 表单共用的世界(11 条,跨四个类型 + 两层父子)。 */
const WORLD_FIXTURE: WorldEntryDto[] = [
	ENTRY_HARBOR,
	ENTRY_LIGHTHOUSE,
	ENTRY_GUILD,
	ENTRY_LINYAN,
	ENTRY_ACHE,
	ENTRY_LIUSAN,
	ENTRY_HANQU,
	ENTRY_FIRST_FOG,
	ENTRY_DARK_NIGHT,
	ENTRY_ACT1,
	ENTRY_ACT2,
];

/** 12 条关系(树行上的关系条数、条目卡的关系清单都用它)。 */
const TREE_RELATIONS: WorldRelationDto[] = [
	rel("r01", "ch-linyan", "ch-ache", "师徒", "教他看星", "single", true),
	rel("r02", "ch-linyan", "world-lighthouse", "守卫", "守了十四年", "single"),
	rel("r03", "ch-linyan", "ch-liusan", "旧识", "欠她七顿饭"),
	rel("r04", "ch-ache", "world-harbor", "来自", "南边漂来的", "single"),
	rel("r05", "ch-liusan", "world-guild", "债主", "行会欠她一笔", "single"),
	rel("r06", "world-lighthouse", "world-harbor", "位于", "外礁上", "single"),
	rel("r07", "world-guild", "world-harbor", "掌权", "账簿记着全城", "single"),
	rel("r08", "ch-hanqu", "world-harbor", "海图", "暗礁都标过"),
	rel("r09", "tl-first-fog", "world-harbor", "纪年", "雾进港那一年", "none"),
	rel("r10", "tl-dark-night", "world-lighthouse", "那夜", "灯熄了一整夜", "none", true),
	rel("r11", "out-act1", "out-act2", "续", "第二幕", "single"),
	rel("r12", "out-act1", "ch-linyan", "登场", "渡口初遇", "single"),
];

/** 满态图画布用的 24 条关系(真实量级:一张中等大小的关系网)。 */
const GRAPH_RELATIONS: WorldRelationDto[] = [
	rel("g01", "ch-linyan", "ch-ache", "师徒", "教他看星", "single", true),
	rel("g02", "ch-linyan", "world-lighthouse", "守卫", "守了十四年", "single"),
	rel("g03", "ch-linyan", "ch-liusan", "旧识", "欠她七顿饭"),
	rel("g04", "ch-ache", "world-harbor", "来自", "南边漂来的", "single"),
	rel("g05", "ch-liusan", "world-guild", "债主", "行会欠她一笔", "single"),
	rel("g06", "world-lighthouse", "world-harbor", "位于", "外礁上", "single"),
	rel("g07", "world-guild", "world-harbor", "掌权", "账簿记着全城", "single"),
	rel("g08", "ch-hanqu", "world-harbor", "海图", "暗礁都标过"),
	rel("g09", "tl-first-fog", "world-harbor", "纪年", "雾进港那一年", "none"),
	rel("g10", "tl-dark-night", "world-lighthouse", "那夜", "灯熄了一整夜", "none", true),
	rel("g11", "out-act1", "out-act2", "续", "第二幕", "single"),
	rel("g12", "out-act1", "ch-linyan", "登场", "渡口初遇", "single"),
	rel("g13", "ch-ache", "ch-liusan", "饭钱", "赊账"),
	rel("g14", "ch-linyan", "ch-hanqu", "故人", "一起画过海图", "single"),
	rel("g15", "ch-linyan", "tl-dark-night", "亲历", "在场", "single"),
	rel("g16", "ch-liusan", "ch-ache", "照看", "给他留了铺位", "single"),
	rel("g17", "world-guild", "ch-linyan", "雇用", "发灯油钱", "single"),
	rel("g18", "world-guild", "ch-hanqu", "查封", "海图锁进账房", "single"),
	rel("g19", "world-harbor", "tl-first-fog", "纪年起点", "此后以此为元", "single"),
	rel("g20", "world-lighthouse", "tl-dark-night", "见证", "塔上看见的", "single"),
	rel("g21", "ch-ache", "out-act1", "初遇", "渡口", "single"),
	rel("g22", "ch-linyan", "out-act2", "讲起往事", "十四年前", "single", true),
	rel("g23", "ch-liusan", "world-guild", "账目往来", "十年旧账"),
	rel("g24", "ch-hanqu", "ch-ache", "遗物", "留下半张海图", "single"),
];

/** 主图 + 图库(条目信息栏与只读详情的满态)。 */
const ENTRY_LINYAN_PHOTO: WorldEntryDto = {
	...ENTRY_LINYAN,
	avatar: "linyan-tower.png",
	images: ["linyan-tower.png", "linyan-desk.png", "linyan-hands.png"],
};

/** 长正文条目(表单 / 卡片 / 只读详情的极端内容档)。 */
const ENTRY_LINYAN_LONG: WorldEntryDto = { ...ENTRY_LINYAN, body: LONG_BODY };

// —— 1. 世界树 ——

/** 世界树默认 props(写操作空转),状态档只覆盖关心的字段。 */
const TREE_BASE: ComponentProps<typeof WorldTree> = {
	entries: WORLD_FIXTURE,
	selId: "ch-linyan",
	onSelect: () => {},
	relations: TREE_RELATIONS,
	creating: false,
	onCreatingChange: () => {},
	createType: "character",
	onCreateType: () => {},
	createTitle: "",
	onCreateTitle: () => {},
	onCreate: () => {},
};

/** 多类型多条目:两个类型有父子层级,行右侧带关系条数,未激活条目带眼睛图标。 */
function TreeFull() {
	const [selId, setSelId] = useState<string | null>("ch-linyan");
	return <WorldTree {...TREE_BASE} selId={selId} onSelect={setSelId} />;
}

/** 空世界:四个分组都是空态提示行,树底仍有新建入口。 */
function TreeEmpty() {
	return <WorldTree {...TREE_BASE} entries={[]} selId={null} relations={[]} />;
}

/** 未加载(entries=null):树区整块留白,错误文案由页面呈现。 */
function TreeUnloaded() {
	return <WorldTree {...TREE_BASE} entries={null} selId={null} relations={[]} />;
}

/** 内联新建行展开:类型下拉 + 标题输入 + 「添加」按标题空否禁用。 */
function TreeCreating() {
	const [creating, setCreating] = useState(true);
	const [createType, setCreateType] = useState<WorldEntryDto["type"]>("world");
	const [createTitle, setCreateTitle] = useState("钟楼");
	return (
		<WorldTree
			{...TREE_BASE}
			creating={creating}
			onCreatingChange={setCreating}
			createType={createType}
			onCreateType={setCreateType}
			createTitle={createTitle}
			onCreateTitle={setCreateTitle}
		/>
	);
}

// —— 2. 条目卡 ——

/** 普通条目:带关闭 / 在条目中编辑 / 删除三个动作。 */
function CardPlain() {
	return (
		<EntryCard
			entry={ENTRY_LIUSAN}
			entries={WORLD_FIXTURE}
			relations={TREE_RELATIONS}
			slug="demo-book"
			onJump={() => {}}
			onClose={() => {}}
			onEdit={() => {}}
			onDelete={() => {}}
		/>
	);
}

/** 带关系:四条关系(含强调关系、双向/单向箭头),对端标题可点。 */
function CardRelated() {
	return <EntryCard entry={ENTRY_LINYAN} entries={WORLD_FIXTURE} relations={TREE_RELATIONS} slug="demo-book" onJump={() => {}} />;
}

/** 长正文:上千字简介走 markdown 渲染(卡片内滚动)。 */
function CardLongBody() {
	return <EntryCard entry={ENTRY_LINYAN_LONG} entries={WORLD_FIXTURE} relations={[]} slug="demo-book" onJump={() => {}} />;
}

/** 对端已删:关系指向不存在的条目 → 行禁用并标「(已删除)」。 */
function CardDangling() {
	const relations: WorldRelationDto[] = [
		rel("x01", "ch-linyan", "ch-vanished", "旧识", "人已经不在了"),
		rel("x02", "ch-vanished", "ch-linyan", "遗物", "只剩一把钥匙", "single"),
	];
	return <EntryCard entry={ENTRY_LINYAN} entries={WORLD_FIXTURE} relations={relations} slug="demo-book" onJump={() => {}} />;
}

// —— 3. 条目表单 + 类型图标 ——

/** 新建:标题为空、无关键词、草稿态未激活(头部走「未命名」兜底)。 */
function FormNew() {
	const [draft, setDraft] = useState<WorldEntryDto>(() =>
		entry({ id: "ch-new-01", title: "", status: "draft", active: false }),
	);
	return <EntryForm entry={draft} onChange={setDraft} onRequestDelete={() => {}} />;
}

/** 编辑现有:关键词 chips + 上千字正文(右下角字数统计)。 */
function FormEditing() {
	const [draft, setDraft] = useState<WorldEntryDto>(ENTRY_LINYAN_LONG);
	return <EntryForm entry={draft} onChange={setDraft} onRequestDelete={() => {}} />;
}

/** 类型图标全集:人物 / 世界 / 时间线 / 大纲四个图标与类型色。 */
function TypeIconSet() {
	return (
		<div className="w-form">
			<div className="w-form-head">
				{ENTRY_TYPES.map((t) => (
					<span key={t} className={`w-entry-icon type-${t}`}>
						<EntryTypeIcon type={t} size={18} />
					</span>
				))}
				<h2 className="w-form-title">类型图标</h2>
			</div>
			<div className="w-keys">
				{ENTRY_TYPES.map((t) => (
					<span key={t} className="w-key-chip">
						{t} · {ENTRY_TYPE_LABELS[t]}
					</span>
				))}
			</div>
		</div>
	);
}

// —— 4. 条目信息栏 ——

/** 有引用:主图 + 三张图库、勾选两个章节、父条目指向跨类型的「雾港」。 */
function InfoReferenced() {
	const rt = useUIRoomRuntime();
	return (
		<EntryInfoPanel
			entry={{ ...ENTRY_LINYAN_PHOTO, parent: "world-harbor" }}
			entries={WORLD_FIXTURE}
			chapters={rt.library.bookDetail?.chapters ?? []}
			chaptersOk
			slug={rt.slug ?? "demo-book"}
			client={rt.client}
			onChange={() => {}}
		/>
	);
}

/** 无引用:无主图无图库、不关联任何章节(全部章节生效)、根条目。 */
function InfoBare() {
	const rt = useUIRoomRuntime();
	return (
		<EntryInfoPanel
			entry={entry({ id: "ch-new-02", title: "码头帮工 阿七", status: "draft", active: false })}
			entries={WORLD_FIXTURE}
			chapters={rt.library.bookDetail?.chapters ?? []}
			chaptersOk
			slug={rt.slug ?? "demo-book"}
			client={rt.client}
			onChange={() => {}}
		/>
	);
}

/** 章节列表不可用:章节区退化为一行提示(选择被禁用)。 */
function InfoNoChapters() {
	const rt = useUIRoomRuntime();
	return (
		<EntryInfoPanel
			entry={ENTRY_LINYAN}
			entries={WORLD_FIXTURE}
			chapters={[]}
			chaptersOk={false}
			slug={rt.slug ?? "demo-book"}
			client={rt.client}
			onChange={() => {}}
		/>
	);
}

// —— 5. 条目只读详情(手机端形态) ——

/** 只读详情:配图 + 关系数 + 标签 + 元信息表(章节 id 映射成标题)。 */
function DetailReadonly() {
	const rt = useUIRoomRuntime();
	return (
		<WorldEntryDetail
			entry={ENTRY_LINYAN_PHOTO}
			slug={rt.slug ?? "demo-book"}
			chapters={rt.library.bookDetail?.chapters ?? []}
			relationCount={TREE_RELATIONS.filter((r) => r.from === ENTRY_LINYAN.id || r.to === ENTRY_LINYAN.id).length}
			onEdit={() => {}}
			onDelete={() => {}}
			onChangeAvatar={() => {}}
		/>
	);
}

/** 长正文:上千字正文原样换行,元信息表在下方。 */
function DetailLongBody() {
	const rt = useUIRoomRuntime();
	return (
		<WorldEntryDetail
			entry={ENTRY_LINYAN_LONG}
			slug={rt.slug ?? "demo-book"}
			chapters={rt.library.bookDetail?.chapters ?? []}
			relationCount={4}
			onEdit={() => {}}
			onDelete={() => {}}
			onChangeAvatar={() => {}}
		/>
	);
}

/** 空正文:给出「还没有正文」的引导语(配图位也空)。 */
function DetailEmptyBody() {
	const rt = useUIRoomRuntime();
	return (
		<WorldEntryDetail
			entry={entry({ id: "tl-unnamed", type: "timeline", title: "未命名的纪年", tags: [], status: "unknown" })}
			slug={rt.slug ?? "demo-book"}
			chapters={rt.library.bookDetail?.chapters ?? []}
			relationCount={0}
			onEdit={() => {}}
			onDelete={() => {}}
			onChangeAvatar={() => {}}
		/>
	);
}

// —— 6. 关系图 ——

/** 满态图:11 个节点 + 24 条关系(默认只显示人物/世界两类,可在工具条切换)。 */
function GraphFull() {
	return (
		<RelationGraph
			entries={WORLD_FIXTURE}
			relations={GRAPH_RELATIONS}
			slug="demo-book"
			focusId="ch-linyan"
			onSelect={() => {}}
			onUpdateRelations={() => {}}
			onUpdateEntry={() => {}}
			onDeleteEntry={() => {}}
			canUndo
			onUndo={() => {}}
			canRedo={false}
			onRedo={() => {}}
		/>
	);
}

/** 空图:没有任何条目 → 画布上覆一层空态提示,工具条仍在。 */
function GraphEmpty() {
	return (
		<RelationGraph
			entries={[]}
			relations={[]}
			slug="demo-book"
			focusId={null}
			onSelect={() => {}}
			onUpdateRelations={() => {}}
		/>
	);
}

// —— 7. 时间线 ——

const TIMELINE_EVENTS: TimelineEventDto[] = [
	{ id: "evt-01", chapter: "ch01", text: "阿澈在渡口被赶下船,遇见来取灯油的林砚。" },
	{ id: "evt-02", chapter: "ch01", text: "柳三娘替阿澈垫了一顿饭钱,记在行会的账上。" },
	{ id: "evt-03", chapter: "ch02", text: "两人上礁,灯塔的灯油只剩三桶。" },
	{ id: "evt-04", chapter: "ch02", text: "林砚第一次讲起十四年前的那个夜晚。" },
	{ id: "evt-05", chapter: "ch03", text: "钟表匠行会派人来收灯塔的钥匙(该章文件缺失)。" },
	{ id: "evt-06", chapter: "ch-missing", text: "旧账本上多出一页没有署名的记录——章节 id 未知时原样显示。" },
];

/** 有时间线:六条事件(含未知章节 id 兜底显示)。 */
function TimelineFull() {
	const rt = useUIRoomRuntime();
	const [events, setEvents] = useState<TimelineEventDto[]>(TIMELINE_EVENTS);
	return (
		<TimelinePanel
			events={events}
			chapters={rt.library.bookDetail?.chapters ?? []}
			chaptersOk
			onChange={setEvents}
		/>
	);
}

/** 空:没有事件,底部新增行可输入(章节默认第一章)。 */
function TimelineEmpty() {
	const rt = useUIRoomRuntime();
	const [events, setEvents] = useState<TimelineEventDto[]>([]);
	return (
		<TimelinePanel
			events={events}
			chapters={rt.library.bookDetail?.chapters ?? []}
			chaptersOk
			onChange={setEvents}
		/>
	);
}

/** 章节列表不可用:新增行退化为一行提示,已有事件仍显示。 */
function TimelineNoChapters() {
	const [events, setEvents] = useState<TimelineEventDto[]>(TIMELINE_EVENTS);
	return <TimelinePanel events={events} chapters={[]} chaptersOk={false} onChange={setEvents} />;
}

// —— 8. 发展线 ——

const STORY_NODES: StorylineDto["nodes"] = [
	{
		id: "story-01",
		title: "阿澈留在灯塔",
		status: "done",
		goal: "让阿澈有一个不必再漂的位置",
		next: "守夜人的日常",
	},
	{
		id: "story-02",
		title: "灯油耗尽",
		status: "in-progress",
		goal: "把两个人一起困在礁上,逼出十四年前的旧事",
		next: "林砚开口",
	},
	{
		id: "story-03",
		title: "行会来收钥匙",
		status: "pending",
		goal: "把冲突从礁石上带回港内,让柳三娘的旧账浮出来",
		next: "第三幕 · 归航",
	},
];

/** 全状态:四个节点覆盖 待办 / 进行中 / 完成 / 搁置,右上「至多一个进行中」提示。 */
const STORY_NODES_ALL: StorylineDto["nodes"] = [
	{
		id: "story-a",
		title: "初雾之年的旧账",
		status: "done",
		goal: "让读者知道林砚欠的不是钱,是一个没说出口的名字",
		next: "账本上的第七顿饭",
	},
	{
		id: "story-b",
		title: "灯塔熄灭之夜(闪回)",
		status: "in-progress",
		goal: "把七条船撞礁的一夜拆成三段闪回,每段只给一个细节:灯芯的爆响、白雾里挪动的光点、韩渠圈出来的第一处暗礁",
		next: "接过钥匙的那一天",
	},
	{
		id: "story-c",
		title: "接手账房",
		status: "pending",
		goal: "让阿澈拿到韩渠的半张海图",
		next: null,
	},
	{
		id: "story-d",
		title: "南方的船票",
		status: "shelved",
		goal: "原计划的离别线,暂缓:先不把阿澈送走",
		next: null,
	},
];

/** 正常:三个节点,推进状态可改(改「进行中」会自动把别的降回「待办」)。 */
function StorylineNormal() {
	const [line, setLine] = useState<StorylineDto>(() => ({ enabled: true, nodes: STORY_NODES }));
	return <StorylinePanel storyline={line} onChange={setLine} />;
}

/** 空:零节点,右上「＋ 新节点」展开内联新增行。 */
function StorylineEmpty() {
	const [line, setLine] = useState<StorylineDto>(() => ({ enabled: true, nodes: [] }));
	return <StorylinePanel storyline={line} onChange={setLine} />;
}

/** 全状态:四种状态胶囊 + 超长目标文本(单行输入被撑满)。 */
function StorylineAllStatus() {
	const [line, setLine] = useState<StorylineDto>(() => ({ enabled: true, nodes: STORY_NODES_ALL }));
	return <StorylinePanel storyline={line} onChange={setLine} />;
}

// —— 9. 工作区面板 ——

/** 未打开书:slug=null 走「未打开书。」分支(不触发任何取数)。 */
function WorkspaceNoSlug() {
	const rt = useUIRoomRuntime();
	return (
		<WorkspacePanel
			client={rt.client}
			slug={null}
			active={false}
			aiTouched={new Set<string>()}
			onOpenChapter={() => {}}
			onPreview={() => {}}
		/>
	);
}

/**
 * 有书、等待文件清单:清单由组件自己的 effect 拉取(浏览器里先「加载中…」,
 * 失败显示重试条);SSR 不跑 effect,所以这里补一行说明,免得格子看起来是空的。
 * aiTouched 传一个交集非空的台账:「AI 写过」收件箱与行内 AI 徽标都会出现。
 */
function WorkspaceWaiting() {
	const rt = useUIRoomRuntime();
	return (
		<>
			<div className="ws-desc">文件清单在组件的 effect 里拉取:浏览器中先是「加载中…」,取不到则显示失败与重试。</div>
			<WorkspacePanel
				client={rt.client}
				slug={rt.slug ?? "demo-book"}
				active
				aiTouched={new Set<string>(["draft/ch01.md", "notes/海图残片.md"])}
				onOpenChapter={() => {}}
				onPreview={() => {}}
			/>
		</>
	);
}

/** 体积与相对时间:两个纯函数(formatBytes / formatAgo)的全部档位样例。 */
function WorkspaceFormatters() {
	const now = Date.now();
	const rows: Array<[string, string]> = [
		["formatBytes(0)", formatBytes(0)],
		["formatBytes(1023)", formatBytes(1023)],
		["formatBytes(2048)", formatBytes(2048)],
		["formatBytes(3_500_000)", formatBytes(3_500_000)],
		["formatAgo(30 秒前)", formatAgo(now - 30_000, now)],
		["formatAgo(5 分钟前)", formatAgo(now - 5 * 60_000, now)],
		["formatAgo(3 小时前)", formatAgo(now - 3 * 3_600_000, now)],
		["formatAgo(10 天前)", formatAgo(now - 10 * 86_400_000, now)],
		["formatAgo(7 个月前)", formatAgo(now - 210 * 86_400_000, now)],
	];
	return (
		<div className="ws-group">
			<div className="ws-group-head">
				<span>体积与相对时间</span>
				<span className="ws-count">{rows.length}</span>
			</div>
			<div className="ws-group-desc">列表行右侧那半行元信息,由这两个纯函数拼出来。</div>
			{rows.map(([k, v]) => (
				<div key={k} className="ws-row">
					<span className="ws-row-name">{k}</span>
					<span className="ws-row-meta">{v}</span>
				</div>
			))}
		</div>
	);
}

// —— 展项表 ——

export const WORLD_ENTRIES: readonly UIRoomEntry[] = [
	{
		id: "world-tree",
		group: "world",
		title: "世界树",
		module: "components/WorldTree.tsx",
		symbols: ["WorldTree"],
		note: "按类型分组的分类树:组内用 parent 建层级、行右侧显示关系条数、未激活条目带眼睛图标;底部是内联新建入口。",
		variants: ["多类型多条目", "空世界", "未加载", "内联新建"],
	},
	{
		id: "entry-card",
		group: "world",
		title: "条目卡",
		module: "components/EntryCard.tsx",
		symbols: ["EntryCard"],
		note: "关系图右侧的词条详情卡:类型色环头像 / 类型胶囊 / 关键词 chips / 关系清单(方向箭头)/ markdown 简介。",
		variants: ["普通条目", "带关系", "长正文", "对端已删"],
	},
	{
		id: "entry-form",
		group: "world",
		title: "条目表单",
		module: "components/EntryForm.tsx",
		symbols: ["EntryForm", "EntryTypeIcon"],
		note: "条目正文区:标题大输入 + 关键词 chips + 正文 textarea(右下字数);末档单看四个类型图标。",
		variants: ["新建", "编辑现有", "类型图标全集"],
	},
	{
		id: "entry-info-panel",
		group: "world",
		title: "条目信息栏",
		module: "components/EntryForm.tsx",
		symbols: ["EntryInfoPanel"],
		note: "条目右栏:主图与图库、条目 ID、状态与激活开关、关联章节勾选、父条目(含跨类型兜底)。",
		variants: ["有引用", "无引用", "章节不可用"],
	},
	{
		id: "world-entry-detail",
		group: "world",
		title: "条目只读详情",
		module: "components/WorldEntryDetail.tsx",
		symbols: ["WorldEntryDetail"],
		note: "手机端「条目详情」页:配图、关系数、标签、元信息表(章节 id 映射成标题),底部编辑/删除。",
		variants: ["只读详情", "长正文", "空正文"],
	},
	{
		id: "relation-graph",
		group: "world",
		title: "关系图",
		module: "components/RelationGraph.tsx",
		symbols: ["RelationGraph"],
		note: "cytoscape 画布:11 节点 / 24 条关系的满态与空图,工具条含类型过滤、连线、撤销重做与缩放横条。",
		variants: ["24 条关系", "空图"],
	},
	{
		id: "timeline-panel",
		group: "world",
		title: "时间线",
		module: "components/TimelinePanel.tsx",
		symbols: ["TimelinePanel"],
		note: "事件行 = 章节胶囊 + 文本 + 删除;底部新增行(章节下拉 + 描述 + 琥珀添加钮)。",
		variants: ["有时间线", "空", "章节不可用"],
	},
	{
		id: "storyline-panel",
		group: "world",
		title: "发展线",
		module: "components/StorylinePanel.tsx",
		symbols: ["StorylinePanel"],
		note: "节点行 = 序号 + 标题 + 状态胶囊 + 上移/下移/删除,次级行是目标与下一步;置「进行中」会把别的降回「待办」。",
		variants: ["正常", "空", "全状态"],
	},
	{
		id: "workspace-panel",
		group: "world",
		title: "工作区面板",
		module: "components/WorkspacePanel.tsx",
		symbols: ["WorkspacePanel", "formatBytes", "formatAgo"],
		note: "编辑页左栏「工作区」:文件清单由 effect 拉取(SSR 不跑 effect,故第 2 档是等待态),末档单看 formatBytes / formatAgo。",
		variants: ["未开书", "有书等待", "体积与时间"],
	},
	{
		id: "world-summary-panel",
		group: "world",
		title: "简要世界观",
		module: "components/WorldSummaryPanel.tsx",
		symbols: ["WorldSummaryPanel", "SUMMARY_LIMIT"],
		note: "常驻注入的编辑体:textarea + 字数计数,超过 SUMMARY_LIMIT(600)转红并说明保存会被拒。",
		variants: ["空", "正常", "超限"],
	},
];

/* —— 简要世界观编辑体:空 / 正常 / 超限(计数转红) —— */
function SummaryEmpty() {
	const [text, setText] = useState("");
	return <WorldSummaryPanel summary={text} onChange={setText} />;
}

function SummaryNormal() {
	const [text, setText] = useState(
		"九年前的「大雾」之后,海上商路改由钟表匠行会分发灯油:灯塔按月配给,配给单记在行会的蓝皮账上。\n雾里行船要听钟——钟声之外的声音,不要应答。",
	);
	return <WorldSummaryPanel summary={text} onChange={setText} />;
}

function SummaryOverLimit() {
	const [text, setText] = useState("雾中的钟声每十四年响一次,那一年出生的人……".repeat(40));
	return <WorldSummaryPanel summary={text} onChange={setText} />;
}

export const WORLD_SECTION: UIRoomSection = {
	"world-tree": [
		{ label: "多类型多条目", note: "人物/世界各带一层子条目", render: TreeFull },
		{ label: "空世界", note: "四个分组都空", render: TreeEmpty },
		{ label: "未加载", note: "entries=null,树区留白", render: TreeUnloaded },
		{ label: "内联新建", note: "类型下拉 + 标题,可取消", render: TreeCreating },
	],
	"entry-card": [
		{ label: "普通条目", note: "关闭/编辑/删除三个动作", render: CardPlain },
		{ label: "带关系", note: "4 条关系,含强调与双向", render: CardRelated },
		{ label: "长正文", note: "约 1100 字 markdown 简介", render: CardLongBody },
		{ label: "对端已删", note: "关系行禁用并标已删除", render: CardDangling },
	],
	"entry-form": [
		{ label: "新建", note: "空标题/草稿态,可输入", render: FormNew },
		{ label: "编辑现有", note: "关键词 chips + 上千字正文", render: FormEditing },
		{ label: "类型图标全集", note: "四个类型图标与类型名", render: TypeIconSet },
	],
	"entry-info-panel": [
		{ label: "有引用", note: "主图+3 张图库,勾选 2 章,跨类型父条目", render: InfoReferenced },
		{ label: "无引用", note: "无图、无章节、根条目", render: InfoBare },
		{ label: "章节不可用", note: "chaptersOk=false 的退化提示", render: InfoNoChapters },
	],
	"world-entry-detail": [
		{ label: "只读详情", note: "配图 + 4 条关系 + 标签 + 元信息表", render: DetailReadonly },
		{ label: "长正文", note: "约 1100 字,无配图", render: DetailLongBody },
		{ label: "空正文", note: "引导语 + 0 关系", render: DetailEmptyBody },
	],
	"relation-graph": [
		{ label: "24 条关系", note: "11 个节点,默认显示人物/世界", render: GraphFull },
		{ label: "空图", note: "无条目时的画布空态", render: GraphEmpty },
	],
	"timeline-panel": [
		{ label: "有时间线", note: "6 条事件,含未知章节 id", render: TimelineFull },
		{ label: "空", note: "零事件,底部可直接新增", render: TimelineEmpty },
		{ label: "章节不可用", note: "chaptersOk=false 的退化提示", render: TimelineNoChapters },
	],
	"storyline-panel": [
		{ label: "正常", note: "3 个节点,状态可改", render: StorylineNormal },
		{ label: "空", note: "零节点 + 内联新增行", render: StorylineEmpty },
		{ label: "全状态", note: "四种状态胶囊 + 超长目标", render: StorylineAllStatus },
	],
	"workspace-panel": [
		{ label: "未开书", note: "slug=null,不取数", render: WorkspaceNoSlug },
		{ label: "有书等待", note: "effect 拉清单前的等待态", render: WorkspaceWaiting },
		{ label: "体积与时间", note: "formatBytes / formatAgo 全档位", render: WorkspaceFormatters },
	],
	"world-summary-panel": [
		{ label: "空", note: "placeholder 全显示", render: SummaryEmpty },
		{ label: "正常", note: "两段设定,计数远低于上限", render: SummaryNormal },
		{ label: "超限", note: "远超 600 字,计数转红", render: SummaryOverLimit },
	],
};
