import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ActorSpec, type CastConfig, type SceneScript } from "./types.ts";

export const CAST_FILE = "cast.json";

function isActorSpec(value: unknown): value is ActorSpec {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0) return false;
	if (v.type !== "named" && v.type !== "pool" && v.type !== "narrator") return false;
	if (v.character !== undefined && typeof v.character !== "string") return false;
	if (v.model !== undefined && typeof v.model !== "string") return false;
	if (v.thinking !== undefined && typeof v.thinking !== "string") return false;
	if (v.temperature !== undefined && (typeof v.temperature !== "number" || Number.isNaN(v.temperature))) return false;
	if (v.topP !== undefined && (typeof v.topP !== "number" || Number.isNaN(v.topP))) return false;
	return true;
}

/** 防御性清洗：字段缺失时补默认值，坏条目丢弃。 */
function sanitizeCast(raw: unknown): CastConfig {
	const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const version = typeof obj.version === "number" ? obj.version : 1;
	const actors = Array.isArray(obj.actors) ? obj.actors.filter(isActorSpec) : [];
	return { version, actors };
}

/** 读取演员池编制；cast.json 不存在时返回空池。 */
export async function loadCast(bookDir: string): Promise<CastConfig> {
	const file = join(bookDir, CAST_FILE);
	if (!existsSync(file)) return { version: 1, actors: [] };
	const raw = await readFile(file, "utf8");
	return sanitizeCast(JSON.parse(raw));
}

/** 写回演员池编制（自动建目录）。 */
export async function saveCast(bookDir: string, cast: CastConfig): Promise<void> {
	await mkdir(bookDir, { recursive: true });
	await writeFile(join(bookDir, CAST_FILE), JSON.stringify(cast, null, 2), "utf8");
}

/** 编制校验：返回错误列表（空 = 合法）。 */
export function validateCast(cast: CastConfig): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const actor of cast.actors) {
		if (seen.has(actor.id)) errors.push(`演员 id 重复：${actor.id}`);
		seen.add(actor.id);
		if (actor.type === "named" && !actor.character) {
			errors.push(`named 演员 ${actor.id} 缺少 character`);
		}
		if (actor.type === "pool" && actor.character) {
			errors.push(`pool 演员 ${actor.id} 不应绑定 character（群演按幕注入）`);
		}
		if (actor.temperature !== undefined && (actor.temperature < 0 || actor.temperature > 2)) {
			errors.push(`演员 ${actor.id} 的 temperature 必须在 0..2 之间`);
		}
		if (actor.topP !== undefined && (actor.topP < 0 || actor.topP > 1)) {
			errors.push(`演员 ${actor.id} 的 topP 必须在 0..1 之间`);
		}
	}
	return errors;
}

/**
 * 选角校验：剧本定义段的选角表必须满足——
 * 1. 引用的 actor 都在编制内；
 * 2. 一幕内一个演员只演一个角色（值数组长度为 1）；
 * 3. 同场角色必须由不同演员饰演（角色名不重复）。
 */
export function validateSceneCast(script: SceneScript, cast: CastConfig): string[] {
	const errors: string[] = [];
	const ids = new Set(cast.actors.map((a) => a.id));
	const castTable = script.definition.cast;
	for (const [actorId, characters] of Object.entries(castTable)) {
		if (!ids.has(actorId)) {
			errors.push(`选角引用了编制外的演员：${actorId}`);
			continue;
		}
		if (!Array.isArray(characters) || characters.length === 0) {
			errors.push(`演员 ${actorId} 未被分配角色`);
		} else if (characters.length > 1) {
			errors.push(`演员 ${actorId} 一幕内被分配了多个角色：${characters.join("、")}`);
		}
	}
	const allCharacters = new Set<string>();
	for (const characters of Object.values(castTable)) {
		for (const c of characters) {
			if (allCharacters.has(c)) {
				errors.push(`同场角色重复饰演：${c}`);
			}
			allCharacters.add(c);
		}
	}
	return errors;
}
