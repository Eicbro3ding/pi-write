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
 * 插件 UI/菜单声明(2026-09 定稿:声明式渲染协议,renderer 零用户 JS)。
 *
 * 原则:插件 UI 只能「声明数据」,由 pi-writer 服务端/前端用受信任的
 * 通用渲染器渲染(FieldRenderer + 现有 s-* 组件族);设置值存
 * plugins/<id>/settings.json(atomicWriteFile),未知键丢弃。
 * 插件自定义组件/任意 JS 注入仍不在开放面。
 */
export interface PluginUiSpec {
	/** 设置页「集成」分类下的设置菜单项声明。 */
	settingsItems?: PluginSettingsItemSpec[];
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
