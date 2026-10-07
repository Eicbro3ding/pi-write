/**
 * 「UI 房」原子控件分组(atoms)—— 图标 / 开关 / 下拉 / 小卡片这类最小可复用件。
 *
 * 一个展项 = 一个组件模块 + 若干状态档;状态档是**函数组件**(页面用 createElement
 * 挂载),所以里面可以正常调 hook。契约在 `web/src/uiroom-types.ts`,页面壳在
 * `pages/UIRoom.tsx`。
 *
 * 两条自律(契约测试会盯):
 * 1. 档内排布**自包含**:只用行内样式 + 主题 token,不依赖页面壳的类名 ——
 *    壳是并行写的另一个人负责的,展项不该因为它的 CSS 变化而跑版。
 * 2. 必须 **SSR 可渲染**(测试在 node 里 renderToStaticMarkup):渲染期不读
 *    window/document、不发请求;需要交互的档在自己那个组件里 useState。
 *    纯客户端形态(Select 的 createPortal 弹层)只能点进浏览器看,写在 note 里。
 */
import { useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { IconBook, IconDoc, IconEdit, IconGear, IconGlobe, IconPlus, IconStage, IconTrash, IconX } from "../components/Icons.tsx";
import { Lu, LUCIDE_NAMES, type LucideName } from "../components/Lu.tsx";
import { ToolIcon } from "../components/ToolIcon.tsx";
import { ToggleSwitch } from "../components/ToggleSwitch.tsx";
import { Select } from "../components/Select.tsx";
import { MobileHeader } from "../components/MobileHeader.tsx";
import { StageAvatar, characterColor } from "../components/StageAvatar.tsx";
import { MessagePager } from "../components/MessagePager.tsx";
import { FoldablePre } from "../components/FoldablePre.tsx";
import { FilePreview } from "../components/FilePreview.tsx";
import { ThemeCards, ThemeCardsFromManifest, type ThemeAsset } from "../components/ThemeCards.tsx";
import { buildThemeFamilies } from "../themes.ts";
import type { SelectOption } from "../select-logic.ts";
import type { ToolIcon as ToolIconKind } from "../tool-status.ts";
import type { BookFileEntryDto } from "../types.ts";
import { useUIRoomRuntime } from "../uiroom-runtime.tsx";
import type { UIRoomEntry, UIRoomSection } from "../uiroom-types.ts";

/* ════════════════════════════════════════════════════════════════
   展项表(顺序即页面上的顺序)
   ════════════════════════════════════════════════════════════════ */

export const ATOMS_ENTRIES: readonly UIRoomEntry[] = [
	{
		id: "icons",
		group: "atoms",
		title: "应用图标 · 门面",
		module: "components/Icons.tsx",
		symbols: ["IconStage", "IconEdit", "IconGlobe", "IconGear", "IconBook", "IconDoc", "IconX", "IconPlus", "IconTrash"],
		note: "九个语义图标(导航 / 侧栏 / 通用动作);每个名字都对应 lucide 节点名。",
		variants: ["全部图标", "尺寸梯度"],
	},
	{
		id: "lu-icons",
		group: "atoms",
		title: "图标全集(lucide 子集)",
		module: "components/Lu.tsx",
		symbols: ["Lu", "LUCIDE_NAMES"],
		note: "vendored 的 lucide 路径数据:全集网格一眼看缺哪枚,常用一批对业务语义,尺寸梯度看描边比例。",
		variants: ["全集网格", "常用一批", "尺寸梯度"],
	},
	{
		id: "tool-icon",
		group: "atoms",
		title: "工具图标",
		module: "components/ToolIcon.tsx",
		symbols: ["ToolIcon"],
		note: "动作流 / 工具卡共用的八族图标:换族时看是不是每族都能一眼区分。",
		variants: ["全部形态", "尺寸梯度"],
	},
	{
		id: "toggle-switch",
		group: "atoms",
		title: "开关",
		module: "components/ToggleSwitch.tsx",
		symbols: ["ToggleSwitch"],
		note: "开 / 关 / 禁用(禁用态开与关各一枚)+ 可点档:knob 位移与禁用灰度是否分明。",
		variants: ["开", "关", "禁用", "可点切换"],
	},
	{
		id: "select",
		group: "atoms",
		title: "统一下拉",
		module: "components/Select.tsx",
		symbols: ["Select"],
		note: "收起态四档(空 / 选中 / 禁用 / 长列表);展开层走 createPortal 挂 body,SSR 渲染不到,点触发器才看得到。",
		variants: ["空态", "已选中", "禁用", "长列表"],
	},
	{
		id: "mobile-header",
		group: "atoms",
		title: "手机端页头",
		module: "components/MobileHeader.tsx",
		symbols: ["MobileHeader"],
		note: "52px 页头:已保存 / 生成中(live 点) / 角标 / 无主导操作;手机端形态直接这样渲染,不靠 useIsPhone 分支。",
		variants: ["已保存", "生成中", "角标", "无主导操作"],
	},
	{
		id: "stage-avatar",
		group: "atoms",
		title: "角色头像",
		module: "components/StageAvatar.tsx",
		symbols: ["StageAvatar", "characterColor"],
		note: "三类角色(named / pool / narrator)的首字兜底、三档尺寸、世界书主图通路,以及取色函数的色板。",
		variants: ["三类角色", "尺寸梯度", "世界书主图", "取色函数"],
	},
	{
		id: "msg-pager",
		group: "atoms",
		title: "消息版本切换器",
		module: "components/MessagePager.tsx",
		symbols: ["MessagePager"],
		note: "气泡下缘的「‹ 1 / 3 ›」:同一条消息有几个版本(编辑重发 / 重新生成)时就地切换;单版本整块不渲染,两端箭头到底各自禁用。",
		variants: ["单版本", "多版本", "首版", "流式中禁用"],
	},
	{
		id: "foldable-pre",
		group: "atoms",
		title: "折叠长文本",
		module: "components/FoldablePre.tsx",
		symbols: ["FoldablePre"],
		note: "12 行边界两侧(12 行铺开 / 13 行折叠)、55 行长 diff、单行超长;展开态靠点击,SSR 只呈现折叠态。",
		variants: ["短文本", "长代码", "12 行边界", "单行超长"],
	},
	{
		id: "file-preview",
		group: "atoms",
		title: "文件预览覆盖层",
		module: "components/FilePreview.tsx",
		symbols: ["FilePreview"],
		note: "图片 / 文本(正文走 effects 异步取,SSR 停在「加载中」) / 路径不存在 / 二进制元信息。",
		variants: ["图片", "文本", "缺失图片", "二进制"],
	},
	{
		id: "theme-cards",
		group: "atoms",
		title: "主题卡",
		module: "components/ThemeCards.tsx",
		symbols: ["ThemeCards", "ThemeCardsFromManifest"],
		note: "浅深合并卡:只有默认主题 / 多家族列表 / 深色变体选中(胶囊跟着走)。",
		variants: ["当前主题", "多主题列表", "深色选中"],
	},
];

/* ════════════════════════════════════════════════════════════════
   展项里的排布小件(自包含:行内样式 + 主题 token)
   ════════════════════════════════════════════════════════════════ */

function DemoRow({ children, gap = 14 }: { children: ReactNode; gap?: number }) {
	return <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap }}>{children}</div>;
}

