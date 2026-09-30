/**
 * 「UI 房」的展项契约(纯数据,不 import 任何组件/React 运行时)。
 *
 * 这个模块是 UI 房的**唯一真相源**:谁被陈列、陈列在哪个分组、渲染哪几个导出符号、
 * 有几个状态档。渲染实现在 `web/src/uiroom/<group>.tsx`(每个分组一个文件),
 * 页面壳在 `web/src/pages/UIRoom.tsx`。
 *
 * 为什么把契约抽出来:UI 房的意义是「所有 UI 组件都能一眼看到」,而**漏掉一个组件
 * 是静默的**——没人会发现少了一格。所以 `test/uiroom.test.ts` 会扫
 * `web/src/components/` 的真实文件列表,逐一对照本模块的展项表:没被任何展项覆盖、
 * 又不在 `UIROOM_NOT_EXHIBITED` 里给出理由的组件,测试直接红。
 *
 * 新增组件时的流程:在某个分组文件里加一个展项(ENTRIES 一条 + SECTION 一格),
 * 或者在这里的 `UIROOM_NOT_EXHIBITED` 里登记「为什么不需要视觉陈列」。
 * 两个都不做 → 契约测试红。
 */
import type { ComponentType } from "react";

/** 分组(页面上是筛选 chips;也是「这格归谁写」的边界)。 */
export type UIRoomGroupId = "atoms" | "chat" | "world" | "settings" | "stage" | "tokens";

export interface UIRoomGroup {
	id: UIRoomGroupId;
	label: string;
	/** 这个分组在讲什么(渲染在分组标题下的一行说明)。 */
	note: string;
}

/** 分组表(顺序即页面上的顺序)。 */
export const UIROOM_GROUPS: readonly UIRoomGroup[] = [
	{ id: "atoms", label: "原子控件", note: "按钮 / 开关 / 下拉 / 图标 / 小卡片——最小的可复用件。" },
	{ id: "chat", label: "消息流", note: "对话、思考、工具卡、预览卡、待确认卡、输入条。" },
	{ id: "world", label: "世界书", note: "世界树、条目卡 / 表单 / 详情、关系图、时间线。" },
	{ id: "settings", label: "设置与列表", note: "供应商 / 模型 / MCP / 插件 / 导出 / 全屏编辑器。" },
	{ id: "stage", label: "舞台与布局壳", note: "剧本、选角、节奏、侧栏、三栏壳。" },
	{ id: "tokens", label: "动效与主题 token", note: "时长/缓动档位、三主题色板、退场动画现场。" },
];

/**
 * 一个状态档。
 *
 * `render` 是**组件类型**(不是「返回 JSX 的函数」):页面与契约测试都用
 * `createElement(v.render)` 挂载它,所以里面可以正常调 hook(useState /
 * useUIRoomRuntime)。别把它当普通函数直接调用(`v.render()`),那样 hook 会挂到
 * 页面组件上、切档时 hook 顺序变化 → React 报错。
 */
export interface UIRoomVariant {
	/** 段控件上的标签(2-4 个字最好;多了格子会被撑宽)。 */
	label: string;
	/** 这一档在说什么(渲染在标签右边的小字)。 */
	note?: string;
	render: ComponentType;
}

/** 分组渲染表:展项 id → 状态档数组。键集必须与本分组 ENTRIES 的 id 集完全一致。 */
export type UIRoomSection = Record<string, readonly UIRoomVariant[]>;

/** 一个展项。 */
export interface UIRoomEntry {
	/** 唯一 id(kebab-case);也是页面上的锚点与搜索键。 */
	id: string;
	group: UIRoomGroupId;
	/** 格子标题(中文)。 */
	title: string;
	/** 承载体:相对 `web/src/` 的模块路径(如 `components/ToggleSwitch.tsx`)。 */
	module: string;
	/** 这个展项实际渲染的导出符号名(契约测试会在 module 源码里核对它们确实被导出)。 */
	symbols: readonly string[];
	/** 这个展项想让你看什么(一行)。 */
	note?: string;
	/**
	 * 状态档标签,顺序与 SECTION 里的数组一致。
	 * 契约测试会核对两边数量与文案完全相同 —— 只写不渲染、或渲染了没登记,都会红。
	 */
	variants: readonly string[];
	/**
	 * 需要「框」的展项:固定定位的弹层在普通格子(static)里会以视口为包含块,
	 * 一展开就盖住整页。给格子套一层 `transform` 容器即可把它关回格子里。
	 */
	frame?: "viewport" | "phone";
	/**
	 * SSR 冒烟跳过 + 原因。**只允许 DOM 独占依赖**(CodeMirror / cytoscape / EventSource 之类);
	 * 「我没让它在 node 下跑通」不是理由 —— 那样等于绕过契约测试。
	 *
	 * 注意:跳过只作用于「逐档 SSR」那条用例;`test/uiroom.test.ts` 还会渲染整个页面壳
	 * (壳每格只渲染**第一档**),所以**第一档必须能在没有 DOM 的 node 下渲染** ——
	 * 把真 DOM 独占的档放到后面(见 chat 的 `ask-user`:第一位是「已回答记录」)。
	 */
	ssrSkip?: string;
}

