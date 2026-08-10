import { Type, type Static } from "typebox";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../../vendor/pi-coding-agent/src/index.ts";
import { slugify } from "../config.ts";
import { ensureWorld, type WorldData } from "../world-data.ts";
import { wordCountTool, worldFindTool, worldUpdateTool } from "../tools.ts";
import { resolveWorldRefs } from "./assembler.ts";
import { loadScript, reviseScript, saveScript } from "./script-store.ts";
import { type ActorText, type InjectRule, type SceneScript, type ScriptPatch } from "./types.ts";
import type { RoleSpec, StageOrchestrator } from "./orchestrator.ts";

/**
 * 舞台区扩展工厂：导演/演员/编剧三种角色的会话装配（系统提示 + 工具 + "context" 钩子）。
 *
 * "context" 事件即 transformContext（每次 LLM 调用前重写消息列表）——模块化
 * 消息队列的挂载点：每次调用前重装 [舞台切片 | 剧本文字段 | 计数块]。
 */

const DIRECTOR_PROMPT = `你是「导演」，一部小说的创作负责人。你处于三种模式之一（系统会提示你当前模式）：
· 讨论模式（开演前）：与用户讨论剧情走向、人物设定、大纲；维护世界书（world_find 查询 / world_update 修改角色、世界观、时间线、大纲等条目）。
· 剧本模式（写剧本中，可主动进入）：与用户一起写剧本——剧本必须通过 stage_script 工具调用输出（结构化字段），禁止直接输出剧本文本。文字段 = 场景意象 / 节拍（事件序列，不是台词稿）/ 角色任务（objective：角色想要什么，不是性格标签）/ 风格示例（禁止复述）。完整方法论可 read skills/stage-scripting/SKILL.md。
· 导演模式（演出中）：观看实时注入的舞台区，与用户讨论演出效果，可示意收尾、喊停、修订剧本。
你决定每个演员知道什么：定义段 inject 指定注入哪些世界书节点（include-only——没指定的演员不知道，信息差即悬念）。一幕演完（编剧成文）后更新世界书与大纲。`;

const ACTOR_PROMPT = `你是「演员」，在一幕共演的舞台戏中饰演角色。规则：
1. **第一人称代入**：思考时以角色第一人称代入（"我是李四。我想要……"）——你的思考链是角色的内心，绝不写进演出内容；
2. 每次轮到你时，舞台提示会告知你饰演的角色；只演自己：自己的台词、动作、神态、内心；可**提及**他人（作为你台词/动作的对象："店小二，上酒"），**不代演**他人（不给他写台词、不描写其动作反应）；环境描写留给叙述者；
3. 无话可说时**优先输出动作/神态描写**（如（垂着眼，摩挲着杯沿）），确无行动可演才输出 <pass>；<pass> 不用于回避剧情推进；
4. 上下文里的【场务·演员不可在演出中提及此信息】是制作信息，绝不能在演出内容中提及；
5. 剧本演出指令是你的表演依据；若收到「提示收尾」，请在剩余条数内自然收束本角色。`;

/** 叙述者专属（场景描写/环境/龙套代演，§10.4）。 */
const NARRATOR_PROMPT = `你是「叙述者」，负责舞台的场景描写、氛围与无专属演员的龙套代演。规则：
1. 以第一人称代入"这场戏的镜头"，描写环境、光线、声音、物件与群像氛围；
2. **代演龙套**：一句台词的无主龙套由你代演，输出"店小二：好嘞"格式（对白归属该角色名）；
3. 不描写主要角色的内心（那是他们的隐私），只写可观察的外在：动作、神态、位置；
4. 你的描写用括号包裹（（烛火晃了一下。）），输出可直接进转录；
5. 上下文里的【场务】信息是制作信息，绝不能在演出内容中提及。`;

const WRITER_PROMPT = `你是「编剧」。你的唯一职责：把舞台区转录整理成正文小说——去掉对白标签与舞台指示，叙述化、连贯成文；**参考【剧本·角色内心】与【世界书】把潜台词与心理矛盾写进正文**（角色没说出口的内心，由导演声明的 state 与世界书提供）。整理完成后用 write 工具写入指定路径。`;

