/**
 * 技能调用(`/skill:<name>`)的**展示形态**。
 *
 * 为什么需要:`/skill:critique 帮我看看` 这条消息在**进会话之前**就被 vendor 展开成
 * 整份 SKILL.md(`vendor` 的 `agent-session.ts` → `_expandSkillCommand`),落盘的、
 * 模型看到的都是
 * `<skill name="…" location="…">\n…正文…\n</skill>\n\n帮我看看`。
 * 聊天区此前把这条用户消息**原样**渲染,于是一整份方法论灌进气泡(critique 约 3.5KB、
 * craft 约 8.6KB),连带「复制」拷全文、「编辑」把全文预填进输入框。
 *
 * 这里把它解析回「技能名 + 技能正文 + 你自己说的话」,由 MessageList 渲染成一枚芯片
 * (与 TUI 的 `[skill] name`、HTML 导出的 `[skill] name` 同一套语言,正文折在展开里)。
 * **纯展示**:会话里存的、模型收到的仍是展开后的全文,撤回/分支/重放都不受影响。
 *
 * 两种形态都要认:
 * - **展开态**(vendor 写的:历史水合与 SSE 回显)——带正文;
 * - **字面态**(输入框里选中技能后那一下:`/skill:<name> 话`)——没有正文,回显到达后
 *   同一条消息会带着正文再来一次,那时箭头才出现。
 *
 * 展开态的正则与 vendor 的 `parseSkillBlock` **逐字同形**(同一份格式,两边各一份
 * 拷贝):web 包不能 import vendor(那边拖着 node 依赖),所以照 motion/themes 的镜像
 * 测试做法,用 `test/skill-invocation.test.ts` 读两边源码比对,漂移即红。
 */

/** 展开态(与 vendor `agent-session.ts` 的 parseSkillBlock 同一正则)。 */
const EXPANDED_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** 字面态:`/skill:<name>` 后面可跟一句自己的话。 */
const LITERAL_RE = /^\/skill:([^\s]+)(?:[ \t]+([\s\S]*))?$/;

/** 一条用户消息里的技能调用。 */
export interface SkillInvocation {
	name: string;
	/** 技能正文(SKILL.md 去 frontmatter);只有展开态拿得到,字面态为 null。 */
	body: string | null;
	/** 用户自己说的话;只说技能不带话时为空串。 */
	words: string;
}

/**
 * 解析一条用户消息里的技能调用;不是技能消息返回 null。
 *
 * 顺序要紧:先认展开态 —— 它一定以 `<skill ` 开头,`/skill:` 只可能来自字面态。
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
	const expanded = text.match(EXPANDED_RE);
	if (expanded) {
		return { name: expanded[1]!, body: expanded[3]!, words: expanded[4]?.trim() ?? "" };
	}
	const literal = text.match(LITERAL_RE);
	if (literal) {
		return { name: literal[1]!, body: null, words: (literal[2] ?? "").trim() };
	}
	return null;
}

/**
 * 折叠形态:`/skill:<name> <话>`。
 *
 * 复制与「编辑(撤回并重发)」都用它 —— 它既是用户在输入框里实际打出的形态,
 * 也是唯一能**原样重发**的形态(直接发全文只是碰巧等效,还丢掉了技能身份:
 * 那条消息不再走 vendor 的展开路径)。
 */
export function skillCommandText(skill: SkillInvocation): string {
	return skill.words.length > 0 ? `/skill:${skill.name} ${skill.words}` : `/skill:${skill.name}`;
}
