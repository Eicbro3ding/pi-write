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

import type {
	CreateAgentSessionRuntimeFactory,
	ExtensionFactory,
	InlineExtension,
	ResolveCliModelResult,
	RuntimeFactoryHandle,
	ThinkingLevel,
	ToolDefinition,
} from "./pi-adapter/index.ts";
import {
	assembleSessionServices,
	createSessionFromServices,
	resolveModelSpec,
	toFactoryHandle,
} from "./pi-adapter/index.ts";
import { resolveExtraSkillsDirs, resolveSkillsDir } from "./config.ts";
import { dedupePaths, installToolPathGuard, skillDirsOf } from "./tool-guard.ts";
import { setWordCountCwd, setWorldUpdateBookDir } from "./tools.ts";
import { writeRailsExtension } from "./write-rails-extension.ts";

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
	/** 是否加载打包自带的 skills/(critique / outline / revise / stage-scripting)。
	 *  缺省 true —— 只要会话有 read 工具,vendor 就会把 `<available_skills>` 追加进
	 *  系统提示词(见 sessionSkillDirs)。stage 角色提示词自带技能绝对路径(见
	 *  stage-extension 的 {SKILLS_PATH}),显式传 false 保持 2026-08-11 的收窄。 */
	packagedSkills?: boolean;
	/** 额外的 skill 目录(自带 skills/ 与全局技能目录之外;缺省无需传)。 */
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
}

/**
 * 一次会话要加载的技能目录清单 —— **唯一真相源**。
 *
 * 组成(前者优先,同名冲突由 vendor loadSkills 记 collision 诊断):
 * 1. 打包自带 `skills/`(resolveSkillsDir;packagedSkills:false 时跳过)
 * 2. 调用方附加目录(additionalSkillPaths)
 * 3. 全局技能目录 `~/.agents/skills`(resolveExtraSkillsDirs)
 *
 * 为什么收在这里:自带 skills/ 原先由各调用方自己经 additionalSkillPaths 传入,
 * writer-host(web 主对话「AI 伙伴」背后的常驻编剧会话)漏传 → 模型能读到
 * skills/&lt;name&gt;/SKILL.md(工具守卫只读放行),系统提示词里却没有 `<available_skills>`,
 * 表现为「模型说它目录里有 skill,但没加载进提示词」(2026-10-01 根因)。
 *
 * readOnlyDirs 与 skillPaths 同源:技能文件必须可读而不可写,否则路径守卫会把
 * 技能目录挡在书目录之外(2026-08-09 曾有同款误拦)。
 */
export function sessionSkillDirs(
	opts: Pick<SessionFactoryOptions, "additionalSkillPaths" | "readOnlyDirs" | "packagedSkills"> = {},
	env: Record<string, string | undefined> = process.env,
): { skillPaths: string[]; readOnlyDirs: string[] } {
	const packaged = opts.packagedSkills === false ? [] : [resolveSkillsDir(env)];
	const extra = resolveExtraSkillsDirs(env);
	return {
		skillPaths: dedupePaths(packaged, opts.additionalSkillPaths, extra),
		readOnlyDirs: dedupePaths(packaged, opts.readOnlyDirs, extra),
	};
}

/**
 * 生成会话 runtime 工厂。
 *
 * **对外返回的是句柄**(`RuntimeFactoryHandle`)而不是 vendor 的
 * `CreateAgentSessionRuntimeFactory` —— 见 T7 批 2 的「消除 vendor 类型泄漏」。
 * 调用方只能把它原样交给 `SessionHost` / `assembleRuntime`,看不到内部签名。
 * 每次会话创建时调用(切书 cwd 变化,路径基准与工具路径守卫随工厂重建更新)。
 */
