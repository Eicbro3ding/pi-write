/**
 * UI 房 · 「设置与列表」分组:供应商 / 模型 / MCP / 插件 / 导出 / 全屏编辑器 / 向导 /
 * 会话用量 / 备忘录板。
 *
 * 这一组大多是**数据型组件**:它们自己发请求、自己管状态。展项只负责递上运行时
 * (`useUIRoomRuntime()` 里 App 注入的那个真实 client),不新建 ApiClient、不在渲染期
 * 发请求 —— 请求都在组件自己的 effect 里(SSR 下 effects 不跑)。
 * 真实服务在跑时它们显示真实数据,这正是陈列室的价值;离线时看到的是各自的加载 / 空态。
 *
 * 固定定位的弹层(`.dlg-overlay` / `.fs-editor` / `.wz-overlay` / 手机整屏 `.m-sheet`)
 * 都登记了 `frame`,由页面套一层 transform 容器关回格子里(见 styles/uiroom.css 的
 * `.uiroom-stage--fixed`),否则一展开就盖住整页。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../api/client.ts";
import { AddModelDialog } from "../components/AddModelDialog.tsx";
import { AddProviderDialog } from "../components/AddProviderDialog.tsx";
import { ChoiceCards } from "../components/ChoiceCards.tsx";
import { CREATION_MODES } from "../components/CreationModeCards.tsx";
import { ConversationScopeCards } from "../components/ConversationScopeCards.tsx";
import { CreationModeCards } from "../components/CreationModeCards.tsx";
import { ExportPanel } from "../components/ExportPanel.tsx";
import { FullScreenEditor } from "../components/FullScreenEditor.tsx";
import { McpServerList } from "../components/McpServerList.tsx";
import { PluginList } from "../components/PluginList.tsx";
import { PluginSettings } from "../components/PluginSettings.tsx";
import { ProviderList } from "../components/ProviderList.tsx";
import { SHELL_CHOICES, ShellCards } from "../components/ShellCards.tsx";
import { SetupWizard } from "../components/SetupWizard.tsx";
import type { PluginInfoDto } from "../types.ts";
import { useUIRoomRuntime } from "../uiroom-runtime.tsx";
import type { UIRoomEntry, UIRoomSection } from "../uiroom-types.ts";

export const SETTINGS_ENTRIES: readonly UIRoomEntry[] = [
	{
		id: "provider-list",
		group: "settings",
		title: "供应商列表",
		module: "components/ProviderList.tsx",
		symbols: ["ProviderList"],
		note: "桌面双栏 / 手机三态共用的一套数据:左侧全量列表 + 搜索,右侧详情(Key、模型列表、测试连接)。有服务在跑时是真实供应商。",
		variants: ["已连接", "加载中"],
	},
	{
		id: "add-provider-dialog",
		group: "settings",
		title: "添加供应商弹窗",
		module: "components/AddProviderDialog.tsx",
		symbols: ["AddProviderDialog"],
		note: "只管供应商(id / 名称 / Base URL / Key),模型在供应商详情里单独加。固定定位弹层,已加框。",
		variants: ["默认", "校验错误"],
		frame: "viewport",
	},
	{
		id: "add-model-dialog",
		group: "settings",
		title: "添加 / 编辑模型弹窗",
		module: "components/AddModelDialog.tsx",
		symbols: ["AddModelDialog"],
		note: "只管模型(ID / 显示名 / 上下文窗口 / 最大输出 / 输入类型);Base URL 与 Key 属于供应商,不在这里出现。固定定位弹层,已加框。",
		variants: ["新增", "编辑", "校验错误"],
		frame: "viewport",
	},
	{
		id: "mcp-server-list",
		group: "settings",
		title: "MCP 服务器列表",
		module: "components/McpServerList.tsx",
		symbols: ["McpServerList"],
		note: "服务器行(类型 + 连接状态 / 工具数)+ 行内表单 + 直接编辑 mcp.json。有服务在跑时显示真实连接状态。",
		variants: ["真实服务", "空态"],
	},
	{
		id: "plugin-list",
		group: "settings",
		title: "插件列表",
		module: "components/PluginList.tsx",
		symbols: ["PluginList"],
		note: "启用 / 禁用、完全信任(二次确认)、删除(行内确认);装载错误直接挂在那一行下面。",
		variants: ["真实服务", "加载中"],
	},
	{
		id: "plugin-settings",
		group: "settings",
		title: "插件设置表单",
		module: "components/PluginSettings.tsx",
		symbols: ["PluginSettings"],
		note: "按 plugin.json 声明的字段 schema 渲染的真表单(白名单:字符串 / 数字 / 开关 / 下拉 / 多行);这里用手写 PluginInfoDto 喂。假插件不在盘上(真读设置会 404),所以读方法挂住,只看 schema → 控件这一段。",
		variants: ["标准", "多区块"],
	},
	{
		id: "export-panel",
		group: "settings",
		title: "导出面板",
		module: "components/ExportPanel.tsx",
		symbols: ["ExportPanel", "EXPORT_FORMATS"],
		note: "五个格式页签+ 范围 / 选项 / 统计。手机端是整屏 `.m-sheet` 形态(fixed),所以这一格加框。",
		variants: ["桌面", "手机整屏"],
		frame: "phone",
	},
	{
		id: "full-screen-editor",
		group: "settings",
		title: "全屏编辑器",
		module: "components/FullScreenEditor.tsx",
		symbols: ["FullScreenEditor"],
		note: "覆盖整窗的模态编辑页:路径 + 常用文件下拉 + Ctrl+S 保存 + 脏缓冲退出确认。编辑器本体是 CodeMirror 6,但 EditorView 在 effect 里创建,所以 node 里 SSR 也能出外壳(不用 ssrSkip)。整屏覆盖层,已加框。",
		variants: ["本章草稿", "大纲文件"],
		frame: "viewport",
	},
	{
		id: "creation-mode-cards",
		group: "settings",
		title: "创作方式卡",
		module: "components/CreationModeCards.tsx",
		symbols: ["CreationModeCards", "CREATION_MODES"],
		note: "多 Agent / 单 Agent 两张大选项卡(首启向导「创作方式」步与设置页「Agent 形态」卡共用)。文案与要点只写在这一份里,两处说法不会漂移;点已选中的那张不重复请求。",
		variants: ["多 Agent 选中", "单 Agent 选中"],
	},
	{
		id: "conversation-scope-cards",
		group: "settings",
		title: "对话与章节选择",
		module: "components/ConversationScopeCards.tsx",
		symbols: ["ConversationScopeCards", "CONVERSATION_SCOPES"],
		note: "绑定章节 / 分离 两选一(设置页「对话与章节」卡与首启向导「对话范围」步共用)。骨架走 ChoiceCards,文案与要点只写在这一份里,两处说法不会漂移;点已选中的那个不重复请求。",
		variants: ["绑定章节选中", "分离选中"],
	},
	{
		id: "choice-cards",
		group: "settings",
		title: "选择卡(骨架)",
		module: "components/ChoiceCards.tsx",
		symbols: ["ChoiceCards"],
		note: "单选卡片组的**唯一骨架**:创作方式 / 对话范围 / 执行命令三处向导步与设置页两张卡都套它,各自只给一份数据(2026-10-02 由三份实现收敛成这一份)。图标底 + 标题胶囊 + 一句话定位 + 要点列表 + 右上单选圈。",
		variants: ["创作方式数据", "执行命令数据"],
	},
	{
		id: "shell-cards",
		group: "settings",
		title: "执行命令卡",
		module: "components/ShellCards.tsx",
		symbols: ["ShellCards", "SHELL_CHOICES", "SHELL_CONFIRM_TEXT"],
		note: "保持关闭 / 开启 shell 两选一(首启向导「执行命令」步)。风险确认条由调用方画,正文 `SHELL_CONFIRM_TEXT` 与设置页「执行命令」那一处共用一份 —— 改口径两处一起变。",
		variants: ["保持关闭", "已开启"],
	},
	{
		id: "setup-wizard",
		group: "settings",
		title: "首启向导",
		module: "components/SetupWizard.tsx",
		symbols: ["SetupWizard"],
		note: "八步整屏向导(介绍 → 创作方式 → 对话范围 → 执行命令 → 模型服务 → 默认模型 → 第一本书 → 界面偏好)。四档都按**新默认(单 Agent)**渲染,后三档挂载后连环点「下一步」,分别停在创作方式 / 对话范围 / 执行命令三步 —— 每一步都是同一套两选一卡片(ChoiceCards),执行命令那步选「开启」才会出现风险确认条。整屏覆盖层,已加框。向导在渲染期读浏览器 localStorage(主题),所以这几档在服务端(SSR)只出一行说明、挂载后才换成真向导。",
		variants: ["介绍", "创作方式", "对话范围", "执行命令"],
		frame: "viewport",
	},
];

/** 永不落地的 promise:用来把数据型展项定格在首帧的「加载中…」。 */
function pendingForever<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

