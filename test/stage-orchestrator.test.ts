import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { saveScript } from "../src/stage/script-store.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildWriterMessage,
	classifyActorOutput,
	cleanCrossTalk,
	decideTurnAction,
	nextDirectorMode,
	parseReviseArgs,
	readAdvice,
	renderStateForWriter,
	StageOrchestrator,
} from "../src/stage/orchestrator.ts";
import { buildScriptMethodBlock } from "../src/stage/stage-extension.ts";
import { createEmptyWorld } from "../src/world-data.ts";
import type { DirectorMode, SceneRules, SceneScript } from "../src/stage/types.ts";

const rules: SceneRules = { minLines: 10, maxLines: 20, wrapUpWindow: 3, turn: "round-robin" };

describe("decideTurnAction（收幕决策状态机）", () => {
	it("正常状态继续演", () => {
		expect(decideTurnAction("normal", 5, rules)).toBe("speak");
		expect(decideTurnAction("wrapping", 5, rules)).toBe("speak"); // 未达下限不收
	});

	it("收尾中且达到下限 → wrap-close", () => {
		expect(decideTurnAction("wrapping", 10, rules)).toBe("wrap-close");
		expect(decideTurnAction("wrapping", 15, rules)).toBe("wrap-close");
	});

	it("达到上限强制收幕（优先级最高）", () => {
		expect(decideTurnAction("normal", 20, rules)).toBe("force-close");
		expect(decideTurnAction("wrapping", 20, rules)).toBe("force-close");
		expect(decideTurnAction("wrapping", 25, rules)).toBe("force-close");
	});
});

describe("parseReviseArgs（/revise k=v 解析，结构化字段）", () => {
	it("解析数值规则", () => {
		const patch = parseReviseArgs(["min=5", "max=25", "wrap=2"]);
		expect(patch.rules).toEqual({ minLines: 5, maxLines: 25, wrapUpWindow: 2 });
	});

	it("解析 shared 标量字段（setting/goal/tone 字段级）", () => {
		const patch = parseReviseArgs(["tone=更欢快", "goal=新目标"]);
		expect(patch.text?.shared?.tone).toBe("更欢快");
		expect(patch.text?.shared?.goal).toBe("新目标");
		expect(patch.text?.shared?.setting).toBeUndefined();
	});

	it("解析数组字段（beats/forbidden 用 | 分隔）", () => {
		const patch = parseReviseArgs(["beats=拍1|拍2", "forbidden=禁1|禁2"]);
		expect(patch.text?.shared?.beats).toEqual(["拍1", "拍2"]);
		expect(patch.text?.shared?.forbidden).toEqual(["禁1", "禁2"]);
	});

	it("解析定向演员字段（actor:<id>.<字段>，缺省 objective）", () => {
		const patch = parseReviseArgs(["actor:actor-1.objective=更冷淡", "actor:actor-2=新角色任务"]);
		expect(patch.text?.perActor?.["actor-1"]?.objective).toBe("更冷淡");
		expect(patch.text?.perActor?.["actor-2"]?.objective).toBe("新角色任务");
	});

	it("examples 字段用 | 分隔整体替换", () => {
		const patch = parseReviseArgs(["actor:actor-1.examples=王五: 你好。|李四: ……"]);
		expect(patch.text?.perActor?.["actor-1"]?.examples).toEqual(["王五: 你好。", "李四: ……"]);
	});

	it("无 '=' 的 token 被忽略", () => {
		expect(parseReviseArgs(["min=5", "garbage", "tone=新基调"]).rules?.minLines).toBe(5);
		expect(parseReviseArgs(["garbage"]).rules).toBeUndefined();
		expect(parseReviseArgs([]).rules).toBeUndefined();
	});

	it("重复 key 后者覆盖前者", () => {
		const patch = parseReviseArgs(["min=5", "min=8"]);
		expect(patch.rules?.minLines).toBe(8);
	});
});

describe("nextDirectorMode（三模式状态机，意图识别已移除）", () => {
	it("script_confirm 工具调用 → scripting（导演主动进入剧本模式）", () => {
		expect(nextDirectorMode("discussion", "tool-script-confirm")).toBe("scripting");
		expect(nextDirectorMode("directing", "tool-script-confirm")).toBe("scripting");
	});

	it("开演 → directing；收幕 → discussion", () => {
		expect(nextDirectorMode("scripting", "scene-started")).toBe("directing");
		expect(nextDirectorMode("directing", "scene-closed")).toBe("discussion");
	});

	it("同模式事件幂等", () => {
		expect(nextDirectorMode("scripting", "tool-script-confirm")).toBe("scripting");
		expect(nextDirectorMode("discussion", "scene-closed")).toBe("discussion");
	});

	it("三态全遍历", () => {
		const all: DirectorMode[] = ["discussion", "scripting", "directing"];
		for (const mode of all) {
			expect(nextDirectorMode(mode, "scene-started")).toBe("directing");
			expect(nextDirectorMode(mode, "scene-closed")).toBe("discussion");
			expect(nextDirectorMode(mode, "tool-script-confirm")).toBe("scripting");
		}
	});
});