function DemoCell({ label, children, width = 84 }: { label: string; children: ReactNode; width?: number }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: width }}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 34 }}>{children}</div>
			<em style={{ fontStyle: "normal", fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap" }}>{label}</em>
		</div>
	);
}

function DemoNote({ children }: { children: ReactNode }) {
	return <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.6, color: "var(--faint)" }}>{children}</p>;
}

function DemoPanel({ children, width }: { children: ReactNode; width?: number }) {
	return (
		<div style={{ padding: 14, border: "1px solid var(--line)", borderRadius: 10, background: "var(--bg-elev)", width, maxWidth: "100%" }}>
			{children}
		</div>
	);
}

/* ════════════════════════════════════════════════════════════════
   icons —— 九个语义图标
   ════════════════════════════════════════════════════════════════ */

const ICON_SHOWCASE: ReadonlyArray<readonly [string, ComponentType<{ size?: number; className?: string }>]> = [
	["舞台", IconStage],
	["编辑", IconEdit],
	["世界书", IconGlobe],
	["设置", IconGear],
	["书", IconBook],
	["草稿", IconDoc],
	["关闭", IconX],
	["新建", IconPlus],
	["删除", IconTrash],
];

function IconsAll() {
	return (
		<DemoRow>
			{ICON_SHOWCASE.map(([label, Icon]) => (
				<DemoCell key={label} label={label}>
					<Icon size={20} />
				</DemoCell>
			))}
		</DemoRow>
	);
}