/**
 * 读方法替身:把下面这几个**读**方法挂住(永不 resolve),其余原样走运行时那个真实
 * client(写方法也照旧)。两处用途:
 * - 定格首帧的「加载中…」(供应商 / MCP / 插件列表);
 * - 插件设置档:手写的 PluginInfoDto 对应的插件不在盘上,真读设置会 404,挂住就没有
 *   那条与 schema 无关的错误,只留「schema → 控件」本身。
 * 不新建 ApiClient —— 请求基址 / 凭据仍然是 App 注入的实例。
 */
const STALLED_READS = new Set(["getProviders", "getModels", "getMcpServers", "getPlugins", "getPluginSettings"]);

function stalledClient(real: ApiClient): ApiClient {
	return new Proxy(real, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && STALLED_READS.has(prop)) return pendingForever;
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * 带框格子的「演示视口」。固定定位的弹层不参与文档流,格子高度只由普通流内容决定 ——
 * 不在这儿撑出一段高度,弹层就会被 `.uiroom-stage--fixed` 的 overflow 上下裁掉
 * (`.dlg-overlay` 是 inset:0 + 居中,面板比格子高时两头一起切)。
 * `height` 就是这一档给弹层的视口高度;`align` 供右侧浮层(导出面板贴按钮下缘那种)用。
 */
function FrameBox({ height, align = "left", children }: { height: number; align?: "left" | "right"; children: ReactNode }) {
	return <div style={{ width: "100%", minHeight: height, textAlign: align }}>{children}</div>;
}

// —— 供应商列表 ——

/** 真实 client(有服务在跑时就是真数据)。 */
function ProviderListLive() {
	const { client } = useUIRoomRuntime();
	return <ProviderList client={client} onAuthChanged={() => {}} />;
}

/** 读方法挂住 → 停在首帧的「加载中…」。 */
function ProviderListLoading() {
	const { client } = useUIRoomRuntime();
	const stalled = useMemo(() => stalledClient(client), [client]);
	return <ProviderList client={stalled} onAuthChanged={() => {}} />;
}

// —— 弹窗:点一次「保存」看校验错误 ——

/**
 * 两个弹窗的校验错误只在提交时产生,没有外部入口 —— 挂载后替用户点一下「保存」。
 * effect 只在浏览器里跑(node 下不执行),所以 SSR 渲染的仍是干净的默认档。
 */
function useClickSaveOnMount(selector: string) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		ref.current?.querySelector<HTMLButtonElement>(selector)?.click();
	}, [selector]);
	return ref;
}

