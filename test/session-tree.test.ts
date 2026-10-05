/**
 * 会话分支树 / 消息版本视图单测(纯逻辑,不碰真实 provider 与磁盘)。
 *
 * 用最小内存树喂 `buildSessionTree`:只需要 getLeafId / getBranch / getTree 三个
 * 方法 —— 这正是 SessionTreeSource 存在的理由(真 SessionManager 结构上也满足)。
 *
 * 覆盖:线性会话(无版本)、编辑重发(user 版本)、重新生成(assistant 版本)、
 * 非消息兄弟不参与、多个候选叶子时的选择口径、leaf 停在非叶子节点、空会话。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager, type SessionEntry, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { buildSessionTree, type SessionTreeSource } from "../src/session-tree.ts";

interface Row {
	id: string;
	parentId: string | null;
	/** user / assistant 消息;其它类型(如 model_change)不进版本视图。 */
	role?: "user" | "assistant";
	text?: string;
}

/** 内存会话树:rows 按追加顺序,parentId 串成树;leaf 指针单独给。 */
function fakeSession(rows: Row[], leafId: string | null): SessionTreeSource {
	const entries = new Map<string, SessionEntry>();
	for (const r of rows) {
		const entry =
			r.role === undefined
				? { id: r.id, parentId: r.parentId, type: "model_change", timestamp: 0 }
				: {
						id: r.id,
						parentId: r.parentId,
						type: "message",
						timestamp: 0,
						message: { role: r.role, content: [{ type: "text", text: r.text ?? r.id }] },
					};
		entries.set(r.id, entry as unknown as SessionEntry);
	}
	const childrenOf = (parentId: string | null): SessionEntry[] =>
		[...entries.values()].filter((e) => (e.parentId ?? null) === parentId);
	const nodeOf = (entry: SessionEntry): SessionTreeNode => ({
		entry,
		children: childrenOf(entry.id).map(nodeOf),
	});
	return {
		getLeafId: () => leafId,
		getBranch: (fromId?: string) => {
			const path: SessionEntry[] = [];
			let cur = fromId !== undefined ? entries.get(fromId) : leafId !== null ? entries.get(leafId) : undefined;
			while (cur) {
				path.push(cur);
				cur = cur.parentId !== null ? entries.get(cur.parentId) : undefined;
			}
			return path.reverse();
		},
		getTree: () => childrenOf(null).map(nodeOf),
	};
}

