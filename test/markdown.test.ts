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

/**
 * 正文图片白名单(需求 11「AI 的回复内容可以嵌入图片」)。
 * 图片 src 与链接 href 是**两条独立白名单**:图片走 <img>,脚本不执行,但 `file://`
 * 能探测本地文件是否存在,裸绝对路径同理,都得拦。
 */
describe("renderMarkdown 图片白名单", () => {
	it("书内相对路径交给 resolveImage 换成可访问 URL", () => {
		const html = renderMarkdown("![灯塔草图](images/light.png)", {
			resolveImage: (src) => `/api/books/fog/images/${src.replace(/^images\//, "")}`,
		});
		expect(html).toContain('src="/api/books/fog/images/light.png"');
		expect(html).toContain('alt="灯塔草图"');
		expect(html).toContain('class="md-img"');
		expect(html).toContain('loading="lazy"');
	});

	it("没给 resolveImage 时相对路径原样保留", () => {
		expect(renderMarkdown("![](images/a.png)")).toContain('src="images/a.png"');
	});

	it("http(s) 外链放行", () => {
		expect(renderMarkdown("![](https://example.com/a.png)")).toContain('src="https://example.com/a.png"');
	});

	it("data:image 内联图放行(SVG 也放行 —— img 上下文里脚本不执行)", () => {
		const png = "data:image/png;base64,iVBORw0KGgo=";
		expect(renderMarkdown(`![](${png})`)).toContain(png);
		expect(renderMarkdown("![](data:image/svg+xml;base64,PHN2Zy8+)")).toContain("data:image/svg+xml");
	});

	it("裸绝对路径被拦,降级成一行文本而不是静默消失", () => {
		const html = renderMarkdown("![本地](/etc/passwd)");
		expect(html).not.toContain("<img");
		expect(html).toContain("md-img-blocked");
		expect(html).toContain("本地");
	});

	it("file: scheme 被拦", () => {
		expect(renderMarkdown("![](file:///etc/passwd)")).not.toContain("<img");
	});

	it("data:text/html 被拦(不能借图片语法塞 HTML)", () => {
		expect(renderMarkdown("![](data:text/html;base64,PHNjcmlwdD4=)")).not.toContain("<img");
	});

	it("图片语法里的 HTML 不进 DOM(alt 已转义)", () => {
		const html = renderMarkdown('![" onerror="alert(1)](images/a.png)');
		expect(html).not.toContain("onerror=\"alert(1)\"");
	});
});
