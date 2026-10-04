/**
 * 会话分支树 + 消息版本视图 —— web 侧分支 UI 的数据构造**唯一实现**。
 *
 * 两个消费点(常驻编剧 SessionHost.getSessionTree、服务重启后从磁盘恢复的
 * writer-host.readSessionFromDisk)此前各写一份「叶子遍历 + 分支摘要」的 walk,
 * 2026-10 收敛到这里;顺带给出**每条消息的版本(同位置兄弟变体)** —— 对话流里
 * 「‹ 2/2 ›」就地切换的数据来源(微信多版本消息那一套)。
 *
 * 版本语义(与界面一致):
 * - 一个「位置」= 同一父 entry 下的同角色消息。编辑重发产生新的 user 兄弟、
 *   重新生成产生新的 assistant 兄弟,它们就是同一条消息的多个版本。
 * - `ids` 按会话文件追加顺序(旧 → 新);`index` 指向当前分支上的那个版本。
 * - `leaves[i]` = 切到第 i 个版本时要 navigate 到的分支终点。同一版本可能落在
 *   多条候选分支上(它下面还有分叉),取「离当前位置最近」的一条:先比与当前路径
 *   的公共后缀长度,再比路径长度 —— 这样切版本时对话尽量停在原处,而不是跳到
 *   另一条分支的尾巴上。
 * - 只给**当前分支路径上**的消息建版本(界面只渲染这条路径)。
 *
 * 版本地图的键是「可见消息的首个 entry id」:user 消息就是它自己;assistant 气泡
 * 是一组多段输出(思考 / 工具 / 正文)的首段 entry(见 extractMessagesFromManager
 * 的 firstEntryId)—— 组内后续段不是这个位置的代表。
 */
import type { SessionEntry, SessionTreeNode } from "./pi-adapter/index.ts";
import { chatTextOfMessage } from "./session-text.ts";

/** 一条候选分支的概览(分支栏的数据;字段与前端 SessionBranchInfo 对齐)。 */
export interface SessionBranchInfo {
	leafId: string;
	isCurrent: boolean;
	/** 该分支路径上的消息数。 */
	count: number;
	/** 分支起点摘要:路径上最后一条 user 消息,前 24 字。 */
	summary: string;
	/** 分支结尾摘要:最后一条消息,前 24 字。 */
	tail: string;
}

/** 一条消息的版本视图(前端「‹ 2/2 ›」用;键 = 可见消息的首个 entry id)。 */
export interface SessionVersionInfo {
	/** 全部版本(entry id),按追加顺序:第 1 个是最早的(通常是原文)。 */
	ids: string[];
	/** 与 `ids` 一一对应的分支终点(navigate 目标)。 */
	leaves: string[];
	/** 当前分支上的版本下标(0 起)。 */
	index: number;
}

/** 分支树完整视图。 */
export interface SessionTreeInfo {
	currentLeafId: string | null;
	branches: SessionBranchInfo[];
	/** entry id → 版本视图;只有 ≥2 个版本的消息才出现。 */
	versions: Record<string, SessionVersionInfo>;
}

/**
 * 只读的会话树来源。取结构类型而不是直接依赖 SessionManager 类:
 * 磁盘只读恢复路径手里拿的确实是 SessionManager,而单测给一份最小内存实现即可
 * (无需真的落一个 jsonl 文件)。
 *
 * 2026-10-04(T7 批 2):本接口的方法名与 pi-adapter 的 `SessionReader` **一致**
 * (getLeafId / getBranch / getTree),但不做 `extends` —— 因为这里要的是
 * **精确类型**(`SessionEntry[]` / `SessionTreeNode[]`),而 adapter 那层刻意
 * 只承诺 `unknown[]`(它不该假装知道 entry 的形状,见该处注释)。
 *
 * 两者的关系是:**adapter 的 `SessionReader` 是最小契约,本接口是它的精确版本**。
 * 调用点若手里是 adapter 的读取器,需要显式断言一次 —— 那一处断言就是
 * 「我知道这里要的是精确形状」的表达。
 */
export interface SessionTreeSource {
	getLeafId(): string | null;
	getBranch(fromId?: string): SessionEntry[];
	getTree(): SessionTreeNode[];
}

/** 根节点的兄弟键(parentId 为 null 的条目归到同一个位置)。 */
const ROOT_KEY = "\u0000root";

/** 消息角色(只有 user / assistant 参与版本,工具结果、压缩记录等一律不参与)。 */
function messageRole(entry: SessionEntry): "user" | "assistant" | null {
	if (entry.type !== "message") return null;
	const role = (entry as { message?: { role?: unknown } }).message?.role;
	return role === "user" || role === "assistant" ? role : null;
}