describe("buildSessionTree", () => {
	it("空会话:空树、无版本", () => {
		const tree = buildSessionTree(fakeSession([], null));
		expect(tree).toEqual({ currentLeafId: null, branches: [], versions: {} });
	});

	it("线性会话:一条分支,摘要取路径上最后一条 user 消息,没有版本", () => {
		const tree = buildSessionTree(
			fakeSession(
				[
					{ id: "u1", parentId: null, role: "user", text: "写个开头" },
					{ id: "a1", parentId: "u1", role: "assistant", text: "雨落在瓦上" },
					{ id: "u2", parentId: "a1", role: "user", text: "再狠一点" },
					{ id: "a2", parentId: "u2", role: "assistant", text: "他踹开了门" },
				],
				"a2",
			),
		);
		expect(tree.currentLeafId).toBe("a2");
		expect(tree.branches).toEqual([
			{ leafId: "a2", isCurrent: true, count: 4, summary: "再狠一点", tail: "他踹开了门" },
		]);
		expect(tree.versions).toEqual({});
	});

	it("编辑重发:user 消息多版本,versions 只给当前路径上的那条,leaves 指向各自分支", () => {
		const rows: Row[] = [
			{ id: "u1", parentId: null, role: "user", text: "起点" },
			{ id: "a1", parentId: "u1", role: "assistant", text: "旧答" },
			// 撤回 u1 后重发:u2 与 u1 同父(根),a2 接在 u2 下
			{ id: "u2", parentId: null, role: "user", text: "新起点" },
			{ id: "a2", parentId: "u2", role: "assistant", text: "新答" },
		];
		const tree = buildSessionTree(fakeSession(rows, "a2"));
		// 当前路径 = [u2, a2]:只有 u2 需要版本视图(u1 不在界面上)
		expect(Object.keys(tree.versions)).toEqual(["u2"]);
		expect(tree.versions.u2).toEqual({ ids: ["u1", "u2"], leaves: ["a1", "a2"], index: 1 });
		expect(tree.branches.map((b) => b.leafId).sort()).toEqual(["a1", "a2"]);

		// 切到旧分支:下标翻转,leaves 不变
		const old = buildSessionTree(fakeSession(rows, "a1"));
		expect(old.versions.u1).toEqual({ ids: ["u1", "u2"], leaves: ["a1", "a2"], index: 0 });
		expect(old.versions.u2).toBeUndefined();
	});

	it("重新生成:assistant 多版本(同一 user 下的兄弟)", () => {
		const tree = buildSessionTree(
			fakeSession(
				[
					{ id: "u1", parentId: null, role: "user", text: "写一段" },
					{ id: "a1", parentId: "u1", role: "assistant", text: "第一版" },
					{ id: "a2", parentId: "u1", role: "assistant", text: "第二版" },
				],
				"a2",
			),
		);
		expect(tree.versions.a2).toEqual({ ids: ["a1", "a2"], leaves: ["a1", "a2"], index: 1 });
	});

	it("非消息兄弟(模型切换等)不参与版本;单条消息也不生成版本", () => {
		const tree = buildSessionTree(
			fakeSession(
				[
					{ id: "m1", parentId: null },
					{ id: "u1", parentId: "m1", role: "user", text: "唯一提问" },
					{ id: "a1", parentId: "u1", role: "assistant", text: "唯一回答" },
				],
				"a1",
			),
		);
		expect(tree.versions).toEqual({});
	});

	it("版本落在多条候选分支上时,选离当前位置最近的那条(先比公共后缀)", () => {
		// u1 → a1 → u2 ─┬─ a2        (leaf L1)
		//                └─ a2b       (leaf L2b)
		// u2 还有个兄弟 u2b(编辑重发),挂在 a1 下:
		// u1 → a1 → u2b → a2c          (leaf L2)
		const rows: Row[] = [
			{ id: "u1", parentId: null, role: "user", text: "开头" },
			{ id: "a1", parentId: "u1", role: "assistant", text: "第一答" },
			{ id: "u2", parentId: "a1", role: "user", text: "追问(原)" },
			{ id: "a2", parentId: "u2", role: "assistant", text: "答 A" },
			{ id: "a2b", parentId: "u2", role: "assistant", text: "答 B" },
			{ id: "u2b", parentId: "a1", role: "user", text: "追问(改)" },
			{ id: "a2c", parentId: "u2b", role: "assistant", text: "答 C" },
		];
		// 当前停在 a2b(L2b):u2 的版本里,「原追问」自己就在当前分支上 —— 切回它应留在 L2b,
		// 而不是跳到 L1(同样的 u2,但后缀完全不同)
		const tree = buildSessionTree(fakeSession(rows, "a2b"));
		expect(tree.versions.u2).toEqual({ ids: ["u2", "u2b"], leaves: ["a2b", "a2c"], index: 0 });
		expect(tree.versions.u2b).toBeUndefined(); // u2b 不在当前路径上

		// 停在 a2c(L2)时:「原追问 u2」有两个候选叶子(L1 / L2b),两者与当前路径的公共
		// 后缀都是 0、路径也一样长 —— 同分时取候选顺序里更早的那条(会话文件里更早的分支)
		const other = buildSessionTree(fakeSession(rows, "a2c"));
		expect(other.versions.u2b).toEqual({ ids: ["u2", "u2b"], leaves: ["a2", "a2c"], index: 1 });
	});

	it("leaf 停在非叶子节点(branch 之后):该节点也是候选终点并标记当前", () => {
		const rows: Row[] = [
			{ id: "u1", parentId: null, role: "user", text: "开头" },
			{ id: "a1", parentId: "u1", role: "assistant", text: "旧答" },
			{ id: "u2", parentId: "a1", role: "user", text: "改过的追问" },
			{ id: "a2", parentId: "u2", role: "assistant", text: "答" },
		];
		const tree = buildSessionTree(fakeSession(rows, "u2")); // branch 后 leaf 停在 u2
		expect(tree.currentLeafId).toBe("u2");
		expect(tree.branches.map((b) => [b.leafId, b.isCurrent])).toEqual([
			["a2", false],
			["u2", true],
		]);
		expect(Object.keys(tree.versions)).toEqual([]);
	});
});

describe("真实会话文件(SessionManager.open)", () => {
	/**
	 * 磁盘恢复路径(服务重启后 writer-host.readSessionFromDisk)看到的是一份真
	 * jsonl:header + model_change/thinking_level_change 夹在消息之间。这里钉住
	 * 「编辑重发产生的两个 user 兄弟在真实解析下确实互为版本」—— fake 树测不到
	 * 文件格式这一层。
	 */
	it("编辑重发落盘后,磁盘解析同样给出 user 版本视图", () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-tree-"));
		try {
			const at = (ms: number) => new Date(1700000000000 + ms).toISOString();
			const lines = [
				{ type: "session", version: 3, id: "s1", timestamp: at(0), cwd: dir },
				{ type: "model_change", id: "m1", parentId: null, timestamp: at(1), provider: "deepseek", modelId: "deepseek-flash" },
				{
					type: "message",
					id: "u1",
					parentId: "m1",
					timestamp: at(2),
					message: { role: "user", content: [{ type: "text", text: "原来的开头" }], timestamp: 1700000000002 },
				},
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: at(3),
					message: { role: "assistant", content: [{ type: "text", text: "原来的回复" }], timestamp: 1700000000003 },
				},
				// 编辑重发:新 user 与旧 user 同父(m1)
				{
					type: "message",
					id: "u2",
					parentId: "m1",
					timestamp: at(4),
					message: { role: "user", content: [{ type: "text", text: "改过的开头" }], timestamp: 1700000000004 },
				},
				{
					type: "message",
					id: "a2",
					parentId: "u2",
					timestamp: at(5),
					message: { role: "assistant", content: [{ type: "text", text: "改过的回复" }], timestamp: 1700000000005 },
				},
			];
			const abs = join(dir, "writer-ch01.jsonl");
			writeFileSync(abs, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

			const sm = SessionManager.open(abs, dir, dir);
			const tree = buildSessionTree(sm);
			expect(tree.currentLeafId).toBe("a2");
			expect(tree.versions.u1).toBeUndefined(); // u1 不在当前路径上
			expect(tree.versions.u2).toEqual({ ids: ["u1", "u2"], leaves: ["a1", "a2"], index: 1 });
			expect(tree.branches.map((b) => [b.leafId, b.isCurrent, b.count])).toEqual([
				["a1", false, 2],
				["a2", true, 2],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
