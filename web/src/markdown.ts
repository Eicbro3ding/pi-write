import { marked } from "marked";

/**
 * 聊天消息 / 世界书词条正文的 markdown 渲染(marked 18):
 * - 原始 HTML token 转义为纯文本(LLM 输出与用户输入均不可信,防 XSS);
 * - 链接强制新窗口打开 + noopener;
 * - **图片走白名单**(2026-09-22,需求「AI 的回复内容可以嵌入图片」):书内相对路径
 *   (`images/…`)、`http(s)://` 外链、`data:image/…` 内联图放行;`file://`、裸绝对
 *   路径、`data:text/html` 等一律拒。书内相对路径交给调用方的 `resolveImage` 换成
 *   可访问 URL —— 渲染层不知道当前书 slug,不该由它去猜。
 * - gfm + 换行即 <br>(聊天与词条场景段落更直观)。
 * 自 MessageList.tsx 抽出,词条面板(EntryCard)复用同一渲染器。
 */

/** renderMarkdown 的可选上下文。 */
export interface MarkdownRenderOptions {
	/**
	 * 把书内相对路径(`images/xxx.png` / `assets/yyy.jpg`)换成可访问 URL。
	 * 缺省原样返回 —— 那样相对路径会按页面 URL 解析,通常取不到图。
	 */
	resolveImage?: (src: string) => string;
}

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

/**
 * 图片 src 白名单(需求 11)。放行三类,其余返回 null:
 * - `data:image/…` 内联图(生成图的常见形态)。**SVG 也放行** —— 它是放在 `<img>`
 *   上下文里加载的,那种情况下 SVG 里的脚本不会执行,与内联进 DOM 不是一回事;
 * - `http(s)://` 外链;
 * - 无 scheme 且不以 `/` 开头的相对路径(书内图片)→ 交给 resolveImage。
 *
 * 明确拦掉:`file://`(可探测本地文件是否存在)、裸绝对路径、`data:text/html` 等。
 */
function sanitizeImageSrc(href: string | undefined, resolveImage?: (src: string) => string): string | null {
	const src = (href ?? "").trim();
	if (src.length === 0) return null;
	if (/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(src)) return src;
	if (/^https?:\/\//i.test(src)) return src;
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) && !src.startsWith("/")) {
		return resolveImage ? resolveImage(src) : src;
	}
	return null;
}

/** 按本次渲染的选项造 renderer(marked 的 Renderer 有状态,不能跨调用复用)。 */
function makeRenderer(resolveImage?: (src: string) => string) {
	const renderer = new marked.Renderer();
	renderer.html = ({ text }) => escapeHtml(text);
	renderer.link = function ({ href, title, tokens }) {
		// label 必须经 parser 渲染:直接拼 tokens 的 raw 会绕过 html token 转义,
		// 链接文本里的 <script> 等可经 dangerouslySetInnerHTML 注入执行;parseInline
		// 走本 renderer 的 html()(已转义),同时保留 **加粗** 等内联格式
		const label = this.parser.parseInline(tokens);
		const safeHref = sanitizeHref(href);
		return `<a href="${escapeAttr(safeHref)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(title ?? "")}">${label}</a>`;
	};
	renderer.image = function ({ href, title, text }) {
		const safe = sanitizeImageSrc(href, resolveImage);
		if (safe === null) {
			// 被拦下时不静默吞掉:降级成一行纯文本,用户至少知道 AI 这里放过一张图
			return `<span class="md-img-blocked">${escapeHtml(text || href || "图片")}</span>`;
		}
		return `<img class="md-img" src="${escapeAttr(safe)}" alt="${escapeAttr(text ?? "")}" loading="lazy" decoding="async"${title ? ` title="${escapeAttr(title)}"` : ""} />`;
	};
	return renderer;
}

/** 渲染为 HTML(仅用于 dangerouslySetInnerHTML;输入一律视为不可信)。 */
export function renderMarkdown(text: string, opts?: MarkdownRenderOptions): string {
	return marked.parse(text, { renderer: makeRenderer(opts?.resolveImage), gfm: true, breaks: true }) as string;
}
