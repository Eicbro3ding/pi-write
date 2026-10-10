import { describe, expect, it } from "vitest";
import { buildBuiltinPromptText, buildEditorSystemPrompt, buildWriterSystemPrompt } from "../src/prompt.ts";

describe("buildWriterSystemPrompt", () => {
	it("无外部工具时只含基础提示,shell 行按方言注入", () => {
		const web = buildWriterSystemPrompt([], "none");
		expect(web).toContain("你**没有** `bash`");
		expect(web).not.toContain("外部工具(MCP)");
		const tui = buildWriterSystemPrompt([], "bash");
		expect(tui).toContain("你可以使用 `bash`");
		expect(tui).not.toContain("你**没有** `bash`");
	});

	it("pwsh 方言:点明实际是 PowerShell、工具名仍叫 bash,并说明退出码折算", () => {
		const prompt = buildWriterSystemPrompt([], "pwsh");
		expect(prompt).toContain("PowerShell 7(pwsh)");
		// 工具名仍是 bash(schema 由 vendor 固定),必须让模型知道别写 bash 语法
		expect(prompt).toContain("`bash` 工具");
		expect(prompt).toContain("exit $LASTEXITCODE");
		expect(prompt).not.toContain("你**没有** `bash`");
	});

	it("Windows PowerShell 5.1:额外说明不支持 && / ||", () => {
		const prompt = buildWriterSystemPrompt([], "powershell");
		expect(prompt).toContain("Windows PowerShell 5.1");
		expect(prompt).toContain("`&&`/`||`");
	});

	it("拿到 shell 要**如实说清能力范围**:整台机器,包括联网与执行代码(2026-09-20)", () => {
		// 此前这里只写「工作目录为书目录」并把联网说成「仍需经外部工具挂载」——与事实
		// 相反(shell 以服务进程身份运行,路径守卫管不到它)。模型不知道自己的能力范围
		// 就会绕远路:该联网查证时说自己没这能力、该跑脚本时纯手算。
		for (const dialect of ["bash", "pwsh", "powershell"] as const) {
			const p = buildWriterSystemPrompt([], dialect);
			expect(p).toContain("整台机器");
			expect(p).toContain("访问网络");
			expect(p).toContain("执行任意代码与程序");
		}
		// 没有 shell 时不能吹有联网能力
		expect(buildWriterSystemPrompt([], "none")).not.toContain("访问网络");
	});

	it("额外工具清单追加在文末,名称+单行描述", () => {
		const prompt = buildWriterSystemPrompt(
			[
				{ name: "tavily_search", description: "网络搜索,查资料用" },
				{ name: "fetch_url", description: "抓取网页\n支持多行描述" },
			],
			"none",
		);
		// T9-A:标题去掉了「(MCP)」—— MCP 工具改由上游扩展注册进工具声明,
		// 本段现在只服务「非 MCP 的额外工具说明」这一潜在场景(见 prompt.ts 注释)
		expect(prompt).toContain("# 外部工具");
		expect(prompt).toContain("`tavily_search` — 网络搜索,查资料用");
		expect(prompt).toContain("`fetch_url` — 抓取网页 支持多行描述");
		// 追加在提示词末尾(基础提示之后)
		expect(prompt.indexOf("# 外部工具")).toBeGreaterThan(prompt.indexOf("你绝不做的事"));
	});

	it("占位符被替换,不残留 {SHELL_LINE}", () => {
		const prompt = buildWriterSystemPrompt([], "none");
		expect(prompt).not.toContain("{SHELL_LINE}");
	});
});

/**
 * 自定义系统提示词(2026-10-10):非空**整段替换**内置提示词。
 *
 * 为什么钉这一组:覆盖必须是"整段接管"而不是"拼接"—— 内置的「你绝不做的事」
 * 「散文只有一个落点」是防止 AI 越权的底线,拼接型覆盖会让用户以为改掉了而
 * 实际还在。同时,空串必须走内置路径,否则未动过设置的安装行为会被悄悄改掉。
 */
