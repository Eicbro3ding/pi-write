/**
 * 备忘录板(Notice 待办清单)——AI 伙伴栏「备忘录」标签的内容(2026-08-12 回到初衷):
 * Notice 是全局备忘录/待办:AI 埋伏笔、记重要事项写成待办(未完成项会注入所有
 * agent 的上下文),用户在板子上勾选完成、就地改文案。数据存 world.json 的
 * notice.items,800ms 防抖整体 putWorld 保存(与 WorldPage 同款)。
 *
 * 控件按设计稿 02-模态与面板/02 收成两个:方形自绘勾选框(完成 = 琥珀实心),
 * 以及底部的「＋ 记一条待办…」输入行。**行尾没有删除按钮**——设计稿里这一行
 * 只有勾选一个控件;待办要清掉,改 world.json(世界书页 / AI 均可)。
 *
 * 取舍:不做多窗口冲突检测(useCrossWindowReload 的脏检测)——板子是轻量辅助,
 * 多窗口同时编辑备忘录罕见,刷新即与服务端收敛。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError } from "../api/client.ts";
import type { WorldDataDto } from "../types.ts";
import { newId } from "./id.ts";
import { Lu } from "./Lu.tsx";

interface NoticeBoardProps {
	/** 共享 API 客户端(App 注入,与其余组件同单例;不再自建实例)。 */
	client: ApiClient;
	/** 当前打开的书 slug;null = 未打开书。 */
	slug: string | null;
	/**
	 * 视觉变体。"full"(缺省)= 顶部「注入全部 agent 上下文」开关 + 添加行(备忘录栏用);
	 * "minimal" = 舞台面板「备忘录」页签用:头部说明与「＋ 记一条待办…」输入行由
	 * 舞台面板自己给(设计稿 02-模态与面板/02),板子只出条目本身。
	 */
	variant?: "full" | "minimal";
	/** 条目数变化回调(添加/删除/完成切换后;舞台面板头部「备忘录 · N 条」用)。 */
	onItemsChange?(items: WorldDataDto["notice"]["items"]): void;
}

const SAVE_DELAY_MS = 800;

