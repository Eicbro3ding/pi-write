import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";
import { DEEPSEEK_MODELS } from "./deepseek.models.ts";

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
 * 为什么不"三态":vendor 的 `Model.reasoning` 是布尔值,而 clamp 逻辑
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

/** 从 DeepSeek 官方 /models 接口拉取在线模型列表,并保留静态目录中已有的元数据。 */
async function fetchDeepSeekModels(context: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	const credential = context.credential;
	if (!credential || credential.type !== "api_key" || !credential.key) return [];
	const response = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${credential.key}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`DeepSeek models request failed: ${response.status} ${response.statusText}`);
	}
	const body = (await response.json()) as { data?: Array<{ id: string }> };
	const known = DEEPSEEK_MODELS as Record<string, Model<"openai-completions">>;
	// 静态目录收录的模型保留其精确元数据(reasoning / thinkingLevelMap / 价格 / 窗口)
	return (body.data ?? []).map((item) => known[item.id] ?? deepSeekDynamicModel(item.id));
}

export function deepseekProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: DEEPSEEK_BASE_URL,
		auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
		models: Object.values(DEEPSEEK_MODELS),
		fetchModels: fetchDeepSeekModels,
		api: openAICompletionsApi(),
	});
}