function AddProviderDefault() {
	const { client } = useUIRoomRuntime();
	return (
		<FrameBox height={520}>
			<AddProviderDialog client={client} onSaved={() => {}} onClose={() => {}} />
		</FrameBox>
	);
}

/** 空表单直接提交 → id 校验先拦下来(不发请求)。 */
function AddProviderInvalid() {
	const { client } = useUIRoomRuntime();
	const ref = useClickSaveOnMount(".amd-foot .wz-primary");
	return (
		<FrameBox height={520}>
			<div ref={ref}>
				<AddProviderDialog client={client} onSaved={() => {}} onClose={() => {}} />
			</div>
		</FrameBox>
	);
}

function AddModelCreate() {
	const { client } = useUIRoomRuntime();
	return (
		<FrameBox height={560}>
			<AddModelDialog
				client={client}
				mode="model"
				providerId="mock"
				providerLabel="本地 Mock"
				baseUrl="http://127.0.0.1:8787/v1"
				onSaved={() => {}}
				onClose={() => {}}
			/>
		</FrameBox>
	);
}

/** 编辑自定义模型:预填现有条目,标题与提交路径都换成「编辑模型」。 */
function AddModelEdit() {
	const { client } = useUIRoomRuntime();
	return (
		<FrameBox height={560}>
			<AddModelDialog
				client={client}
				mode="edit"
				providerId="mock"
				providerLabel="本地 Mock"
				initialModel={{ id: "mock-1", name: "本地 Mock 一号", contextWindow: 128_000, maxTokens: 8_192, input: ["text", "image"] }}
				onSaved={() => {}}
				onClose={() => {}}
			/>
		</FrameBox>
	);
}

