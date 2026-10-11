/**
 * 插件系统类型(2026-08 起预留缝,2026-09 定稿声明式 UI 协议)。
 *
 * 分层策略:
 *  - 后端代码插件:vendor ExtensionAPI 已是完整接口(tool/event/provider/command),
 *    pi-writer 的 createSessionRuntimeFactory.extensionFactories 是注入点;
 *    未来外部插件 = 加载 `~/.pi/writer/plugins/*.mjs` 后把工厂塞进该数组。
 *  - 后端 HTTP 插件:WriterServerOptions.extraRoutes(Route[]) + broadcastEvent()。
 *  - 前端插件:只接受声明式清单(斜杠命令 + 设置菜单 schema),绝不在 renderer 执行用户 JS;
 *    `/node`、`/chapter`、`/compact` 已是同一条 SlashCommand 注册缝。
 *
 * 安全边界:插件与主进程同权,视为受信任本地代码;不做沙箱承诺,
 * 不自动安装/不自动更新(用户显式启用,与 Obsidian / SillyTavern 社区插件同级)。
 */

/** 前端斜杠命令的声明式描述(执行逻辑由入口模块具名导出 webCommands 提供,主进程执行)。 */
export interface PluginSlashCommandSpec {
	/** 不带斜杠的触发名,如 "roll"。 */
	trigger: string;
	hint: string;
}

/** 设置字段类型白名单(通用 FieldRenderer 只渲染这几种;不支持任意组件)。 */
export type PluginSettingsFieldType = "string" | "number" | "boolean" | "select" | "textarea";

/** 设置项单个字段(静态声明;default 为保存建议值,前端初始回填)。 */
export interface PluginSettingsFieldSpec {
	/** 字段键(小写字母/数字/连字符;settings.json 的键)。 */
	key: string;
	/** 标签(如「默认骰面」)。 */
	label: string;
	/** 字段类型。 */
	type: PluginSettingsFieldType;
	/** 字段说明(标签下弱化展示)。 */
	desc?: string;
	/** 缺省值(未保存时前端初始值;类型与 type 对应)。 */
	default?: string | number | boolean;
	/** select 类型的候选[{value,label}](其他类型忽略)。 */
	options?: Array<{ value: string; label: string }>;
}

/** 设置页菜单项:一个区块(标题 + 描述 + 字段组)。 */
export interface PluginSettingsItemSpec {
	/** 区块标题(如「掷骰子」)。 */
	title: string;
	/** 区块说明(标题下弱化展示)。 */
	description?: string;
	/** 字段组;字段键在整插件内唯一。 */
	fields: PluginSettingsFieldSpec[];
}

/**
 * 浮窗声明(2026-10-11 起:插件的第一个「非设置页」UI 类型)。
 *
 * 与 settingsItems 同一条哲学:插件只声明数据(标题/位置/尺寸/字段),由 pi-writer
 * 的受信任渲染器画成浮窗;renderer 不执行任何用户 JS,所以非 trusted 插件也能开浮窗。
 *
 * 定位:浮窗一律挂在全局层(web 端 `.plugin-layer`),不挑当前在哪一页 ——
 * 编辑页/舞台/世界书都能看到,这是它跟设置页卡片的根本区别。
 */
export interface PluginWindowSpec {
	/** 窗口键(小写字母/数字/连字符;同插件内唯一,用于记住关闭/位置状态)。 */
	id: string;
	/** 标题栏文案。 */
	title: string;
	/** 初始位置百分比(0-100,相对视口左上;缺省右下角 82/78)。拖动后由前端本地记住。 */
	position?: { x: number; y: number };
	/** 初始尺寸(px;缺省 280×自动)。宽高各自可选,超视口由前端钳制。 */
	size?: { width?: number; height?: number };
	/** 窗口内展示的字段组(复用设置字段白名单 renderer)。 */
	fields: PluginSettingsFieldSpec[];
	/** 内容来源:声明式字段(缺省)/ 由插件路由取数渲染(见 windowData)。 */
	contentKind?: "fields" | "data";
	/**
	 * contentKind=data 时的取数路径(相对 /api/plugins/<id>/);
	 * 返回 { rows: [{label,value}] } 或纯对象 → 渲染成键值表。仅 trusted 插件的路由可达。
	 */
	dataSource?: string;
	/** 是否可关闭(缺省 true);false = 常驻浮窗(仍有最小化入口)。 */
	closable?: boolean;
}

