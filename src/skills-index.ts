/**
 * 技能清单(给前端 `/` 菜单的「技能」命令用)——**与模型看到的那份同源**。
 *
 * 用 vendor 的 `loadSkills` 加载,目录清单来自 `session-factory` 的 `sessionSkillDirs()`
 * (自带 `skills/` + 全局 `~/.agents/skills` + agentDir 默认目录)。不自己扫目录:
 * 菜单列出的名字必须与 `/skill:<name>` 能展开的那份**完全一致** —— 对不上时 vendor
 * 会把整段原样透传(它只认自己加载到的名字),用户看到的是「我明明点了技能,AI 却没反应」。
 *
 * 与 agent 装配的两点差异,都是有意的:
 * - **清单里包含 `disable-model-invocation` 的技能**:这类技能被 vendor 从系统提示词的
 *   `<available_skills>` 里排除(模型不知道它存在),`/skill:<name>` 是它们**唯一**的入口,
 *   所以菜单必须列出来(返回 `explicitOnly: true` 供前端标注)。
 * - **不建会话、不写盘**:纯读,拿不到技能时返回空数组而不是抛错(菜单空着不影响输入)。
 */
import { getAgentDir } from "./config.ts";
import { sessionSkillDirs } from "./session-factory.ts";
import { loadSkills } from "./pi-adapter/index.ts";

/** 一条技能(前端 `/skill` 菜单的候选项;不含正文,正文由 vendor 在发送时展开)。 */
export interface SkillSummary {
	/** `/skill:<name>` 里的名字。 */
	name: string;
	/** frontmatter 的 description(菜单里当说明用)。 */
	description: string;
	/** true = 不在模型的 `<available_skills>` 里,只能靠用户显式 `/skill:<name>` 调用。 */
	explicitOnly: boolean;
}

/**
 * 列出当前装配会加载到的技能。
 *
 * @param opts.cwd 项目级技能(`<cwd>/.pi/skills`)的基准目录;书目录或进程 cwd 都行,
 *   给 null 时用进程 cwd(菜单是书无关的:自带技能与全局技能才是主体)。
 * @param opts.env 环境变量(测试注入 `PI_WRITER_DIR` 等;缺省 process.env)。
 */
export function listSkills(opts: { cwd?: string | null; env?: Record<string, string | undefined> } = {}): SkillSummary[] {
	const env = opts.env ?? process.env;
	const { skillPaths } = sessionSkillDirs({}, env);
	const { skills } = loadSkills({
		cwd: opts.cwd ?? process.cwd(),
		// agentDir 只认 process.env(PI_WRITER_AGENT_DIR / PI_WRITER_DIR),没有 env 参数
		agentDir: getAgentDir(),
		skillPaths,
		includeDefaults: true,
	});
	return skills
		.map((s) => ({ name: s.name, description: s.description, explicitOnly: s.disableModelInvocation }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
