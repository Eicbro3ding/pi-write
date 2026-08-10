import type { AuthInteraction, AuthPrompt, Provider } from "../../vendor/pi-ai/src/index.ts";

export type ProviderAuthKind = "api_key" | "oauth" | "both" | "ambient";

export interface ProviderListItem {
	id: string;
	name: string;
	configured: boolean;
	authKind: ProviderAuthKind;
	source?: string;
	label?: string;
}

/** 按 Provider.auth 形状推导认证种类:apiKey.login 存在与否 + oauth 存在与否。 */
export function deriveAuthKind(provider: Pick<Provider, "auth">): ProviderAuthKind {
	const hasKeyLogin = Boolean(provider.auth.apiKey?.login);
	const hasOauth = Boolean(provider.auth.oauth);
	if (hasKeyLogin && hasOauth) return "both";
	if (hasOauth) return "oauth";
	if (hasKeyLogin) return "api_key";
	return "ambient";
}

/** 多提示/非 secret 提示的拒绝错误(服务端路由映射为 400)。 */
export class ProviderAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderAuthError";
	}
}

/**
 * web 版 AuthInteraction:只接受一次 secret 提示(即 API key)。
 * 第二个提示(cloudflare 类 provider 的 account ID 等)→ 拒绝并给出引导文案。
 */
export function createKeyInteraction(key: string): AuthInteraction {
	let used = false;
	return {
		prompt: async (prompt: AuthPrompt): Promise<string> => {
			if (used || prompt.type !== "secret") {
				throw new ProviderAuthError(
					"该 provider 需要额外配置(如 account ID),请用 TUI /login 或手动编辑 ~/.pi/writer/agent/auth.json",
				);
			}
			used = true;
			return key;
		},
		notify: () => {},
	};
}

/** 已配置置顶,组内按 id 字典序。 */
export function sortProviders<T extends { configured: boolean; id: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => {
		if (a.configured !== b.configured) return a.configured ? -1 : 1;
		return a.id.localeCompare(b.id);
	});
}
