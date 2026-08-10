/**
 * 多窗口同步订阅 hook —— 原 DraftWorkspace / FullScreenEditor / WorldPage
 * 三处各自实现「draft_changed / world_changed 事件 → 跳过自己回显 → 脏则
 * 提示冲突 / 干净则重载」的收敛(2026-08-10)。
 *
 * 语义约定(与旧实现逐项对齐):
 * - 事件类型与携带标识不匹配(matches 为 false)→ 忽略;
 * - 自己保存后 ECHO_WINDOW_MS 内到达的同目标事件 → 视为自己的保存回显,忽略;
 * - 本窗口 busy(保存中/加载中)→ 跳过(保存完成后自然收敛);
 * - 本窗口 dirty(有未保存修改)→ onConflict(提示,不重载,避免覆盖本地编辑);
 * - 干净 → onReload(与其他窗口收敛)。
 *
 * 回调全部经 ref 读取最新渲染闭包(订阅只注册一次),调用方需保证
 * matches/state 内部读取 ref 化的当前值(如 fileRef.current / slugRef.current)。
 */
import { useEffect, useRef } from "react";
import type { ApiClient } from "./api/client.ts";
import type { AgentEventDto } from "./types.ts";

/** 自己保存回显窗口(ms):窗口内到达的同目标事件视为自己的保存广播,跳过。 */
const ECHO_WINDOW_MS = 1000;

/** 事件参数化所需的窄化类型:draft_changed / world_changed 的联合。 */
export type CrossWindowEvent = Extract<AgentEventDto, { type: "draft_changed" } | { type: "world_changed" }>;

/** 本窗口对该目标的编辑状态。 */
export type CrossWindowState = "busy" | "dirty" | "clean";

export function useCrossWindowReload<E extends CrossWindowEvent["type"]>(args: {
	client: ApiClient;
	/** 订阅的事件类型:draft_changed(草稿文件)或 world_changed(世界书)。 */
	eventType: E;
	/** 事件携带标识与当前目标匹配(调用方比较 file/slug 与当前值,读 ref);e 已随 eventType 收窄。 */
	matches: (e: Extract<CrossWindowEvent, { type: E }>) => boolean;
	/** 本窗口对该目标的编辑状态(读 ref 的最新值)。 */
	state: () => CrossWindowState;
	/** dirty 时调用(冲突提示,不重载)。 */
	onConflict: () => void;
	/** 干净时调用(重载收敛)。 */
	onReload: () => void;
}): () => void {
	const { client, eventType } = args;
	/** 回调最新引用(订阅只注册一次,闭包必须取最新渲染版本)。 */
	const cbRef = useRef(args);
	cbRef.current = args;
	/** 最近一次保存成功的时间戳:窗口内到达的同目标事件视为自己的回显,跳过。 */
	const lastSavedAtRef = useRef(0);

	useEffect(() => {
		const unsub = client.subscribeEvents((e) => {
			if (e.type !== eventType) return;
			const { matches, state, onConflict, onReload } = cbRef.current;
			if (!matches(e as Extract<CrossWindowEvent, { type: E }>)) return;
			if (Date.now() - lastSavedAtRef.current < ECHO_WINDOW_MS) return; // 自己的保存回显
			const s = state();
			if (s === "busy") return; // 保存中/加载中:保存完成后自然收敛
			if (s === "dirty") {
				onConflict();
				return;
			}
			onReload();
		});
		return unsub;
	}, [client, eventType]);

	/** 保存成功后调用:记录时间戳,窗口内到达的同目标事件跳过。 */
	return () => {
		lastSavedAtRef.current = Date.now();
	};
}
