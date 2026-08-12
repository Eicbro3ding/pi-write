/**
 * 书库状态唯一真相源(useLibrary):书列表 / 当前书 / 当前章节 / 侧栏偏好。
 * 由 App 持有并经 props 下发,舞台页与编辑页共用——两页的书库栏因此状态同步
 * (切书/切章在任意一页生效,另一页跟随)。
 *
 * 会话耦合说明:本 hook 只做「数据层」——拉书/切章/增删改导出,不含会话同步
 * (switchSession/历史水合)。编辑页(WritePage)在调用后自行同步会话;舞台页
 * 不需要会话(舞台状态按书从文件读取)。为此 hook 的 setter 与 React setState
 * 同形(setBooks 支持值/函数两形态),WritePage 以别名接入,既有调用点零改动。
 */
import { useCallback, useState } from "react";
import type { ApiClient } from "./api/client.ts";
import type { BookDetail, BookMeta, ChapterRef } from "./types.ts";

export interface Library {
	books: BookMeta[];
	bookDetail: BookDetail | null;
	currentChapter: ChapterRef | null;
	busySlug: string | null;
	importing: boolean;
	sidebarWidth: number;
	sidebarCollapsed: boolean;
	/** AI 伙伴栏标签(编剧/备忘录):两页同步 + localStorage 持久化(2026-08-12)。 */
	memoTab: "chat" | "memo";
	changeMemoTab(t: "chat" | "memo"): void;
	setSidebarWidth(w: number): void;
	toggleSidebarCollapsed(): void;
	/** 拉书列表(返回列表供调用方继续处理,如打开第一本)。 */
	loadBooks(): Promise<BookMeta[]>;
	/** 数据层开书:拉书详情 → 更新书列表计数与当前书 → 上报 onBookChange。不归位章节(调用方决定)。 */
	openBookData(slug: string): Promise<BookDetail>;
	/** 清空当前书(书被删除/连接失败等),上报 onBookChange(null)。 */
	clearBook(): void;
	/** 上报当前书变化(供 App 的 currentSlug 等消费)。 */
	reportBookChange(slug: string | null): void;
	/** 与 React setState 同形的 setter(WritePage 别名接入用);bookDetail 可为 null(书被删除/清空)。 */
	applyBookDetail(detail: BookDetail | null): void;
	applyBooks(next: BookMeta[] | ((prev: BookMeta[]) => BookMeta[])): void;
	applyChapter(ch: ChapterRef | null): void;
	applyBusy(slug: string | null): void;
	applyImporting(v: boolean): void;
	/** 导出书 zip(busy 标记 + Android 分享桥 + a[download] 回退);失败抛出。 */
	exportBook(slug: string): Promise<void>;
	/** 删除书并更新列表;失败抛出。当前书后续处理(打开另一本/清空)由调用方决定。 */
	deleteBookData(slug: string): Promise<void>;
	/** 新建书(列表追加并返回详情;打开由调用方负责)。 */
	createBookData(title: string): Promise<BookDetail>;
	/** 新建章节(当前书);会话切换与详情刷新由调用方负责。 */
	createChapterData(title: string): Promise<ChapterRef>;
	/** 重命名书(列表刷新并返回新详情;若为当前书,打开新 slug 由调用方负责)。 */
	renameBookData(slug: string, title: string): Promise<BookDetail>;
	/** 重命名章节(刷新详情并同步当前章节标题)。 */
	renameChapterData(ch: ChapterRef, title: string): Promise<BookDetail>;
	/** 导入书 zip(列表刷新并返回详情;打开由调用方负责)。 */
	importBookData(file: File): Promise<BookDetail>;
}

