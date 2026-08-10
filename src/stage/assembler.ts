import { lastStage } from "./stage-store.ts";
import { renderTextFor } from "./script-store.ts";
import { ensureWorld, type WorldData, type WorldEntry } from "../world-data.ts";
import { type InjectRule, type SceneScript, type StageEntry, type StageStatus } from "./types.ts";
import { countStage, formatCounterBlock, type SceneCounts } from "./counters.ts";

/**
 * 按角色的消息组装器（模块化消息队列的核心）。
 *
 * 每个角色每次模型调用前的消息尾部 = 世界书注入 + 舞台切片 + 剧本文字段 + 实时计数块，
 * 按缓存纪律组装（2026-08-09）：
 *   [稳定前缀: system/世界书快照/角色卡] ← M3 扩展侧组装
 *   [世界书·你可知（导演 inject 指定，include-only）]
 *   [舞台切片（追加式，最近 N 轮）]
 *   [剧本文字段（post-history instructions，可变尾部）]
 *   [实时计数块（每轮变化，最尾）]
 *
 * 本模块是纯逻辑（字符串/条目），M3 扩展的 "context" 事件处理器负责转成 AgentMessage。
 */

/**
 * 世界书引用解析（容错，2026-08-09 定稿）：
 * 模型可能传 id、名称（title）或关键词（keys）——三级匹配，能修就修：
 *   1. entry.id 精确匹配（模型传了 c1/w1 这类 id）
 *   2. entry.title 精确匹配（传名字）
 *   3. entry.keys 关键词命中
 * 仍匹配不到才进 missing（由调用方报错并列出可用条目）。
 */
export interface WorldRefResult {
	matched: WorldEntry[];
	missing: string[];
}

export function resolveWorldRefs(world: WorldData, refs: string[]): WorldRefResult {
	const matched: WorldEntry[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const byId = world.entries.find((e) => e.id === ref);
		const candidates = byId
			? [byId]
			: world.entries.filter((e) => e.title === ref || e.keys.includes(ref));
		if (candidates.length > 0) {
			for (const entry of candidates) {
				if (!seen.has(entry.id)) {
					seen.add(entry.id);
					matched.push(entry);
				}
			}
		} else {
			missing.push(ref);
		}
	}
	return { matched, missing };
}

/**
 * 世界书注入解析（include-only 语义，见设计文档 §5.1）：
 * 按导演 inject 规则从 world.json 拉取条目——只取 character/world 类型
 * （跳过 Notice/发展线/约束等元信息，防泄密与干扰）。
 * 返回 missing：引用未匹配/类型不可注入的清单（execute 校验据此报中文错误，
 * 导演看到"该传什么、现有条目是什么"，而不是静默缺注入）。
 */
export interface WorldInjectionResult {
	text: string | null;
	missing: string[];
}

export async function resolveWorldInjection(
	bookDir: string,
	rule: InjectRule | undefined,
	world?: WorldData,
): Promise<WorldInjectionResult | null> {
	if (!rule) return null;
	const refs = [...(rule.characters ?? []), ...(rule.world ?? [])];
	if (refs.length === 0) return null;
	const resolved = world ?? (await ensureWorld(bookDir));
	const { matched, missing } = resolveWorldRefs(resolved, refs);
	// 类型过滤：只注入 character/world；引用到 timeline/outline 等 → 归入 missing 提示
	const usable = matched.filter((e) => e.type === "character" || e.type === "world");
	const unusable = matched.filter((e) => e.type !== "character" && e.type !== "world");
	const allMissing = [
		...missing,
		...unusable.map((e) => `${e.title}（${e.type} 类型不可注入，仅 character/world 可注入）`),
	];
	if (usable.length === 0) return { text: null, missing: allMissing };
	const lines = usable.map((entry) => `【${entry.type === "character" ? "角色" : "世界"}·${entry.title}】${entry.body}`);
	return { text: lines.join("\n"), missing: allMissing };
}

export interface ActorContextBlocks {
	/** 世界书注入块（导演 inject 指定；无注入为 null）。 */
	worldBlock: string | null;
	/** 舞台切片（最近 sliceMax 轮，追加式）。 */
	slice: StageEntry[];
	/** 该演员的演出指令（shared + perActor 定向块，字段级合并）。 */
	scriptLines: string[];
	/** 场务信息块（实时计数 + 收尾提示，永远最尾）。 */
	counterBlock: string;
}

export interface ActorContextOptions {
	/** 舞台切片上限（默认 12 条；缓存纪律要求切片上界固定）。 */
	sliceMax?: number;
	/** 收尾提示的剩余条数（用户 /wrap N 覆盖剧本 wrapUpWindow）。 */
	wrapRemaining?: number;
	/** 世界书注入文本（由编排器先 resolveWorldInjection）。 */
	worldInjection?: string | null;
}

/** 把舞台条目渲染成对话行（供切片消息与 CLI 回显）。叙述者行带括号以示舞台指示。 */
export function formatStageLines(entries: StageEntry[]): string[] {
	return entries.map((entry) => {
		const text = entry.content.map((b) => b.text).join("");
		if (entry.character === "叙述者") {
			return `（${text}）`;
		}
		return `${entry.character}: ${text}`;
	});
}

/** 组装某演员本次调用的上下文尾部块。 */
export function buildActorContextBlocks(
	script: SceneScript,
	entries: StageEntry[],
	actorId: string,
	status: StageStatus,
	options: ActorContextOptions = {},
): ActorContextBlocks {
	const sliceMax = options.sliceMax ?? 12;
	const slice = lastStage(entries, sliceMax);
	const scriptLines = renderTextFor(script, actorId);
	const counts: SceneCounts = countStage(entries);
	const counterBlock = formatCounterBlock(counts, actorId, status, script.definition.rules, options.wrapRemaining);
	return {
		worldBlock: options.worldInjection ?? null,
		slice,
		scriptLines,
		counterBlock,
	};
}
