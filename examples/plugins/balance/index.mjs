/**
 * 示例插件:余额浮窗(与 docs/plugin-development.md 配套)。
 *
 * 设计约束:余额接口是**供应商自己的**,各家返回的结构完全不同 —— 所以
 * "赠金 / 充值"这类卡片只属于 DeepSeek 适配器,不能被通用层写死。
 * 内置两家(DeepSeek / OpenRouter),其余走 custom:用户在设置里填
 * 接口路径 + 取值字段,任何有余额接口的服务都能接。
 *
 * 三件事:
 *  1. **声明式浮窗 + cards 布局** —— plugin.json 的 `frontend.ui.windows`
 *     声明一个 data + layout:"cards" 的窗口,由宿主渲染成数字面板;
 *  2. **凭据来源** —— 内置 provider 的 key 在 `agent/auth.json`,自定义/中转
 *     provider 在 `agent/models.json`;两份都查,baseUrl 跟着 provider 走;
 *  3. **trusted 后由插件路由取数** —— `routes` 暴露 GET /api/plugins/balance/balance,
 *     窗口用 contentKind:"data" 指向它;路由仅在 trusted 时注册。
 *
 * 设置项(settings.json):provider / adapter / custom_path / custom_field /
 * custom_label / threshold / show_currency。
 * 浮窗「余额提醒」与设置页写的是同一份文件(宿主合并写,互不清空)。
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

/** 设置 → 查询参数(缺省:provider=deepseek、adapter=auto、阈值 10、显示币种)。 */
async function readPrefs() {
	const s = await readSettings();
	const thresholdNum = Number(s.threshold);
	return {
		providerId: typeof s.provider === "string" && s.provider.length > 0 ? s.provider : "deepseek",
		adapter: typeof s.adapter === "string" && s.adapter.length > 0 ? s.adapter : "auto",
		customPath: typeof s.custom_path === "string" ? s.custom_path : "",
		customField: typeof s.custom_field === "string" ? s.custom_field : "",
		customLabel: typeof s.custom_label === "string" && s.custom_label.length > 0 ? s.custom_label : "可用余额",
		threshold: Number.isFinite(thresholdNum) ? thresholdNum : 10,
		showCurrency: s.show_currency !== false,
	};
}

/** 内置 provider 的默认地址(auth.json 只存 key,地址来自这里)。 */
const DEFAULT_BASE_URL = {
	deepseek: "https://api.deepseek.com",
	openrouter: "https://openrouter.ai/api/v1",
};

