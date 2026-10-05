/**
 * 回归护栏:**工具集 ⊆ 提示词工具清单**(2026-10-05)。
 *
 * 背景:真实会话 `writer-c-v05ij1` 复盘里最贵的一条事故 —— `read_chapter` 自 T3
 * 上线起就注册着,但 `prompts/` 与 `skills/` 里**零命中**。工具 schema 本来随请求
 * 发给模型,可主提示词明说「以下是你可用的**基础工具**」并给了张清单,**模型服从
 * 提示词**,于是这个工具是死代码:会话里 `read` 被调了 **117 次**(91 次打在同一章、
 * 全部带 offset、翻到 `Offset 180 is beyond end of file`),`read_chapter` **0 次**。
 *
 * 教训:**注册了不等于告诉了模型。** 反向也一样 —— 提示词写了却没有装配,模型调了
 * 只拿到「工具不存在」,同样是白白损失一轮。
 *
 * 所以这里做的是双向对撞:每个「形态 → 实际工具集」与它对应的提示词逐项比对,
 * 任一侧新增都不放过。
 *
 * 工具集一律**从生产代码取**,不用手写名单:
 * - 编剧 / 经典模式:`writerToolset()`(`src/web/writer-host.ts` 的纯函数,本就是
 *   权限边界的真相源,已有单测钉着);
 * - TUI 主会话:扫 `src/extension.ts` 的 `pi.registerTool(X)`,再把变量名换成真实
 *   工具名。
 * 这样以后加了新工具会自动纳入 ——— 不需要有人记得回来补名单。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptText } from "../src/prompts.ts";
import { writerToolset } from "../src/web/writer-host.ts";
import * as toolObjects from "../src/tools.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** vendor 内置的文件工具六件套 —— 主提示词必须让模型看见它们。 */
const BUILTIN_FILE_TOOLS = ["read", "write", "edit", "ls", "grep", "find"] as const;

/** 变量名(`wordCountTool`)→ 真实工具名(`word_count`),从导出对象上读,不猜。 */
const NAMED = new Map<string, string>(
	Object.entries(toolObjects)
		.filter((e): e is [string, { name: string }] => !!e[1] && typeof e[1] === "object" && typeof (e[1] as { name?: unknown }).name === "string")
		.map(([k, v]) => [k, v.name]),
);

function namesOf(tools: readonly { name: string }[]): string[] {
	return tools.map((t) => t.name);
}

/** 扫 writerFactory 里注册的自定义工具(它就是 TUI 主会话的唯一注册点)。 */
function tuiMainSessionTools(): string[] {
	const src = readFileSync(resolve(REPO_ROOT, "src/extension.ts"), "utf8");
	const out = new Set<string>();
	for (const m of src.matchAll(/pi\.registerTool\((\w+)\)/g)) {
		const name = NAMED.get(m[1]);
		// 变量名对不上任何导出工具 = 扫描失效,直接炸掉而不是静默漏掉工具
		if (!name) throw new Error(`extension.ts 注册了未知工具变量 ${m[1]}(是改名了还是新工具没从 tools.ts 导出?)`);
		out.add(name);
	}
	expect(out.size, "没扫到任何 registerTool —— 这一段被重构了,护栏失效").toBeGreaterThan(0);
	return [...out];
}

