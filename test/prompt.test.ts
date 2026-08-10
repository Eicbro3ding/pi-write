import { describe, expect, it } from "vitest";
import { buildWriterSystemPrompt } from "../src/prompt.ts";

describe("buildWriterSystemPrompt", () => {
	it("无外部工具时只含基础提示,shell 行按 hasBash 注入", () => {
		const web = buildWriterSystemPrompt([], false);
		expect(web).toContain("你**没有** \\`bash\\`");
		expect(web).not.toContain("外部工具(MCP)");
		const tui = buildWriterSystemPrompt([], true);
		expect(tui).toContain("你可以使用 \\`bash\\`");
		expect(tui).not.toContain("你**没有** \\`bash\\`");
	});

	it("外部工具清单追加在文末,名称+单行描述", () => {
		const prompt = buildWriterSystemPrompt(
			[
				{ name: "tavily_search", description: "网络搜索,查资料用" },
				{ name: "fetch_url", description: "抓取网页\n支持多行描述" },
			],
			false,
		);
		expect(prompt).toContain("# 外部工具(MCP)");
		expect(prompt).toContain("`tavily_search` — 网络搜索,查资料用");
		expect(prompt).toContain("`fetch_url` — 抓取网页 支持多行描述");
		// 追加在提示词末尾(基础提示之后)
		expect(prompt.indexOf("外部工具(MCP)")).toBeGreaterThan(prompt.indexOf("你绝不做的事"));
	});

	it("占位符被替换,不残留 {SHELL_LINE}", () => {
		const prompt = buildWriterSystemPrompt([], false);
		expect(prompt).not.toContain("{SHELL_LINE}");
	});
});
