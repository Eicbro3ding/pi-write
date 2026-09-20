import { describe, expect, it } from "vitest";
import { buildWriterSystemPrompt } from "../src/prompt.ts";

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