/**
 * 不需要视觉陈列的组件模块(不是 UI,或没有独立视觉)。
 *
 * 写法是「为什么不陈列」,不是「懒得陈列」:契约测试只认理由字符串非空,
 * 但下一个人读到这里要能判断能不能删。
 */
export const UIROOM_NOT_EXHIBITED: ReadonlyArray<{ module: string; why: string }> = [
	{ module: "components/id.ts", why: "纯函数 newId(生成稳定 id),没有视觉。" },
	{ module: "components/file-input.ts", why: "纯函数 snapshotFiles(FileList → File[]),没有视觉。" },
];

/** 分组文件(一个分组一个文件,导出 `<GROUP>_ENTRIES` 与 `<GROUP>_SECTION`)。 */
export const UIROOM_GROUP_FILES: ReadonlyArray<{ group: UIRoomGroupId; file: string; entries: string; section: string }> = [
	{ group: "atoms", file: "web/src/uiroom/atoms.tsx", entries: "ATOMS_ENTRIES", section: "ATOMS_SECTION" },
	{ group: "chat", file: "web/src/uiroom/chat.tsx", entries: "CHAT_ENTRIES", section: "CHAT_SECTION" },
	{ group: "world", file: "web/src/uiroom/world.tsx", entries: "WORLD_ENTRIES", section: "WORLD_SECTION" },
	{ group: "settings", file: "web/src/uiroom/settings.tsx", entries: "SETTINGS_ENTRIES", section: "SETTINGS_SECTION" },
	{ group: "stage", file: "web/src/uiroom/stage.tsx", entries: "STAGE_ENTRIES", section: "STAGE_SECTION" },
	{ group: "tokens", file: "web/src/uiroom/tokens.tsx", entries: "TOKENS_ENTRIES", section: "TOKENS_SECTION" },
];

/**
 * 会**直接拿真实 `client` 干活**的组件模块:它们的按钮不是回调 prop,点了就真的
 * 写服务端(删供应商凭据 / 改 MCP 配置 / 停用插件 / 导出整本书 / 覆盖文件 / 建书写设置)。
 *
 * UI 房对这批展项做两件事(见 pages/UIRoom.tsx):
 * 1. **默认用「隔离客户端」渲染**(uiroom-runtime.tsx 的 `stubClient`,所有请求 reject)——
 *    一次误点不该改掉真实数据;顺带把「请求失败」态也陈列了;
 * 2. 格子上打标:隔离态写「已隔离」,切到真实服务后写「⚠ 会真的生效」。
 *
 * 契约测试会核对:清单里每个模块都真实存在,且都被某个展项覆盖(否则这个标记没意义)。
 */
export const UIROOM_LIVE_MODULES: readonly string[] = [
	"components/ProviderList.tsx",
	"components/McpServerList.tsx",
	"components/PluginList.tsx",
	"components/PluginSettings.tsx",
	"components/NoticeBoard.tsx",
	"components/ExportPanel.tsx",
	"components/WorkspacePanel.tsx",
	"components/FullScreenEditor.tsx",
	"components/SetupWizard.tsx",
];

export function isLiveModule(module: string): boolean {
	return UIROOM_LIVE_MODULES.includes(module);
}

export interface UIRoomCoverage {
	/** 有组件文件但没有任何展项、也没有登记理由 —— 必须修。 */
	missing: string[];
	/**
	 * 展项指向了不存在的组件模块 —— 路径写错或组件被删。
	 * 只查 `components/` 下的路径:token / hook / 样式这类承载体(如 `motion.ts`、
	 * `use-exit-presence.ts`)不参与「组件覆盖」,它们的存在性由测试的 existsSync 与符号检查守。
	 */
	unknownModules: string[];
	/** 同一个 id 出现在两个展项里 —— 页面会渲染两次、锚点冲突。 */
	duplicatedIds: string[];
}

/**
 * 对照「磁盘上真实的组件文件列表」与「展项表」,算出缺口。
 *
 * `modules` 传相对 `web/src/` 的路径(如 `components/ToggleSwitch.tsx`)。
 */
export function uiroomCoverage(
	modules: readonly string[],
	entries: readonly UIRoomEntry[],
	notExhibited: ReadonlyArray<{ module: string; why: string }> = UIROOM_NOT_EXHIBITED,
): UIRoomCoverage {
	const covered = new Set(entries.map((e) => e.module));
	const excused = new Set(notExhibited.filter((n) => n.why.trim().length > 0).map((n) => n.module));
	const missing = modules.filter((m) => !covered.has(m) && !excused.has(m));
	const known = new Set(modules);
	const unknownModules = [...covered].filter((m) => m.startsWith("components/") && !known.has(m));
	const seen = new Set<string>();
	const duplicatedIds: string[] = [];
	for (const e of entries) {
		if (seen.has(e.id)) duplicatedIds.push(e.id);
		seen.add(e.id);
	}
	return { missing, unknownModules, duplicatedIds };
}

/** 展项总数 / 分组数之类的页头计数(页面与测试共用口径)。 */
export function uiroomStats(entries: readonly UIRoomEntry[]): { exhibits: number; variants: number; groups: number; modules: number } {
	return {
		exhibits: entries.length,
		variants: entries.reduce((n, e) => n + e.variants.length, 0),
		groups: new Set(entries.map((e) => e.group)).size,
		modules: new Set(entries.map((e) => e.module)).size,
	};
}
