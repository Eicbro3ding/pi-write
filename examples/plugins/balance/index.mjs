/**
 * 示例插件:余额浮窗(与 docs/plugin-development.md 配套)。
 *
 * 演示两件事:
 *  1. **声明式 windows**(plugin.json 的 frontend.ui.windows)—— 即使不开启「完全信任」,
 *     浮窗本身也会渲染出来(fields 形态的「余额提醒设置」窗口就是这样);
 *  2. **trusted 后由插件路由取数** —— 下面 `routes` 暴露 GET /api/plugins/balance/balance,
 *     浮窗用 contentKind:"data" 指向它;路由仅在 trusted 时注册,未信任时浮窗显示 404
 *     (这就是为什么真正的余额需要完全信任)。
 *
 * 取数逻辑:从 ~/.pi/writer/agent/models.json 读 provider 的 baseUrl + apiKey,
 * 调各家的余额接口(DeepSeek / OpenRouter)。key 不出机器,只在本进程内用。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** writer 根目录(随 PI_WRITER_DIR 迁移)。 */
function writerDir() {
	return process.env.PI_WRITER_DIR || join(homedir(), ".pi", "writer");
}

/** 读插件设置(settings.json;损坏按空处理)。 */
async function readSettings() {
	try {
		const raw = JSON.parse(await readFile(join(writerDir(), "plugins", "balance", "settings.json"), "utf8"));
		return typeof raw === "object" && raw !== null ? raw : {};
	} catch {
		return {};
	}
}

/** 从 models.json 找一个 provider 的 { baseUrl, apiKey }(大小写不敏感匹配 name/id)。 */
async function findProvider(wanted) {
	try {
		const cfg = JSON.parse(await readFile(join(writerDir(), "agent", "models.json"), "utf8"));
		const providers = cfg?.providers ?? {};
		for (const [id, p] of Object.entries(providers)) {
			const name = String(p?.name ?? id).toLowerCase();
			if (id.toLowerCase() === wanted || name === wanted) {
				return { baseUrl: String(p?.baseUrl ?? ""), apiKey: String(p?.apiKey ?? "") };
			}
		}
	} catch {
		/* 无 models.json */
	}
	return null;
}

/** 调 DeepSeek 余额接口。 */
async function deepseekBalance(provider) {
	const res = await fetch("https://api.deepseek.com/user/balance", {
		headers: { authorization: `Bearer ${provider.apiKey}`, accept: "application/json" },
	});
	if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
	const body = await res.json();
	const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : null;
	return [
		{ label: "可用", value: info ? `${info.total_balance} ${info.currency}` : "未知" },
		{ label: "赠金", value: info ? `${info.granted_balance} ${info.currency}` : "—" },
		{ label: "充值", value: info ? `${info.topped_up_balance} ${info.currency}` : "—" },
		{ label: "状态", value: body?.is_available ? "可用" : "不可用" },
	];
}

/** 调 OpenRouter 余额接口(/api/v1/credits)。 */
async function openrouterBalance(provider) {
	const base = provider.baseUrl.replace(/\/v1\/?$/, "");
	const res = await fetch(`${base}/api/v1/credits`, {
		headers: { authorization: `Bearer ${provider.apiKey}`, accept: "application/json" },
	});
	if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
	const body = await res.json();
	const d = body?.data ?? {};
	const total = Number(d.total_credits ?? 0);
	const used = Number(d.total_usage ?? 0);
	return [
		{ label: "总额", value: `$${total.toFixed(2)}` },
		{ label: "已用", value: `$${used.toFixed(2)}` },
		{ label: "剩余", value: `$${(total - used).toFixed(2)}` },
	];
}

/** 插件入口:声明一个工具(可选;这里只注册一个手动查询工具,便于在对话里问余额)。 */
export default function balancePlugin(pi) {
	pi.registerTool({
		name: "check_balance",
		description: "查询已配置的模型供应商(DeepSeek / OpenRouter)账户余额。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => {
			const settings = await readSettings();
			const providerId = String(settings.provider ?? "deepseek");
			const provider = await findProvider(providerId);
			if (!provider?.apiKey) return { result: `未在 models.json 里找到 ${providerId} 的 API Key。` };
			try {
				const rows = providerId === "openrouter" ? await openrouterBalance(provider) : await deepseekBalance(provider);
				return { result: rows.map((r) => `${r.label}: ${r.value}`).join("\n") };
			} catch (e) {
				return { result: `查询失败: ${e instanceof Error ? e.message : String(e)}` };
			}
		},
	});
}

/**
 * 后端自定义路由(仅「完全信任」后生效;segments 自动加插件 id 前缀
 * → GET /api/plugins/balance/balance)。返回 { rows: [{label,value}] },
 * 浮窗的 WindowData 归一化后直接渲染成键值表。
 */
export const routes = [
	{
		method: "GET",
		segments: ["balance"],
		handler: async (ctx) => {
			const settings = await readSettings();
			const providerId = String(settings.provider ?? "deepseek");
			const provider = await findProvider(providerId);
			let body;
			if (!provider?.apiKey) {
				body = { rows: [{ label: "状态", value: `未配置 ${providerId} 的 API Key` }] };
			} else {
				try {
					const rows = providerId === "openrouter" ? await openrouterBalance(provider) : await deepseekBalance(provider);
					body = { rows };
				} catch (e) {
					body = { rows: [{ label: "状态", value: `查询失败: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			}
			ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			ctx.res.end(JSON.stringify(body));
		},
	},
];