function IconsSizes() {
	return (
		<DemoRow>
			{[12, 16, 20, 28, 40].map((size) => (
				<DemoCell key={size} label={`${size}px`}>
					<IconBook size={size} />
				</DemoCell>
			))}
			<DemoCell label="舞台 28">
				<IconStage size={28} />
			</DemoCell>
			<DemoCell label="删除 40">
				<IconTrash size={40} />
			</DemoCell>
		</DemoRow>
	);
}

/* ════════════════════════════════════════════════════════════════
   lu-icons —— lucide 子集
   ════════════════════════════════════════════════════════════════ */

const COMMON_ICONS: ReadonlyArray<readonly [LucideName, string]> = [
	["book", "书"],
	["globe", "世界书"],
	["settings", "设置"],
	["search", "搜索"],
	["hash", "字数"],
	["network", "世界树"],
	["users", "角色"],
	["plus", "新建"],
	["trash-2", "删除"],
	["check", "完成"],
	["x", "关闭"],
	["sparkles", "生成"],
	["wand-sparkles", "润色"],
	["eye-off", "隐藏"],
	["chevron-down", "展开"],
	["triangle-alert", "警告"],
];

function LuAll() {
	return (
		<div>
			<DemoNote>全集 {LUCIDE_NAMES.length} 枚(vendored,不引依赖)。</DemoNote>
			<DemoRow gap={8}>
				{LUCIDE_NAMES.map((name) => (
					<DemoCell key={name} label={name} width={96}>
						<Lu icon={name} size={18} />
					</DemoCell>
				))}
			</DemoRow>
		</div>
	);
}

function LuCommon() {
	return (
		<DemoRow>
			{COMMON_ICONS.map(([name, label]) => (
				<DemoCell key={name} label={label}>
					<Lu icon={name} size={20} />
				</DemoCell>
			))}
		</DemoRow>
	);
}

function LuSizes() {
	return (
		<div>
			<DemoNote>同一枚图标的不同尺寸(描边宽度默认 1.5,小尺寸下线条会显粗)。</DemoNote>
			<DemoRow>
				{[12, 14, 16, 20, 24, 32].map((size) => (
					<DemoCell key={size} label={`${size}px`}>
						<Lu icon="sparkles" size={size} />
					</DemoCell>
				))}
			</DemoRow>
			<DemoNote>描边梯度(尺寸不变,改 strokeWidth)。</DemoNote>
			<DemoRow>
				{[1, 1.25, 1.5, 1.75, 2].map((strokeWidth) => (
					<DemoCell key={strokeWidth} label={`${strokeWidth}`}>
						<Lu icon="book-open" size={24} strokeWidth={strokeWidth} />
					</DemoCell>
				))}
			</DemoRow>
		</div>
	);
}

/* ════════════════════════════════════════════════════════════════
   tool-icon —— 八族工具图标
   ════════════════════════════════════════════════════════════════ */

const TOOL_KINDS: ReadonlyArray<readonly [ToolIconKind, string]> = [
	["read", "阅读"],
	["edit", "编辑"],
	["search", "搜索"],
	["find", "查找"],
	["count", "计数"],
	["world", "世界树"],
	["ask", "提问"],
	["other", "其他"],
];

function ToolIconsAll() {
	return (
		<DemoRow>
			{TOOL_KINDS.map(([kind, label]) => (
				<DemoCell key={kind} label={`${label} · ${kind}`} width={104}>
					<ToolIcon kind={kind} size={20} />
				</DemoCell>
			))}
		</DemoRow>
	);
}

function ToolIconsSizes() {
	return (
		<DemoRow>
			{[11, 13, 16, 20, 26].map((size) => (
				<DemoCell key={size} label={`${size}px`}>
					<ToolIcon kind="world" size={size} />
				</DemoCell>
			))}
			<DemoCell label="默认 13">
				<ToolIcon kind="edit" />
			</DemoCell>
		</DemoRow>
	);
}

/* ════════════════════════════════════════════════════════════════
   toggle-switch —— 开 / 关 / 禁用
   ════════════════════════════════════════════════════════════════ */

function ToggleOn() {
	const [on, setOn] = useState(true);
	return <ToggleSwitch checked={on} onChange={setOn} ariaLabel="演示开关" />;
}

function ToggleOff() {
	const [on, setOn] = useState(false);
	return <ToggleSwitch checked={on} onChange={setOn} ariaLabel="演示开关" />;
}

function ToggleDisabled() {
	return (
		<DemoRow>
			<DemoCell label="禁用 · 开">
				<ToggleSwitch checked disabled onChange={() => {}} ariaLabel="禁用开关" />
			</DemoCell>
			<DemoCell label="禁用 · 关">
				<ToggleSwitch checked={false} disabled onChange={() => {}} ariaLabel="禁用开关" />
			</DemoCell>
		</DemoRow>
	);
}

