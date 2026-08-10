import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "../../vendor/pi-ai/src/index.ts";
import { type StageEntry } from "./types.ts";

export const STAGE_DIR = "stage";

export function stagePath(bookDir: string, sceneId: string): string {
	return join(bookDir, STAGE_DIR, `${sceneId}.jsonl`);
}

export function makeStageEntry(
	sceneId: string,
	turn: number,
	actor: string,
	character: string,
	text: string,
	ts = Date.now(),
): StageEntry {
	return {
		id: uuidv7(),
		scene: sceneId,
		turn,
		actor,
		character,
		content: [{ type: "text", text }],
		ts,
	};
}

/** 追加一条舞台记录（追加式：历史行绝不动）。 */
export async function appendStageEntry(bookDir: string, entry: StageEntry): Promise<void> {
	const file = stagePath(bookDir, entry.scene);
	await mkdir(join(bookDir, STAGE_DIR), { recursive: true });
	await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** 读取整幕转录；坏行跳过（防御）。 */
export async function readStage(bookDir: string, sceneId: string): Promise<StageEntry[]> {
	const file = stagePath(bookDir, sceneId);
	if (!existsSync(file)) return [];
	const raw = await readFile(file, "utf8");
	const entries: StageEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line) as StageEntry);
		} catch {
			// 坏行跳过——追加式转录不容许改写历史，只能容忍脏行。
		}
	}
	return entries;
}

/** 取舞台最近 n 条（演员场景局部切片）。 */
export function lastStage(entries: StageEntry[], n: number): StageEntry[] {
	return n <= 0 ? [] : entries.slice(-n);
}

/**
 * 截断舞台转录到前 keepCount 条（精准重演的唯一允许改历史操作——
 * 追加式纪律的显式例外：重演 = 修正历史，见设计文档 §10.5）。
 */
export async function truncateStage(bookDir: string, sceneId: string, keepCount: number): Promise<void> {
	const entries = await readStage(bookDir, sceneId);
	const kept = entries.slice(0, keepCount);
	const file = stagePath(bookDir, sceneId);
	await mkdir(join(bookDir, STAGE_DIR), { recursive: true });
	await writeFile(file, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
}
