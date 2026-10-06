/**
 * 注入实况探针 —— **看看真实会话里模型到底收到什么**。
 *
 * 这个脚本不做断言,只把「一次对话装配后,各通道实际注入了什么文本」原样打出来,
 * 用**人眼**核对去重是否真的生效、顺序是否合理、体量是否可接受。
 *
 * 它模拟的场景是真实的:一个已经写了三章的书,有世界书条目、约束、Notice、
 * 发展线、memory.md、舞台转录,用户在**分离模式(book)**下的一段自由对话中
 * 说了一句要求修改的话 —— 这正是「重复注入」最该被看清的场合。
 *
 * 用法:`npx tsx scripts/probe-injection.ts`
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须赶在 import 业务模块之前设好隔离目录 —— 那些模块在装载时读环境变量
const ROOT = mkdtempSync(join(tmpdir(), "piw-probe-"));
process.env.PI_WRITER_DIR = ROOT;

const { getBookDir } = await import("../src/config.ts");
const { ensureWorld, saveWorld } = await import("../src/world-data.ts");
const { buildChapterContext } = await import("../src/world-context.ts");
const { planStableBlocks, planPerTurnBlocks, renderAnchor, truncate } = await import("../src/inject-plan.ts");
const { buildMemoryAnchor, readAnchorMemory } = await import("../src/extension.ts");

const SLUG = "fog-harbor";
const CHAPTER = "ch03.jsonl";
const BOOK_DIR = getBookDir(SLUG);

// ————————————————————————————————————————————————————————————
// 一、造一本"写到第三章"的书
// ————————————————————————————————————————————————————————————

/** 模拟用户在这个会话里说过的话(最近 2 条进激活扫描)。 */
const RECENT_USER_MESSAGES = ["林婉她爸是不是也是守塔人?", "把这一段的节奏放慢一点,别急着揭底"];

/** 这一轮用户即将说的话。 */
const USER_PROMPT = "让林婉在档案室里发现那把她爸的旧钥匙,写得克制一点";

async function seedBook(): Promise<void> {
	mkdirSync(join(BOOK_DIR, "draft"), { recursive: true });
	mkdirSync(join(BOOK_DIR, "stage"), { recursive: true });

	// 正文(第三章草稿,已在写的状态)
	writeFileSync(
		join(BOOK_DIR, "draft", "ch03.md"),
		[
			"雾港的雨下了整整三天。",
			"",
			"林婉把伞靠在档案室门口,推门进去的时候,霉味先一步扑了上来。她数着架子往前走——第七排,第八排——",
			"",
			"「你父亲最后一次来这儿,是三十一年前。」老周的声音从背后传来,「那天也下雨。」",
		].join("\n"),
		"utf8",
	);

	// 跨章节记忆
	writeFileSync(
		join(BOOK_DIR, "memory.md"),
		[
			"- 主角:林婉,28 岁,守塔人后代,左眼是义眼(她自己不愿提)",
			"- 她的剑叫「婉姐的剑」——这是她母亲起的绰号,别写成正式剑名",
			"- 老周:档案室管理员,知道林家的旧事,但说话总是绕",
			"- 用户要求:战斗场面不写血腥细节;人物对话用「」不用引号",
		].join("\n"),
		"utf8",
	);

	const world = await ensureWorld(BOOK_DIR);
	await saveWorld(BOOK_DIR, {
		...world,
		worldSummary: "架空 1880 年代,雾港是北方海岸的旧灯塔城市。守塔人家族世代看守一座早已熄灭的白塔,塔内据说封着「信物」。蒸汽工业正在取代帆船,旧家族在衰落。",
		entries: [
			{
				id: "e1", type: "character", title: "林婉", keys: ["林婉", "婉姐"], chapters: ["ch01", "ch02", "ch03"],
				status: "alive", active: true, parent: null, tags: [], avatar: null, images: [], updatedAt: 0,
				body: "女主。守塔人林家独女,左眼义眼。性情克制,习惯用行动代替解释。怕水(童年落海留下的)。",
			},
			{
				id: "e2", type: "character", title: "老周", keys: ["老周", "档案室"], chapters: ["ch02", "ch03"],
				status: "alive", active: true, parent: null, tags: [], avatar: null, images: [], updatedAt: 0,
				body: "档案室管理员。六十多岁,林家的旧识。知道信物的事,但从不直说,喜欢用问题回答问题。",
			},
			{
				id: "e3", type: "world", title: "白塔", keys: ["白塔", "灯塔", "塔"], chapters: [],
				status: "active", active: true, parent: null, tags: [], avatar: null, images: [], updatedAt: 0,
				body: "雾港地标,已熄灭三十年。塔内档案室保存着历代守塔人的记录。",
			},
			{
				id: "e4", type: "world", title: "信物", keys: ["信物", "钥匙"], chapters: [],
				status: "active", active: true, parent: null, tags: [], avatar: null, images: [], updatedAt: 0,
				body: "守塔人代代相传的一件东西,具体是什么没人说得清。林婉的父亲失踪前带走了它。",
			},
		],
		constraints: [
			{ id: "c1", name: "叙事人称", text: "第三人称限知,只跟林婉的视角走,不写她看不到的事", enabled: true, target: "all" },
			{ id: "c2", name: "节奏", text: "每章至少留一个未解的问题;不要一次揭穿底牌", enabled: true, target: "all" },
			{ id: "c3", name: "导演专用", text: "这条只给舞台导演", enabled: true, target: "director" },
		],
		notice: {
			enabled: true,
			items: [
				{ id: "n1", text: "第三卷结尾要回收「信物」伏笔", done: false },
				{ id: "n2", text: "老周的立场要在 ch05 前给个暗示", done: false },
				{ id: "n3", text: "已处理:主角的姓氏统一", done: true },
			],
		},
		storyline: {
			enabled: true,
			nodes: [
				{ id: "s1", title: "抵达雾港", status: "done", goal: "", next: null },
				{ id: "s2", title: "找到父亲的踪迹", status: "in-progress", goal: "在档案室里找到林家旧档", next: "发现旧钥匙" },
			],
		},
	});
}