/** 从 models.json 找一个自定义 provider 的 { baseUrl, apiKey }(大小写不敏感匹配 name/id)。 */
async function readModelsProvider(wanted) {
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

/**
 * 从 auth.json 读内置 provider 的 key(向导/登录配的那份)。
 * 结构:{ "<provider>": { "type": "api_key", "key": "..." } };损坏/缺失返回空串。
 */
async function readAuthKey(id) {
	try {
		const raw = JSON.parse(await readFile(join(writerDir(), "agent", "auth.json"), "utf8"));
		const entry = raw?.[id];
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object" && typeof entry.key === "string") return entry.key;
	} catch {
		/* 无 auth.json */
	}
	return "";
}

/**
 * 解析要查询的 provider:models.json(自定义/中转)优先,没有 key 再用 auth.json
 * + 内置默认地址兜底。内置 provider 的 key 不在 models.json 里 ——
 * 只查 models.json 会把「已配好模型」误报成「未配置 API Key」。
 */
async function resolveProvider(id) {
	const custom = await readModelsProvider(id);
	if (custom?.apiKey) return custom;
	const key = await readAuthKey(id);
	if (!key) return null;
	return { baseUrl: custom?.baseUrl || DEFAULT_BASE_URL[id] || "", apiKey: key };
}

/** 金额 → 两位小数(接口给字符串也统一;非数原样返回)。 */
function fmt(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n.toFixed(2) : String(v ?? "—");
}

/** 由余额与阈值决定主卡的色调。 */
function balanceTone(amount, threshold) {
	const n = Number(amount);
	if (!Number.isFinite(n)) return undefined;
	if (n <= 0) return "err";
	if (n <= threshold) return "warn";
	return "ok";
}

/** 按点分路径取值(支持数组下标,如 `balance_infos.0.total_balance`)。 */
function pickPath(value, path) {
	if (!path) return undefined;
	let cur = value;
	for (const seg of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/** 自动识别适配器:只认内置两家;其余返回 null(提示用户配 custom)。 */
function pickAdapter(prefs) {
	if (prefs.adapter !== "auto") return prefs.adapter;
	const id = prefs.providerId.toLowerCase();
	if (id.includes("deepseek")) return "deepseek";
	if (id.includes("openrouter")) return "openrouter";
	return null;
}

/** DeepSeek 余额 → cards(赠金/充值是它自己的账户结构,只在这个适配器里出现)。 */
function deepseekCards(body, prefs) {
	const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : null;
	const currency = String(info?.currency ?? "CNY");
	const available = body?.is_available === true;
	const total = info ? fmt(info.total_balance) : null;
	const tone = total !== null ? balanceTone(total, prefs.threshold) : available ? "ok" : "err";
	const unit = (v) => (prefs.showCurrency ? `${v} ${currency}` : v);
	const low = total !== null && Number(total) <= prefs.threshold;
	const state = available ? "可用" : "不可用";
	return [
		{
			label: "可用余额",
			value: total !== null ? unit(total) : "—",
			hint: total === null
				? "接口未返回余额"
				: low
					? `低于提醒阈值 ${prefs.threshold} · ${state}`
					: `${state} · 币种 ${currency}`,
			...(tone ? { tone } : {}),
		},
		{ label: "赠金", value: unit(fmt(info?.granted_balance)) },
		{ label: "充值", value: unit(fmt(info?.topped_up_balance)) },
	];
}

/** OpenRouter 余额 → cards(总额/已用是它自己的口径)。 */
function openrouterCards(body, prefs) {
	const d = body?.data ?? {};
	const total = Number(d.total_credits ?? 0);
	const used = Number(d.total_usage ?? 0);
	const left = total - used;
	const usd = (v) => (prefs.showCurrency ? `$${v.toFixed(2)}` : v.toFixed(2));
	const tone = balanceTone(left, prefs.threshold);
	return [
		{
			label: "剩余额度",
			value: usd(left),
			hint: left <= prefs.threshold ? `低于提醒阈值 ${prefs.threshold} 美元` : "已用 / 总额见下",
			...(tone ? { tone } : {}),
		},
		{ label: "总额", value: usd(total) },
		{ label: "已用", value: usd(used) },
	];
}

/**
 * 自定义适配器:用户给接口路径 + 取值字段,响应结构不用猜。
 * 只出一张主卡 —— 其余字段是对方的账户结构,插件无从知道,不编。
 */
function customCards(body, prefs) {
	if (!prefs.customField) {
		return [{ label: "未配置取值字段", value: "—", hint: "设置里填「取值字段」,如 balance.amount", tone: "warn" }];
	}
	const raw = pickPath(body, prefs.customField);
	if (raw === undefined) {
		return [{ label: "字段未命中", value: "—", hint: `响应里没有 ${prefs.customField}`, tone: "warn" }];
	}
	const num = Number(raw);
	const shown = Number.isFinite(num) ? fmt(num) : String(raw);
	return [
		{
			label: prefs.customLabel,
			value: shown,
			hint: `来自 ${prefs.customPath}`,
			...(balanceTone(num, prefs.threshold) ? { tone: balanceTone(num, prefs.threshold) } : {}),
		},
	];
}

/** 未配置 key 时的提示卡。 */
function missingCards(providerId) {
	return [
		{
			label: "未找到 API Key",
			value: "—",
			hint: `已有配置里没有 ${providerId}(auth.json 或 models.json);先到「模型」设置里添加`,
			tone: "warn",
		},
	];
}

/** provider 存在但没有内置适配器时的提示卡。 */
function noAdapterCards(providerId) {
	return [
		{
			label: "未识别余额接口",
			value: "—",
			hint: `${providerId} 没有内置适配器;在设置里把「适配器」改成自定义,填接口路径与取值字段`,
			tone: "warn",
		},
	];
}

/** 查询失败时的提示卡(不让浮窗只剩一行裸错误)。 */
function errorCards(e) {
	const msg = e instanceof Error
		? e.name === "TimeoutError"
			? "请求超时(8 秒),检查网络或代理"
			: e.message
		: String(e);
	return [{ label: "查询失败", value: "—", hint: msg, tone: "err" }];
}

/** 统一取数:返回 cards 数组(路由与工具共用)。 */
async function queryCards(prefs) {
	const provider = await resolveProvider(prefs.providerId);
	if (!provider?.apiKey) return missingCards(prefs.providerId);
	const adapter = pickAdapter(prefs);
	if (!adapter) return noAdapterCards(prefs.providerId);
	try {
		if (adapter === "deepseek") {
			const res = await fetch(new URL("/user/balance", provider.baseUrl || DEFAULT_BASE_URL.deepseek), {
				headers: { authorization: `Bearer ${provider.apiKey}`, accept: "application/json" },
				signal: AbortSignal.timeout(8000),
			});
			if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
			return deepseekCards(await res.json(), prefs);
		}
		if (adapter === "openrouter") {
			const res = await fetch(new URL("/api/v1/credits", provider.baseUrl || DEFAULT_BASE_URL.openrouter), {
				headers: { authorization: `Bearer ${provider.apiKey}`, accept: "application/json" },
				signal: AbortSignal.timeout(8000),
			});
			if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
			return openrouterCards(await res.json(), prefs);
		}
		// custom:路径由用户给,baseUrl 必须能拼出绝对地址
		if (!prefs.customPath) {
			return [{ label: "未配置余额接口", value: "—", hint: "设置里填「接口路径」,如 /user/balance 或 /api/v1/credits", tone: "warn" }];
		}
		if (!provider.baseUrl) {
			return [{ label: "缺少 baseUrl", value: "—", hint: `${prefs.providerId} 在 models.json 里没有 baseUrl,无法拼接接口地址`, tone: "warn" }];
		}
		const res = await fetch(new URL(prefs.customPath, provider.baseUrl), {
			headers: { authorization: `Bearer ${provider.apiKey}`, accept: "application/json" },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}(${prefs.customPath})`);
		return customCards(await res.json(), prefs);
	} catch (e) {
		return errorCards(e);
	}
}

/** 插件入口:注册一个手动查询工具(对话里问「我还有多少余额」也能用)。 */
export default function balancePlugin(pi) {
	pi.registerTool({
		name: "check_balance",
		description: "查询当前配置的模型供应商账户余额,低于提醒阈值时会标注。只对有余额接口的供应商有效。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => {
			const cards = await queryCards(await readPrefs());
			return { result: cards.map((c) => `${c.label}: ${c.value}${c.hint ? `(${c.hint})` : ""}`).join("\n") };
		},
	});
}

/**
 * 后端自定义路由(仅「完全信任」后生效;segments 自动加插件 id 前缀
 * → GET /api/plugins/balance/balance)。返回 { cards: [{label,value,hint,tone}] },
 * 浮窗按 layout:"cards" 归一化后渲染成数字面板。
 * 查询失败也返回 200 + 提示卡 —— 窗口里看到的是人话,不是一行 HTTP 错误。
 */
export const routes = [
	{
		method: "GET",
		segments: ["balance"],
		handler: async (ctx) => {
			const cards = await queryCards(await readPrefs());
			ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			ctx.res.end(JSON.stringify({ cards }));
		},
	},
];
