import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { loadPromptText, renderPrompt, resolvePromptsDir } from "../src/prompts.ts";

describe("prompts 外置加载器", () => {
	it("resolvePromptsDir 解析到仓库根 prompts/", () => {
		const dir = resolvePromptsDir({});
		expect(dir.endsWith("prompts")).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});
	it("loadPromptText 读到主会话提示词本体", () => {
		const text = loadPromptText("writer-main.md");
		expect(text).toContain("你是 pi-writer");
		expect(text).toContain("{SHELL_LINE}");
	});
	it("7 个提示词文件全部存在", () => {
		for (const f of ["writer-main.md", "writer-editor.md", "director.md", "actor.md", "narrator.md", "writer-scene.md", "script-method.md"]) {
			expect(existsSync(`${resolvePromptsDir({})}/${f}`), f).toBe(true);
		}
	});
	it("缺失文件抛错(提示词是必需品,fail fast)", () => {
		expect(() => loadPromptText("not-exist.md")).toThrow(/提示词文件缺失/);
	});
});

describe("renderPrompt 占位渲染", () => {
	it("替换已知键,未提供键原样保留", () => {
		expect(renderPrompt("a {X} b {UNKNOWN} c", { X: "1" })).toBe("a 1 b {UNKNOWN} c");
	});
});

/**
 * 回归护栏:中间产物纪律(2026-09-18)。
 *
 * 背景:主提示词原来写着「写在其他任何位置(临时文件、notes/…)用户在界面上都看不见,
 * 等于没写」——那是工作区面板出现之前的事实,却正好卡住工作区「资料与笔记」的唯一
 * 内容来源。改完后必须同时满足两件事,这里把两边都钉住,免得日后被顺手改回去:
 * ① 中间产物(notes/)是允许且被鼓励写的;② 散文落点仍只有当前章节草稿。
 */
describe("中间产物纪律", () => {
	it("写作 agent:允许写 notes/,且保留『散文只进当前章节草稿』硬规则", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("notes/");
		expect(main).toContain("中间产物");
		// 已废弃的措辞:出现即说明有人把旧规则搬回来了
		expect(main).not.toContain("等于没写");
		// 正文落点硬规则必须还在(2026-08「正文写到 draft/第一章.md、前端读到空」的修复)
		expect(main).toContain("散文只有一个落点");
		expect(main).toContain("draft/<章节id>.md");
		// 不可伪造来源:没有联网检索工具时要向用户要材料
		expect(main).toContain("绝不编造出处");
	});

	it("导演:有资料收集纪律,且明确 notes/ 不进正文、不进世界书", () => {
		const director = loadPromptText("director.md");
		expect(director).toContain("资料收集纪律");
		expect(director).toContain("notes/");
		expect(director).toContain("不进正文、也不写进世界书");
	});

	it("常驻编剧不承担资料收集:提示词里不出现 notes/", () => {
		expect(loadPromptText("writer-editor.md")).not.toContain("notes/");
	});
});

/**
 * 回归护栏:开场纪律(2026-10-01)。
 *
 * 背景:首启向导只管模型 / 建书 / 主题,不管写作与题材风格。而 web 默认落地页是
 * **舞台**(非经典模式 → App 初始 view 为 "stage"),用户第一个说话的对象是**导演**;
 * 经典模式与 TUI 走写作 agent;**编剧**(编辑页 AI 伙伴)拿不到 world_update,写不了世界书。
 * 三个入口都要"提一次",但落盘能力不同——这里把三边都钉住,免得日后改提示词时漏掉某一路,
 * 或者更糟:让编剧谎称自己已经写进世界书。
 */