/** 剧本模式注入块（scripting 模式每次调用前注入；含"必须经工具输出"状态指令）。 */
export const SCRIPT_METHOD_BLOCK = `【剧本写作方法·你在剧本模式】
· 你写剧本必须通过 stage_script 工具调用输出，禁止直接输出剧本文本
· objective 写角色的欲望（想要什么），不是性格标签
· beats 是事件序列（必须发生什么），不是台词稿；措辞留给演员
· examples 是风格演示：最多 2-3 轮，禁止与剧情内容重复，演员不得复述
· forbidden 只写硬禁区，别超过 3 条
· perActor 的 id 必须与 cast 的演员 id 一致；世界书引用可传 id 或名称（title）
· 分幕目标对齐世界书大纲；开演前检查选角约束（一幕一人一角）
· 完整方法论与示例剧本：read skills/stage-scripting/SKILL.md（必要时查阅）`;

export function directorRole(orch: StageOrchestrator): RoleSpec {
	return {
		systemPrompt: DIRECTOR_PROMPT,
		extensions: [{ name: "stage-director", factory: (pi) => stageDirectorExtension(pi, orch) }],
		excludeTools: ["bash"],
		activeTools: ["read", "write", "edit", "ls", "grep"],
		customTools: [stageScriptTool(orch), stageReviseTool(orch), worldFindTool, worldUpdateTool, wordCountTool],
	};
}

export function actorRole(orch: StageOrchestrator, actorId: string): RoleSpec {
	// 叙述者专属 prompt（角色名约定为"叙述者"）；演员第一人称思考用 low（§10.6）
	const isNarrator = orch.script?.definition.cast[actorId]?.[0] === "叙述者";
	return {
		systemPrompt: isNarrator ? NARRATOR_PROMPT : ACTOR_PROMPT,
		extensions: [{ name: `stage-actor-${actorId}`, factory: (pi) => stageActorExtension(pi, orch, actorId) }],
		noTools: "all",
		thinkingLevel: isNarrator ? undefined : "low",
	};
}

export function writerRole(): RoleSpec {
	return {
		systemPrompt: WRITER_PROMPT,
		extensions: [],
		excludeTools: ["bash"],
		activeTools: ["write", "read"],
	};
}

function stageDirectorExtension(pi: ExtensionAPI, orch: StageOrchestrator): void {
	pi.on("context", async (event) => {
		const result = await orch.directorContext(event.messages);
		return result ? { messages: result } : undefined;
	});
	// 工具完成信号：stage_script 调用即切剧本模式（强信号），一致性检测据此核对
	pi.on("tool_result", (event) => {
		orch.onDirectorToolResult(event.toolName);
	});
}

function stageActorExtension(pi: ExtensionAPI, orch: StageOrchestrator, actorId: string): void {
	pi.on("context", async (event) => {
		const result = await orch.actorContext(actorId, event.messages);
		return result ? { messages: result } : undefined;
	});
}

/**
 * 宽容解析（prepareArguments 垫片，schema 校验前运行——2026-08-09）：
 * 模型常以奇怪格式传参（旧版本实测：数组/字符串混用、缺字段、id/名称反复试错）。
 * 只修"确定可安全修复"的：
 *   - beats/forbidden/examples 传字符串 → 按 | 或换行 split 成数组
 *   - shared 缺字段补空值（校验有默认）
 *   - perActor 传成数组 → 不可安全修复，throw 中文错误（带正确格式示例）
 */
export function prepareStageScriptArgs(raw: unknown): Static<typeof stageScriptParameters> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(
			"stage_script 参数必须是对象（scene/chapter/cast/text/rules 字段）。当前收到的参数无法解析，请重新以工具参数 JSON 格式调用。",
		);
	}
	const args = raw as Record<string, unknown>;
	const text = (args.text ?? {}) as Record<string, unknown>;
	const shared = (text.shared ?? {}) as Record<string, unknown>;
	const perActor = text.perActor;
	if (Array.isArray(perActor)) {
		throw new Error(
			"text.perActor 必须是对象（演员 id → 字段），你传了数组。格式：{'actor-1': {'objective': '角色想要什么', 'examples': ['示例对白1', '示例对白2']}}",
		);
	}
	const splitArray = (v: unknown): string[] => {
		if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
		if (typeof v === "string") return v.split(/[|\n]/).map((s) => s.trim()).filter(Boolean);
		return [];
	};
	const fixedPerActor: Record<string, unknown> = {};
	for (const [actorId, fields] of Object.entries((perActor ?? {}) as Record<string, unknown>)) {
		if (typeof fields !== "object" || fields === null) {
			// 字段整体不是对象：留给 collectStageScriptErrors 报中文错误（不静默丢）
			fixedPerActor[actorId] = fields;
			continue;
		}
		const f = fields as Record<string, unknown>;
		fixedPerActor[actorId] = { ...f, examples: splitArray(f.examples) };
	}
	return {
		...args,
		text: {
			...text,
			shared: {
				setting: typeof shared.setting === "string" ? shared.setting : "",
				goal: typeof shared.goal === "string" ? shared.goal : "",
				beats: splitArray(shared.beats),
				tone: typeof shared.tone === "string" ? shared.tone : "",
				forbidden: splitArray(shared.forbidden),
			},
			perActor: fixedPerActor,
		},
	} as Static<typeof stageScriptParameters>;
}

