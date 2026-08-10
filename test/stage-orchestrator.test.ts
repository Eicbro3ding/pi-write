import { describe, expect, it } from "vitest";
import {
	buildWriterMessage,
	classifyActorOutput,
	cleanCrossTalk,
	decideTurnAction,
	detectScriptIntent,
	nextDirectorMode,
	parseReviseArgs,
	renderStateForWriter,
} from "../src/stage/orchestrator.ts";
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

describe("detectScriptIntent（剧本意图弱信号）", () => {
	it("命中写剧本信号", () => {
		for (const text of ["帮我写剧本", "开一幕酒馆重逢", "我来安排选角", "写一幕戏"]) {
			expect(detectScriptIntent(text), text).toBe(true);
		}
	});

	it("普通讨论不命中", () => {
		for (const text of ["李四的性格怎么样", "世界书更新了吗", "今天天气不错"]) {
			expect(detectScriptIntent(text), text).toBe(false);
		}
	});
});

describe("nextDirectorMode（三模式状态机）", () => {
	it("剧本意图/工具调用 → scripting", () => {
		expect(nextDirectorMode("discussion", "user-script-intent")).toBe("scripting");
		expect(nextDirectorMode("directing", "director-script-intent")).toBe("scripting");
		expect(nextDirectorMode("directing", "tool-stage-script")).toBe("scripting");
	});

	it("开演 → directing；收幕 → discussion", () => {
		expect(nextDirectorMode("scripting", "scene-started")).toBe("directing");
		expect(nextDirectorMode("directing", "scene-closed")).toBe("discussion");
	});

	it("同模式事件幂等", () => {
		expect(nextDirectorMode("scripting", "user-script-intent")).toBe("scripting");
		expect(nextDirectorMode("discussion", "scene-closed")).toBe("discussion");
	});

	it("三态全遍历", () => {
		const all: DirectorMode[] = ["discussion", "scripting", "directing"];
		for (const mode of all) {
			expect(nextDirectorMode(mode, "scene-started")).toBe("directing");
			expect(nextDirectorMode(mode, "scene-closed")).toBe("discussion");
			expect(nextDirectorMode(mode, "user-script-intent")).toBe("scripting");
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