function ToggleInteractive() {
	const [on, setOn] = useState(false);
	return (
		<DemoRow>
			<ToggleSwitch checked={on} onChange={setOn} ariaLabel="演示开关" />
			<span style={{ fontSize: 12, color: "var(--faint)" }}>{on ? "已开启(点一下关掉)" : "已关闭(点一下开启)"}</span>
		</DemoRow>
	);
}

/* ════════════════════════════════════════════════════════════════
   select —— 收起态四档
   ════════════════════════════════════════════════════════════════ */

const SELECT_BASIC: readonly SelectOption[] = [
	{ value: "character", label: "角色", dot: "#d9a84e" },
	{ value: "world", label: "世界", dot: "#7b9ec9" },
	{ value: "timeline", label: "时间线", dot: "#a08cc0" },
	{ value: "outline", label: "大纲", dot: "#9a9184", hint: "只读" },
];

const SELECT_RICH: readonly SelectOption[] = [
	{ value: "character", label: "角色", dot: "#d9a84e", hint: "12 条" },
	{ value: "world", label: "世界", dot: "#7b9ec9", hint: "8 条" },
	{ value: "timeline", label: "时间线", dot: "#a08cc0", hint: "3 条", disabled: true },
	{ value: "outline", label: "大纲条目", dot: "#9a9184", hint: "只读" },
	{ value: "note", label: "笔记(条目本身没有类型色)", hint: "纯文本" },
];

/** 18 条(>12):展开层会自动带搜索框;这里看到的是收起态。 */
const SELECT_LONG: readonly SelectOption[] = Array.from({ length: 18 }, (_, i) => ({
	value: `ch${i + 1}`,
	label: `第 ${i + 1} 章 · ${["渡口", "灯塔", "归航", "暗涌", "潮信"][i % 5]}`,
	hint: `${(i + 1) * 420} 字`,
	dot: ["#9a6524", "#5f7d4e", "#4a6d8c"][i % 3],
	disabled: i === 7,
}));

function SelectEmpty() {
	return <Select value="" onChange={() => {}} options={SELECT_BASIC} placeholder="选择词条类型" ariaLabel="演示下拉" />;
}

function SelectSelected() {
	return (
		<DemoRow>
			<Select value="world" onChange={() => {}} options={SELECT_RICH} placeholder="选择词条类型" ariaLabel="演示下拉" />
			<Select value="note" onChange={() => {}} options={SELECT_RICH} placeholder="选择词条类型" dot="#7b9ec9" ariaLabel="自带色点的下拉" />
		</DemoRow>
	);
}

function SelectDisabled() {
	return (
		<DemoRow>
			<Select value="world" onChange={() => {}} options={SELECT_BASIC} disabled placeholder="选择词条类型" ariaLabel="禁用的下拉" />
			<Select value="" onChange={() => {}} options={SELECT_BASIC} disabled placeholder="无选中值也禁用" ariaLabel="禁用的下拉" />
		</DemoRow>
	);
}

function SelectLong() {
	return (
		<DemoRow>
			<Select value="ch6" onChange={() => {}} options={SELECT_LONG} placeholder="选择章节" title="18 条:展开层自带搜索框" ariaLabel="演示下拉" />
			<Select value="" onChange={() => {}} options={SELECT_LONG} placeholder="空选中值" title="18 条:展开层自带搜索框" ariaLabel="演示下拉" />
		</DemoRow>
	);
}

/* ════════════════════════════════════════════════════════════════
   mobile-header —— 52px 手机端页头
   ════════════════════════════════════════════════════════════════ */

const MOBILE_ACTIONS = [
	{ key: "world", icon: "globe" as LucideName, label: "世界书", onPress: () => {} },
	{ key: "companion", icon: "message-square" as LucideName, label: "AI 伙伴", onPress: () => {}, accent: true },
];

/** 页头右端「自定控件」的两枚 chip(行内样式:不依赖页面壳 CSS)。 */
const CHIP_ON: CSSProperties = {
	padding: "3px 9px",
	border: "1px solid var(--amber-tint-strong)",
	borderRadius: 999,
	background: "var(--amber-tint)",
	color: "var(--amber)",
};
const CHIP_OFF: CSSProperties = {
	padding: "3px 9px",
	border: "1px solid var(--line)",
	borderRadius: 999,
	color: "var(--muted)",
};