/**
 * 字段级中文校验（execute 前置，2026-08-09）：
 * 每条错误 = 位置 + 收到的值 + 期望格式 + 怎么找到正确值；并列出世界书
 * 现有条目（id+title）——模型看到就能自我修正，而不是反复试错。
 */
export function collectStageScriptErrors(
	params: Record<string, unknown>,
	world: WorldData,
): string[] {
	const errors: string[] = [];
	const cast = (params.cast ?? {}) as Record<string, unknown>;
	const text = (params.text ?? {}) as Record<string, unknown>;
	const perActor = (text.perActor ?? {}) as Record<string, unknown>;
	for (const [actorId, fields] of Object.entries(perActor)) {
		if (typeof fields !== "object" || fields === null) {
			errors.push(`text.perActor.${actorId} 必须是对象（objective/state/relation/voice/boundary/examples 字段），你传了：${JSON.stringify(fields)}`);
			continue;
		}
		const f = fields as Record<string, unknown>;
		if (!(actorId in cast)) {
			const castIds = Object.keys(cast).join("、") || "（空）";
			errors.push(`text.perActor.${actorId} 不在选角表中（当前演员：${castIds}）。perActor 的 id 必须与 cast 的演员 id 一致`);
		}
		if (typeof f.objective !== "string" || f.objective.trim() === "") {
			errors.push(`text.perActor.${actorId} 缺少 objective（角色任务：角色想要什么，如「证明自己还清了债」）`);
		}
		if (Array.isArray(f.examples) && f.examples.length > 3) {
			errors.push(`text.perActor.${actorId}.examples 最多 3 轮风格示例（当前 ${f.examples.length} 轮）`);
		}
	}
	// inject 引用存在性（双通道容错：id/名称/keys 均可；仍匹配不到才报错并列出可用条目）
	const inject = (params.inject ?? {}) as Record<string, unknown>;
	for (const [actorId, rule] of Object.entries(inject)) {
		const r = rule as { characters?: string[]; world?: string[] } | undefined;
		const refs = [...(r?.characters ?? []), ...(r?.world ?? [])];
		if (refs.length === 0) continue;
		const { matched, missing } = resolveWorldRefs(world, refs);
		const unusable = matched.filter((e) => e.type !== "character" && e.type !== "world");
		const problems: string[] = [];
		if (missing.length > 0) problems.push(`未匹配到条目：${missing.join("、")}`);
		if (unusable.length > 0) {
			problems.push(`类型不可注入（仅 character/world 可注入）：${unusable.map((e) => `${e.title}(${e.type})`).join("、")}`);
		}
		if (problems.length > 0) {
			const candidates = world.entries
				.filter((e) => e.type === "character" || e.type === "world")
				.map((e) => `${e.title}(id:${e.id})`)
				.join("、");
			errors.push(
				`inject[${actorId}]：${problems.join("；")}。工具接受 id 或名称（title）均可，当前世界书可注入条目：${candidates || "（无）"}。可用 world_find 查询`,
			);
		}
	}
	return errors;
}