/** 模型 ID 留空 → 模型 id 校验先拦下来(不发请求)。 */
function AddModelInvalid() {
	const { client } = useUIRoomRuntime();
	const ref = useClickSaveOnMount(".amd-foot .wz-primary");
	return (
		<FrameBox height={560}>
			<div ref={ref}>
				<AddModelDialog
					client={client}
					mode="model"
					providerId="mock"
					providerLabel="本地 Mock"
					baseUrl="http://127.0.0.1:8787/v1"
					onSaved={() => {}}
					onClose={() => {}}
				/>
			</div>
		</FrameBox>
	);
}

// —— MCP / 插件 ——

function McpLive() {
	const { client } = useUIRoomRuntime();
	return <McpServerList client={client} />;
}

/** 读方法挂住:组件的「空态」判定就是 `!hasServers`,所以这一档看到的是空态外壳。 */
function McpEmpty() {
	const { client } = useUIRoomRuntime();
	const stalled = useMemo(() => stalledClient(client), [client]);
	return <McpServerList client={stalled} />;
}

function PluginListLive() {
	const { client } = useUIRoomRuntime();
	return <PluginList client={client} />;
}

function PluginListLoading() {
	const { client } = useUIRoomRuntime();
	const stalled = useMemo(() => stalledClient(client), [client]);
	return <PluginList client={stalled} />;
}

// —— 插件设置(手写 DTO,覆盖字段类型白名单) ——

const PLUGIN_STANDARD: PluginInfoDto = {
	id: "demo-clock",
	name: "码表",
	version: "1.2.0",
	description: "在侧栏显示本章的写作时长与停顿次数。",
	manifestDisabled: false,
	enabled: true,
	trusted: false,
	error: null,
	path: "/home/me/.pi/writer/plugins/demo-clock/index.mjs",
	frontend: {
		ui: {
			settingsItems: [
				{
					title: "显示",
					description: "控制码表在界面上呈现成什么样子。",
					fields: [
						{ key: "enabled", label: "启用码表", type: "boolean", default: true, desc: "关掉后不再计时,已有记录保留。" },
						{ key: "label", label: "标题文案", type: "string", default: "本章用时" },
						{ key: "limit", label: "提醒阈值(分钟)", type: "number", default: 45, desc: "超时后标题变成琥珀色。" },
						{ key: "position", label: "位置", type: "select", default: "right", options: [
							{ value: "left", label: "左栏底部" },
							{ value: "right", label: "右栏底部" },
							{ value: "hidden", label: "不显示" },
						] },
						{ key: "footer", label: "脚注", type: "textarea", default: "", desc: "显示在码表下方的一行小字。" },
					],
				},
			],
		},
	},
};

