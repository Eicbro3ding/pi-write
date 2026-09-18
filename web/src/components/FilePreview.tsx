/**
 * 工作区文件预览(盖在纸张区上的只读覆盖层)。
 *
 * 为什么盖在纸张区而不是开新页面:正文编辑器(DraftWorkspace)常驻挂载,
 * 卸载会丢未保存文本与选区;覆盖层把它压住但不动它,关掉即回到原样。
 *
 * 三种内容按 kind 分派:markdown/文本走 marked 管线(与对话、世界书同一套
 * `.record-md` 样式)、图片直接吃 `/api/books/:slug/file` 的字节流、
 * 其他二进制只给元信息(不内联,避免把 base64 塞进 JSON)。
 *
 * 只读:没有编辑入口——工作区里放的是 AI 的中间产物,想改就让它改,或者去编辑页。
 */

import { useEffect, useState } from "react";
import { bookFileUrl, type ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { renderMarkdown } from "../markdown.ts";
import type { BookFileEntryDto } from "../types.ts";
import { formatAgo, formatBytes } from "./WorkspacePanel.tsx";

export function FilePreview({
	client,
	slug,
	entry,
	onClose,
}: {
	client: ApiClient;
	slug: string;
	entry: BookFileEntryDto;
	onClose: () => void;
}) {
	/** 文本内容(kind=text 时异步取)。 */
	const [text, setText] = useState<string | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (entry.kind !== "text") return;
		let cancelled = false;
		setText(null);
		setErr(null);
		setTruncated(false);
		void client
			.getBookFileText(slug, entry.path)
			.then((r) => {
				if (cancelled) return;
				setText(r.text);
				setTruncated(r.truncated);
			})
			.catch((e) => {
				if (!cancelled) setErr(`读取失败: ${friendlyError(e)}`);
			});
		return () => {
			cancelled = true;
		};
	}, [client, slug, entry.path, entry.kind]);

	// Esc 关闭(与全屏编辑器同一习惯)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	/** 复制相对路径(剪贴板不可用时不报错:预览本身不受影响)。 */
	async function copyPath() {
		try {
			await navigator.clipboard.writeText(entry.path);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			setErr("复制失败（浏览器未授权剪贴板）");
		}
	}

	return (
		<div className="ws-preview" role="dialog" aria-label={`文件预览 ${entry.path}`}>
			<div className="ws-pv-head">
				<div className="ws-pv-title">
					<div className="ws-pv-name">{entry.title}</div>
					<div className="ws-pv-path">{entry.path}</div>
					<div className="ws-pv-meta">
						{entry.chapterTitle && <span>章节：{entry.chapterTitle}</span>}
						<span>{formatBytes(entry.bytes)}</span>
						<span>{formatAgo(entry.mtime)}</span>
					</div>
				</div>
				<div className="ws-pv-actions">
					<button type="button" className="btn-ghost" onClick={() => void copyPath()}>
						{copied ? "已复制" : "复制路径"}
					</button>
					<button type="button" className="btn-ghost" onClick={onClose}>
						关闭
					</button>
				</div>
			</div>
			<div className="ws-pv-body">
				{err && <div className="notice err">{err}</div>}
				{entry.kind === "image" ? (
					<figure className="ws-pv-image">
						<img src={bookFileUrl(slug, entry.path)} alt={entry.title} />
						<figcaption>{entry.path}</figcaption>
					</figure>
				) : entry.kind === "binary" ? (
					<div className="ws-pv-binary">
						<div>这类文件不能内联预览（二进制）。</div>
						<div className="ws-pv-kv">
							<div>
								<span>大小</span>
								<span>{formatBytes(entry.bytes)}</span>
							</div>
							<div>
								<span>路径</span>
								<span>{entry.path}</span>
							</div>
							<div>
								<span>修改</span>
								<span>{formatAgo(entry.mtime)}</span>
							</div>
						</div>
					</div>
				) : text === null && !err ? (
					<div className="ws-desc">加载中…</div>
				) : (
					<>
						{truncated && <div className="notice warn">文件较大，只显示前 512 KB。</div>}
						<div className="record-text record-md ws-pv-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(text ?? "") }} />
					</>
				)}
			</div>
		</div>
	);
}
