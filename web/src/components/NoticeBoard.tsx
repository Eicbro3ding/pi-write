/**
 * 备忘录板(Notice 待办清单)——AI 伙伴栏「备忘录」标签的内容(2026-08-12 回到初衷):
 * Notice 是全局备忘录/待办:AI 埋伏笔、记重要事项写成待办(未完成项会注入所有
 * agent 的上下文),用户在板子上勾选完成/编辑/删除。数据存 world.json 的
 * notice.items,800ms 防抖整体 putWorld 保存(与 WorldPage 同款)。
 *
 * 取舍:不做多窗口冲突检测(useCrossWindowReload 的脏检测)——板子是轻量辅助,
 * 多窗口同时编辑备忘录罕见,刷新即与服务端收敛。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError } from "../api/client.ts";
import type { WorldDataDto } from "../types.ts";
import { newId } from "./id.ts";

interface NoticeBoardProps {
	/** 共享 API 客户端(App 注入,与其余组件同单例;不再自建实例)。 */
	client: ApiClient;
	/** 当前打开的书 slug;null = 未打开书。 */
	slug: string | null;
}

const SAVE_DELAY_MS = 800;

/** 侧栏备忘录板:待办清单(勾选/编辑/删除/添加)+ 注入开关。 */
export function NoticeBoard({ client, slug }: NoticeBoardProps) {
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

	const removeItem = (id: string) => {
		if (!world) return;
		updateNotice({ ...world.notice, items: world.notice.items.filter((it) => it.id !== id) });
	};

	if (world === null) {
		return <div className="notice-board"><div className="s-note">未打开书——备忘录随书保存,先选一本。</div></div>;
	}
	const { notice } = world;
	return (
		<div className="notice-board">
			{saveConflict && (
				<div className="notice err">
					保存失败:世界书已被其他窗口或 AI 修改,已重新加载最新版本
				</div>
			)}
			<label className="notice-enable">
				<input type="checkbox" checked={notice.enabled} onChange={(e) => updateNotice({ ...notice, enabled: e.target.checked })} />
				<span>注入全部 agent 上下文</span>
			</label>
			{notice.items.length === 0 ? (
				<div className="s-note">暂无待办——AI 埋伏笔、记重要事项时会写在这里;也可手动添加。</div>
			) : (
				notice.items.map((it) => (
					<div key={it.id} className={it.done ? "notice-item done" : "notice-item"}>
						<input type="checkbox" checked={it.done} onChange={(e) => patchItem(it.id, { done: e.target.checked })} title={it.done ? "标记未完成" : "标记完成"} />
						<input type="text" value={it.text} onChange={(e) => patchItem(it.id, { text: e.target.value })} className="notice-text" />
						<button type="button" className="notice-del" title="删除" aria-label="删除" onClick={() => removeItem(it.id)}>
							×
						</button>
					</div>
				))
			)}
			<div className="notice-add">
				<input
					type="text"
					placeholder="添加待办(埋伏笔/重要事项)…"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") addItem();
					}}
				/>
				<button type="button" onClick={addItem} disabled={draft.trim().length === 0}>
					添加
				</button>
			</div>
		</div>
	);
}
