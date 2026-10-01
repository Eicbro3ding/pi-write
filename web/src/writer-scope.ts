/**
 * 「对话与章节的关系」(conversationScope)在**前端**的纯逻辑 —— 唯一实现。
 *
 * 背景(见 src/writer-settings.ts / src/web/writer-host.ts):服务端把编剧会话身份
 * 泛化成 conversationId,由设置项 `conversationScope` 决定它是什么:
 * - `"chapter"`(缺省):conversationId **就是**章节文件名(`ch01.jsonl`),
 *   前端只传 chapterFile —— 与本次改动前逐字节一致;
 * - `"book"`:身份是不透明对话 id(`c-xxxxxx` / `default` / 章节文件名),
 *   前端传 conversation,chapterFile 只表示「正在看的章节」(决定注入哪章正文)。
 *
 * 抽成单独模块的理由:这些判定散在 WritePage 的 SSE 回调 / 五个异步对齐链 /
 * 切换器事件里,写错一处就是「切了对话却还显示上一段的消息」或「事件全被过滤掉,
 * 发出去的话没有任何回应」。放这里能被 `test/writer-scope.test.ts` 直接钉住
 * (WritePage 装配层不进单测)。
 */
import type { ConversationDto, ConversationScopeDto } from "./types.ts";

/**
 * writer 事件帧里与「归属」有关的两个字段(writer_event 的子集)。
 *
 * chapter 模式的帧**没有** `conversation` 字段(服务端保持负载逐字节不变),
 * book 模式的帧**恒有**(chapterFile 为 null)。
 */
export interface WriterEventRef {
	chapterFile: string | null;
	conversation?: string;
}

/** 一次 writer 请求要带上的定位参数(直接喂 client 的 writer 方法)。 */
export interface WriterTarget {
	/** 章节:chapter 模式是会话身份;book 模式是「正在看的章节」(null = 没在看)。 */
	chapterFile: string | null;
	/** 对话 id:只有 book 模式传(undefined = 让服务端按当前对话回落)。 */
	conversation?: string;
}

/**
 * 事件归属判定 —— 前端**唯一**的 writer_event 过滤口径。
 *
 * - 帧里带 `conversation`(book 模式)→ 按当前选中的对话过滤;选中还没就位
 *   (列表首次拉取期间)时**不拦**,否则用户在这一瞬发的话会「发出去但看不到任何
 *   回应」(宁可多显示一帧,也不要静默吞掉)。
 * - 帧里没有 `conversation`(chapter 模式)→ 沿用改动前的 chapterFile 判定。
 */
export function acceptsWriterEvent(
	frame: WriterEventRef,
	selectedConversationId: string | null,
	currentChapterFile: string | null,
): boolean {
	if (frame.conversation !== undefined) {
		if (selectedConversationId === null) return true;
		return frame.conversation === selectedConversationId;
	}
	return (frame.chapterFile ?? null) === (currentChapterFile ?? null);
}

/**
 * 本次请求的定位参数。chapter 模式**只传 chapterFile**(身份,零变化);
 * book 模式额外传 conversation(= 身份),chapterFile 仍照传 —— 它决定注入哪章正文
 * (需求:对话里的 AI 可自由编辑任意章节,但仍要知道用户在看哪一章)。
 */
export function writerTarget(
	scope: ConversationScopeDto,
	chapterFile: string | null,
	conversationId: string | null,
): WriterTarget {
	if (scope === "book") return { chapterFile, conversation: conversationId ?? undefined };
	return { chapterFile };
}

/**
 * 编剧会话的「对齐键」:变化即需要 RESET + 重拉 state/tree/context。
 *
 * chapter 模式 = `slug:章节文件`(与改动前的 `${slug}:${ch?.file ?? ""}` 同形
 * —— 切章必须重拉);book 模式 = `slug:conv:对话 id` —— **切章节不重拉**
 * (同一段对话的消息与章节无关,只有注入的正文跟着变)。
 */
export function writerAlignKey(
	scope: ConversationScopeDto,
	slug: string,
	chapterFile: string | null,
	conversationId: string | null,
): string {
	return scope === "book" ? `${slug}:conv:${conversationId ?? ""}` : `${slug}:${chapterFile ?? ""}`;
}

/** 服务端登记的当前对话(isCurrent;未登记时服务端已把最近更新的一条标为 true)。 */
export function currentConversationId(list: readonly ConversationDto[]): string | null {
	return (list.find((c) => c.isCurrent) ?? list[0])?.id ?? null;
}

/**
 * 删除对话后的落点:**不许出现「选中一条已删除对话」的死状态**。
 * 返回列表里的第一条(后端已按 mtime 倒序);列表空了返回 null ——
 * 调用方据此自动新建一段(首屏总得有个落脚点)。
 */
export function nextConversationAfterDelete(list: readonly ConversationDto[], deletedId: string): string | null {
	return list.find((c) => c.id !== deletedId)?.id ?? null;
}

/**
 * 对话标题的相对时间(列表里帮助区分两段长相一样的「新对话」)。
 * `now` 显式传入是为了可测(不在纯函数里读 Date.now)。
 */
export function formatConversationTime(updatedAt: number, now: number): string {
	const diff = now - updatedAt;
	if (!Number.isFinite(diff) || diff < 0) return "";
	const min = Math.floor(diff / 60_000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour} 小时前`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day} 天前`;
	const month = Math.floor(day / 30);
	return month < 12 ? `${month} 个月前` : `${Math.floor(month / 12)} 年前`;
}