function MobileSaved() {
	return (
		<DemoPanel>
			<MobileHeader
				leading={{ icon: "menu", label: "打开书库", onPress: () => {} }}
				title="夜航船"
				subtitle="已保存 · 1,284 字"
				tone="ok"
				actions={MOBILE_ACTIONS}
			/>
		</DemoPanel>
	);
}

function MobileStreaming() {
	return (
		<DemoPanel>
			<MobileHeader
				leading={{ icon: "arrow-left", label: "返回草稿", onPress: () => {} }}
				title="AI 伙伴"
				subtitle="正在生成…"
				tone="busy"
				actions={[{ key: "stop", icon: "x", label: "停止生成", onPress: () => {}, live: true }]}
			/>
		</DemoPanel>
	);
}

function MobileBadge() {
	return (
		<DemoPanel>
			<MobileHeader
				leading={{ icon: "menu", label: "打开书库", onPress: () => {} }}
				title="第一章 · 渡口"
				subtitle="3 处待确认修改"
				tone="busy"
				actions={[{ key: "revise", icon: "square-pen", label: "待确认 3 处", onPress: () => {}, badge: 3, accent: true }]}
			/>
		</DemoPanel>
	);
}

function MobileNoLeading() {
	return (
		<DemoPanel>
			<MobileHeader
				title="世界书"
				right={
					<span style={{ display: "inline-flex", gap: 6, fontSize: 11 }}>
						<span style={CHIP_ON}>世界</span>
						<span style={CHIP_OFF}>角色</span>
					</span>
				}
			>
				<div style={{ display: "flex", gap: 6, paddingTop: 8, fontSize: 12, color: "var(--faint)" }}>搜索框 + 类型 chips 会渲染在这里(children)</div>
			</MobileHeader>
		</DemoPanel>
	);
}

/* ════════════════════════════════════════════════════════════════
   stage-avatar —— 角色头像
   ════════════════════════════════════════════════════════════════ */

function AvatarKinds() {
	return (
		<DemoRow gap={22}>
			<DemoCell label="named · 沈砚" width={110}>
				<StageAvatar slug="demo-book" name="沈砚" />
			</DemoCell>
			<DemoCell label="pool · 灯夫" width={110}>
				<StageAvatar slug="demo-book" name="灯夫" />
			</DemoCell>
			<DemoCell label="narrator" width={110}>
				<StageAvatar slug="demo-book" name="叙述者" narrator />
			</DemoCell>
			<DemoCell label="空名兜底" width={110}>
				<StageAvatar slug="demo-book" name="  " />
			</DemoCell>
		</DemoRow>
	);
}

function AvatarSizes() {
	return (
		<DemoRow gap={22}>
			<DemoCell label="md(默认)" width={110}>
				<StageAvatar slug="demo-book" name="阿枝" />
			</DemoCell>
			<DemoCell label="sm" width={110}>
				<StageAvatar slug="demo-book" name="阿枝" size="sm" />
			</DemoCell>
			<DemoCell label="xs" width={110}>
				<StageAvatar slug="demo-book" name="阿枝" size="xs" />
			</DemoCell>
		</DemoRow>
	);
}

function AvatarImage() {
	return (
		<DemoRow gap={22}>
			<DemoCell label="世界书主图" width={110}>
				<StageAvatar slug="demo-book" name="沈砚" img="shen-yan.png" />
			</DemoCell>
			<DemoCell label="主图缺失(裂图)" width={130}>
				<StageAvatar slug="demo-book" name="沈砚" img="不存在的图.png" />
			</DemoCell>
		</DemoRow>
	);
}

function AvatarColors() {
	const names = ["沈砚", "阿枝", "灯夫", "船家", "叙述者"];
	return (
		<div>
			<DemoNote>characterColor 哈希取色:同角色跨条目稳定,叙述者固定灰。</DemoNote>
			<DemoRow>
				{names.map((name) => {
					const color = characterColor(name, name === "叙述者");
					return (
						<DemoCell key={name} label={color} width={104}>
							<span style={{ display: "block", width: 34, height: 34, borderRadius: 17, background: color }} />
						</DemoCell>
					);
				})}
			</DemoRow>
		</div>
	);
}

/* ════════════════════════════════════════════════════════════════
   msg-pager —— 消息版本切换器(气泡下缘的「‹ 2 / 2 ›」)
   ════════════════════════════════════════════════════════════════ */

function PagerSingle() {
	return (
		<DemoRow>
			<span style={{ fontSize: 12, color: "var(--faint)" }}>只有一个版本时组件返回 null(这一格是留白对照)：</span>
			<MessagePager index={0} total={1} onSelect={() => {}} />
			<span style={{ fontSize: 12, color: "var(--faint)" }}>← 这里什么都没渲染</span>
		</DemoRow>
	);
}

