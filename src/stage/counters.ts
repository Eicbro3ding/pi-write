import { type SceneRules, type StageEntry, type StageStatus } from "./types.ts";
import { cjkCount } from "../cjk.ts";

/**
 * 实时计数器——纯确定性计算(零模型调用),由编排器从舞台转录直接统计。
 * 计数块注入演员上下文最尾部(缓存纪律:每轮只失效尾部短段)。
 * CJK 字数与 tools.ts word_count 口径一致(统一在 cjk.ts)。
 */

export interface SceneCounts {
	/** 对话总条数（舞台条目数）。 */
	lines: number;
	/** 当前轮次（最后一条的 turn；空幕为 0）。 */
	turn: number;
	/** 各演员条数。 */
	perActor: Record<string, number>;
	/** 各角色条数。 */
	perCharacter: Record<string, number>;
	/** 全幕 CJK 字数。 */
	cnChars: number;
}

/** 统计整幕舞台转录。 */
export function countStage(entries: StageEntry[]): SceneCounts {
	const perActor: Record<string, number> = {};
	const perCharacter: Record<string, number> = {};
	let cnChars = 0;
	let turn = 0;
	for (const entry of entries) {
		perActor[entry.actor] = (perActor[entry.actor] ?? 0) + 1;
		perCharacter[entry.character] = (perCharacter[entry.character] ?? 0) + 1;
		for (const block of entry.content) cnChars += cjkCount(block.text);
		if (entry.turn > turn) turn = entry.turn;
	}
	return { lines: entries.length, turn, perActor, perCharacter, cnChars };
}

/**
 * 渲染场务信息块（注入演员上下文最尾部）。
 * 明确的戏外标记：演员不可在演出中提及此信息。
 */
export function formatCounterBlock(
	counts: SceneCounts,
	actorId: string,
	status: StageStatus,
	rules: SceneRules,
	wrapRemaining?: number,
): string {
	const selfLines = counts.perActor[actorId] ?? 0;
	const head = `【场务·演员不可在演出中提及此信息】`;
	const progress = `场景进度：对话 ${counts.lines} 条（下限 ${rules.minLines}，上限 ${rules.maxLines}）；本演员 ${selfLines} 条`;
	let state: string;
	if (status === "wrapping") {
		const remaining = wrapRemaining ?? rules.wrapUpWindow;
		state = `状态：提示收尾（用户示意，剩余约 ${remaining} 条后自然收束本场）`;
	} else {
		state = `状态：正常轮转`;
	}
	return [head, progress, state].join("\n");
}
