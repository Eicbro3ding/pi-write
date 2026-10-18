/**
 * 编辑工具捕获器(共享):SSE 工具事件的 before/after 捕获与 diff 组装。
 *
 * 编剧确认卡(WritePage)与导演预览卡(StagePage)共用——两处此前各持一份
 * 相似实现(事件源不同但捕获/组装逻辑重复),2026-08-10 收敛于此。
 * 页面层只保留差异:事件接线(writer_event 内层 vs stage_tool)+ 状态容器
 * (确认卡队列 vs 单张预览卡)+ 展示形态(确认/回退 vs 只读)。
 */
import type { ApiClient } from "./api/client.ts";
import type { WorldDataDto } from "./types.ts";
import { buildDraftDiff, buildWorldDiff, classifyToolCall, classifyWorldChange, memoryTargetOf, parseToolArgs, pathFromArgs, type PreviewData } from "./preview.ts";

/** 一次编辑工具调用的捕获结果:before = 编辑前基线(回退写回用),data = diff 预览。 */
export interface CapturedEdit {
	toolCallId: string;
	kind: "draft" | "world" | "memory";
	/** 草稿文件路径(世界书/记忆为 null;记忆的展示路径在 data.path 上)。 */
	path: string | null;
	toolName: string;
	/** 记忆写入的目标(memory = 本书 memory.md,user = 全局 user.md)。 */
	memoryTarget?: "memory" | "user";
	/** 编辑前内容(草稿/记忆 string,世界书 WorldDataDto)。 */
	before: string | WorldDataDto;
	/** 组装好的预览数据(草稿 diff / 关系图 / 词条 / 记忆 diff)。 */
	data: PreviewData;
}

/**
 * 创建捕获器。slugFn 返回当前书 slug(预览数据的世界书卡片携带,供前端跳转世界书页)。
 * 幂等:同一 toolCallId 的重复 start/end(SSE 重放)只处理一次。
 */