function PagerMany() {
	return (
		<DemoPanel>
			<MessagePager index={1} total={3} onSelect={() => {}} />
		</DemoPanel>
	);
}

function PagerFirst() {
	return (
		<div>
			<DemoNote>第一个版本:左箭头禁用(没有更早的版本可回)。</DemoNote>
			<DemoPanel>
				<MessagePager index={0} total={4} onSelect={() => {}} />
			</DemoPanel>
		</div>
	);
}

function PagerDisabled() {
	return (
		<div>
			<DemoNote>流式中 / 消息还没结束时禁用(服务端此刻拒绝 navigate)。</DemoNote>
			<DemoPanel>
				<MessagePager index={0} total={2} disabled onSelect={() => {}} />
			</DemoPanel>
		</div>
	);
}

/* ════════════════════════════════════════════════════════════════
   foldable-pre —— 折叠长文本
   ════════════════════════════════════════════════════════════════ */

const SHORT_TEXT = ["read draft/ch01.md", "edit draft/ch01.md(3 处替换)", "# draft/ch01.md(1,284 字 · 9 段)"].join("\n");

const LONG_DIFF = [
	"--- a/draft/ch01.md",
	"+++ b/draft/ch01.md",
	"@@ -18,7 +18,9 @@",
	...Array.from({ length: 52 }, (_, i) => `${i % 3 === 0 ? "-" : "+"}  第 ${i + 1} 次改动：潮声压得很低。`),
].join("\n");

