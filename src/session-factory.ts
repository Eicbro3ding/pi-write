/**
 * 会话装配工厂 —— cli.ts / web.ts / stage 编排器三处共用的
 * CreateAgentSessionRuntimeFactory 生成器。
 *
 * 三处装配的历史样板(路径基准注入、工具路径守卫、技能目录、
 * 模型解析、createAgentSessionFromServices)完全一致,只差系统提示生成
 * 与工具集形态;本模块把它们收敛为一处,新增装配点不再复制样板。
 *
 * 注意:systemPromptOverride 必须是动态函数(静态字符串会整个替换 pi 的
 * 动态工具段,MCP 外部工具对 agent 不可见——2026-08-08 根因,见 prompt.ts)。
 */

import type { InlineExtension, ExtensionFactory, ToolDefinition } from "../vendor/pi-coding-agent/src/index.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
	resolveCliModel,
	type ResolveCliModelResult,
} from "../vendor/pi-coding-agent/src/index.ts";
import type { ThinkingLevel } from "../vendor/pi-agent-core/src/index.ts";
import { resolveExtraSkillsDirs } from "./config.ts";
import { installToolPathGuard } from "./tool-guard.ts";
import { setWordCountCwd, setWorldUpdateBookDir } from "./tools.ts";

type CliModel = ResolveCliModelResult["model"];

/** 会话装配参数;三处装配点只声明差异项,共同样板在本模块。 */
export interface SessionFactoryOptions {
	/** agent 配置目录(auth/models/settings),传给 createAgentSessionServices。 */
	agentDir: string;
	/** 路径守卫只读放行目录(skills 目录等;书目录本身读写均放行)。 */
	readOnlyDirs?: string[];
	/** 系统提示动态生成(cli/web 经 buildWriterSystemPrompt,stage 用角色固定提示)。 */
	systemPromptOverride: () => string;
	/** 扩展工厂(writerExtension 等;vendor InlineExtension,含裸函数形式)。 */
	extensionFactories: InlineExtension[];
	/** 外部插件工厂(plugin-loader 加载的 ExtensionFactory;追加到 extensionFactories 之后)。 */
	pluginFactories?: ExtensionFactory[];
	/** 附加 skill 路径(TUI/web 加载打包 skills;stage 不加载)。 */
	additionalSkillPaths?: string[];
	/** 正文文件白名单(如 "ch01.md"):启用 draft/ 目录 write 强制,只允许写当前章节文件。
	 *  防 agent 自由发挥文件名(正文写到 draft/第一章.md,前端按约定路径读到空)。 */
	draftFile?: string;
	/** 内置工具黑名单(web 禁 bash)。 */
	excludeTools?: string[];
	/**
	 * shell 可执行文件路径(shell 方言解析结果,见 shell-kind.ts):
	 * - `string`:写入 vendor settingsManager.shellPath,由它 spawn 该可执行文件;
	 * - `null`:清空该设置,让 vendor 走自己的探测链(Git Bash → PATH bash → /bin/bash);
	 * - `undefined`:不动(舞台/编剧等不关心 shell 的装配点)。
	 * 仅在值确实变化时写盘(settingsManager.setShellPath 会落盘 agent/settings.json)。
	 */
	shellPath?: string | null;
	/** 初始激活的内置工具(不设白名单——白名单会把 MCP customTools 滤掉)。 */
	initialActiveToolNames?: string[];
	/** 禁用全部/内置工具(舞台演员等)。 */
	noTools?: "all" | "builtin";
	/** 自定义工具(MCP 工具、world_update 等)。 */
	customTools?: ToolDefinition[];
	/** --model 模式串;缺省用服务默认模型。 */
	model?: string;
	/** 思考等级。 */
	thinkingLevel?: ThinkingLevel;
	/** 采样温度(0..2);缺省用服务默认。 */
	temperature?: number;
	/** 核采样概率质量(0..1);缺省用服务默认。 */
	topP?: number;
}

/**
 * 生成会话 runtime 工厂;每次会话创建时调用(切书 cwd 变化,路径基准与
 * 工具路径守卫随工厂重建更新)。
 */
