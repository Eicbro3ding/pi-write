/**
 * 锚输入的冻结缓存(2026-10-13,Phase 1「冻结快照」)。
 *
 * 记忆锚每轮由 `buildMemoryAnchor` 现读现拼(memory.md + 全局 user.md +
 * world.json 约束 + 设置),而这些输入在一章的绝大多数轮次里都不变 —— 每轮重读
 * 重解析是纯浪费,且给「systemPrompt 字节稳定 → 前缀缓存命中」添了不确定性。
 *
 * 本缓存按 `(bookDir, 口径)` 记住上一次的输入,用**依赖文件的 mtime** 做失效判据
 * (与 `src/web/server.ts` 的 `worldPackStale`「背景包陈旧重注」同一套思路):
 * 任一依赖被改写(用户界面改设定、AI 调 `world_update`、memory 工具写记忆/画像、
 * 改记忆预算),mtime 就变,下次调用自动重建。
 *
 * 缓存**不改语义**:命中与重建产出的锚文本逐字相同(见 `test/anchor-cache.test.ts`
 * 的反证)。它省的是 IO 与解析,不是内容。`mode` / `chapter` **不进缓存** —— 它们
 * 很便宜,且 mode 由当前 prompt 判定(见 `detectSessionMode`),本就该每轮现算。
 */
import { stat } from "node:fs/promises";

/** 锚的稳定输入(mode / chapter 不在内)。 */
export interface AnchorInputs {
	readonly memory: string;
	/** 全局作者画像(user.md);空串 = 无该块。 */
	readonly user: string;
	readonly constraints: readonly { readonly name: string; readonly text: string }[];
}

interface Entry {
	readonly inputs: AnchorInputs;
	/** 各依赖文件的 mtime,顺序与调用方传入的 dependencyPaths 一致。 */
	readonly deps: readonly number[];
}

const cache = new Map<string, Entry>();

async function mtimeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return -1; // 不存在:创建后 mtime 必变,自然失效
	}
}

/** 清空缓存(测试 / 强制重建用)。给了前缀(如某本书的 bookDir)只清匹配项。 */
export function invalidateAnchorInputs(prefix?: string): void {
	if (prefix === undefined) {
		cache.clear();
		return;
	}
	for (const key of [...cache.keys()]) {
		if (key.startsWith(prefix)) cache.delete(key);
	}
}

/**
 * 取锚的稳定输入;依赖文件 mtime 全部不变时直接返回缓存,跳过 `load`。
 *
 * `cacheKey` 需在同一本书内区分口径(是否带约束 + 角色集合)—— 主对话与编剧拿到
 * 的约束集不同,不能共用同一份缓存。
 */
export async function cachedAnchorInputs(
	cacheKey: string,
	dependencyPaths: readonly string[],
	load: () => Promise<AnchorInputs>,
): Promise<AnchorInputs> {
	const before = await Promise.all(dependencyPaths.map(mtimeOf));
	const hit = cache.get(cacheKey);
	if (hit && hit.deps.length === before.length && hit.deps.every((m, i) => m === before[i])) {
		return hit.inputs;
	}

	const inputs = await load();
	// load 可能创建文件(world.json / 目录),故签名在 load 之后重取一次 —— 这样下次
	// 调用能直接命中,而不是因为「首次不存在 → -1」白重建一轮。
	const after = await Promise.all(dependencyPaths.map(mtimeOf));
	cache.set(cacheKey, { inputs, deps: after });
	return inputs;
}