const LINE_12 = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：甲板上的灯还亮着。`).join("\n");
const LINE_13 = Array.from({ length: 13 }, (_, i) => `第 ${i + 1} 行：甲板上的灯还亮着。`).join("\n");

const ONE_LONG_LINE = `warning: ${"潮声从舱底传上来，像有人用指节敲木板。".repeat(16)}`;

function FoldShort() {
	return <FoldablePre text={SHORT_TEXT} />;
}

function FoldLong() {
	return (
		<div>
			<DemoNote>55 行 diff:收到 12 行 + 渐隐 + 「展开全部(共 55 行)」。</DemoNote>
			<FoldablePre text={LONG_DIFF} />
		</div>
	);
}

function FoldBoundary() {
	return (
		<DemoRow gap={22}>
			<div style={{ flex: "1 1 260px", minWidth: 240 }}>
				<DemoNote>12 行(边界内:原样铺开,不给展开入口)</DemoNote>
				<FoldablePre text={LINE_12} />
			</div>
			<div style={{ flex: "1 1 260px", minWidth: 240 }}>
				<DemoNote>13 行(越过边界:折叠 + 展开入口)</DemoNote>
				<FoldablePre text={LINE_13} />
			</div>
		</DemoRow>
	);
}

function FoldOneLine() {
	return (
		<div>
			<DemoNote>单行超长:只有 1 行 → 不折叠,靠外面的横向滚动兜(把这一条拖到底看尾巴)。</DemoNote>
			<div style={{ maxWidth: "100%", overflowX: "auto" }}>
				<FoldablePre text={ONE_LONG_LINE} />
			</div>
		</div>
	);
}

/* ════════════════════════════════════════════════════════════════
   file-preview —— 文件预览覆盖层
   ════════════════════════════════════════════════════════════════ */

const FILE_IMAGE: BookFileEntryDto = {
	path: "images/cover.png",
	name: "cover.png",
	title: "封面草图",
	group: "image",
	kind: "image",
	bytes: 245_760,
	mtime: 1_760_000_000_000,
	chapterId: null,
	chapterTitle: null,
};

const FILE_TEXT: BookFileEntryDto = {
	path: "draft/ch01.md",
	name: "ch01.md",
	title: "第一章 · 渡口",
	group: "draft",
	kind: "text",
	bytes: 12_480,
	mtime: 1_760_000_000_000,
	chapterId: "ch01",
	chapterTitle: "第一章 · 渡口",
};

const FILE_MISSING: BookFileEntryDto = {
	path: "images/不存在的地图.png",
	name: "不存在的地图.png",
	title: "缺失的参考图",
	group: "image",
	kind: "image",
	bytes: 0,
	mtime: 1_759_000_000_000,
	chapterId: null,
	chapterTitle: "第二章 · 灯塔",
};

const FILE_BINARY: BookFileEntryDto = {
	path: "exports/book.zip",
	name: "book.zip",
	title: "book.zip",
	group: "other",
	kind: "binary",
	bytes: 5_242_880,
	mtime: 1_759_000_000_000,
	chapterId: null,
	chapterTitle: null,
};

/**
 * .ws-preview 是 `position: absolute; inset: 0` 的覆盖层 —— 它自己不带高度,
 * 必须有一个「有高度的定位祖先」才看得见(真实应用里那个祖先是纸张区)。
 * 这里给展项自己造一个,不依赖页面壳的 min-height,也不滥用 entry.frame
 * (frame 是给 position: fixed 的弹层用的,.ws-preview 不是 fixed)。
 */
function PreviewFrame({ children }: { children: ReactNode }) {
	return (
		<div style={{ position: "relative", minHeight: 340, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
			{children}
		</div>
	);
}

function PreviewImage() {
	const { client, slug } = useUIRoomRuntime();
	return (
		<PreviewFrame>
			<FilePreview client={client} slug={slug ?? "demo-book"} entry={FILE_IMAGE} onClose={() => {}} />
		</PreviewFrame>
	);
}

function PreviewText() {
	const { client, slug } = useUIRoomRuntime();
	return (
		<div>
			<DemoNote>正文由 effect 异步取(SSR 停在「加载中」;页面上会真去读这个路径,读不到就转成红色错误条)。</DemoNote>
			<PreviewFrame>
				<FilePreview client={client} slug={slug ?? "demo-book"} entry={FILE_TEXT} onClose={() => {}} />
			</PreviewFrame>
		</div>
	);
}

function PreviewMissing() {
	const { client, slug } = useUIRoomRuntime();
	return (
		<div>
			<DemoNote>路径不存在:元信息照常渲染,图片位是裂图。</DemoNote>
			<PreviewFrame>
				<FilePreview client={client} slug={slug ?? "demo-book"} entry={FILE_MISSING} onClose={() => {}} />
			</PreviewFrame>
		</div>
	);
}

function PreviewBinary() {
	const { client, slug } = useUIRoomRuntime();
	return (
		<PreviewFrame>
			<FilePreview client={client} slug={slug ?? "demo-book"} entry={FILE_BINARY} onClose={() => {}} />
		</PreviewFrame>
	);
}

/* ════════════════════════════════════════════════════════════════
   theme-cards —— 主题卡(浅深合并)
   ════════════════════════════════════════════════════════════════ */

/** 演示用主题清单:css 首行注释的写法与真实主题文件一致(themes.ts 靠它取显示名与色板)。 */
const BUILTIN_THEMES: readonly ThemeAsset[] = [
	{ file: "paper.css", css: "/* pi-writer 主题 · 纸上书房(paper) */\n:root { --bg: #f7f2e8; --amber: #9a6524; --ink: #241f19; }" },
	{ file: "parchment.css", css: "/* pi-writer 主题 · 羊皮灯下(parchment) */\n:root { --bg: #efe1c8; --amber: #a8641f; --ink: #33261a; }" },
	{ file: "morandi.css", css: "/* pi-writer 主题 · 莫兰迪(morandi) */\n:root { --bg: #ece9e3; --amber: #8b7a63; --ink: #2f2c28; }" },
	{ file: "morandi-dark.css", css: "/* pi-writer 主题 · 莫兰迪 深色(morandi-dark) */\n:root { --bg: #1a1917; --amber: #c0a882; --ink: #e6e2da; }" },
];

const USER_THEMES: readonly ThemeAsset[] = [
	{ file: "night-owl.css", css: "/* pi-writer 主题 · 夜猫子(night-owl) */\n:root { --bg: #0b1021; --amber: #e0af68; --ink: #c8d3f5; }" },
	{ file: "night-owl-dark.css", css: "/* pi-writer 主题 · 夜猫子 深色(night-owl-dark) */\n:root { --bg: #070b18; --amber: #e0af68; --ink: #a9b8e8; }" },
];

function ThemesCurrent() {
	return (
		<div>
			<DemoNote>只有默认主题(night)时的样子:单张卡、选中态。</DemoNote>
			<ThemeCards families={buildThemeFamilies([], [])} current="night" onPick={() => {}} />
		</div>
	);
}

function ThemesMany() {
	return (
		<div>
			<DemoNote>清单驱动(buildThemeFamilies 合并浅深):内置 4 个文件 + 用户 2 个,加上默认 night 共 5 张卡。</DemoNote>
			<ThemeCardsFromManifest builtin={BUILTIN_THEMES} user={USER_THEMES} current="parchment" onPick={() => {}} />
		</div>
	);
}

function ThemesDarkPicked() {
	return (
		<div>
			<DemoNote>选中深色变体:卡片色板跟着走,「深色」胶囊点亮。</DemoNote>
			<ThemeCards families={buildThemeFamilies(BUILTIN_THEMES, USER_THEMES)} current="morandi-dark" onPick={() => {}} />
		</div>
	);
}

/* ════════════════════════════════════════════════════════════════
   状态档表(键集与 ENTRIES 的 id 集一一对应;label 与 variants 逐字同序)
   ════════════════════════════════════════════════════════════════ */

export const ATOMS_SECTION: UIRoomSection = {
	"icons": [
		{ label: "全部图标", note: "九个语义图标一次看全", render: IconsAll },
		{ label: "尺寸梯度", note: "12 → 40px", render: IconsSizes },
	],
	"lu-icons": [
		{ label: "全集网格", note: "看缺哪一枚", render: LuAll },
		{ label: "常用一批", note: "业务语义对照", render: LuCommon },
		{ label: "尺寸梯度", note: "尺寸与描边两档", render: LuSizes },
	],
	"tool-icon": [
		{ label: "全部形态", note: "八族各一枚", render: ToolIconsAll },
		{ label: "尺寸梯度", note: "11 → 26px", render: ToolIconsSizes },
	],
	"toggle-switch": [
		{ label: "开", note: "checked=true", render: ToggleOn },
		{ label: "关", note: "checked=false", render: ToggleOff },
		{ label: "禁用", note: "开 / 关 两枚灰态", render: ToggleDisabled },
		{ label: "可点切换", note: "自己那个组件里的 useState", render: ToggleInteractive },
	],
	"select": [
		{ label: "空态", note: "value=\"\" → 占位文案", render: SelectEmpty },
		{ label: "已选中", note: "选项色点 / hint / 禁用项,以及触发器自带色点", render: SelectSelected },
		{ label: "禁用", note: "有值 / 无值两种", render: SelectDisabled },
		{ label: "长列表", note: "18 条:展开层会自动带搜索", render: SelectLong },
	],
	"mobile-header": [
		{ label: "已保存", note: "tone=ok,双图标动作", render: MobileSaved },
		{ label: "生成中", note: "tone=busy + live 呼吸点", render: MobileStreaming },
		{ label: "角标", note: "badge=3 + accent 底", render: MobileBadge },
		{ label: "无主导操作", note: "无 leading / 无 subtitle,右端自定控件", render: MobileNoLeading },
	],
	"stage-avatar": [
		{ label: "三类角色", note: "named / pool / narrator + 空名兜底", render: AvatarKinds },
		{ label: "尺寸梯度", note: "md / sm / xs", render: AvatarSizes },
		{ label: "世界书主图", note: "img 通路 + 主图缺失", render: AvatarImage },
		{ label: "取色函数", note: "characterColor 的色板", render: AvatarColors },
	],
	"msg-pager": [
		{ label: "单版本", note: "total=1 → 组件返回 null 的对照", render: PagerSingle },
		{ label: "多版本", note: "第 2 / 共 3 版:两头都可点", render: PagerMany },
		{ label: "首版", note: "左箭头禁用", render: PagerFirst },
		{ label: "流式中禁用", note: "disabled → 两颗箭头都点不动", render: PagerDisabled },
	],
	"foldable-pre": [
		{ label: "短文本", note: "3 行:不折叠", render: FoldShort },
		{ label: "长代码", note: "55 行 diff:折叠 + 展开入口", render: FoldLong },
		{ label: "12 行边界", note: "12 行 vs 13 行", render: FoldBoundary },
		{ label: "单行超长", note: "1 行 400+ 字:不折叠,靠横向滚动", render: FoldOneLine },
	],
	"file-preview": [
		{ label: "图片", note: "字节流直出 + 元信息", render: PreviewImage },
		{ label: "文本", note: "异步取正文(SSR 停在加载中)", render: PreviewText },
		{ label: "缺失图片", note: "路径不存在 → 裂图", render: PreviewMissing },
		{ label: "二进制", note: "只给元信息,不内联", render: PreviewBinary },
	],
	"theme-cards": [
		{ label: "当前主题", note: "只有默认 night", render: ThemesCurrent },
		{ label: "多主题列表", note: "内置 + 用户 + 默认 night → 5 张卡", render: ThemesMany },
		{ label: "深色选中", note: "选中 -dark 变体", render: ThemesDarkPicked },
	],
};