const PLUGIN_MULTI: PluginInfoDto = {
	id: "demo-export-plus",
	name: "导出增强(实验)",
	version: "0.3.1-beta.2",
	description: "给导出面板加 Dropbox / WebDAV 两个去处,并允许把导出结果自动归档到书目录。",
	manifestDisabled: false,
	enabled: false,
	trusted: true,
	error: "装载告警:未找到可选依赖 node-fetch,将回退到内置实现。",
	path: "/home/me/.pi/writer/plugins/demo-export-plus/index.mjs",
	frontend: {
		ui: {
			settingsItems: [
				{
					title: "目标",
					description: "两个去处可以同时开;凭据只存本机。",
					fields: [
						{ key: "dropbox", label: "启用 Dropbox", type: "boolean", default: false },
						{ key: "webdav", label: "启用 WebDAV", type: "boolean", default: false },
						{ key: "endpoint", label: "WebDAV 地址", type: "string", default: "https://dav.example.com/remote.php/dav/files/me/novels" },
						{ key: "token", label: "访问令牌", type: "string", desc: "只写不读;留空表示不改动。" },
					],
				},
				{
					title: "归档",
					description: "导出成功后额外做一次本地归档。",
					fields: [
						{ key: "archive", label: "启用归档", type: "boolean", default: true },
						{ key: "format", label: "归档格式", type: "select", default: "md", options: [
							{ value: "md", label: "Markdown(保留标题与强调)" },
							{ value: "txt", label: "纯文本(不带任何格式)" },
						] },
						{ key: "keepDays", label: "保留天数", type: "number", default: 30, desc: "0 = 不自动清理。" },
						{ key: "note", label: "归档说明", type: "textarea", desc: "写进归档清单的一句话。" },
					],
				},
			],
		},
	},
};

function PluginSettingsStandard() {
	const { client } = useUIRoomRuntime();
	const stalled = useMemo(() => stalledClient(client), [client]);
	return <PluginSettings client={stalled} plugin={PLUGIN_STANDARD} />;
}

function PluginSettingsMulti() {
	const { client } = useUIRoomRuntime();
	const stalled = useMemo(() => stalledClient(client), [client]);
	return <PluginSettings client={stalled} plugin={PLUGIN_MULTI} />;
}

// —— 导出面板 ——

/** 演示章节(与 BookDetail.chapters 同形);真实页面里由 WritePage 注入。 */
const EXPORT_CHAPTERS = [
	{ id: "ch01", file: "ch01.jsonl", title: "第一章 · 渡口", label: null },
	{ id: "ch02", file: "ch02.jsonl", title: "第二章 · 灯塔", label: "草稿" },
	{ id: "ch03", file: "ch03.jsonl", title: "第三章 · 归航", label: "完成" },
];

const EXPORT_BODY = "……(演示正文:真实页面里这里是从服务端读回来的草稿原文,统计也按它算。)";

/**
 * 导出面板的 props(真实页面里由 WritePage 注入)。做成常量:里面的读函数是
 * ExportPanel effect 的依赖,每次渲染换身份会让统计反复重算。
 */
const EXPORT_PROPS = {
	bookTitle: "夜航船",
	chapters: EXPORT_CHAPTERS,
	currentChapterFile: "ch01.jsonl",
	currentChapterTitle: "第一章 · 渡口",
	loadChapterText: async () => EXPORT_BODY,
	loadWorldAppendix: async () => ({ text: "世界书附录演示文本", count: 8 }),
	onError: () => {},
};

/** 桌面形态:受控打开(自带触发按钮不渲染,省得再点一次);面板贴宿主右缘向左展开。 */
function ExportDesktop() {
	return (
		<FrameBox height={400} align="right">
			<ExportPanel {...EXPORT_PROPS} control={{ open: true, onClose: () => {} }} />
		</FrameBox>
	);
}

/** 手机整屏形态:与 WritePage 的同款外壳(≤700px 时 .m-sheet 才是整屏页)。 */
function ExportPhoneSheet() {
	return (
		<FrameBox height={440} align="right">
			<div className="m-sheet" role="dialog" aria-label="导出">
				<div className="m-sheet-head">
					<button type="button" className="m-icon-btn" aria-label="返回" title="返回">
						‹
					</button>
					<span className="m-sheet-title">导出</span>
					<span className="m-head-sub-text">夜航船</span>
				</div>
				<div className="m-sheet-body">
					<ExportPanel {...EXPORT_PROPS} control={{ open: true, onClose: () => {} }} />
				</div>
			</div>
		</FrameBox>
	);
}

// —— 全屏编辑器 ——

function FsEditorChapter() {
	const { client, slug } = useUIRoomRuntime();
	return (
		<FrameBox height={460}>
			<FullScreenEditor
				client={client}
				slug={slug}
				initialFile="draft/ch01.md"
				title="《夜航船》 · 第一章 · 渡口 · 全屏编辑"
				onClose={() => {}}
			/>
		</FrameBox>
	);
}