/**
 * 声明式槽位条目(2026-10-11 槽位树):插件把「往哪个槽位放什么」写成数据。
 *
 * 这是**非 trusted 插件**的 UI 出口 —— 它不写 JS,只是声明「我有一个浮窗,
 * 想放进 app.chrome.overlay 这个槽位」。宿主据此把它编译成槽位条目。
 *
 * 当前只开放一种形态:`window`(复用 PluginWindowSpec)。其他槽位形态
 * (往导航塞按钮、往页面塞面板)需要各自的受信任渲染器,后续按需开。
 *
 * 为什么是「声明槽位名」而不是「声明浮窗 + 前端猜默认放哪儿」:槽位名是宿主公开的
 * 契约(见 web/src/shell-slots.ts 的常量与 UI 房的槽位目录),插件显式写出来,
 * 宿主就能在装载期校验「这个名字存在吗」—— **声明 = 授权**这条铁律延伸到插件侧。
 */
export interface PluginSlotContributionSpec {
	/** 目标槽位名(点分命名,须是宿主已声明的槽位;装载期校验)。 */
	slot: string;
	/**
	 * 目标槽位是 keyed 形态时的分派键。
	 * 例如设置页插件卡扩展位 `app.view.settings.plugin` 以 key=插件 id 分派,
	 * 插件要往那里放东西就必须给出这个 key(通常就是自己的 id)。
	 * 非 keyed 槽位给了 key 会被忽略。
	 */
	key?: string;
	/** 条目在该槽位内的排序权重(list 升序 / chain 降序)。 */
	order?: number;
	/** 贡献形态。当前仅 `window`。 */
	kind: "window";
	/** kind=window 时的浮窗声明。 */
	window: PluginWindowSpec;
}

/**
 * 插件 UI/菜单声明(2026-09 定稿声明式协议;2026-10 增 windows 浮窗与 slots 槽位条目)。
 *
 * 原则:插件 UI 只能「声明数据」,由 pi-writer 服务端/前端用受信任的
 * 通用渲染器渲染(FieldRenderer + 现有 s-* 组件族);设置值存
 * plugins/<id>/settings.json(atomicWriteFile),未知键丢弃。
 * 插件自定义组件/任意 JS 注入仍不在开放面(那要 trusted,走 window.piWriter.slots)。
 */
export interface PluginUiSpec {
	/** 设置页「集成」分类下的设置菜单项声明。 */
	settingsItems?: PluginSettingsItemSpec[];
	/** 全局浮窗声明(挂 `.plugin-layer`,非 trusted 插件亦可用)。 */
	windows?: PluginWindowSpec[];
	/** 槽位条目声明(比 windows 更一般:可指定目标槽位)。 */
	slots?: PluginSlotContributionSpec[];
}

/** 插件清单(`~/.pi/writer/plugins/<id>/plugin.json`)。 */
export interface PluginManifest {
	id: string;
	version: string;
	name?: string;
	description?: string;
	/** 作者声明禁用(用户层无法覆盖;缺省 true)。 */
	enabled?: boolean;
	/** 后端扩展入口(相对插件目录的 .mjs 模块,default export = ExtensionFactory)。 */
	backend?: string;
	/** 声明式前端贡献(斜杠命令 + 设置菜单 + 前端 JS 入口)。 */
	frontend?: {
		slashCommands?: PluginSlashCommandSpec[];
		/** 插件 UI/菜单声明(设置页菜单项 + 字段 schema)。 */
		ui?: PluginUiSpec;
		/**
		 * 前端 JS 入口(相对插件目录的 .mjs;**仅 trusted 插件加载**,
		 * 经 GET /api/plugins/:id/frontend.mjs 返回 text/javascript)。缺省 "frontend.mjs"。
		 */
		frontend?: string;
	};
}
