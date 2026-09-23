/**
 * 供应商列表的纯逻辑:左栏行的过滤/计数/行内小字、以及"这个供应商能不能填 API key"。
 *
 * 为什么单独一个模块:web 侧没有 jsdom,组件渲染测不了,项目惯例是把判定逻辑抽成
 * 纯函数再单测(同 `settings-page.tsx` 的 `pickFallbackModel`、`Select` 的 `select-logic.ts`)。
 *
 * **排序不在这一层做** —— `/api/providers` 已经按「已配置优先 → id 字母序」返回
 * (后端 `src/web/provider-auth.ts` 的 `sortProviders`)。前端只过滤、不重排,
 * 免得两边各有一套口径。
 */
import type { ProviderInfo } from "./types.ts";

/** 按 id / name 做大小写不敏感的包含匹配;空查询原样返回(保持后端顺序)。 */
export function filterProviders(providers: readonly ProviderInfo[], query: string): ProviderInfo[] {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return [...providers];
	return providers.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
}

/** 计数:左栏标题与页脚用。 */
export function providerCounts(providers: readonly ProviderInfo[]): { total: number; configured: number } {
	let configured = 0;
	for (const p of providers) if (p.configured) configured += 1;
	return { total: providers.length, configured };
}

/**
 * 左栏标题。**不再写「已配置 N」** —— 左栏现在列全部,标题得如实说清
 * "总共几个"和"其中几个配了",否则用户又会以为列表不全是 bug。
 */
export function providerCountLabel(counts: { total: number; configured: number }): string {
	if (counts.total === 0) return "供应商";
	return `供应商 ${counts.total} · 已配置 ${counts.configured}`;
}

/**
 * 该供应商能不能写 API key。
 * `oauth`(如 openai-codex)与 `ambient`(环境变量/本机凭据)都不能 —— 后端
 * `POST /api/providers/:id/apikey` 对这两种直接 400(`server.ts` 的 authKind 校验),
 * 前端再给输入框就是骗人。
 */
export function providerCanHoldApiKey(authKind: ProviderInfo["authKind"]): boolean {
	return authKind === "api_key" || authKind === "both";
}

/** 当前模型引用("provider/id")属于该供应商时返回模型 id,否则 null。 */
export function currentModelOf(current: string | null, providerId: string): string | null {
	if (!current) return null;
	const sep = current.indexOf("/");
	if (sep < 0) return null;
	return current.slice(0, sep) === providerId ? current.slice(sep + 1) : null;
}

/** 左栏行内小字:已配置显示当前用的模型,未配置显示 authKind 的归属(id 对用户没意义,但比空白强)。 */
export function providerRowSub(provider: ProviderInfo, currentModel: string | null): string {
	const used = currentModelOf(currentModel, provider.id);
	if (used) return used;
	if (provider.configured) return "未选择模型";
	if (!providerCanHoldApiKey(provider.authKind)) return provider.authKind === "oauth" ? "OAuth 登录" : "本机凭据";
	return "未配置";
}

/**
 * 未配置供应商的右栏该说什么。
 * 返回 null = 可以填 key(渲染输入框);返回字符串 = 替代输入框的那行说明。
 */
export function unconfiguredHint(provider: ProviderInfo): string | null {
	if (provider.authKind === "oauth") return "该供应商用 OAuth 登录,Web 界面暂不支持,请在命令行里登录后回到这里。";
	if (provider.authKind === "ambient") return "该供应商用本机环境变量或已有凭据,无需在这里配置。";
	return null;
}