function FsEditorOutline() {
	const { client, slug } = useUIRoomRuntime();
	return (
		<FrameBox height={460}>
			<FullScreenEditor client={client} slug={slug} initialFile="outline.md" title="《夜航船》 · 大纲 · 全屏编辑" onClose={() => {}} />
		</FrameBox>
	);
}

// —— 创作方式卡(两张大卡;向导与设置页共用) ——

function CreationModeMulti() {
	return <CreationModeCards classic={false} onPick={() => {}} />;
}

function CreationModeSingle() {
	return <CreationModeCards classic onPick={() => {}} />;
}

// —— 对话与章节 / 选择卡骨架 / 执行命令卡 ——

function ConversationScopeChapter() {
	return <ConversationScopeCards scope="chapter" onPick={() => {}} />;
}

function ConversationScopeBook() {
	return <ConversationScopeCards scope="book" onPick={() => {}} />;
}

/** 骨架本身:同一份 DOM / 样式套两组真实数据(创作方式、执行命令)。 */
function ChoiceCardsModes() {
	return <ChoiceCards ariaLabel="创作方式" options={CREATION_MODES} value onPick={() => {}} />;
}

function ChoiceCardsShell() {
	return <ChoiceCards ariaLabel="执行命令" options={SHELL_CHOICES} value={false} onPick={() => {}} />;
}

function ShellOff() {
	return <ShellCards enabled={false} onPick={() => {}} />;
}

function ShellOn() {
	return <ShellCards enabled onPick={() => {}} />;
}

// —— 首启向导 ——

/**
 * 向导渲染期会经 theme.ts 的 currentTheme() 读 localStorage,而 node / SSR 里没有这个
 * 全局(读了就抛)。所以按「浏览器独占组件」处理:服务端先渲染一行说明,挂载后才换成
 * 真向导 —— 浏览器里第一次 effect 之后就是真的,看不到这一行。
 * (不登记 ssrSkip:展项本身在 node 里能渲染出来,不该跳过冒烟。)
 */
function WizardMount({ classicMode, openSteps = 0 }: { classicMode: boolean; openSteps?: number }) {
	const { client } = useUIRoomRuntime();
	const [mounted, setMounted] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => setMounted(true), []);
	/**
	 * 「走到第 N 步」档:挂载后连环点页脚主按钮。向导的当前步骤是内部 state,没有对外
	 * 入口;这与「添加模型弹窗」档自动点一次保存是同一手法。每点一次要等 React 把下一步
	 * 画出来(下一次点击才有新的 .wz-primary),所以用定时器排队而不是一口气点 N 下。
	 * effect 在 node 下不跑,所以 SSR 仍渲染介绍步,浏览器里才跳。
	 */
	useEffect(() => {
		if (!mounted || openSteps <= 0) return;
		let cancelled = false;
		const timers: number[] = [];
		let n = 0;
		const tick = () => {
			if (cancelled) return;
			ref.current?.querySelector<HTMLButtonElement>(".wz-foot .wz-primary")?.click();
			n += 1;
			if (n < openSteps) timers.push(window.setTimeout(tick, 50));
		};
		timers.push(window.setTimeout(tick, 0));
		return () => {
			cancelled = true;
			for (const t of timers) window.clearTimeout(t);
		};
	}, [mounted, openSteps]);
	if (!mounted) {
		return (
			<p className="uiroom-hint">
				向导只在浏览器里挂载:它在渲染期会读浏览器的 localStorage(当前主题),node / SSR 下没有这个 API。
			</p>
		);
	}
	return (
		<FrameBox height={620}>
			<div ref={ref}>
				<SetupWizard
					client={client}
					autoExpandThinking
					onAutoExpandThinkingChange={() => {}}
					autoConfirmEdits={false}
					onAutoConfirmEditsChange={() => {}}
					classicMode={classicMode}
					onClassicModeChange={async () => {}}
					conversationScope="chapter"
					onConversationScopeChange={async () => {}}
					shellEnabled={false}
					onShellEnabledChange={async () => {}}
					onFinished={() => {}}
				/>
			</div>
		</FrameBox>
	);
}

function WizardIntro() {
	return <WizardMount classicMode />;
}

