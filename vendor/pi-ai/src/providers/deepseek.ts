import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";
import { DEEPSEEK_MODELS } from "./deepseek.models.ts";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

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
	return (body.data ?? []).map((item) => {
		const existing = known[item.id];
		if (existing) return existing;
		const isVision = item.id.toLowerCase().includes("vision");
		return {
			id: item.id,
			name: item.id,
			api: "openai-completions" as const,
			provider: "deepseek" as const,
			baseUrl: DEEPSEEK_BASE_URL,
			reasoning: false,
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
	});
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