describe("cleanCrossTalk（串台清理，§10.4）", () => {
	it("剥离自称前缀", () => {
		expect(cleanCrossTalk("李四: 跑船，没空回来。", "李四", ["王五"])).toBe("跑船，没空回来。");
	});

	it("出现其他角色冒号代演 → 从该行截断", () => {
		const text = "（捏紧酒杯）\n王五: 那笔账，我不急。\n我：胡说。";
		expect(cleanCrossTalk(text, "李四", ["王五"])).toBe("（捏紧酒杯）");
	});

	it("提及他人（无冒号代演）不受影响", () => {
		expect(cleanCrossTalk("店小二，再来一壶酒。", "李四", ["王五", "店小二"])).toBe("店小二，再来一壶酒。");
	});

	it("自己名字出现在自己台词里不受影响", () => {
		expect(cleanCrossTalk("我李四从不说谎。", "李四", ["王五"])).toBe("我李四从不说谎。");
	});
});

describe("classifyActorOutput（三态，§10.3）", () => {
	it("<pass> → pass", () => {
		expect(classifyActorOutput("<pass>", "")).toBe("pass");
		expect(classifyActorOutput("<pass>无话可说</pass>", "")).toBe("pass");
	});

	it("正常/动作演出 → speak", () => {
		expect(classifyActorOutput("三年了。", "三年了。")).toBe("speak");
		expect(classifyActorOutput("（垂着眼，摩挲杯沿）", "（垂着眼，摩挲杯沿）")).toBe("speak");
	});

	it("清理后为空（只写了别人台词）→ invalid", () => {
		expect(classifyActorOutput("王五: 那笔账。", "")).toBe("invalid");
	});
});

describe("renderStateForWriter（编剧内心素材，§10.7）", () => {
	it("渲染各角色 task/state/relation", () => {
		const script: SceneScript = {
			scene: "s1",
			chapter: "第一章",
			version: 1,
			definition: {
				cast: { "actor-1": ["李四"] },
				inject: {},
				rules: { minLines: 10, maxLines: 20, wrapUpWindow: 3, turn: "round-robin" },
			},
			text: {
				shared: { setting: "酒馆", goal: "", beats: [], tone: "", forbidden: [] },
				perActor: {
					"actor-1": { objective: "证明自己还清了债", state: "愧疚但放不下面子", relation: "对王五冷淡" },
				},
			},
		};
		const rendered = renderStateForWriter(script);
		expect(rendered).toContain("【李四】任务：证明自己还清了债；内心：愧疚但放不下面子；关系：对王五冷淡");
	});

	it("无内心声明时给出占位", () => {
		const script: SceneScript = {
			scene: "s1",
			chapter: "第一章",
			version: 1,
			definition: { cast: {}, inject: {}, rules: { minLines: 10, maxLines: 20, wrapUpWindow: 3, turn: "round-robin" } },
			text: { shared: { setting: "", goal: "", beats: [], tone: "", forbidden: [] }, perActor: {} },
		};
		expect(renderStateForWriter(script)).toContain("导演未声明角色内心");
	});
});

describe("buildWriterMessage（编剧成文消息，§10.7）", () => {
	const base = {
		transcript: "李四: 三年了。",
		stateText: "【李四】内心：愧疚",
		worldText: "【李四】跑船十年",
		chapter: "第一章",
		thoughts: null,
		thoughtAccess: 2 as const,
	};

	it("含文风采样且指令要求遵循风格", () => {
		const msg = buildWriterMessage({ ...base, styleSample: "暮色如旧，他的眼睛像一盏将熄的灯。" });
		expect(msg).toContain("【文风采样】");
		expect(msg).toContain("遵循文风采样锁定语言风格");
		expect(msg).toContain("draft/第一章.md");
	});

	it("无采样时不出现采样块", () => {
		expect(buildWriterMessage({ ...base, styleSample: null })).not.toContain("【文风采样】");
	});

	it("档3 时注入思考链并标注仅供参考", () => {
		const msg = buildWriterMessage({ ...base, thoughts: "我是李四。我想证明自己还清了债。", thoughtAccess: 3 });
		expect(msg).toContain("【演员思考链（用户已开启档3，仅供内心参考，不要直接引述）】");
		expect(msg).toContain("我是李四。");
	});

	it("档2 时思考链不注入", () => {
		expect(buildWriterMessage({ ...base, thoughts: "我是李四。", thoughtAccess: 2 })).not.toContain("【演员思考链");
	});
});

