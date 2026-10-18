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
describe("开篇纪律(新书还没定风格时的一次性提议)", () => {
	it("写作 agent:触发条件 + 只提一次 + 指向 onboarding 剧本", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("开篇纪律");
		expect(main).toContain("还没定风格");
		expect(main).toContain("【写作约束】");
		// 2026-10-05:采样已移出所有上下文块,判断「有没有」的唯一入口是 read_style
		// ——原先这里断言的是 `【文风采样】` 那个块名,而它现在不该出现在这个入口的判据里了。
		expect(main).toContain("`read_style` 查回来也说没有文风采样");
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

	it("导演:开篇纪律 + 落盘纪律 + 剧本路径占位", () => {
		const director = loadPromptText("director.md");
		expect(director).toContain("开篇纪律");
		expect(director).toContain("{STYLE_SETUP_PATH}");
		expect(director).toContain("长期偏好必须落盘");
	});

	it("编剧:提议后当场用 style_update 落盘(不再只是写 advice.md 等导演)", () => {
		const editor = loadPromptText("writer-editor.md");
		expect(editor).toContain("开篇纪律");
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

	it("画像(user.md)有写入触发纪律:两个入口都给出「换一本书还算不算数」的判据", () => {
		// 回归 2026-10-15:「长期偏好必须落盘」此前只有「写进世界书」这一个出口,
		// 而 user.md 有说明段(怎么用)、memory 工具描述有写法,却**没有任何一句**
		// 说什么时候该往里写 —— 实测后果是 AI 一直写 memory.md、从不写画像。
		// 判据必须落在提示词里,否则又会漂回去(提示词没有别的测试钉)。
		for (const f of ["writer-main.md", "writer-editor.md"]) {
			const text = loadPromptText(f);
			expect(text, f).toContain("换一本书");
			expect(text, f).toContain('target="user"');
			expect(text, f).toContain("不是只读的");
			// 另一侧出口仍在(立约束),否则会矫枉过正成「什么都写画像」
			expect(text, f).toContain("style_update");
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
		expect(main).toContain("开篇纪律");
		expect(main).toContain("还没有可依的设定");
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
		// 2026-10-07:开篇纪律合并后,共同前提提到节首,措辞为「用户让你直接写就写」
		expect(main).toContain("用户让你直接写就写");
		expect(main).toContain("同一场对话里不许再提");
		// 三样里任何一样有内容都不提(免得每本书都被问一遍)
		expect(main).toContain("任意一样有内容");
	});

	it("与开篇纪律里的风格提议并成一次问询(新书不会被连问两轮)", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("就并成一次问询");
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

/**
 * memory.md 纪律必须**两条链路对称**(2026-10-12 用户要求:新功能同时覆盖
 * 「主对话」与「平常的编辑」)。
 *
 * 背景:memory.md 此前只在 writer-main.md 有纪律(3 处),编剧与导演提示词
 * **零提及** —— 而读侧(记忆锚)每轮把 memory.md 注入所有会话,编剧看到这个块
 * 却没有任何规则解释它、更没被要求维护它,用户体感就是「形同虚设」。
 * 这条测试钉住:凡是有 write/edit 的写作角色,都必须知道 memory.md 是什么、
 * 何时读、何时写、写在哪。
 */
describe("memory.md 纪律(主对话 ⇄ 编辑 对称)", () => {
	const roles = ["writer-main.md", "writer-editor.md", "director.md"];

	it("三个写作角色都提到 memory.md(读侧注入了,写侧就要有规则)", () => {
		for (const f of roles) {
			const text = loadPromptText(f);
			expect(text, `${f} 没提 memory.md`).toContain("memory.md");
		}
	});

	it("都讲清了「跨章记忆 + 容量约 1500 token + 装在书目录根」", () => {
		for (const f of roles) {
			const text = loadPromptText(f);
			expect(text, `${f} 没说跨章`).toContain("跨章");
			expect(text, `${f} 没说容量`).toContain("1500");
			expect(text, `${f} 没提醒不在 world.json 禁区`).toContain("禁区");
		}
	});

	it("主对话与编剧都把「状态变化必落盘」写死(死亡 → 不可复活)", () => {
		for (const f of ["writer-main.md", "writer-editor.md"]) {
			const text = loadPromptText(f);
			expect(text, `${f} 缺状态落盘纪律`).toContain("死而复生");
			expect(text, `${f} 缺死亡落盘示例`).toContain("身亡");
		}
	});

	it("导演的纪律按它的角色改写(收幕后盘点,不是动笔时)", () => {
		const d = loadPromptText("director.md");
		expect(d).toContain("跨章记忆纪律");
		expect(d).toContain("收幕后");
	});
});

/**
 * 回归护栏:记忆勤奋 + 世界书激进写入(2026-10-18 用户点名要求)。
 *
 * 背景:此前 memory.md 只在"出事"时写(人物死亡、用户给出长期指示),世界书则一律
 * 「列建议清单 → 等用户确认」。实际体感是记忆常年近空、设定永远等不到落盘,
 * memory.md 也退化成一个只装剧情的抽屉。要求三件事:
 * ① memory.md / user.md 每轮扫一遍,判不准就写;② memory.md 是工作记忆,不只装剧情;
 * ③ 世界书默认直接写,只有破坏性 / 替故事做决定 / 两处说法打架三类先问。
 * 这些都只在提示词里,没有别的测试钉 —— 不钉住就会漂回去。
 */
describe("记忆勤奋(每轮扫一遍)与世界书激进写入", () => {
	it("主对话与编剧都有「每轮扫一遍」的收尾动作,不是只在出事时写", () => {
		for (const f of ["writer-main.md", "writer-editor.md"]) {
			const text = loadPromptText(f);
			expect(text, f).toContain("每轮");
			expect(text, f).toContain("判不准就写");
			expect(text, f).toContain("流水账");
		}
	});

	it("memory.md 被定义为工作记忆,不只装剧情", () => {
		for (const f of ["writer-main.md", "writer-editor.md", "director.md"]) {
			expect(loadPromptText(f), f).toContain("工作记忆");
		}
	});

	it("世界书默认直接写,不再要求先列建议清单等确认", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("默认直接写");
		expect(main).toContain("只有三种情况先问");
		// 旧的「全量确认」写法不能回来
		expect(main).not.toContain("未经用户确认,不得写入");
		// 激进写入唯一真正的代价是近似条目 —— 必须先查重
		expect(main).toContain("查一次重");
		// 防谎报落盘:说了已写入就必须真的写过
		expect(main).toContain("必须真的写过");
		const d = loadPromptText("director.md");
		expect(d).toContain("当场用 world_update 写进去");
		expect(d).toContain("必须真的写过");
	});

	it("讨论态不写正文,但记忆与世界书照写(否则讨论出的结论全丢)", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("记忆与世界书照写");
		// 旧措辞把讨论轮写成「任何文件都不许写」,与"讨论轮也要沉淀"自相矛盾
		expect(main).not.toContain("不要创建、写入、清空或覆盖任何文件");
	});
});

/**
 * 回归护栏:正文写后核对 + 条目正文追加(2026-10-18 追加要求)。
 *
 * 「正文写了之后一定要检查里面有没有人物或东西没写进世界书、或者信息不是最新的;
 * 编辑信息要用追加,一个角色/东西的实际信息应该是动态追加的,而不是覆盖。」
 * 两条都只在提示词里(追加那半另有 `body_append` 的工具实现兜底),不钉就会漂。
 */
describe("正文写后核对与条目追加", () => {
	it("三个角色都要求写完正文回读核对(有没有条目 / 是不是最新)", () => {
		for (const f of ["writer-main.md", "writer-editor.md", "director.md"]) {
			const text = loadPromptText(f);
			expect(text, f).toContain("核对");
			expect(text, f).toContain("是不是最新");
		}
	});

	it("点明 scan 只看得见已登记条目,不能拿它当核对完成", () => {
		for (const f of ["writer-main.md", "writer-editor.md", "director.md"]) {
			expect(loadPromptText(f), f).toContain("只看得见");
		}
	});

	it("条目正文默认追加(body_append),覆盖是例外", () => {
		for (const f of ["writer-main.md", "director.md"]) {
			const text = loadPromptText(f);
			expect(text, f).toContain("body_append");
			expect(text, f).toContain("追加");
			expect(text, f).toContain("覆盖");
		}
		// 世界书是账本不是文档:这条比喻是整个追加纪律的锚
		expect(loadPromptText("writer-main.md")).toContain("账本");
		// 编剧写不了条目正文,但给导演的建议也必须是「追加到原条目」
		expect(loadPromptText("writer-editor.md")).toContain("追加到原条目");
	});
});