describe("开场纪律(新书还没定风格时的一次性提议)", () => {
	it("写作 agent:触发条件 + 只提一次 + 指向 onboarding 剧本", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("开场纪律");
		expect(main).toContain("【写作约束】");
		expect(main).toContain("【文风采样】");
		expect(main).toContain("同一场对话里不许再提");
		expect(main).toContain("onboarding");
	});

	it("写作 agent:技能改成「按需使用」,但多轮流程仍要先征得同意(2026-10-02 放宽)", () => {
		const main = loadPromptText("writer-main.md");
		// 按需调用:场景命中就直接做,不用先问、不用等点名
		expect(main).toContain("技能(按需使用");
		expect(main).toContain("直接按它的方法做事");
		// 显式调用通道(vendor 的 /skill:<name> 展开),用户点名的技能不用再问
		expect(main).toContain("/skill:");
		// 唯一保留的边界:多轮流程先问、不朗读流程、不报内部名
		expect(main).toContain("先问一句再动手");
		expect(main).toContain("不朗读方法论");
		// 旧的全禁写法不应回来(它让用户不问就永远用不上技能)
		expect(main).not.toContain("不自动套用 outline/critique/revise 方法论");
	});

	it("编剧:同样按需使用 + 支持 /skill: 显式点名", () => {
		const editor = loadPromptText("writer-editor.md");
		expect(editor).toContain("技能按需使用");
		expect(editor).toContain("/skill:");
		expect(editor).toContain("先一句话说清再开始");
	});

	it("导演:开场纪律 + 落盘纪律 + 剧本路径占位", () => {
		const director = loadPromptText("director.md");
		expect(director).toContain("开场纪律");
		expect(director).toContain("{STYLE_SETUP_PATH}");
		expect(director).toContain("长期偏好必须落盘");
	});

	it("编剧:提议后当场用 style_update 落盘(不再只是写 advice.md 等导演)", () => {
		const editor = loadPromptText("writer-editor.md");
		expect(editor).toContain("开场纪律");
		expect(editor).toContain("style_update");
		expect(editor).toContain("不要谎称已经写进世界书");
		// 边界仍在:人物/关系/时间线/发展线不归它,建议走 advice.md
		expect(editor).toContain("归导演");
		expect(editor).toContain("advice.md");
	});

	it("三个入口都有长期偏好纪律(「以后都这样」不能只在嘴上答应)", () => {
		for (const f of ["writer-main.md", "director.md", "writer-editor.md"]) {
			expect(loadPromptText(f), f).toContain("长期");
		}
	});

	it("{STYLE_SETUP_PATH} 渲染成真实存在的剧本，且导演的 RoleSpec 里确实渲染过", async () => {
		const { directorRole, styleSetupScriptPath } = await import("../src/stage/stage-extension.ts");
		const p = styleSetupScriptPath();
		expect(p.endsWith("onboarding/references/style-setup.md")).toBe(true);
		expect(existsSync(p), `风格引导剧本不存在:${p}`).toBe(true);

		// 直接取真实 RoleSpec 的 systemPrompt —— 这是导演实际拿到手的东西。
		// 只断言模板不够:renderPrompt 会把未提供的键原样留下,那样导演读到的是
		// 字面量 "{STYLE_SETUP_PATH}" 这个不存在的路径,而模板测试照样绿。
		// (stage 工具只在 execute 闭包里用 orch,构造 RoleSpec 不会碰它,所以传空对象即可。)
		const prompt = directorRole({} as never).systemPrompt;
		expect(prompt).not.toContain("{STYLE_SETUP_PATH}");
		expect(prompt).not.toContain("{SKILLS_PATH}");
		expect(prompt).toContain(p);
		expect(prompt).toContain("stage-scripting/SKILL.md");
	});
});

/**
 * 回归护栏:起笔纪律(2026-10-01,用户点名要求)。
 *
 * 背景:世界书 / 大纲 / 约束三样全空时闷头起笔,写出来的正文没有任何可依的设定与风格依据,
 * 用户事后才发现"AI 直接开始写了"。要求:三样都空时先问一句要不要补进去;用户说直接写就不阻塞。
 * 这里把触发条件、问法边界(与开场纪律合并成一次,不连问两轮)与"不再提"都钉住。
 */
describe("起笔纪律(世界书/大纲/约束都没有时先问再写)", () => {
	it("写作 agent:三样都空才触发 + 先问再写 + 具体到点", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("起笔纪律");
		expect(main).toContain("都没有内容");
		expect(main).toContain("世界书");
		expect(main).toContain("发展线");
		expect(main).toContain("写作约束");
		expect(main).toContain("先问再写");
		// 问要问到点上(哪几个条目/什么样的大纲/哪几条约束),而不是空问一句"要不要补"
		expect(main).toContain("具体到点");
	});

	it("不阻塞动笔:用户说直接写就写,且同一场对话不再提", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("用户说直接写就写");
		expect(main).toContain("同一场对话里不许再提");
		// 三样里任何一样有内容都不提(免得每本书都被问一遍)
		expect(main).toContain("任意一样有内容");
	});

	it("与开场纪律合并成一次问询(新书不会被连问两轮)", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("合并成一次问询");
	});

	it("编剧:同一条纪律按它的权限改写(设定归导演,建议走 advice.md)", () => {
		const editor = loadPromptText("writer-editor.md");
		expect(editor).toContain("起笔纪律");
		// 它写不了世界书:指出归属,并落 advice.md 交导演
		expect(editor).toContain("advice.md");
		expect(editor).toContain("归导演");
		// 同样不阻塞:用户让直接写就写,不再提
		expect(editor).toContain("直接写就写");
	});
});
