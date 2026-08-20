import { Type, type Static } from "typebox";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../../vendor/pi-coding-agent/src/index.ts";
import { resolveSkillsDir, slugify } from "../config.ts";
import { ensureWorld, type WorldData } from "../world-data.ts";
import { loadPromptText, renderPrompt } from "../prompts.ts";
import { wordCountTool, worldFindTool, worldUpdateTool } from "../tools.ts";
import { resolveWorldRefs } from "./assembler.ts";
import { loadScript, reviseScript, saveScript } from "./script-store.ts";
import { type ActorSpec, type ActorText, type InjectRule, type SceneScript, type ScriptPatch } from "./types.ts";
import type { RoleSpec, StageOrchestrator } from "./orchestrator.ts";

/**
 * 舞台区扩展工厂：导演/演员/编剧三种角色的会话装配（系统提示 + 工具 + "context" 钩子）。
 *
 * 角色提示词外置在 prompts/*.md(2026-08-12,与 skills 同目录模式);带路径占位的
 * 用 {SKILLS_PATH} 渲染(相对路径会解析到书目录内,守卫只读放行 skills 目录——
 * 必须给绝对路径模型才读得到,2026-08-11 实测)。
 *
 * "context" 事件即 transformContext（每次 LLM 调用前重写消息列表）——模块化
 * 消息队列的挂载点：每次调用前重装 [舞台切片 | 剧本文字段 | 计数块]。
 */

/** 剧本写作手册的绝对路径（注入提示用）：相对路径会解析到书目录内（不存在），
 *  守卫对 skills 目录只读放行——必须给绝对路径模型才读得到（2026-08-11 实测）。 */
export function scriptWritingManualPath(): string {
	return `${resolveSkillsDir()}/stage-scripting/SKILL.md`;
}

const DIRECTOR_PROMPT_TEMPLATE = loadPromptText("director.md");
const ACTOR_PROMPT = loadPromptText("actor.md");
const NARRATOR_PROMPT = loadPromptText("narrator.md");
const WRITER_PROMPT = loadPromptText("writer-scene.md");

/** 导演提示词(渲染 {SKILLS_PATH} 为剧本写作手册绝对路径)。 */
function directorPrompt(skillsPath: string): string {
	return renderPrompt(DIRECTOR_PROMPT_TEMPLATE, { SKILLS_PATH: skillsPath });
}

/** 剧本模式注入块（scripting 模式每次调用前注入；含"必须经工具输出"状态指令）。
 *   模板外置 prompts/script-method.md;skillsDir 渲染进 {SKILLS_PATH}(注入绝对路径:
 *   相对路径会解析到书目录内,读不到——2026-08-11 实测)。 */
export function buildScriptMethodBlock(skillsDir: string): string {
	return renderPrompt(loadPromptText("script-method.md"), { SKILLS_PATH: skillsDir });
}

export function directorRole(orch: StageOrchestrator): RoleSpec {
	return {
		systemPrompt: directorPrompt(scriptWritingManualPath()),
		extensions: [{ name: "stage-director", factory: (pi) => stageDirectorExtension(pi, orch) }],
		excludeTools: ["bash"],
		activeTools: ["read", "write", "edit", "ls", "grep"],
		customTools: [scriptConfirmTool(orch), stageScriptTool(orch), stageReviseTool(orch), stageCastTool(orch), worldFindTool, worldUpdateTool, wordCountTool],
	};
}

export function actorRole(orch: StageOrchestrator, actorId: string, spec?: ActorSpec): RoleSpec {
	// 叙述者专属 prompt（角色名约定为"叙述者"）；演员第一人称思考用 low（§10.6）
	const isNarrator = orch.script?.definition.cast[actorId]?.[0] === "叙述者";
	const defaultThinking = isNarrator ? undefined : "low";
	return {
		systemPrompt: isNarrator ? NARRATOR_PROMPT : ACTOR_PROMPT,
		extensions: [{ name: `stage-actor-${actorId}`, factory: (pi) => stageActorExtension(pi, orch, actorId) }],
		noTools: "all",
		model: spec?.model,
		thinkingLevel: spec?.thinking ?? defaultThinking,
		temperature: spec?.temperature,
		topP: spec?.topP,
	};
}

