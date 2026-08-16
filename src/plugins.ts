/**
 * 插件系统预留类型(2026-08,P0 只留缝,不写加载器)。
 *
 * 分层策略:
 *  - 后端代码插件:vendor ExtensionAPI 已是完整接口(tool/event/provider/command),
 *    pi-writer 的 createSessionRuntimeFactory.extensionFactories 是注入点;
 *    未来外部插件 = 加载 `~/.pi/writer/plugins/*.mjs` 后把工厂塞进该数组。
 *  - 后端 HTTP 插件:WriterServerOptions.extraRoutes(Route[]) + broadcastEvent()。
 *  - 前端插件:只接受声明式清单(斜杠命令),绝不在 renderer 执行用户 JS;
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

/** 插件清单(未来 `~/.pi/writer/plugins/<id>/plugin.json`)。 */
export interface PluginManifest {
	id: string;
	version: string;
	name?: string;
	description?: string;
	/** 后端扩展入口(相对插件目录的 .mjs 模块,default export = ExtensionFactory)。 */
	backend?: string;
	/** 声明式前端贡献(斜杠命令等)。 */
	frontend?: {
		slashCommands?: PluginSlashCommandSpec[];
	};
}
