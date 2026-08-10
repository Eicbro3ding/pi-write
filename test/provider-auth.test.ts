import { describe, expect, it } from "vitest";
import { createKeyInteraction, deriveAuthKind, ProviderAuthError, sortProviders } from "../src/web/provider-auth.ts";

describe("provider-auth 纯逻辑", () => {
	it("deriveAuthKind:按 apiKey.login/oauth 存在性推导", () => {
		const keyLogin = { login: async () => ({ type: "api_key" as const, key: "k" }) };
		expect(deriveAuthKind({ auth: { apiKey: keyLogin } })).toBe("api_key");
		expect(deriveAuthKind({ auth: { apiKey: keyLogin, oauth: {} as never } })).toBe("both");
		expect(deriveAuthKind({ auth: { oauth: {} as never } })).toBe("oauth");
		expect(deriveAuthKind({ auth: { apiKey: {} } })).toBe("ambient");
	});
	it("createKeyInteraction:secret 提示返回 key,仅一次", async () => {
		const interaction = createKeyInteraction("sk-1");
		await expect(interaction.prompt({ type: "secret", message: "Enter API key" })).resolves.toBe("sk-1");
		await expect(interaction.prompt({ type: "secret", message: "Enter API key" })).rejects.toThrow(ProviderAuthError);
	});
	it("createKeyInteraction:非 secret 提示直接拒绝", async () => {
		const interaction = createKeyInteraction("sk-1");
		await expect(interaction.prompt({ type: "text", message: "Enter account ID" })).rejects.toThrow(ProviderAuthError);
		await expect(interaction.notify({ type: "progress", message: "x" })).toBeUndefined();
	});
	it("sortProviders:已配置置顶,组内 id 字典序", () => {
		const items = [
			{ id: "zai", configured: false },
			{ id: "anthropic", configured: true },
			{ id: "openai", configured: false },
		];
		expect(sortProviders(items).map((i) => i.id)).toEqual(["anthropic", "openai", "zai"]);
		expect(sortProviders([])).toEqual([]);
	});
});