export function createSessionRuntimeFactory(opts: SessionFactoryOptions): CreateAgentSessionRuntimeFactory {
	return async ({ cwd, sessionManager, sessionStartEvent }) => {
		// word_count/world_update 以会话 cwd(书目录)为路径基准,切书时随工厂重建更新
		setWordCountCwd(cwd);
		setWorldUpdateBookDir(cwd);
		// 文件工具路径守卫:书目录内可读写;readOnlyDirs(skills 等)只读放行;
		// draftFile 启用正文目录白名单(write 只允许写当前章节文件)
		//
		// 额外技能目录(2026-09-22「完全放开 skill」):全局技能目录在这里统一并入
		// **三处装配点**(cli / web / stage),调用方不必各自记得——否则舞台演员读不到
		// 全局技能文件。只读放行也要给,不然路径守卫会把技能目录挡在书目录之外。
		const extraSkillDirs = resolveExtraSkillsDirs();
		const skillPaths = [...(opts.additionalSkillPaths ?? []), ...extraSkillDirs];
		const readOnlyDirs = [...(opts.readOnlyDirs ?? []), ...extraSkillDirs];
		installToolPathGuard(cwd, readOnlyDirs, opts.draftFile);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: opts.agentDir,
			resourceLoaderOptions: {
				systemPromptOverride: opts.systemPromptOverride,
				appendSystemPromptOverride: () => [],
				// skill 加载:noSkills:false 让 vendor 把 packageManager 解析到的技能一并
				// 装上(2026-08-11 曾为「独立身份」收窄为 true,2026-09-22 按需求放开);
				// additionalSkillPaths 再显式挂上自带 skills/ 与全局技能目录。
				// noContextFiles 保持 true —— 那是祖先目录 AGENTS.md **项目上下文**,
				// 与技能无关,放开会把主目录的说明文件混进写作会话(2026-08-11 实测根因)。
				noSkills: false,
				noContextFiles: true,
				...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
				extensionFactories: opts.pluginFactories?.length
					? [...opts.extensionFactories, ...opts.pluginFactories]
					: opts.extensionFactories,
			},
		});
		// skill 命令(2026-09-22):恢复注册,会话的 / 菜单重新列出 /skill:xxx。
		// 此前被隐性关闭——技能只能靠模型自己 read 文件,用户无从主动调用。
		// 只在值不对时写:该 setter 会落盘 agent/settings.json,每次会话都写是噪音。
		if (!services.settingsManager.getEnableSkillCommands()) {
			services.settingsManager.setEnableSkillCommands(true);
		}
		// shell 方言:vendor 的 getShellConfig() 只会 spawn bash(除非 settings.shellPath
		// 指向别的可执行文件——PowerShell 的 -Command 可缩写为 -c,所以 pwsh 能借此跑起来)。
		// 只在值变化时写:setShellPath 会落盘 agent/settings.json,每次会话都写是噪音。
		if (opts.shellPath !== undefined) {
			const desired = opts.shellPath ?? undefined;
			if (services.settingsManager.getShellPath() !== desired) {
				services.settingsManager.setShellPath(desired);
			}
		}
		let model: CliModel;
		if (opts.model) {
			const resolved = resolveCliModel({ cliModel: opts.model, modelRuntime: services.modelRuntime });
			if (resolved.error) throw new Error(resolved.error);
			if (resolved.warning) process.stderr.write(`${resolved.warning}\n`);
			model = resolved.model ?? undefined;
		}
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			thinkingLevel: opts.thinkingLevel,
			temperature: opts.temperature,
			topP: opts.topP,
			...(opts.excludeTools ? { excludeTools: opts.excludeTools } : {}),
			...(opts.initialActiveToolNames ? { initialActiveToolNames: opts.initialActiveToolNames } : {}),
			...(opts.noTools ? { noTools: opts.noTools } : {}),
			...(opts.customTools ? { customTools: opts.customTools } : {}),
		});
		return {
			...result,
			services,
			diagnostics: services.diagnostics,
		};
	};
}