/** 构造分支树 + 版本视图(纯函数:只读传进来的树,不落盘、不改 leaf)。 */
export function buildSessionTree(sm: SessionTreeSource): SessionTreeInfo {
	const roots = sm.getTree();
	const currentLeafId = sm.getLeafId();

	// 1) 候选分支终点 = 全部树叶子 ∪ 当前 leaf 指针(branch 后 leaf 可能停在非叶子
	//    节点上,该节点的子树仍在树里 —— 它也是合法的分支终点)
	const leaves: string[] = [];
	const collect = (nodes: readonly SessionTreeNode[]): void => {
		for (const n of nodes) {
			if (n.children.length === 0) leaves.push(n.entry.id);
			else collect(n.children);
		}
	};
	collect(roots);
	const candidates = new Set<string>(leaves);
	if (currentLeafId) candidates.add(currentLeafId);
	const candidateList = [...candidates];

	/** 每个候选分支的完整路径(entry id 序列);下标与 candidateList 对齐。 */
	const paths = candidateList.map((leafId) => sm.getBranch(leafId));
	/** entry id → 含它的候选分支下标(按 candidateList 顺序)。 */
	const leavesWith = new Map<string, number[]>();
	paths.forEach((path, i) => {
		for (const e of path) {
			const list = leavesWith.get(e.id);
			if (list) list.push(i);
			else leavesWith.set(e.id, [i]);
		}
	});

	const currentIdx = currentLeafId ? candidateList.indexOf(currentLeafId) : -1;
	const currentPath: SessionEntry[] = currentIdx >= 0 ? paths[currentIdx]! : [];

	// 2) 分支概览(摘要口径与收敛前逐字一致:起点取路径上最后一条 user 消息)
	const branches: SessionBranchInfo[] = candidateList.map((leafId, i) => {
		const texts: string[] = [];
		let summary = "";
		for (const e of paths[i]!) {
			const msg = (e as { message?: { role?: string; content?: unknown } }).message;
			if (messageRole(e) === null) continue;
			const text = msg ? chatTextOfMessage(msg) : undefined;
			if (!text) continue;
			if (msg?.role === "user") summary = text;
			texts.push(text);
		}
		return {
			leafId,
			isCurrent: leafId === currentLeafId,
			count: texts.length,
			summary: summary.slice(0, 24) || "开始",
			tail: (texts[texts.length - 1] ?? "").slice(0, 24),
		};
	});

	// 3) 位置分组:同一父 entry 下的同角色消息互为版本
	const byParent = new Map<string, SessionEntry[]>();
	const group = (nodes: readonly SessionTreeNode[]): void => {
		for (const n of nodes) {
			const role = messageRole(n.entry);
			if (role !== null) {
				const key = n.entry.parentId ?? ROOT_KEY;
				const list = byParent.get(key);
				if (list) list.push(n.entry);
				else byParent.set(key, [n.entry]);
			}
			group(n.children);
		}
	};
	group(roots);

	/** 切到某版本时最该去的分支终点(见文件头「离当前位置最近」口径)。 */
	const targetLeaf = (entryId: string): string => {
		const idxs = leavesWith.get(entryId);
		if (!idxs || idxs.length === 0) return entryId; // 兜底:结点自己就是终点
		let best = candidateList[idxs[0]!]!;
		let bestSuffix = -1;
		let bestLen = -1;
		for (const i of idxs) {
			const leafId = candidateList[i]!;
			const path = paths[i]!;
			let suffix = 0;
			// 与当前路径的公共后缀长度(从尾往前比)
			while (
				suffix < path.length &&
				suffix < currentPath.length &&
				path[path.length - 1 - suffix]!.id === currentPath[currentPath.length - 1 - suffix]!.id
			) {
				suffix++;
			}
			if (suffix > bestSuffix || (suffix === bestSuffix && path.length > bestLen)) {
				best = leafId;
				bestSuffix = suffix;
				bestLen = path.length;
			}
		}
		return best;
	};

	const versions: Record<string, SessionVersionInfo> = {};
	for (const entry of currentPath) {
		const role = messageRole(entry);
		if (role === null) continue;
		const siblings = (byParent.get(entry.parentId ?? ROOT_KEY) ?? []).filter((e) => messageRole(e) === role);
		if (siblings.length < 2) continue;
		const ids = siblings.map((e) => e.id);
		versions[entry.id] = {
			ids,
			leaves: ids.map(targetLeaf),
			index: Math.max(0, ids.indexOf(entry.id)),
		};
	}

	return { currentLeafId, branches, versions };
}
