/**
 * 工作区面板 —— 编辑页左栏「工作区」模式的内容(只读)。
 *
 * 它回答一个问题:**这本书的工作台上摊着哪些东西?**
 * 定位是 **AI 产出的中间产物**:收集的资料与笔记、参考图、各章草稿
 * (分组与展示名由服务端给,前端只渲染——见 src/book-files.ts)。
 *
 * 刻意**不列**世界书生成物(outline.md / .writer/*.md):那些内容的权威视图在
 * 世界书页,摆进工作区会被当成可以编辑的稿子。见 isGeneratedView。
 *
 * 交互约定(与设计确认一致):
 * - 点**草稿**条目 → 交回 onOpenChapter,由页面切回「章节」模式并选中那一章
 *   (编辑页本来就是草稿的编辑器,这里不再开只读预览);
 * - 点**其他**条目 → 交回 onPreview,由页面在纸张区弹预览覆盖层。
 *
 * 刻意**没有**的能力:重命名 / 删除 / 移动 / 新建。书目录与 book.json 的章节索引、
 * 会话文件名、world.json 的 outline 引用三处交叉引用同一个文件名,UI 层删改会
 * 把数据改歪——要改文件请走系统文件管理器,或者让 agent 用工具改(它有路径守卫)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { BookFileEntryDto, BookFilesDto } from "../types.ts";

/** 文件体积(列表里尽量短)。 */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 相对时间:列表按「多久以前」读比绝对时间有用(与 mtime 一起用于排序展示)。 */
export function formatAgo(mtimeMs: number, now = Date.now()): string {
	const min = Math.max(0, Math.round((now - mtimeMs) / 60_000));
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`;
	const days = Math.round(min / (60 * 24));
	if (days < 60) return `${days} 天前`;
	return `${Math.round(days / 30)} 个月前`;
}

export function WorkspacePanel({
	client,
	slug,
	active,
	aiTouched,
	onOpenChapter,
	onPreview,
}: {
	client: ApiClient;
	/** 当前书 slug;null = 未打开书。 */
	slug: string | null;
	/** 面板是否处于可见模式(切到「工作区」时刷新一次,拿到最新清单)。 */
	active: boolean;
	/** 本会话 agent 碰过的相对路径(前端台账,见 WritePage;刷新后为空)。 */
	aiTouched: ReadonlySet<string>;
	/** 点草稿条目:交回章节 id("ch01"),由页面切回章节模式并选中。 */
	onOpenChapter: (chapterId: string) => void;
	/** 点其他条目:交回条目,由页面在纸张区弹预览。 */
	onPreview: (entry: BookFileEntryDto) => void;
}) {
	const [data, setData] = useState<BookFilesDto | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	/** 当前书 slug(请求返回时比对:期间切书则丢弃结果)。 */
	const slugRef = useRef<string | null>(slug);
	slugRef.current = slug;

	const reload = useCallback(async () => {
		const cur = slugRef.current;
		if (!cur) {
			setData(null);
			return;
		}
		setLoading(true);
		try {
			const files = await client.getBookFiles(cur);
			if (slugRef.current !== cur) return; // 期间切书:丢弃
			setData(files);
			setErr(null);
		} catch (e) {
			if (slugRef.current !== cur) return;
			setErr(`工作区加载失败: ${friendlyError(e)}`);
		} finally {
			if (slugRef.current === cur) setLoading(false);
		}
	}, [client]);

	// 切书 → 重拉;切到「工作区」模式 → 再拉一次(期间 agent 可能写过文件)
	useEffect(() => {
		if (slug) void reload();
		else setData(null);
	}, [slug, reload]);
	useEffect(() => {
		if (active && slug) void reload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// 外部变更(agent 工具写盘 / 服务端 watcher 发现) → 去抖重拉清单
	useEffect(() => {
		if (!slug) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsub = client.subscribeEvents((e) => {
			if (e.type !== "draft_changed" && e.type !== "world_changed") return;
			if (e.slug !== slug) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void reload(), 400);
		});
		return () => {
			if (timer) clearTimeout(timer);
			unsub();
		};
	}, [client, slug, reload]);

	if (!slug) return <div className="ws-desc">未打开书。</div>;

	const files = data?.files ?? [];
	const groups = data?.groups ?? [];
	/** 本次会话 agent 碰过的文件(只算清单里存在的,避免显示幽灵条目)。 */
	const touched = files.filter((f) => aiTouched.has(f.path));

	return (
		<>
			{loading && !data && <div className="ws-desc">加载中…</div>}
			{err && (
				<div className="notice err ws-notice">
					{err}
					<button type="button" className="btn-ghost" onClick={() => void reload()}>
						重试
					</button>
				</div>
			)}
			{touched.length > 0 && (
				<div className="ws-inbox">
					<div className="ws-inbox-head">AI 写过 · {touched.length} 个文件</div>
					<div className="ws-inbox-desc">本会话内 agent 改动过（刷新页面后重置）</div>
					<div className="ws-chips">
						{touched.map((f) => (
							<button
								key={f.path}
								type="button"
								className="ws-chip"
								title={f.path}
								onClick={() => (f.group === "draft" && f.chapterId ? onOpenChapter(f.chapterId) : onPreview(f))}
							>
								{f.path}
							</button>
						))}
					</div>
				</div>
			)}
			{data && files.length === 0 && <div className="ws-desc">这本书的目录里还没有可列的文件。</div>}
			{groups.map((g) => {
				const items = files.filter((f) => f.group === g.id);
				if (items.length === 0) return null;
				return (
					<div key={g.id} className="ws-group">
						<div className="ws-group-head">
							<span>{g.label}</span>
							<span className="ws-count">{items.length}</span>
							{g.id === "draft" && <span className="ws-lock" title="草稿在编辑页里直接编辑">编辑页</span>}
						</div>
						<div className="ws-group-desc">{g.description}</div>
						{items.map((f) => (
							<button
								key={f.path}
								type="button"
								className="ws-row"
								title={f.path}
								onClick={() => (f.group === "draft" && f.chapterId ? onOpenChapter(f.chapterId) : onPreview(f))}
							>
								<span className="ws-row-name">
									{f.title}
									<em>{f.name}</em>
								</span>
								<span className="ws-row-meta">
									{aiTouched.has(f.path) && <span className="ws-badge ai">AI</span>}
									{formatBytes(f.bytes)} · {formatAgo(f.mtime)}
								</span>
							</button>
						))}
					</div>
				);
			})}
		</>
	);
}