export function useLibrary(client: ApiClient, onBookChange?: (slug: string | null) => void): Library {
	const [books, setBooks] = useState<BookMeta[]>([]);
	const [bookDetail, setBookDetail] = useState<BookDetail | null>(null);
	const [currentChapter, setCurrentChapter] = useState<ChapterRef | null>(null);
	const [busySlug, setBusySlug] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	/** 侧栏宽度(px),拖拽手柄调整。 */
	const [sidebarWidth, setSidebarWidth] = useState(168);
	/** 书库栏折叠态(56px 图标条):localStorage 持久化。 */
	const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
		try {
			return localStorage.getItem("pi-writer:library-collapsed") === "1";
		} catch {
			return false;
		}
	});
	/** AI 伙伴栏标签(编剧/备忘录):localStorage 持久化,两页共享。
	 *  旧值 "library"(书库侧栏标签时代)按默认 "chat" 处理,自然迁移。 */
	const [memoTab, setMemoTab] = useState<"chat" | "memo">(() => {
		try {
			return localStorage.getItem("pi-writer:sidebar-tab") === "memo" ? "memo" : "chat";
		} catch {
			return "chat";
		}
	});
	const changeMemoTab = useCallback((t: "chat" | "memo") => {
		setMemoTab(t);
		try {
			localStorage.setItem("pi-writer:sidebar-tab", t);
		} catch {
			/* localStorage 不可用:仅内存态 */
		}
	}, []);
	const toggleSidebarCollapsed = () => {
		setSidebarCollapsed((v) => {
			const next = !v;
			try {
				localStorage.setItem("pi-writer:library-collapsed", next ? "1" : "0");
			} catch {
				/* 存储失败不影响使用 */
			}
			return next;
		});
	};

	const reportBookChange = useCallback((slug: string | null) => onBookChange?.(slug), [onBookChange]);

	const clearBook = useCallback(() => {
		setBookDetail(null);
		setCurrentChapter(null);
		reportBookChange(null);
	}, [reportBookChange]);

	const applyBookDetail = useCallback((detail: BookDetail | null) => {
		setBookDetail(detail);
		if (detail) {
			setBooks((prev) => prev.map((b) => (b.slug === detail.slug ? { ...b, chapters: detail.chapters.length } : b)));
		}
	}, []);

	const applyBooks = useCallback((next: BookMeta[] | ((prev: BookMeta[]) => BookMeta[])) => {
		setBooks(next);
	}, []);

	const applyChapter = useCallback((ch: ChapterRef | null) => setCurrentChapter(ch), []);
	const applyBusy = useCallback((slug: string | null) => setBusySlug(slug), []);
	const applyImporting = useCallback((v: boolean) => setImporting(v), []);

	const loadBooks = useCallback(async () => {
		const list = await client.getBooks();
		setBooks(list);
		return list;
	}, [client]);

	const openBookData = useCallback(
		async (slug: string) => {
			const detail = await client.getBook(slug);
			applyBookDetail(detail);
			reportBookChange(detail.slug);
			return detail;
		},
		[applyBookDetail, reportBookChange, client],
	);

	/** 导出书:fetch blob → Android 壳有分享桥时经桥走系统分享面板,否则回退 a[download] 下载。 */
	const exportBook = useCallback(
		async (slug: string) => {
			setBusySlug(slug);
			try {
				const blob = await client.exportBook(slug);
				// Android 外壳(pi-writer-android):桥存在时把 zip 以 data URL 交给
				// Kotlin 侧(系统分享面板);桌面无桥,走既有浏览器下载
				if (window.PiWriterBridge?.shareZip) {
					const dataUrl = await new Promise<string>((resolve, reject) => {
						const r = new FileReader();
						r.onload = () => resolve(r.result as string);
						r.onerror = () => reject(r.error);
						r.readAsDataURL(blob);
					});
					window.PiWriterBridge.shareZip(`${slug}.zip`, dataUrl);
					return;
				}
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `${slug}.zip`;
				a.click();
				URL.revokeObjectURL(url);
			} finally {
				setBusySlug(null);
			}
		},
		[client],
	);

	const deleteBookData = useCallback(
		async (slug: string) => {
			setBusySlug(slug);
			try {
				await client.deleteBook(slug);
				setBooks((prev) => prev.filter((b) => b.slug !== slug));
			} finally {
				setBusySlug(null);
			}
		},
		[client],
	);

	const createBookData = useCallback(
		async (title: string) => {
			const book = await client.createBook(title);
			setBooks((prev) => [...prev, { slug: book.slug, title: book.title, chapters: book.chapters.length, updatedAt: Date.now() }]);
			return book;
		},
		[client],
	);

	const createChapterData = useCallback(
		async (title: string) => {
			if (!bookDetail) throw new Error("未打开书");
			return client.createChapter(bookDetail.slug, title);
		},
		[bookDetail, client],
	);

	const renameBookData = useCallback(
		async (slug: string, title: string) => {
			const book = await client.renameBook(slug, title);
			setBooks(await client.getBooks());
			return book;
		},
		[client],
	);

	const renameChapterData = useCallback(
		async (ch: ChapterRef, title: string) => {
			if (!bookDetail) throw new Error("未打开书");
			const detail = await client.patchChapter(bookDetail.slug, ch.id, { title });
			applyBookDetail(detail);
			setCurrentChapter((prev) => (prev?.id === ch.id ? detail.chapters.find((c) => c.id === ch.id) ?? prev : prev));
			return detail;
		},
		[bookDetail, applyBookDetail, client],
	);

	const importBookData = useCallback(
		async (file: File) => {
			setImporting(true);
			try {
				const book = await client.importBook(file);
				setBooks(await client.getBooks());
				return book;
			} finally {
				setImporting(false);
			}
		},
		[client],
	);

	return {
		books,
		bookDetail,
		currentChapter,
		busySlug,
		importing,
		sidebarWidth,
		sidebarCollapsed,
		memoTab,
		changeMemoTab,
		setSidebarWidth,
		toggleSidebarCollapsed,
		loadBooks,
		openBookData,
		clearBook,
		reportBookChange,
		applyBookDetail,
		applyBooks,
		applyChapter,
		applyBusy,
		applyImporting,
		exportBook,
		deleteBookData,
		createBookData,
		createChapterData,
		renameBookData,
		renameChapterData,
		importBookData,
	};
}
