import { marked } from "marked";

/**
 * 聊天消息 / 世界书词条正文的 markdown 渲染(marked 18):
 * - 原始 HTML token 转义为纯文本(LLM 输出与用户输入均不可信,防 XSS);
 * - 链接强制新窗口打开 + noopener;
 * - gfm + 换行即 <br>(聊天与词条场景段落更直观)。
 * 自 MessageList.tsx 抽出,词条面板(EntryCard)复用同一渲染器。
 */
const mdRenderer = new marked.Renderer();
mdRenderer.html = ({ text }) => escapeHtml(text);
mdRenderer.link = function ({ href, title, tokens }) {
	// label 必须经 parser 渲染:直接拼 tokens 的 raw 会绕过 html token 转义,
	// 链接文本里的 <script> 等可经 dangerouslySetInnerHTML 注入执行;parseInline
	// 走本 renderer 的 html()(已转义),同时保留 **加粗** 等内联格式
	const label = this.parser.parseInline(tokens);
	const safeHref = sanitizeHref(href);
	return `<a href="${escapeAttr(safeHref)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(title ?? "")}">${label}</a>`;
};

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/'/g, "&#39;");
}

/** 链接 scheme 白名单:无 scheme 的相对链接放行;仅 http/https/mailto 允许,其余(javascript:/data: 等)置空。 */
function sanitizeHref(href: string | undefined): string {
	const h = (href ?? "").trim();
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) return h;
	return /^(https?:|mailto:)/i.test(h) ? h : "";
}

/** 渲染为 HTML(仅用于 dangerouslySetInnerHTML;输入一律视为不可信)。 */
export function renderMarkdown(text: string): string {
	return marked.parse(text, { renderer: mdRenderer, gfm: true, breaks: true }) as string;
}