const stageScriptParameters = Type.Object({
	scene: Type.String({ description: "场景名（将作为 scene id，如 第一章·酒馆初遇）" }),
	chapter: Type.String({ description: "章节名，如 第一章" }),
	cast: Type.Record(Type.String(), Type.Array(Type.String()), {
		description: "选角表：演员 id → 该演员饰演的角色（一幕一人一角，同场角色不同演员）",
	}),
	inject: Type.Optional(
		Type.Record(Type.String(), Type.Object({
			characters: Type.Optional(Type.Array(Type.String({ description: "注入的角色条目引用（接受 id 或名称，如 c1 或 李四）" }))),
			world: Type.Optional(Type.Array(Type.String({ description: "注入的世界条目引用（接受 id 或名称/关键词，如 酒馆）" }))),
			budget: Type.Optional(Type.Integer({ description: "注入量上界 token（默认 2000）" })),
		}), {
			description:
				"演员知识面：导演指定注入哪些世界书节点（include-only；未指定的演员不知道——信息差即悬念）。缺省自动按 cast 角色名生成",
		}),
	),
	text: Type.Object({
		shared: Type.Object({
			setting: Type.String({ description: "场景意象清单（氛围/关键物件/空间感，非完整描写）" }),
			goal: Type.Optional(Type.String({ description: "本幕最高任务" })),
			beats: Type.Optional(Type.Array(Type.String({ description: "事件序列：必须发生什么，不是台词稿" }))),
			tone: Type.Optional(Type.String({ description: "基调（节奏/情绪/留白）" })),
			forbidden: Type.Optional(Type.Array(Type.String({ description: "硬禁区（≤3 条）" }))),
		}),
		perActor: Type.Optional(
			Type.Record(Type.String(), Type.Object({
				objective: Type.String({ description: "角色任务：角色想要什么（斯坦尼式，非性格标签）" }),
				state: Type.Optional(Type.String({ description: "本幕内心状态" })),
				relation: Type.Optional(Type.String({ description: "与在场角色的关系动态" })),
				voice: Type.Optional(Type.String({ description: "说话方式（语速/句式/口头禅）" })),
				boundary: Type.Optional(Type.String({ description: "演出边界（每轮上限/潜台词要求）" })),
				examples: Type.Optional(Type.Array(Type.String({ description: "风格示例 2-3 轮；禁止与剧情重复，演员不得复述" }))),
			}), {
				description: "定向演出指令：演员 id → 结构化字段（角色任务/状态/关系/示例）",
			}),
		),
	}),
	rules: Type.Optional(
		Type.Object({
			minLines: Type.Optional(Type.Integer({ description: "对话条数下限（默认 10）" })),
			maxLines: Type.Optional(Type.Integer({ description: "对话条数上限（默认 20）" })),
			wrapUpWindow: Type.Optional(Type.Integer({ description: "收尾窗口条数（默认 3）" })),
		}),
	),
});

const stageReviseParameters = Type.Object({
	scene: Type.Optional(Type.String({ description: "场景名（缺省当前在演的一幕）" })),
	text: Type.Optional(
		Type.Object({
			shared: Type.Optional(
				Type.Object({
					setting: Type.Optional(Type.String()),
					goal: Type.Optional(Type.String()),
					beats: Type.Optional(Type.Array(Type.String())),
					tone: Type.Optional(Type.String()),
					forbidden: Type.Optional(Type.Array(Type.String())),
				}),
			),
			perActor: Type.Optional(
				Type.Record(Type.String(), Type.Object({
					objective: Type.Optional(Type.String()),
					state: Type.Optional(Type.String()),
					relation: Type.Optional(Type.String()),
					voice: Type.Optional(Type.String()),
					boundary: Type.Optional(Type.String()),
					examples: Type.Optional(Type.Array(Type.String())),
				})),
			),
		}),
	),
	rules: Type.Optional(
		Type.Object({
			minLines: Type.Optional(Type.Integer()),
			maxLines: Type.Optional(Type.Integer()),
			wrapUpWindow: Type.Optional(Type.Integer()),
		}),
	),
});

/** 导演专属工具：修订当前剧本（字段级合并，版本 +1；不触发开演——精准重演的修订侧）。 */
function stageReviseTool(orch: StageOrchestrator): ToolDefinition {
	return defineTool<typeof stageReviseParameters, { ok: boolean; sceneId?: string; version?: number }>({
		name: "stage_revise",
		label: "修订当前剧本",
		description:
			"修订一幕正在演出的剧本（字段级合并：只改提供的字段，其余不动；数组字段整体替换）。版本 +1，下一轮演出生效。用于用户反馈 OOC/不满意后修正 objective/voice/examples/beats 等。",
		parameters: stageReviseParameters,
		prepareArguments: (raw) => {
			// 与 stage_script 同款宽容：数组字段字符串 → split
			if (typeof raw !== "object" || raw === null) throw new Error("stage_revise 参数必须是对象");
			const args = raw as Record<string, unknown>;
			const text = (args.text ?? {}) as Record<string, unknown>;
			const shared = (text.shared ?? {}) as Record<string, unknown>;
			const splitArray = (v: unknown): string[] => {
				if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
				if (typeof v === "string") return v.split(/[|\n]/).map((s) => s.trim()).filter(Boolean);
				return [];
			};
			return {
				...args,
				text: {
					...text,
					shared: shared
						? {
								setting: typeof shared.setting === "string" ? shared.setting : undefined,
								goal: typeof shared.goal === "string" ? shared.goal : undefined,
								beats: shared.beats ? splitArray(shared.beats) : undefined,
								tone: typeof shared.tone === "string" ? shared.tone : undefined,
								forbidden: shared.forbidden ? splitArray(shared.forbidden) : undefined,
							}
						: undefined,
					perActor: text.perActor ?? undefined,
				},
			} as Static<typeof stageReviseParameters>;
		},
		execute: async (_callId, params) => {
			const sceneId = params.scene ? slugify(params.scene) : orch.sceneId;
			if (!sceneId) {
				return {
					content: [{ type: "text", text: "当前没有在演的一幕，无法修订。请先 stage_script 开一幕。" }],
					details: { ok: false },
				};
			}
			const script = await loadScript(orch.bookDir, sceneId);
			if (!script) {
				return { content: [{ type: "text", text: `剧本不存在：${sceneId}` }], details: { ok: false } };
			}
			const patch: ScriptPatch = {
				text: params.text,
				rules: params.rules,
			};
			const revised = reviseScript(script, patch);
			await saveScript(orch.bookDir, sceneId, revised);
			// 编排器内存态同步（下一轮演出生效）
			if (orch.sceneId === sceneId) orch.applyScriptUpdate(revised);
			return {
				content: [{ type: "text", text: `剧本已修订 → v${revised.version}（${sceneId}），下一轮生效。` }],
				details: { sceneId, version: revised.version, ok: true },
			};
		},
	});
}