describe("自定义系统提示词(整段替换)", () => {
	it("空串/undefined/纯空白 → 走内置(默认行为逐字不变)", () => {
		const builtin = buildWriterSystemPrompt([], "none");
		expect(buildWriterSystemPrompt([], "none", "chapter", "")).toBe(builtin);
		expect(buildWriterSystemPrompt([], "none", "chapter", undefined)).toBe(builtin);
		// 纯空白也是「没写」,不能给模型一段空白提示词
		expect(buildWriterSystemPrompt([], "none", "chapter", "   \n  ")).toBe(builtin);
	});

	it("非空 → 整段替换:内置文本、shell 行、外部工具段一概不再出现", () => {
		const custom = "你是我的私人写手。只写正文,不改别的东西。";
		const p = buildWriterSystemPrompt([{ name: "fetch_url", description: "抓网页" }], "bash", "chapter", custom);
		expect(p).toBe(custom);
		// 内置的硬约束与落点纪律不在了(这是整段替换的既定代价,故此处正向断言)
		expect(p).not.toContain("你绝不做的事");
		expect(p).not.toContain("散文只有一个落点");
		// shell 行与外部工具段也不追加 —— 那是用户逐字写的稿,不往里插字
		expect(p).not.toContain("整台机器");
		expect(p).not.toContain("# 外部工具");
		expect(p).not.toContain("{SHELL_LINE}");
	});

	it("对话范围不影响自定义文本(用户自己写口径)", () => {
		const custom = "自定义提示词";
		expect(buildWriterSystemPrompt([], "bash", "book", custom)).toBe(custom);
		expect(buildWriterSystemPrompt([], "bash", "chapter", custom)).toBe(custom);
	});

	it("编剧提示词同款:空串走内置,非空整段替换", () => {
		const builtin = buildEditorSystemPrompt();
		expect(buildEditorSystemPrompt("chapter", "")).toBe(builtin);
		expect(buildEditorSystemPrompt("chapter", undefined)).toBe(builtin);
		const custom = "你是编剧,只按用户指令改正文。";
		expect(buildEditorSystemPrompt("chapter", custom)).toBe(custom);
		expect(buildEditorSystemPrompt("book", custom)).toBe(custom);
	});
});

/**
 * 内置原文导出(2026-10-10):设置页「查看内置」弹层的数据来源。
 *
 * 要求:① 与真实装配同口径渲染(占位符不许漏给用户看 —— 用户会照着抄);
 * ② 给的是**基础提示**(不含 # 外部工具 段,那由 MCP 决定),且不受自定义覆盖影响
 *   (本函数的语义就是「内置长什么样」)。
 */
describe("buildBuiltinPromptText(内置原文导出)", () => {
	const PLACEHOLDER = /\{[A-Za-z_]+\}/;

	it("writer:基础提示与装配一致,但 shell 占位已按方言渲染", () => {
		const none = buildBuiltinPromptText("writer", "chapter", "none");
		const bash = buildBuiltinPromptText("writer", "chapter", "bash");
		// 缺省 chapter 下,装配出来的 base(无外部工具段)应当与之一致
		expect(bash).toBe(buildWriterSystemPrompt([], "bash", "chapter"));
		// 方言不同 → shell 行不同
		expect(bash).not.toBe(none);
		expect(bash).toContain("整台机器");
		expect(none).toContain("没有");
	});

	it("writer:对话范围占位按 scope 渲染(book 下的整节说明出现)", () => {
		const chapter = buildBuiltinPromptText("writer", "chapter", "bash");
		const book = buildBuiltinPromptText("writer", "book", "bash");
		expect(book).not.toBe(chapter);
		expect(book).toContain("对话与章节分离");
		// 两种范围都不许把占位符漏出来
		expect(chapter).not.toMatch(PLACEHOLDER);
		expect(book).not.toMatch(PLACEHOLDER);
	});

	it("editor:按 scope 渲染,且不带 shell 占位(编剧提示词本就没有)", () => {
		const chapter = buildBuiltinPromptText("editor", "chapter", "bash");
		const book = buildBuiltinPromptText("editor", "book", "bash");
		expect(chapter).toBe(buildEditorSystemPrompt("chapter"));
		expect(book).toBe(buildEditorSystemPrompt("book"));
		expect(chapter).not.toMatch(PLACEHOLDER);
		expect(book).not.toMatch(PLACEHOLDER);
	});

	it("不含 # 外部工具 段(那是 MCP 挂载的事,与内置文案无关)", () => {
		const p = buildBuiltinPromptText("writer", "chapter", "bash");
		expect(p).not.toContain("# 外部工具");
	});
});