/** 创作方式步:多/单 Agent 两张大卡(默认选中单 Agent)。 */
function WizardMode() {
	return <WizardMount classicMode openSteps={1} />;
}

/** 对话范围步:绑定章节 / 分离 两张大卡(默认选中绑定章节)。 */
function WizardScope() {
	return <WizardMount classicMode openSteps={2} />;
}

/** 执行命令步:保持关闭 / 开启 shell 两张大卡(默认选中保持关闭)。 */
function WizardShell() {
	return <WizardMount classicMode openSteps={3} />;
}

export const SETTINGS_SECTION: UIRoomSection = {
	"provider-list": [
		{ label: "已连接", note: "真实 client:已配置的排前、带徽章", render: ProviderListLive },
		{ label: "加载中", note: "读方法被挂住,停在首帧", render: ProviderListLoading },
	],
	"add-provider-dialog": [
		{ label: "默认", note: "空表单 + 协议说明", render: AddProviderDefault },
		{ label: "校验错误", note: "挂载后自动点一次保存", render: AddProviderInvalid },
	],
	"add-model-dialog": [
		{ label: "新增", note: "上下文 1M / 输出 128K 的默认值", render: AddModelCreate },
		{ label: "编辑", note: "预填现有自定义模型", render: AddModelEdit },
		{ label: "校验错误", note: "模型 ID 留空后提交", render: AddModelInvalid },
	],
	"mcp-server-list": [
		{ label: "真实服务", note: "行 + 连接状态 + 工具数", render: McpLive },
		{ label: "空态", note: "尚未配置服务器时的整块空态", render: McpEmpty },
	],
	"plugin-list": [
		{ label: "真实服务", note: "启用 / 信任 / 删除三态", render: PluginListLive },
		{ label: "加载中", note: "读方法被挂住", render: PluginListLoading },
	],
	"plugin-settings": [
		{ label: "标准", note: "五种控件各一", render: PluginSettingsStandard },
		{ label: "多区块", note: "两个区块、长地址与令牌字段", render: PluginSettingsMulti },
	],
	"export-panel": [
		{ label: "桌面", note: "440px 浮层,挂在按钮下方", render: ExportDesktop },
		{ label: "手机整屏", note: ".m-sheet 形态(≤700px 生效)", render: ExportPhoneSheet },
	],
	"full-screen-editor": [
		{ label: "本章草稿", note: "draft/ch01.md", render: FsEditorChapter },
		{ label: "大纲文件", note: "outline.md", render: FsEditorOutline },
	],
	"creation-mode-cards": [
		{ label: "多 Agent 选中", note: "默认档:舞台共演 + 常驻编剧", render: CreationModeMulti },
		{ label: "单 Agent 选中", note: "经典模式:只有编辑页 + 全量工具", render: CreationModeSingle },
	],
	"conversation-scope-cards": [
		{ label: "绑定章节选中", note: "默认档:一节一段对话,切章节即切对话", render: ConversationScopeChapter },
		{ label: "分离选中", note: "对话与章节各聊各的,AI 可编辑任意章节", render: ConversationScopeBook },
	],
	"choice-cards": [
		{ label: "创作方式数据", note: "骨架 + 多/单 Agent 两组数据(选中单 Agent)", render: ChoiceCardsModes },
		{ label: "执行命令数据", note: "骨架 + 关闭/开启两组数据(选中关闭)", render: ChoiceCardsShell },
	],
	"shell-cards": [
		{ label: "保持关闭", note: "默认档:内置工具照常,没有本机命令", render: ShellOff },
		{ label: "已开启", note: "开启档:危险要点 + 与设置页共用的确认文案", render: ShellOn },
	],
	"setup-wizard": [
		{ label: "介绍", note: "默认(单 Agent):编辑 / 世界书 / 设置,无「舞台」卡", render: WizardIntro },
		{ label: "创作方式", note: "自动点到第 2 步:两张大卡,单 Agent 默认选中", render: WizardMode },
		{ label: "对话范围", note: "自动点到第 3 步:绑定章节默认选中", render: WizardScope },
		{ label: "执行命令", note: "自动点到第 4 步:保持关闭默认选中(点「开启」才弹确认条)", render: WizardShell },
	],
};