/** 导演专属工具：编写剧本 → 写 stage/<scene>.json → 回调编排器开演。 */
function stageScriptTool(orch: StageOrchestrator): ToolDefinition {
	return defineTool({
		name: "stage_script",
		label: "编写剧本开一幕",
		description:
			"编写一幕戏的剧本（定义段=选角+知识面注入+规则，文字段=场景/节拍/角色任务/示例），写入后立即开演。选角中引用的演员若不在 cast.json 会自动补为群演槽位。注入与校验容错：世界书引用接受 id 或名称（title），匹配不到会报错并列出可用条目。",
		parameters: stageScriptParameters,
		prepareArguments: prepareStageScriptArgs,
		execute: async (_callId, params) => {
			const sceneId = slugify(params.scene);
			// 字段级中文校验（含 inject 引用存在性）——错误带可用条目清单，模型可自我修正
			const world = await ensureWorld(orch.bookDir);
			const fieldErrors = collectStageScriptErrors(params as unknown as Record<string, unknown>, world);
			if (fieldErrors.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `剧本校验未通过（请修正后重新调用 stage_script）：\n${fieldErrors.map((e) => `· ${e}`).join("\n")}`,
						},
					],
					details: { sceneId, ok: false },
				};
			}
			const rules = {
				minLines: params.rules?.minLines ?? 10,
				maxLines: params.rules?.maxLines ?? 20,
				wrapUpWindow: params.rules?.wrapUpWindow ?? 3,
				turn: "round-robin" as const,
			};
			// 演员知识面：导演显式 inject 优先；缺省按 cast 角色名自动生成
			// （character 注入 + budget 2000）——信息差即悬念，导演可借此
			// 决定演员知道什么（include-only，见设计文档 §5.1）。
			const inject: Record<string, InjectRule> = {};
			for (const [actorId, characters] of Object.entries(params.cast)) {
				const custom = params.inject?.[actorId];
				inject[actorId] = custom
					? { characters: custom.characters ?? characters, world: custom.world, budget: custom.budget ?? 2000 }
					: { characters, budget: 2000 };
			}
			const shared = {
				setting: params.text.shared.setting,
				goal: params.text.shared.goal ?? "",
				beats: params.text.shared.beats ?? [],
				tone: params.text.shared.tone ?? "",
				forbidden: params.text.shared.forbidden ?? [],
			};
			const perActor: Record<string, ActorText> = {};
			for (const [actorId, fields] of Object.entries(params.text.perActor ?? {})) {
				perActor[actorId] = {
					objective: fields.objective,
					state: fields.state,
					relation: fields.relation,
					voice: fields.voice,
					boundary: fields.boundary,
					examples: fields.examples ?? [],
				};
			}
			const script: SceneScript = {
				scene: params.scene,
				chapter: params.chapter,
				version: 1,
				definition: { cast: params.cast, inject, rules },
				text: { shared, perActor },
			};
			await saveScript(orch.bookDir, sceneId, script);
			const result = await orch.startScene(sceneId);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `剧本校验未通过，未开演：\n${result.errors.join("\n")}` }],
					details: { sceneId, ok: false },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `剧本已写入 stage/${sceneId}.json 并开演（v1：${rules.minLines}-${rules.maxLines} 条，收尾窗口 ${rules.wrapUpWindow} 条）`,
					},
				],
				details: { sceneId, ok: true },
			};
		},
	});
}