/**
 * 回归护栏:提示词的「对话范围」叙述(2026-10-03)。
 *
 * 背景:对话与章节解耦之后,提示词仍无条件写着「每个会话对应书的一章」「正文由当前
 * 章节决定」——分离模式下模型据此自我收窄(用户让它改别的章节时把活推回去),编剧
 * 提示词那句「写其他路径会被工具拒绝」更与事实相反(分离模式下正文白名单不设)。
 * 这里钉住三件事:① chapter 的措辞**逐字不变**(默认模式行为不许被顺手改掉);
 * ② book 不再出现绑定口径;③ 两种范围都不许把占位符漏给模型。
 */
describe("对话范围(chapter / book)在提示词里的叙述", () => {
	const PLACEHOLDER = /\{[A-Za-z_]+\}/;

	it("缺省 = 绑定章节:解耦前的原话逐字保留,且不新增对话范围整节", () => {
		const p = buildWriterSystemPrompt([], "none");
		expect(p).toBe(buildWriterSystemPrompt([], "none", "chapter"));
		expect(p).toContain("每个 pi-writer *会话*对应书的一章");
		expect(p).toContain("草稿面板只镜像当前会话对应的草稿文件");
		// 绑定章节是默认模式下**无需解释**的关系:整节不注入(默认模式的提示词与
		// 解耦前逐字节一致,见 SCOPE_VARS 的 SCOPE_SECTION 空串)
		expect(p).not.toContain("# 对话范围");
		// 落点硬规则(中间产物纪律的护栏)照旧
		expect(p).toContain("散文只有一个落点");
		expect(p).toContain("draft/<章节id>.md");
		expect(p).not.toMatch(PLACEHOLDER);
	});

	it("分离:注入对话范围整节,不再宣称会话对应一章,并把「当前章节」定义成用户正在看的那一章", () => {
		const p = buildWriterSystemPrompt([], "none", "book");
		expect(p).not.toContain("每个 pi-writer *会话*对应书的一章");
		expect(p).not.toContain("草稿面板只镜像当前会话对应的草稿文件");
		expect(p).toContain("# 对话范围");
		expect(p).toContain("**对话与章节分离**");
		expect(p).toContain("不隶属于任何章节");
		expect(p).toContain("用户此刻正在看的那一章");
		// 「当前章节」这个说法本身保留(全文很多处引用它),靠上面的定义兜住
		expect(p).toContain("散文只有一个落点");
		expect(p).not.toMatch(PLACEHOLDER);
	});

	it("分离模式的提示词与 shell 行/外部工具清单互不干扰", () => {
		const p = buildWriterSystemPrompt([{ name: "fetch_url", description: "抓网页" }], "bash", "book");
		expect(p).toContain("你可以使用 `bash`");
		expect(p).toContain("`fetch_url` — 抓网页");
		expect(p).not.toMatch(PLACEHOLDER);
	});
});

describe("编剧提示词按对话范围渲染", () => {
	const PLACEHOLDER = /\{[A-Za-z_]+\}/;

	it("chapter:正文路径由当前章节决定(白名单确实开着)", () => {
		const p = buildEditorSystemPrompt();
		expect(p).toBe(buildEditorSystemPrompt("chapter"));
		expect(p).toContain("由当前章节决定");
		expect(p).toContain("写其他路径会被工具拒绝");
		expect(p).not.toMatch(PLACEHOLDER);
	});

	it("book:不锁一章,也不再说「写其他路径会被工具拒绝」(白名单已关,那是假约束)", () => {
		const p = buildEditorSystemPrompt("book");
		expect(p).not.toContain("由当前章节决定");
		expect(p).not.toContain("写其他路径会被工具拒绝");
		expect(p).toContain("不与章节绑定");
		expect(p).toContain("任意一章");
		// 落点仍有指引:靠上下文【当前正文 · …】认路径,不许自创文件名
		expect(p).toContain("【当前正文");
		expect(p).toContain("不得自创其他文件名");
		expect(p).not.toMatch(PLACEHOLDER);
	});
});
