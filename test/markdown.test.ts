import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../web/src/markdown.ts";

/**
 * markdown 渲染安全性:所有输出最终进 dangerouslySetInnerHTML(MessageList/EntryCard),
 * 输入一律视为不可信。重点防两条注入路径:
 * 1. 链接文本中的原始 HTML(经 t.raw 拼接曾绕过 html token 转义);
 * 2. 危险 scheme(href 属性值内的 javascript:/data: 等)。
 */
describe("renderMarkdown 安全性", () => {
	it("链接文本内的 <script> 转义(历史 XSS 回归)", () => {
		const html = renderMarkdown("[a <script>alert(1)</script> b](https://example.com)");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("链接文本内的任意 HTML 标签一律转义", () => {
		const html = renderMarkdown("[x <img src=x onerror=alert(1)>](https://example.com)");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("javascript: scheme 链接置空", () => {
		const html = renderMarkdown("[x](javascript:alert(1))");
		expect(html).toContain('href=""');
		expect(html).not.toContain("javascript:");
	});

	it("data: / vbscript: scheme 链接置空", () => {
		expect(renderMarkdown("[x](data:text/html,<script>alert(1)</script>)")).toContain('href=""');
		expect(renderMarkdown("[x](vbscript:msgbox(1))")).toContain('href=""');
	});

	it("http/https/mailto 与相对链接放行", () => {
		expect(renderMarkdown("[a](https://example.com)")).toContain('href="https://example.com"');
		expect(renderMarkdown("[a](mailto:x@y.z)")).toContain('href="mailto:x@y.z"');
		expect(renderMarkdown("[a](/api/books/x)")).toContain('href="/api/books/x"');
	});

	it("纯文本位置的 <script> 仍转义", () => {
		expect(renderMarkdown("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("链接内联格式保留(parseInline 渲染,非 raw 拼接)", () => {
		expect(renderMarkdown("[**加粗**](https://example.com)")).toContain("<strong>加粗</strong>");
	});

	it("普通渲染不受影响", () => {
		const html = renderMarkdown("**标题**\n\n正文\n\n- 列表项");
		expect(html).toContain("<strong>标题</strong>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>列表项</li>");
	});
});
