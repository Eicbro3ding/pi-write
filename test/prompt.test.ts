import { describe, expect, it } from "vitest";
import { buildEditorSystemPrompt, buildWriterSystemPrompt } from "../src/prompt.ts";

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

	it("外部工具清单追加在文末,名称+单行描述", () => {
		const prompt = buildWriterSystemPrompt(
			[
				{ name: "tavily_search", description: "网络搜索,查资料用" },
				{ name: "fetch_url", description: "抓取网页\n支持多行描述" },
			],
			"none",
		);
		expect(prompt).toContain("# 外部工具(MCP)");
		expect(prompt).toContain("`tavily_search` — 网络搜索,查资料用");
		expect(prompt).toContain("`fetch_url` — 抓取网页 支持多行描述");
		// 追加在提示词末尾(基础提示之后)
		expect(prompt.indexOf("外部工具(MCP)")).toBeGreaterThan(prompt.indexOf("你绝不做的事"));
	});

	it("占位符被替换,不残留 {SHELL_LINE}", () => {
		const prompt = buildWriterSystemPrompt([], "none");
		expect(prompt).not.toContain("{SHELL_LINE}");
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