export function createEditCapture(client: ApiClient, slugFn: () => string | null) {
	/** 待配对编辑:按 toolCallId 存(before 在 start 时抓取,可能慢于工具执行,用 promise);
	 *  slug 在 start 时捕获(发起回合的书),after 取数按它解析——工具事件经 SSE 异步
	 *  到达,await 期间若切书,slugFn() 已指向新书,用 p.slug 才能读对旧书的草稿。 */
	const pending = new Map<string, { kind: "draft" | "world" | "memory"; path: string | null; toolName: string; memoryTarget?: "memory" | "user"; before: Promise<string | WorldDataDto>; slug: string | null }>();
	/** 已处理过的 end 的 toolCallId(防 SSE 重放重复组装)。 */
	const handled = new Set<string>();
	/** 回合级预取基线:回合开始(user message_start)时抓取「编辑前」内容——
	 *  工具执行快于 SSE+fetch 时,start 的即时抓取会拿到编辑后内容(diff 为空、卡不弹),
	 *  预取规避该竞态(与主会话预览卡同一机制)。记忆两份一起预取:memory 工具
	 *  的执行同样是毫秒级,等 start 再读就已经写完了。 */
	let turnBaseline: {
		draft: Map<string, Promise<string>>;
		world: Promise<WorldDataDto> | null;
		memory: { memory: Promise<string>; user: Promise<string> } | null;
	} = {
		draft: new Map(),
		world: null,
		memory: null,
	};

	return {
		/** 回合开始预取基线(用户消息到达时调用):草稿按路径+书解析、世界书整体、
		 *  两份长期记忆(memory.md 随书,user.md 全局)。 */
		prefetchBaseline(draftPath: string | null | undefined, slug?: string | null): void {
			if (draftPath) turnBaseline.draft.set(draftPath, client.getDraft(draftPath, slug ?? undefined).then((r) => r.text));
			turnBaseline.world = client.getWorld(slug ?? undefined).then((r) => r.world);
			turnBaseline.memory = {
				memory: client.getMemory("memory", slug ?? undefined).then((r) => r.text),
				user: client.getMemory("user").then((r) => r.text),
			};
		},

		/** 工具 start:命中编辑类工具(write/edit 写 draft·world.json、world_update、memory)时
		 *  抓编辑前基线;优先用回合预取基线(早于工具执行);返回 kind;非编辑工具/缺字段返回 null。 */
		handleStart(toolCallId: string | undefined, toolName: string | undefined, args: unknown): "draft" | "world" | "memory" | null {
			if (!toolCallId || !toolName) return null;
			const parsed = parseToolArgs(args);
			const path = pathFromArgs(parsed);
			const kind = classifyToolCall(toolName, path);
			if (!kind) return null;
			// 发起回合的书:捕获用于 after 取数(切书后不按新书读旧草稿路径)
			const slug = slugFn();
			if (kind === "memory") {
				const target = memoryTargetOf(parsed);
				const before = turnBaseline.memory?.[target] ?? client.getMemory(target, slug ?? undefined).then((r) => r.text);
				pending.set(toolCallId, { kind, path: null, toolName, memoryTarget: target, before, slug });
				return "memory";
			}
			let before: Promise<string | WorldDataDto>;
			if (kind === "draft" && path) {
				before = turnBaseline.draft.get(path) ?? client.getDraft(path, slug ?? undefined).then((r) => r.text);
			} else {
				before = turnBaseline.world ?? client.getWorld(slug ?? undefined).then((r) => r.world);
			}
			pending.set(toolCallId, { kind, path: path ?? null, toolName, before, slug });
			return kind;
		},

		/** 工具 end:配对组装 diff;失败/非编辑工具/重复 → null。 */
		async handleEnd(toolCallId: string | undefined, isError?: boolean): Promise<CapturedEdit | null> {
			if (!toolCallId) return null;
			if (handled.has(toolCallId)) return null;
			handled.add(toolCallId);
			const p = pending.get(toolCallId);
			pending.delete(toolCallId);
			if (!p || isError) return null; // 失败:不弹卡
			try {
				// 预览数据携带的书:以发起回合的书为准(p.slug),而非 slugFn() 的当前值——
				// await 期间切书时卡片数据仍归属旧书(页面层另有 scope 守卫决定是否丢弃)
				const slug = p.slug ?? slugFn();
				const before = await p.before;
				if (p.kind === "draft" && p.path) {
					if (typeof before !== "string") return null;
					const after = await client.getDraft(p.path, p.slug ?? undefined);
					if (before === after.text) return null; // 无实质变化
					return {
						toolCallId,
						kind: "draft",
						path: p.path,
						toolName: p.toolName,
						before,
						data: { kind: "draft", toolName: p.toolName, sections: [{ path: p.path, diff: buildDraftDiff(before, after.text) }] },
					};
				}
				if (p.kind === "world") {
					if (typeof before === "string") return null;
					const after = await client.getWorld(p.slug ?? undefined);
					const diff = buildWorldDiff(before, after.world);
					const cls = classifyWorldChange(diff);
					if (cls === null) return null; // 非词条/结构变更(Notice 等):不弹卡
					const data: PreviewData =
						cls.mode === "graph"
							? { kind: "world", toolName: p.toolName, slug, mode: "graph", afterWorld: after.world, worldDiff: diff }
							: { kind: "world", toolName: p.toolName, slug, mode: "entry", entries: diff.modifiedEntries, allEntries: after.world.entries, relations: after.world.relations };
					return { toolCallId, kind: "world", path: null, toolName: p.toolName, before, data };
				}
				if (p.kind === "memory") {
					if (typeof before !== "string") return null;
					const target = p.memoryTarget ?? "memory";
					const after = await client.getMemory(target, p.slug ?? undefined);
					if (before === after.text) return null; // 无实质变化(如超预算被拒,文件没动)
					const data: PreviewData = {
						kind: "memory",
						toolName: "memory",
						target,
						// 展示路径不带主机绝对路径:user.md 在书外,给个可读的相对写法
						path: target === "user" ? "~/.pi/writer/user.md" : "memory.md",
						diff: buildDraftDiff(before, after.text),
					};
					return { toolCallId, kind: "memory", path: null, toolName: p.toolName, memoryTarget: target, before, data };
				}
				return null;
			} catch {
				return null; // 取数失败:跳过该次捕获(不打断对话/舞台)
			}
		},

		/** 清空待配对、去重记录与回合预取基线(切换书/章节/重置时)。 */
		clear(): void {
			pending.clear();
			handled.clear();
			turnBaseline = { draft: new Map(), world: null, memory: null };
		},
	};
}
