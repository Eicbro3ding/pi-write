import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SceneScript, type ScriptPatch } from "./types.ts";

export const STAGE_DIR = "stage";

function stageDir(bookDir: string): string {
	return join(bookDir, STAGE_DIR);
}

export function scriptPath(bookDir: string, sceneId: string): string {
	return join(stageDir(bookDir), `${sceneId}.json`);
}

/** 读取剧本；不存在返回 null。 */
export async function loadScript(bookDir: string, sceneId: string): Promise<SceneScript | null> {
	const file = scriptPath(bookDir, sceneId);
	if (!existsSync(file)) return null;
	const raw = await readFile(file, "utf8");
	return JSON.parse(raw) as SceneScript;
}

/** 写回剧本（自动建目录）。 */
export async function saveScript(bookDir: string, sceneId: string, script: SceneScript): Promise<void> {
	await mkdir(stageDir(bookDir), { recursive: true });
	await writeFile(scriptPath(bookDir, sceneId), JSON.stringify(script, null, 2), "utf8");
}

/** 列出书内全部剧本文件 basename（不含扩展名）。 */
export async function listScripts(bookDir: string): Promise<string[]> {
	const dir = stageDir(bookDir);
	if (!existsSync(dir)) return [];
	const files = await readdir(dir);
	return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
}

/**
 * 剧本修改（/revise 语义，纯函数）：
 * - version +1；
 * - text.shared / text.perActor 为**字段级合并**（改一处不动其余）；
 *   数组字段（beats/forbidden/examples）提供时整体替换；
 * - rules 字段合并（数值覆盖）；
 * - 上一版快照存入 previous，支持回退重演。
 */
export function reviseScript(script: SceneScript, patch: ScriptPatch): SceneScript {
	const shared = { ...script.text.shared, ...patch.text?.shared };
	const perActor = { ...script.text.perActor };
	if (patch.text?.perActor) {
		for (const [actorId, fields] of Object.entries(patch.text.perActor)) {
			perActor[actorId] = { ...perActor[actorId], ...fields };
		}
	}
	const rules = { ...script.definition.rules, ...patch.rules };
	return {
		...script,
		version: script.version + 1,
		definition: { ...script.definition, rules },
		text: { shared, perActor },
		previous: {
			version: script.version,
			text: script.text,
			rules: script.definition.rules,
			at: Date.now(),
		},
	};
}

/** 渲染某演员的演出指令（结构化字段 → 指令行）。示例对白带"禁止复述"标记。 */
export function renderTextFor(script: SceneScript, actorId: string): string[] {
	const shared = script.text.shared;
	const lines: string[] = [];
	lines.push(`【场景】${shared.setting}`);
	if (shared.goal) lines.push(`【本幕目标】${shared.goal}`);
	if (shared.beats.length > 0) {
		lines.push(`【节拍】\n${shared.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}`);
	}
	if (shared.tone) lines.push(`【基调】${shared.tone}`);
	if (shared.forbidden.length > 0) lines.push(`【禁区】${shared.forbidden.join("；")}`);
	const actor = script.text.perActor[actorId];
	if (actor) {
		if (actor.objective) lines.push(`【角色任务】${actor.objective}`);
		if (actor.state) lines.push(`【内心状态】${actor.state}`);
		if (actor.relation) lines.push(`【关系】${actor.relation}`);
		if (actor.voice) lines.push(`【说话方式】${actor.voice}`);
		if (actor.boundary) lines.push(`【演出边界】${actor.boundary}`);
		if (actor.examples.length > 0) {
			lines.push(`【风格示例·只学语气/句式/用词，禁止复述情节与具体台词】\n${actor.examples.join("\n")}`);
		}
	}
	return lines;
}