describe("readAdvice + directorContext 注入（advice.md，编剧统一方案 2026-08-11）", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "piw-advice-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});
	it("readAdvice：缺失/空白 → null，非空 → 原文", async () => {
		expect(await readAdvice(tmp)).toBeNull();
		writeFileSync(join(tmp, "advice.md"), "\n  \n", "utf8");
		expect(await readAdvice(tmp)).toBeNull();
		writeFileSync(join(tmp, "advice.md"), "下一幕节奏要更快", "utf8");
		expect(await readAdvice(tmp)).toBe("下一幕节奏要更快");
	});
	it("讨论模式（未开演）：advice.md 存在时注入【编剧建议】块", async () => {
		writeFileSync(join(tmp, "advice.md"), "下一幕节奏要更快", "utf8");
		const orch = new StageOrchestrator({ bookDir: tmp, agentDir: tmp });
		const result = await orch.directorContext([{ role: "user", content: "聊聊下一幕", timestamp: 1 }] as never);
		expect(result).toBeDefined();
		const content = (result as never as Array<{ content: string }>)[1].content;
		expect(content).toContain("【编剧建议");
		expect(content).toContain("下一幕节奏要更快");
	});
	it("advice.md 缺失时讨论模式不注入（返回 undefined）", async () => {
		const orch = new StageOrchestrator({ bookDir: tmp, agentDir: tmp });
		const result = await orch.directorContext([{ role: "user", content: "聊聊下一幕", timestamp: 1 }] as never);
		expect(result).toBeUndefined();
	});
	it("讨论模式：world.json 有已完成节点时注入【发展线】块（勿重复追求）", async () => {
		const w = createEmptyWorld();
		w.storyline.nodes = [
			{ id: "s1", title: "第一章·结怨", status: "done", goal: "", next: null },
			{ id: "s2", title: "第二章·寻剑", status: "in-progress", goal: "找到剑", next: null },
		];
		writeFileSync(join(tmp, "world.json"), JSON.stringify(w), "utf8");
		const orch = new StageOrchestrator({ bookDir: tmp, agentDir: tmp });
		const result = await orch.directorContext([{ role: "user", content: "聊聊下一幕", timestamp: 1 }] as never);
		expect(result).toBeDefined();
		const content = (result as never as Array<{ content: string }>)[1].content;
		expect(content).toContain("【发展线】");
		expect(content).toContain("当前目标：第二章·寻剑");
		expect(content).toContain("已完成（禁止重复追求/推进）：第一章·结怨");
	});
});

describe("剧本确认门（script_confirm，2026-08-11）", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "piw-confirm-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const minimalScript: SceneScript = {
		scene: "s1",
		chapter: "第一章",
		version: 1,
		definition: {
			cast: { "actor-1": ["李四"] },
			inject: {},
			rules: { minLines: 2, maxLines: 8, wrapUpWindow: 2, turn: "round-robin" },
		},
		text: { shared: { setting: "雾港", goal: "重逢", beats: [], tone: "安静", forbidden: [] }, perActor: {} },
	};

	it("未提交剧本时 stage_script 被 gate 拒绝（提示先 script_confirm）", async () => {
		const orch = new StageOrchestrator({ bookDir: tmp, agentDir: tmp });
		const r = await orch.startScene("s1");
		expect(r.ok).toBe(false);
		expect(r.errors[0]).toContain("script_confirm");
	});

	it("提交后未确认：仍被拒（等待确认）；confirmScript 确认后放行并清空 pending", async () => {
		mkdirSync(join(tmp, "stage"), { recursive: true });
		await saveScript(tmp, "s1", minimalScript);
		const orch = new StageOrchestrator({ bookDir: tmp, agentDir: tmp });
		const sub = await orch.submitScript("s1");
		expect(sub.ok).toBe(true);
		expect(orch.getPendingScript()).toMatchObject({ sceneId: "s1", confirmed: false });
		// 未确认 → gate 拒绝（错误提示等待用户确认）
		const before = await orch.startScene("s1");
		expect(before.ok).toBe(false);
		expect(before.errors[0]).toContain("等待用户确认");
		// 确认 → confirmed
		expect(await orch.confirmScript()).toContain("剧本已确认");
		expect(orch.getPendingScript()!.confirmed).toBe(true);
		// 确认后开演：gate 已过（错误不再是确认门，而是后续选角/会话层）
		const after = await orch.startScene("s1");
		expect(orch.getPendingScript()).toBeNull(); // 确认已消费
		expect(after.errors.join(" ")).not.toContain("等待用户确认");
	});

	it("submitScript 场景不存在 → ok:false；confirmScript 无待确认 → 提示", async () => {
		const orch = new StageOrchestrator({ bookDir: tmp, agentDir: tmp });
		const sub = await orch.submitScript("ghost");
		expect(sub.ok).toBe(false);
		expect(sub.text).toContain("剧本不存在");
		expect(await orch.confirmScript()).toContain("没有待确认的剧本");
	});

	it("确认后重复 confirmScript → 幂等提示", async () => {
		mkdirSync(join(tmp, "stage"), { recursive: true });
		await saveScript(tmp, "s1", minimalScript);
		const orch = new StageOrchestrator({ bookDir: tmp, agentDir: tmp });
		await orch.submitScript("s1");
		await orch.confirmScript();
		expect(await orch.confirmScript()).toContain("已确认");
	});
});

describe("buildScriptMethodBlock（剧本写作方法注入，含 skill 绝对路径）", () => {
	it("SKILL.md 路径为绝对路径且指向 stage-scripting（相对路径会解析到书目录内、读不到）", () => {
		const block = buildScriptMethodBlock("C:/repo/skills");
		expect(block).toContain("read C:/repo/skills/stage-scripting/SKILL.md");
		expect(block).not.toContain("read skills/");
	});
});
