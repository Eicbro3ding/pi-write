/**
 * UI 房的运行时上下文:展项里的组件需要 `client` / `slug` / `library`(书库栏、
 * 导出面板、供应商列表这些不是纯展示件),但展项文件不该自己 new 一个客户端 ——
 * 页面把 App 的真实运行时放进来,展项按需取。
 *
 * 契约测试(SSR 冒烟)用 `demoRuntime()` 造一份替身:真实 `ApiClient` 实例
 * (构造不触网,effects 在 SSR 不跑)+ 假的书库。所以展项**不要在渲染期发请求**,
 * 数据一律走 effects(现有组件本来就是这个约定)。
 */
import { createContext, useContext, type ReactNode } from "react";
import { ApiClient } from "./api/client.ts";
import type { Library } from "./library.ts";
import type { BookDetail, BookMeta, ChapterRef } from "./types.ts";

export interface UIRoomRuntime {
	client: ApiClient;
	/** 当前书的 slug(没有书时为 null;展项自己处理这个分支)。 */
	slug: string | null;
	library: Library;
	/** 切到别的页面(标题栏的「回到编辑」之类)。 */
	navigate: (view: string) => void;
}

const UIRoomRuntimeContext = createContext<UIRoomRuntime | null>(null);

export function UIRoomRuntimeProvider({ value, children }: { value: UIRoomRuntime; children: ReactNode }) {
	return <UIRoomRuntimeContext.Provider value={value}>{children}</UIRoomRuntimeContext.Provider>;
}

/** 取运行时;在 UI 房之外调用会抛(说明展项被挂到别处了)。 */
export function useUIRoomRuntime(): UIRoomRuntime {
	const rt = useContext(UIRoomRuntimeContext);
	if (!rt) throw new Error("UI 房展项必须在 UIRoomRuntimeProvider 内渲染(见 pages/UIRoom.tsx)");
	return rt;
}

export function useMaybeUIRoomRuntime(): UIRoomRuntime | null {
	return useContext(UIRoomRuntimeContext);
}

/** 演示用的书库替身:只提供展项会读的字段,setter 全部空转(展项不许改真实数据)。 */
export function demoLibrary(overrides: Partial<Library> = {}): Library {
	const books: BookMeta[] = [
		{ slug: "demo-book", title: "夜航船", chapters: 3, updatedAt: 1_760_000_000_000 },
		{ slug: "demo-short", title: "短篇练习", chapters: 1, updatedAt: 1_759_000_000_000 },
	];
	const chapters: ChapterRef[] = [
		{ id: "ch01", file: "ch01.jsonl", title: "第一章 · 渡口", label: null, exists: true },
		{ id: "ch02", file: "ch02.jsonl", title: "第二章 · 灯塔", label: "草稿", exists: true },
		{ id: "ch03", file: "ch03.jsonl", title: "第三章 · 归航", label: "完成", exists: false },
	];
	const detail: BookDetail = { slug: "demo-book", title: "夜航船", currentChapterFile: "ch01.jsonl", chapters };
	const noopAsync = <T,>(v: T) => async () => v;
	return {
		books,
		booksLoaded: true,
		bookDetail: detail,
		currentChapter: chapters[0],
		busySlug: null,
		importing: false,
		sidebarWidth: 232,
		sidebarCollapsed: false,
		memoTab: "chat",
		changeMemoTab: () => {},
		setSidebarWidth: () => {},
		toggleSidebarCollapsed: () => {},
		loadBooks: noopAsync(books),
		openBookData: noopAsync(detail),
		clearBook: () => {},
		reportBookChange: () => {},
		applyBookDetail: () => {},
		applyBooks: () => {},
		applyChapter: () => {},
		applyBusy: () => {},
		applyImporting: () => {},
		exportBook: async () => {},
		deleteBookData: async () => {},
		createBookData: noopAsync(detail),
		createChapterData: noopAsync(chapters[0]),
		renameBookData: noopAsync(detail),
		renameChapterData: noopAsync(detail),
		importBookData: noopAsync(detail),
		...overrides,
	};
}

/** 契约测试与「无 App 环境」下的替代运行时(真实 ApiClient 实例不触网)。 */
export function demoRuntime(overrides: Partial<UIRoomRuntime> = {}): UIRoomRuntime {
	return {
		client: new ApiClient(),
		slug: "demo-book",
		library: demoLibrary(),
		navigate: () => {},
		...overrides,
	};
}

/**
 * 「隔离」客户端:所有方法都 reject,只有 `subscribeEvents` 返回空退订函数
 * (组件在 effect 里会把它当 cleanup 调用,返回 undefined 会在卸载时崩)。
 *
 * 为什么需要:UI 房里有一批组件直接拿 `client` 干活 —— 供应商列表能删凭据、
 * MCP 列表能改配置、插件列表能停用/授权、导出面板会真的导出整本书、全屏编辑器
 * 会写文件、配置向导会建书写设置。**调试页不该因为一次误点就改掉真实数据**,
 * 所以 UI 房默认用这个客户端(数据型组件会走到各自的「请求失败」态——顺带把
 * 平时构造不出来的失败态也陈列了),要看真实数据就在工具条上切「真实服务」。
 */
export function stubClient(reason = "UI 房处于「隔离演示」:这个操作不会真的生效"): ApiClient {
	const noopUnsub = () => {};
	const cache = new Map<string | symbol, unknown>();
	const own: Record<string | symbol, unknown> = { subscribeEvents: () => noopUnsub };
	return new Proxy(own, {
		get(target, prop) {
			if (prop in target) return target[prop];
			if (!cache.has(prop)) {
				cache.set(prop, async () => {
					throw new Error(reason);
				});
			}
			return cache.get(prop);
		},
	}) as unknown as ApiClient;
}
