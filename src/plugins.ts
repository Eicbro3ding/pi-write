/**
 * 插件系统预留类型(2026-08,P0 只留缝,不写加载器)。
 *
 * 分层策略:
 *  - 后端代码插件:vendor ExtensionAPI 已是完整接口(tool/event/provider/command),
 *    pi-writer 的 createSessionRuntimeFactory.extensionFactories 是注入点;
 *    未来外部插件 = 加载 `~/.pi/writer/plugins/*.mjs` 后把工厂塞进该数组。
 *  - 后端 HTTP 插件:WriterServerOptions.extraRoutes(Route[]) + broadcastEvent()。
 *  - 前端插件:只接受声明式清单(斜杠命令 + UI/菜单声明),绝不在 renderer 执行用户 JS;
 *    `/node`、`/chapter`、`/compact` 已是同一条 SlashCommand 注册缝。
 *
 * 安全边界:插件与主进程同权,视为受信任本地代码;不做沙箱承诺,
 * 不自动安装/不自动更新(用户显式启用,与 Obsidian / SillyTavern 社区插件同级)。
 */

/** 前端斜杠命令的声明式描述(执行逻辑必须是内置/服务端受信任实现)。 */
export interface PluginSlashCommandSpec {
	/** 不带斜杠的触发名,如 "roll"。 */
	trigger: string;
	hint: string;
	/** 内置执行器 id(未来接入的受信任动作);不允许插件自带 JS。 */
	executor?: string;
}

/**
 * 插件 UI/菜单声明(2026-09 预留,只定形状,不做实现——见插件开发计划)。
 *
 * 原则:renderer 不执行用户 JS,插件 UI 只能「声明数据」,由 pi-writer
 * 服务端/前端用受信任的协议渲染;具体渲染协议(定义 → 注册 → 渲染)与
 * 数据处理流程在实现插件系统时一并设计,此处仅预留清单字段。
 */
export interface PluginUiSpec {
	/**
	 * 设置页「集成」分类下的菜单项注册:声明一个入口(标题 + 描述),
	 * 点开后由 serviceUrl 提供的受信任 executor 渲染内容。
	 * 字段结构为占位,实现时按渲染协议再定稿。
	 */
	settingsItems?: Array<{
		/** 菜单项标题(如「素材库设置」)。 */
		title: string;
		/** 菜单项说明(标题下弱化展示)。 */
		description?: string;
		/**
		 * 内容加载地址(相对插件目录的受信任模块/端点)。
		 * 占位:实现时校验白名单,禁止指向插件目录外。
		 */
		serviceUrl?: string;
		/** 需要打上「实验/未完成」标记时由实现方过滤,此处不建模。 */
	}>;
}

/** 插件清单(未来 `~/.pi/writer/plugins/<id>/plugin.json`)。 */
export interface PluginManifest {
	id: string;
	version: string;
	name?: string;
	description?: string;
	/** 作者声明禁用(用户层无法覆盖;缺省 true)。 */
	enabled?: boolean;
	/** 后端扩展入口(相对插件目录的 .mjs 模块,default export = ExtensionFactory)。 */
	backend?: string;
	/** 声明式前端贡献(斜杠命令 / UI 菜单)。 */
	frontend?: {
		slashCommands?: PluginSlashCommandSpec[];
		/** 插件 UI/菜单声明(预留,本期不实现)。 */
		ui?: PluginUiSpec;
	};
}
