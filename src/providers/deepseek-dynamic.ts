/**
 * DeepSeek **动态发现**模型的能力推断(原本住在 vendor/pi-ai,T11 迁到自研侧)。
 *
 * ## 为什么迁出来,而不是随依赖化一起丢弃
 *
 * 它修的是 BUG-003:静态目录未收录的新模型此前一律被写成 `reasoning: false`,
 * 于是刚发布的推理模型在「思考等级」里连 low 都选不到(被 clamp 回 off),而静态
 * 目录里的同代模型却有完整 `thinkingLevelMap`。**思考档位直接决定输出质量** ——
 * 按「不影响 web 与整体核心功能的自研才移除」的口径,这条属于核心,保留。
 *
 * 能干净迁出的原因:它是个**纯函数**,只依赖一个正则、一张档位表和一个 baseUrl
 * 常量,不触碰 vendor 内部的其它东西。
 *
 * ## 上游的对应物(将来若要在线拉取,走那条路)
 *
 * 上游 1.0.2 的 `pi-ai/providers/deepseek` 只有 `deepseekProvider()`(纯静态目录),
 * 没有这个能力。但上游有标准的 **provider 扩展点** `fetchModels?: (context) => ...`
 * —— 若要恢复「从 DeepSeek 官方 `/models` 拉取在线列表」,应按那个接口实现,
 * 而不是把旧的 `fetchDeepSeekModels` 从 vendor 里搬过来。
 */

import type { Model } from "../pi-adapter/index.ts";

/** DeepSeek 官方 API 地址(与静态目录的 provider 配置一致)。 */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * 动态发现的 DeepSeek 模型的能力推断(2026-10 审计 BUG-003)。
 *
 * 背景:`/models` 里出现静态目录没收录的新模型时,旧实现一律写 `reasoning: false` ——
 * 于是刚发布的推理模型在「思考等级」里连 low 都选不到(被 clamp 回 off),而静态目录里的
 * 同代模型却有完整 `thinkingLevelMap`。这里按**模型 id 的明确命名约定**给能力:
 *
 * - 命中 reasoner / reasoning / -think 命名 → 确认支持思考,并按 DeepSeek 的档位映射
 *   (仅 high / max 有实际取值,与其静态目录一致);
 * - 其余未收录模型仍在 `reasoning: false`(安全默认,不凭空宣称支持)——但这是
 *   **保守默认**,不代表供应商确认不支持;设置页在只有 off 档时会说明「该模型未声明支持
 *   思考」,自定义模型可手动打开(见 SettingsPage 的可用档位提示)。
 *
 * 为什么不"三态":`Model.reasoning` 是布尔值,而 clamp 逻辑
 * (`getSupportedThinkingLevels`)直接读它;在类型层引入 unknown 会外溢到 pi-ai 的模型
 * schema 与全部 provider。本仓库的可控做法是**能确认的确认、其余保守**,并在 UI 上把
 * 「未知」说成未知,而不是断言不支持。
 */
const REASONING_MODEL_RE = /(?:^|[-_.])(reasoner|reasoning|think(?:ing)?)(?:$|[-_.])/i;

/** DeepSeek 推理模型的思考档位映射(与静态目录的 v4 系列一致:只有 high / max 有值)。 */
const DEEPSEEK_THINKING_LEVEL_MAP = { minimal: null, low: null, medium: null, high: "high", max: "max" } as const;

/**
 * 把 `/models` 返回的**静态目录未收录**的模型 id 转成 Model(纯函数,便于单测)。
 * 推理能力按 id 命名约定判定(见 REASONING_MODEL_RE)。
 */
export function deepSeekDynamicModel(id: string): Model<"openai-completions"> {
	const isVision = id.toLowerCase().includes("vision");
	const isReasoning = REASONING_MODEL_RE.test(id);
	return {
		id,
		name: id,
		api: "openai-completions" as const,
		provider: "deepseek" as const,
		baseUrl: DEEPSEEK_BASE_URL,
		reasoning: isReasoning,
		...(isReasoning ? { thinkingLevelMap: { ...DEEPSEEK_THINKING_LEVEL_MAP } } : {}),
		input: isVision ? (["text", "image"] as const) : (["text"] as const),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		},
	};
}