export function writerRole(): RoleSpec {
	return {
		systemPrompt: WRITER_PROMPT,
		extensions: [],
		excludeTools: ["bash"],
		activeTools: ["write", "read"],
		// world_find(只读):收幕编剧查世界书条目(与常驻编剧同款,2026-08-12)
		customTools: [worldFindTool],
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
	const perActorRaw = text.perActor;
	const perActor = (perActorRaw ?? {}) as Record<string, unknown>;
	// 强制校验（2026-08-11）：perActor 缺失/空 → 报缺失；cast 演员缺演出指令 → 逐条列出。
	// 演员没有 objective/examples 等演出指令无法开演，这里不让静默通过。
	if (!perActorRaw || typeof perActorRaw !== "object" || Array.isArray(perActorRaw) || Object.keys(perActor).length === 0) {
		errors.push(
			"text.perActor 缺失或为空：必须为每个参演角色提供演出指令（actorId → {objective 必填, state?, relation?, voice?, boundary?, examples?}）",
		);
	} else {
		for (const actorId of Object.keys(cast)) {
			if (!(actorId in perActor)) {
				errors.push(`演员 ${actorId} 缺少演出指令：text.perActor.${actorId}（objective 必填，可含 state/relation/voice/boundary/examples）`);
			}
		}
	}
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

const stageCastParameters = Type.Object({
	actor: Type.String({ description: "演员 id（如 actor-1；/cast 可查看）" }),
	model: Type.Optional(Type.String({ description: "演员使用的模型模式串（provider/id 或 pattern）" })),
	thinking: Type.Optional(Type.String({ description: "演员思考级别（off/minimal/low/medium/high/xhigh/max）" })),
	temperature: Type.Optional(Type.Number({ description: "采样温度 0..2（不传保持不变）" })),
	topP: Type.Optional(Type.Number({ description: "核采样概率 0..1（不传保持不变）" })),
});

/** 导演专属工具：调整演员编制参数（模型/思考/温度/top_p）。 */
function stageCastTool(orch: StageOrchestrator): ToolDefinition {
	return defineTool<typeof stageCastParameters, { ok: boolean; actor?: unknown }>({
		name: "stage_cast",
		label: "设定演员参数",
		description:
			"为演员池中的某个演员设置模型/思考级别/采样温度/top_p。设置写入 cast.json；已开演的演员会话会尽量即时生效，未创建会话的演员在下次开演时使用。不传的字段保持不变。",
		parameters: stageCastParameters,
		execute: async (_callId, params) => {
			const result = await orch.updateActorSpec(params.actor, {
				...(params.model !== undefined ? { model: params.model } : {}),
				...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
				...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
				...(params.topP !== undefined ? { topP: params.topP } : {}),
			});
			return {
				content: [{ type: "text", text: result.text }],
				details: { ok: result.ok, ...(result.actor ? { actor: result.actor } : {}) },
			};
		},
	});
}

/** 剧本参数 → 校验 → 组装 SceneScript → 落盘 stage/<sceneId>.json（两工具共用）。 */
async function buildAndSaveScript(
	orch: StageOrchestrator,
	params: Static<typeof stageScriptParameters>,
): Promise<{ sceneId: string; script: SceneScript }> {
	const sceneId = slugify(params.scene);
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
	return { sceneId, script };
}

/** 字段级中文校验（含 inject 引用存在性）——错误带可用条目清单，模型可自我修正。 */
async function validateScriptParams(
	orch: StageOrchestrator,
	params: Static<typeof stageScriptParameters>,
	toolName: string,
): Promise<string[] | null> {
	const world = await ensureWorld(orch.bookDir);
	const fieldErrors = collectStageScriptErrors(params as unknown as Record<string, unknown>, world);
	if (fieldErrors.length > 0) {
		return [`剧本校验未通过（请修正后重新调用 ${toolName}）：\n${fieldErrors.map((e) => `· ${e}`).join("\n")}`];
	}
	return null;
}

/**
 * 导演专属工具：提交剧本 → 写 stage/<scene>.json → 置待确认（前端卡片）。
 * 用户确认（confirm_script 命令）后，stage_script 才可开演（确认门）。
 */
function scriptConfirmTool(orch: StageOrchestrator): ToolDefinition {
	return defineTool({
		name: "script_confirm",
		label: "提交剧本等待确认",
		description:
			"提交一幕戏的剧本（定义段=选角+知识面注入+规则，文字段=场景/节拍/角色任务/示例）。提交后剧本会展示给用户确认（卡片），用户确认前不得调用 stage_script 开演。选角中引用的演员若不在 cast.json 会自动补为群演槽位。注入与校验容错：世界书引用接受 id 或名称（title），匹配不到会报错并列出可用条目。",
		parameters: stageScriptParameters,
		prepareArguments: prepareStageScriptArgs,
		execute: async (_callId, params) => {
			const sceneId = slugify(params.scene);
			const errors = await validateScriptParams(orch, params, "script_confirm");
			if (errors) {
				return { content: [{ type: "text", text: errors[0] }], details: { sceneId, ok: false } };
			}
			const { script } = await buildAndSaveScript(orch, params);
			const result = await orch.submitScript(sceneId);
			return {
				content: [
					{
						type: "text",
						text: result.ok
							? `剧本已提交（${script.scene} v${script.version}），等待用户确认。确认后请调用 stage_script 开演。`
							: result.text,
					},
				],
				details: { sceneId, ok: result.ok },
			};
		},
	});
}

/** 导演专属工具：开演（确认门后可用——剧本须先 script_confirm 提交并经用户确认）。 */
function stageScriptTool(orch: StageOrchestrator): ToolDefinition {
	return defineTool({
		name: "stage_script",
		label: "开演一幕",
		description:
			"开演一幕戏（需用户已确认剧本：先用 script_confirm 提交，用户确认后本工具才可用）。选角中引用的演员若不在 cast.json 会自动补为群演槽位。",
		parameters: stageScriptParameters,
		prepareArguments: prepareStageScriptArgs,
		execute: async (_callId, params) => {
			const sceneId = slugify(params.scene);
			const errors = await validateScriptParams(orch, params, "stage_script");
			if (errors) {
				return { content: [{ type: "text", text: errors[0] }], details: { sceneId, ok: false } };
			}
			const { sceneId: savedSceneId, script } = await buildAndSaveScript(orch, params);
			const result = await orch.startScene(savedSceneId);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `未开演：\n${result.errors.join("\n")}` }],
					details: { sceneId: savedSceneId, ok: false },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `开演：${script.scene}（v${script.version}：${script.definition.rules.minLines}-${script.definition.rules.maxLines} 条，收尾窗口 ${script.definition.rules.wrapUpWindow} 条）`,
					},
				],
				details: { sceneId: savedSceneId, ok: true },
			};
		},
	});
}
