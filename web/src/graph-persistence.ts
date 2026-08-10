/**
 * 关系图布局/视口持久化 —— 从 RelationGraph.tsx 抽出的纯逻辑。
 * 节点位置与视口(缩放/平移)按书 slug 隔离存 localStorage,
 * 视图状态不入 world.json;全部读写容错(损坏/配额满静默降级)。
 */
import type { Core } from "cytoscape";

/** 布局持久化 key(按书隔离)。 */
function layoutKey(slug: string): string {
	return `pi-writer:graph-layout:${slug}`;
}

/** 视口(缩放/平移)持久化 key(按书隔离,视图状态不入 world.json)。 */
function viewportKey(slug: string): string {
	return `pi-writer:graph-viewport:${slug}`;
}

/** 从 localStorage 读取节点位置;无/损坏返回 null。坐标必须为有限数字,非法条目丢弃。 */
export function loadPositions(slug: string): Record<string, { x: number; y: number }> | null {
	try {
		const raw = localStorage.getItem(layoutKey(slug));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const out: Record<string, { x: number; y: number }> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			const p = v as { x?: unknown; y?: unknown } | null;
			if (typeof p !== "object" || p === null) continue;
			if (typeof p.x === "number" && Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y)) {
				out[k] = { x: p.x, y: p.y };
			}
		}
		return out;
	} catch {
		return null;
	}
}

/** 读取按书持久化的视口(缩放/平移);无/损坏返回 null。 */
export function loadViewport(slug: string): { zoom: number; pan: { x: number; y: number } } | null {
	try {
		const raw = localStorage.getItem(viewportKey(slug));
		if (!raw) return null;
		const v = JSON.parse(raw) as unknown;
		if (typeof v !== "object" || v === null) return null;
		const { zoom, pan } = v as { zoom?: unknown; pan?: unknown };
		if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
		const p = pan as { x?: unknown; y?: unknown } | null;
		if (typeof p !== "object" || p === null) return null;
		if (typeof p.x !== "number" || !Number.isFinite(p.x) || typeof p.y !== "number" || !Number.isFinite(p.y)) {
			return null;
		}
		return { zoom, pan: { x: p.x, y: p.y } };
	} catch {
		return null;
	}
}

/** 保存按书视口(缩放/平移);非有限值丢弃,容错失败忽略。 */
export function saveViewport(slug: string, zoom: number, pan: { x: number; y: number }): void {
	if (!Number.isFinite(zoom) || !Number.isFinite(pan.x) || !Number.isFinite(pan.y)) return;
	try {
		localStorage.setItem(viewportKey(slug), JSON.stringify({ zoom, pan }));
	} catch {
		/* 视口持久化失败不影响使用 */
	}
}

/** 保存全部节点位置到 localStorage(容错:不可用/配额满忽略)。 */
export function savePositions(cy: Core, slug: string): void {
	const pos: Record<string, { x: number; y: number }> = {};
	for (const n of cy.nodes()) {
		const p = n.position();
		pos[n.id()] = { x: Math.round(p.x), y: Math.round(p.y) };
	}
	try {
		localStorage.setItem(layoutKey(slug), JSON.stringify(pos));
	} catch {
		/* 位置持久化失败不影响使用 */
	}
}