export function createSessionRuntimeFactory(opts: SessionFactoryOptions): RuntimeFactoryHandle {
	// 工厂体内部需要 vendor 的 `CreateAgentSessionRuntimeFactory` 形状(它就是
	// **被 vendor 调用**的那个函数)。这里是唯一的收窄点:紧贴实现,不外漏。
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		// word_count/world_update 以会话 cwd(书目录)为路径基准,切书时随工厂重建更新
		setWordCountCwd(cwd);
		setWorldUpdateBookDir(cwd);
		// 文件工具路径守卫:书目录内可读写;readOnlyDirs(skills 等)只读放行;
		// draftFile 启用正文目录白名单(write 只允许写当前章节文件)
		//
		// 技能目录统一在这里并入 **全部装配点**(cli / web / writer-host / stage),
		// 调用方不必各自记得传 additionalSkillPaths——漏传就是「技能不在提示词里」
		// 的静默故障(2026-10-01 writer-host 根因,见 sessionSkillDirs)。
		const { skillPaths, readOnlyDirs } = sessionSkillDirs(opts);
		installToolPathGuard(cwd, readOnlyDirs, opts.draftFile);
		const services = await assembleSessionServices({
			cwd,
			agentDir: opts.agentDir,
			resourceLoaderOptions: {
				systemPromptOverride: opts.systemPromptOverride,
				appendSystemPromptOverride: () => [],
				// skill 加载:noSkills:false 让 vendor 把 packageManager 解析到的技能一并
				// 装上(2026-08-11 曾为「独立身份」收窄为 true,2026-09-22 按需求放开);
				// additionalSkillPaths 给 sessionSkillDirs 算出的完整清单(自带 skills/ +
				// 调用方附加 + 全局技能目录),vendor 把它们追加进系统提示词的
				// <available_skills>(前提:会话活跃工具里有 read)。
				// noContextFiles 保持 true —— 那是祖先目录 AGENTS.md **项目上下文**,
				// 与技能无关,放开会把主目录的说明文件混进写作会话(2026-08-11 实测根因)。
				noSkills: false,
				noContextFiles: true,
				...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
				// 写作运行时护栏(write 拦空内容 / read 拦循环 / 写后字数对比)在这里
				// **统一并入**,而不是由各装配点自己传 —— 与上面 sessionSkillDirs 同款
				// 教训:需要每个调用方记得传的东西迟早会漏,而「漏了护栏」是静默的
				// (会话照跑,只是保护不在)。2026-10-05 的实证:该护栏原先只挂在
				// writerExtension 上,而 writerExtension 只装配 cli(TUI)与 web 主会话,
				// 真正写正文的 writer-host 编剧 agent 与 stage 角色全都没有 ——
				// 于是 writer-c-v05ij1 那次「空内容清空 2824 字」在护栏上线后依然可达。
				// 放在第一位:护栏是「保护性」的,应先于业务扩展生效(plugin 更靠后)。
				extensionFactories: [
					writeRailsExtension,
					...opts.extensionFactories,
					...(opts.pluginFactories ?? []),
				],
			},
		});
		// 技能放行的**权威来源是实际加载到的技能**:vendor 除 sessionSkillDirs 给的目录
		// 外,还会发现 agentDir/skills、<cwd>/.pi/skills、插件与 package 声明的技能,
		// 手工基线盖不全就会出现「技能列进了提示词、模型 read 却被判工具路径越界」
		// (2026-10-01 实测)。这里用加载结果重装守卫(TUI 无 ALS per-message 上下文,
		// 走的就是这份 fallback;web 由 SessionHost 每轮写入同源清单,见 session-host)。
		installToolPathGuard(
			cwd,
			dedupePaths(readOnlyDirs, skillDirsOf(services.resourceLoader.getSkills().skills)),
			opts.draftFile,
		);
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
			const resolved = resolveModelSpec({ cliModel: opts.model, modelRuntime: services.modelRuntime });
			if (resolved.error) throw new Error(resolved.error);
			if (resolved.warning) process.stderr.write(`${resolved.warning}\n`);
			model = resolved.model ?? undefined;
		}
		const result = await createSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			thinkingLevel: opts.thinkingLevel,
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
	// 出口处一次性造型成句柄:上游只有 `createAgentSessionRuntime` 会调用它,
	// 而那条路径已经由 `assembleRuntime` 在 adapter 内部还原成实体。
	return toFactoryHandle(factory);
}