/** 侧栏备忘录板:待办清单(勾选/编辑/删除/添加)+ 注入开关。 */
export function NoticeBoard({ client, slug, variant = "full", onItemsChange }: NoticeBoardProps) {
	const minimal = variant === "minimal";
	/** 完整 world(改 notice 后整体保存);null = 无书/加载失败。 */
	const [world, setWorld] = useState<WorldDataDto | null>(null);
	const [draft, setDraft] = useState("");
	/** 409 冲突提示(2026-08 B 档):磁盘 world.json 已被 AI/其他窗口修改,保存被拒。
	 *  显示提示并重载,不再静默失败(静默会让板子显示「已保存」而磁盘是旧值)。 */
	const [saveConflict, setSaveConflict] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const worldRef = useRef(world);
	worldRef.current = world;
	const mtimeRef = useRef<number | undefined>(undefined);
	/** 条目回调经 ref 读取:父级用行内箭头函数也不会引起 effect 反复触发。 */
	const onItemsChangeRef = useRef(onItemsChange);
	onItemsChangeRef.current = onItemsChange;

	const reload = useCallback(async () => {
		if (!slug) {
			setWorld(null);
			return;
		}
		try {
			const { world: w, mtime } = await client.getWorld(slug ?? undefined);
			mtimeRef.current = mtime;
			setWorld(w);
		} catch {
			setWorld(null);
		}
	}, [slug, client]);

	useEffect(() => {
		void reload();
	}, [reload]);

	/** 更新本地 world 副本并防抖保存。 */
	const updateNotice = useCallback(
		(next: WorldDataDto["notice"]) => {
			if (!worldRef.current) return;
			setWorld({ ...worldRef.current, notice: next });
			clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				const w = worldRef.current;
				if (!w) return;
				void client
					.putWorld(w, mtimeRef.current, slug ?? undefined)
					.then((m) => {
						mtimeRef.current = m;
						setSaveConflict(false);
					})
					.catch((err: unknown) => {
						// 409 = 磁盘已被 AI/其他窗口改动:提示 + 重载以磁盘为准收敛
						// (继续用旧 mtime 会反复 409,板子静默失效;B 档 2026-08)
						if (err instanceof ApiError && err.status === 409) {
							setSaveConflict(true);
							void reload();
							return;
						}
						/* 其他失败(网络瞬断等):板子显示旧值,用户下次编辑会再触发 */
					});
			}, SAVE_DELAY_MS);
		},
		[client],
	);

	const addItem = () => {
		const text = draft.trim();
		if (!text || !world) return;
		updateNotice({
			...world.notice,
			items: [...world.notice.items, { id: newId("ntc"), text, done: false, updatedAt: Date.now() }],
		});
		setDraft("");
	};

	const patchItem = (id: string, patch: Partial<{ text: string; done: boolean }>) => {
		if (!world) return;
		updateNotice({
			...world.notice,
			items: world.notice.items.map((it) => (it.id === id ? { ...it, ...patch, updatedAt: Date.now() } : it)),
		});
	};

	// 条目集变化上报(舞台面板头部「备忘录 · N 条」):只在增删时触发(依赖条数,
	// 文本编辑不打扰父级);回调经 ref 读取,父级用行内箭头函数不会反复触发。
	const itemCount = world?.notice.items.length ?? 0;
	useEffect(() => {
		onItemsChangeRef.current?.(world?.notice.items ?? []);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [itemCount]);

	if (world === null) {
		return (
			<div className={minimal ? "notice-board minimal" : "notice-board"}>
				<div className="s-note">未打开书——备忘录随书保存,先选一本。</div>
			</div>
		);
	}
	const { notice } = world;
	return (
		<div className={minimal ? "notice-board minimal" : "notice-board"}>
			{saveConflict && (
				<div className="notice err">
					保存失败:世界书已被其他窗口或 AI 修改,已重新加载最新版本
				</div>
			)}
			{/* 「注入全部 agent 上下文」总开关只在完整形态给;舞台面板的说明行里
			    已经写明「未完成项会注入所有 agent」(设计稿 02),不重复一个开关 */}
			{!minimal && (
				<button
					type="button"
					role="checkbox"
					aria-checked={notice.enabled}
					className="notice-enable"
					onClick={() => updateNotice({ ...notice, enabled: !notice.enabled })}
				>
					<CheckBox on={notice.enabled} />
					<span>注入全部 agent 上下文</span>
				</button>
			)}
			{notice.items.length === 0 ? (
				<div className="s-note">暂无待办——AI 埋伏笔、记重要事项时会写在这里;也可手动添加。</div>
			) : (
				notice.items.map((it) => (
					/* 待办行 = 一张卡(设计稿 02-模态与面板/02):左端方形勾选框 + 正文,
					   行尾不再挂删除按钮——设计稿里这一行只有勾选一个控件,勾选即完成 */
					<div key={it.id} className={it.done ? "notice-item done" : "notice-item"}>
						<button
							type="button"
							role="checkbox"
							aria-checked={it.done}
							className="notice-check"
							title={it.done ? "标记未完成(会重新注入上下文)" : "标记完成(不再注入上下文)"}
							aria-label={it.done ? "标记未完成" : "标记完成"}
							onClick={() => patchItem(it.id, { done: !it.done })}
						>
							{it.done && <CheckMark />}
						</button>
						<input
							type="text"
							value={it.text}
							onChange={(e) => patchItem(it.id, { text: e.target.value })}
							className="notice-text"
							aria-label="待办内容"
						/>
					</div>
				))
			)}
			{/* 添加行:＋ 图标 + 输入框,回车添加(设计稿同款;不再多一个「添加」按钮) */}
			<div className="notice-add">
				<PlusIcon />
				<input
					type="text"
					placeholder="记一条待办…"
					aria-label="记一条待办"
					title="回车添加"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") addItem();
					}}
				/>
			</div>
		</div>
	);
}

/** 方形勾选框(18px、圆角 5):未选中是描边空框,选中是琥珀实心 + 深色勾。 */
function CheckBox({ on }: { on: boolean }) {
	return <span className={on ? "check-box on" : "check-box"}>{on && <CheckMark />}</span>;
}

/** 勾(选中态;$bg 色,压在琥珀底上才够对比)。 */
function CheckMark() {
	return (
		<Lu icon="check" size={12} strokeWidth={2.2} />
	);
}

/** 添加行的 + 图标(设计稿是细线加号,不用全角「＋」字符)。 */
function PlusIcon() {
	return (
		<Lu icon="plus" size={13} className="notice-add-plus" />
	);
}