// ————————————————————————————————————————————————————————————
// 二、打印
// ————————————————————————————————————————————————————————————

const RULE = "─".repeat(72);

function head(text: string): void {
	console.log(`\n${RULE}\n${text}\n${RULE}`);
}

/** 带行号 + 总字数打印,便于看体量。 */
function dump(label: string, text: string): void {
	const chars = text.length;
	console.log(`\n▍${label}  (${chars} 字)`);
	console.log("┄".repeat(72));
	console.log(text);
}

async function main(): Promise<void> {
	await seedBook();
	const world = await ensureWorld(BOOK_DIR);

	head("场景:分离模式(book)下的常驻编剧会话 · 第 3 章 · 用户说「让林婉发现旧钥匙」");

	// ─────────────────────────────────────────────────────
	// 1) 系统提示(格 A)—— 会话建立时定死
	// ─────────────────────────────────────────────────────
	head("① 系统提示(格 A · 装配期一次)");
	const { buildEditorSystemPrompt } = await import("../src/prompt.ts");
	const sysPrompt = buildEditorSystemPrompt("book");
	dump("systemPrompt(分割线以上为 brand 头,此处只示末尾的落点规则部分)", sysPrompt.slice(-1200));

	// ─────────────────────────────────────────────────────
	// 2) 记忆锚(格 D)—— 每轮追加到 systemPrompt 尾部
	// ─────────────────────────────────────────────────────
	head("② 记忆锚(格 D · 每轮追加到 systemPrompt 末尾)");
	const { detectSessionMode } = await import("../src/session-mode.ts");
	const mode = detectSessionMode(USER_PROMPT);
	const memory = await readAnchorMemory(BOOK_DIR);
	const anchor = renderAnchor({ mode, chapterFile: CHAPTER, memory });
	console.log(`\n用户这句话被判定为模式:${mode}`);
	dump("锚正文(实际会被拼到 systemPrompt 尾部)", anchor);

	// ─────────────────────────────────────────────────────
	// 3) 稳定块(格 B)—— 指纹去重,随下个 prompt 落盘
	// ─────────────────────────────────────────────────────
	head("③ 稳定块(格 B · 指纹去重,内容不变不重注)");
	const stable = planStableBlocks({ world, classicMode: false });
	console.log(`\n本块由 ${stable.length} 个子块组成,指纹 = 对全文做 FNV-1a。`);
	dump("稳定块全文", stable.join("\n\n"));

	// ─────────────────────────────────────────────────────
	// 4) 每轮易变块(格 C)—— context 钩子,追加为一条 user 消息
	// ─────────────────────────────────────────────────────
	head("④ 每轮易变块(格 C · 每轮作为一条 user 消息追加)");
	const draftText = "雾港的雨下了整整三天。\n\n林婉把伞靠在档案室门口,推门进去的时候,霉味先一步扑了上来。";
	const perTurn = planPerTurnBlocks({
		world,
		draft: draftText,
		draftFile: "draft/ch03.md",
		transcript: "【导演】老周不该这么快出现。\n【林婉】他一直都在,只是你没看见。",
	});
	console.log(`\n本块由 ${perTurn.length} 个子块组成。`);
	dump("每轮易变块全文(实际会作为 user 消息追加)", perTurn.join("\n\n"));

	// ─────────────────────────────────────────────────────
	// 5) 背景包 —— 注意:编剧会话**不走**这条
	// ─────────────────────────────────────────────────────
	head("⑤ 背景包(格 E · **仅供对照** —— 编剧会话并不走这条通道)");
	const pack = buildChapterContext(world, {
		chapterId: "ch03",
		draftText,
		recentUserMessages: [...RECENT_USER_MESSAGES].reverse(),
		memory,
		budget: 2000,
		activationDepth: 0,
		limits: { noticeInjectLimit: 10, completedMilestoneLimit: 6 },
	});
	console.log("\n背景包是 **主会话**(web 那个 chat)专有的注入 —— 编剧会话有自己的格 B/C/D。");
	console.log("把它打出来是为了对照:若编剧会话误走这条,Notice/发展线/记忆会与上面 ③④ 全部重复。");
	dump("背景包全文(主会话实际收到的那份)", pack.text);

	// ─────────────────────────────────────────────────────
	// 6) 去重核对 —— 本探针的重点
	// ─────────────────────────────────────────────────────
	head("⑥ 去重核对:同一份数据在编剧会话里出现了几次?");

	const channels: Record<string, string> = {
		"② 记忆锚": anchor,
		"③ 稳定块": stable.join("\n\n"),
		"④ 每轮易变块": perTurn.join("\n\n"),
	};
	const markers = ["【跨章节记忆 memory.md】", "【世界观概述】", "【世界书】", "【写作约束】", "【Notice·备忘录】", "【发展线】"];
	const rows = markers.map((m) => {
		const hits = Object.entries(channels).filter(([, t]) => t.includes(m)).map(([k]) => k);
		return { 块: m, 次数: hits.length, 出现在: hits.join(" + ") || "(未注入)" };
	});
	console.table(rows);

	const dup = rows.filter((r) => r.次数 > 1);
	console.log(
		dup.length === 0
			? "\n✅ 无重复:每个块在编剧会话里只出现一次。"
			: `\n❌ 仍重复:${dup.map((d) => `${d.块}×${d.次数}`).join(", ")}`,
	);

	// ─────────────────────────────────────────────────────
	// 7) 最终对话形态
	// ─────────────────────────────────────────────────────
	head("⑦ 模型最终看到的对话(按实际顺序)");
	const total =
		sysPrompt.length + anchor.length + stable.length + perTurn.join("\n\n").length + USER_PROMPT.length;
	console.log(`
第 1 条 · role=system   ← 格 A 系统提示 + 格 D 记忆锚(钩子在末尾拼接)
                           ${sysPrompt.length} 字 + ${anchor.length} 字(锚)

第 2 条 · role=custom   ← 格 B 稳定块(customType=world-context,nextTurn 投递)
                           ${stable.join("\n\n").length} 字
                           *(首次对话或世界书变更时才有;不变则不再出现)*

第 3 条 · role=custom   ← 格 C 每轮易变块(context 钩子产出,作为 user 消息插入)
                           ${perTurn.join("\n\n").length} 字
                           *(每轮都有)*

第 4 条 · role=user     ← 用户原话
                           「${USER_PROMPT}」(${USER_PROMPT.length} 字)

———————————————————————————————
注入总量约 ${total} 字(不含系统提示其余部分与历史消息)
  · 其中 每轮重复付出的是「格 C + 格 D」= ${perTurn.join("\n\n").length + anchor.length} 字
  · 「格 B」只在内容变化时重付
`);

	head("⑧ 这一轮里被刻意排除的东西(确认没被注进去)");
	const all = [sysPrompt, anchor, stable.join("\n\n"), perTurn.join("\n\n")].join("\n");
	for (const [what, needle, why] of [
		["文风采样块", "【文风采样】", "2026-10-05 起改由 read_style 按需取"],
		["导演专用约束", "这条只给舞台导演", "target=director 不该进编剧"],
		["已完成的 Notice", "已处理:主角的姓氏统一", "done 项不注入"],
		["【记忆】块(背景包写法)", "【记忆】", "编剧会话用锚的【跨章节记忆】,不用背景包那份"],
	] as const) {
		const hit = all.includes(needle);
		console.log(`  ${hit ? "❌ 出现了" : "✅ 未出现"}  ${what.padEnd(22)} —— ${why}`);
	}

	head("⑨ 模式判定的边界(它决定「能不能碰文件」这条硬约束)");
	console.log("\n模式判定的结果直接改变锚的第一行 —— 讨论态会明确禁止写文件。");
	console.log("所以判定错了,后果不是「多写一段话」,而是「该写的时候它不敢写」。\n");
	const modeCases = [
		["继续写", "writing"],
		["接着写第三章", "writing"],
		["往下写", "writing"],
		["把这一段写出来", "writing"],
		["让林婉在档案室里发现那把她爸的旧钥匙,写得克制一点", "?"],
		["帮我写一段林婉进档案室", "?"],
		["林婉走进档案室,发现了一把钥匙", "?"],
		["这一章写得怎么样?", "discussing"],
		["先别写,我们讨论一下剧情", "discussing"],
	] as const;
	for (const [text, expect] of modeCases) {
		const got = detectSessionMode(text);
		const mark = expect === "?" ? "❓" : got === expect ? "✅" : "⚠️ ";
		console.log(`  ${mark} ${got.padEnd(11)} 「${text}」${expect === "?" ? "  ← 人工判断?" : ""}`);
	}

	// 收尾:清掉临时目录
	rmSync(ROOT, { recursive: true, force: true });
}

await main();