describe("形态工具集 ⊆ 提示词工具清单(防 read_chapter 式死代码)", () => {
	it("writerToolset:两个形态的工具集都拿得到(护栏本身没瞎)", () => {
		const editor = namesOf(writerToolset({ classicMode: false, mcpTools: [] }));
		const classic = namesOf(writerToolset({ classicMode: true, mcpTools: [] }));
		expect(editor).toContain("read_chapter");
		expect(editor).toContain("style_update");
		expect(editor).not.toContain("world_update"); // 权限边界:世界书改动归导演
		expect(classic).toContain("world_update");
		expect(classic).toContain("word_count");
	});

	it("编剧(舞台形态):拿到的每个工具都写进了 writer-editor.md", () => {
		const tools = namesOf(writerToolset({ classicMode: false, mcpTools: [] }));
		const editor = loadPromptText("writer-editor.md");
		for (const name of tools) {
			expect(editor, `writer-editor.md 没提 ${name}`).toContain(name);
		}
	});

	it("写作 agent(经典模式):拿到的每个工具都写进了 writer-main.md", () => {
		const tools = namesOf(writerToolset({ classicMode: true, mcpTools: [] }));
		const main = loadPromptText("writer-main.md");
		for (const name of tools) {
			expect(main, `writer-main.md 没提 ${name}`).toContain(name);
		}
	});

	it("TUI 主会话:注册的工具都写进了 writer-main.md", () => {
		const main = loadPromptText("writer-main.md");
		for (const name of tuiMainSessionTools()) {
			expect(main, `writer-main.md 没提 ${name}`).toContain(name);
		}
	});

	it("反过来:提示词点名的自定义工具,至少一个形态真的装配了它", () => {
		// 反向一致同样要紧 —— 提示词写了却没装配,模型调了只拿到「工具不存在」。
		const assembled = new Set<string>([
			...namesOf(writerToolset({ classicMode: true, mcpTools: [] })),
			...namesOf(writerToolset({ classicMode: false, mcpTools: [] })),
			...tuiMainSessionTools(),
		]);
		const main = loadPromptText("writer-main.md");
		for (const name of [...NAMED.values()]) {
			if (!main.includes(name)) continue; // 主提示词没提它,不归这条管
			expect(assembled, `${name} 出现在 writer-main.md,但没有任何形态装配它`).toContain(name);
		}
	});

	it("内置文件工具六件套在主提示词里看得见", () => {
		const main = loadPromptText("writer-main.md");
		for (const name of BUILTIN_FILE_TOOLS) {
			// 用带反引号的形式断言 —— 散落在散文里的同名词不算「写进工具清单」
			expect(main, `writer-main.md 的工具清单漏了 ${name}`).toContain(`\`${name}\``);
		}
	});

	it("src/tools.ts 里定义的工具没有漏网之鱼(都被某个形态装配或至少导出)", () => {
		// 兜底:有人在 tools.ts 加了 defineTool 却忘了 export / 忘了注册 ——
		const src = readFileSync(resolve(REPO_ROOT, "src/tools.ts"), "utf8");
		const defined = [...src.matchAll(/^export const \w+Tool: ToolDefinition = defineTool\(\{\s*\n\tname: "([a-z_]+)"/gm)].map((m) => m[1]);
		expect(defined.length).toBeGreaterThan(0);
		for (const name of defined) {
			expect([...NAMED.values()], `${name} 定义了但没导出`).toContain(name);
		}
	});
});

/**
 * 回归护栏:**负面示例**留在提示词里(2026-10-05)。
 *
 * 2026 年的共识是 negative examples beat general warnings:光说「不要反复读」没有用,
 * 要说清楚*长什么样*叫反复读。下面这条是真实会话里模型自己踩出来的 offset 轨迹,
 * 把它钉在提示词里,比任何抽象告诫都具体。
 */
describe("负面示例:用 read 分页翻整章的反面教材", () => {
	it("主提示词里写明了「不要用 read 带 offset 翻完一整章」", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("不要用 `read` 带 offset 把一整章翻完");
		expect(main).toContain("换 `read_chapter` 一次拿全文");
	});

	it("主提示词里保留了真实事故轨迹做对照(offset 反复回溯)", () => {
		const main = loadPromptText("writer-main.md");
		// 这段是 writer-c-v05ij1 里真实发生过的:offset 一路递增又回头,还翻过了文件末尾。
		// 留着它,模型才知道「分页翻」具体长什么样。
		expect(main).toContain("beyond end of file");
	});

	it("停止条件还在(同文件 ≤2 次 / 读到重复或截断就停)", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("同一个文件一轮内读取不超过 2 次");
		expect(main).toContain("立刻停止继续读");
	});

	it("场景节奏的写作门禁还在(讨论轮不执行 1–4 步)", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("先判断这一轮是不是要写");
		expect(main).toContain("讨论轮");
		expect(main).toContain("不要执行下面的步骤");
	});
});
