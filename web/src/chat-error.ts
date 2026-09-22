/**
 * 模型报错的梳理(纯函数,便于单测)。
 *
 * **需求 1「错误原文照实显示,不吞成一句『出错了』」** —— 这一层的职责只有一件事:
 * 把 provider 甩回来的原始错误文本读一遍,**分类别、提状态码、给处置提示**,
 * **但不改写原文**。原文由 `ChatErrorInfo.raw` 逐字带着走,UI 照抄进原文框;
 * 这里的 title / code / hint 只是给标题行与徽标用的「旁注」,永远不与原文冲突
 * (归类失败就退回「模型返回错误」,不硬猜)。
 *
 * 为什么之前那套 `friendlyError()` 不行:它把 401 一律映射成
 * 「当前模型不可用,请到设置页检查模型与 API key」,把
 * `401 Insufficient balance: your account balance is insufficient`
 * 与 `401 Invalid API key` 揉成同一句话 —— 用户拿不到 HTTP 码、拿不到 request id、
 * 也没法把原文贴给供应商。所以这条链路(模型报错)**不再走 friendlyError**,
 * 设置页/世界书那些本地接口错误仍照旧用它(那些确实只需要一句人话)。
 *
 * 匹配顺序有讲究:先「能定性」的具体错因(key / 余额 / 限流 / 超时 / 模型不存在),
 * 再落到状态码(401 认证失败、403 权限、5xx 服务端)、最后网络层。反过来会被
 * 泛化规则吃掉 —— `401 Invalid API key` 会先被 401 规则拦成「认证失败」。
 */
import type { ChatErrorInfo, ChatErrorKind } from "./types.ts";

/**
 * 从原文里提 HTTP 状态码(**不猜**)。
 *
 * 只认三种明确写法:开头的裸码(provider SDK 普遍把码放最前,如
 * `401 Insufficient balance: …`)、`status/status code: 401`、`HTTP 401`。
 * 不做「全文找第一个三位数」——错误体里出现 400/500 这类数字太常见(行号、字节数、
 * 时间戳片段),猜错的状态码徽标比没有徽标更坏。取不到返回 null。
 */
export function statusCodeOf(raw: string): number | null {
	const patterns = [
		/^\s*(?:HTTP\s+)?(\d{3})\b/i, // 开头裸码(最常见)
		/\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i, // status: 401 / HTTP 401
	];
	for (const re of patterns) {
		const m = re.exec(raw);
		if (!m) continue;
		const code = Number(m[1]);
		// 只认 HTTP 错误码区间:200/302 这类出现在错误文本里多半是别的意思
		if (code >= 400 && code <= 599) return code;
	}
	return null;
}

/**
 * 归类规则表:**按顺序**匹配,先到先得(见文件头)。
 *
 * 只有 `hint` 存在这一条**判断规则**:提示行讲的是「重试之外还得做什么」——
 * 密钥、额度、模型名、上下文窗口这四类光点「重试」不会变好,所以给提示;
 * 限流/超时/网络/服务端这些「等一会儿再点重试就行」的不给提示,免得把
 * 一句正确但没用的建议塞满卡片(设计稿也只有 key 那张卡带提示行)。
 */
const RULES: ReadonlyArray<{ kind: ChatErrorKind; title: string; hint?: string; re: RegExp }> = [
	// —— 本地前置检查类(vendor 的 auth-guidance 文案,发请求之前就抛出来) ——
	// 这三条**没有 HTTP 状态码**:请求根本没发出去,所以徽标不出现。它们也是最常见的
	// 「报错」—— 用户看到的原文是 `No API key found for deepseek.` 加一段 /login 帮助,
	// 照实显示的同时得把「去哪儿改」说清楚,否则一段英文帮助文本等于没说。
	{
		kind: "key",
		title: "未配置 API key",
		hint: "该供应商还没有可用密钥，到「设置 · 模型」里填写；错误原文会保留在对话里，方便复制给供应商。",
		re: /no[\s_]?api[\s_]?key[\s_]?found|missing[\s_]api[\s_]key|not configured[^\n]{0,24}api[\s_]key|未(?:配置|填写)[^\n]{0,6}(?:密钥|api ?key)/i,
	},
	{
		kind: "key",
		title: "认证失效",
		hint: "凭据可能已过期，到「设置 · 模型」重新填写密钥或重新授权；错误原文会保留在对话里，方便复制给供应商。",
		re: /authentication failed for|credentials may have expired|re-?authenticate/i,
	},
	{
		kind: "model",
		title: "未选择模型",
		hint: "到「设置 · 模型」里选一个模型（没有可选的就先添加供应商）；错误原文会保留在对话里，方便复制给供应商。",
		re: /no models? (?:selected|available|configured)|未(?:选择|配置)[^\n]{0,4}模型/i,
	},
	// —— provider 回包类 ——
	{
		kind: "key",
		title: "API key 无效",
		// 输入法/供应商措辞都在这里:`invalid api key`、`api key … revoked`、
		// `incorrect api key`、`invalid_api_key`,以及中文侧「密钥无效/失效」
		hint: "密钥在「设置 · 模型」里重新填写；错误原文会保留在对话里，方便复制给供应商。",
		re: /invalid[\s_-]*api[\s_-]*key|api[\s_-]*key[^\n]{0,24}(?:invalid|revoked|expired|incorrect)|incorrect[\s_-]*api[\s_-]*key|authentication[\s_-]*error|密钥[^\n]{0,8}(?:无效|错误|失效|过期)/i,
	},
	{
		kind: "balance",
		title: "余额不足",
		hint: "账户额度已用尽，需到供应商侧充值或调整额度；错误原文会保留在对话里，方便复制给供应商。",
		re: /insufficient[\s_]*(?:balance|quota|funds|credit)|exceeded your current quota|billing[\s_-]*(?:hard[\s_-]*limit|issue)|payment required|余额不足|额度(?:不足|用尽)|欠费/i,
	},
	{
		kind: "rate",
		title: "请求过于频繁",
		re: /rate[\s_-]*limit|too many requests|requests? per (?:minute|second)|请求(?:过于频繁|频率)/i,
	},
	{
		kind: "timeout",
		title: "请求超时",
		re: /timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|超时/i,
	},
	{
		kind: "model",
		title: "模型不存在",
		hint: "当前模型名在供应商侧不存在或已下线，到「设置 · 模型」换一个；错误原文会保留在对话里，方便复制给供应商。",
		re: /model[^\n]{0,40}(?:not[\s_-]*found|does not exist|is not (?:a )?valid|unsupported)|unknown[\s_-]*model|no such model|模型(?:不存在|未找到)/i,
	},
	{
		kind: "context",
		title: "上下文超长",
		hint: "本轮请求超出模型上下文窗口，压缩上下文或缩短正文后重试；错误原文会保留在对话里，方便复制给供应商。",
		re: /context[\s_-]*(?:length|window)[^\n]{0,24}(?:exceed|too long|limit)|maximum context length|too many tokens|上下文[^\n]{0,8}(?:超长|过长|超出)/i,
	},
	{
		kind: "network",
		title: "网络连接失败",
		re: /failed to fetch|fetch failed|network[\s_-]*(?:error|unreachable)|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|连接被拒绝|网络(?:不可达|连接失败)/i,
	},
];

/** 状态码兜底:具体错因没匹配上时,按码定性(措辞取自 HTTP 语义,不编细节)。 */
const BY_CODE: Record<number, { title: string; kind: ChatErrorKind }> = {
	400: { title: "请求被拒绝", kind: "other" },
	401: { title: "认证失败", kind: "auth" },
	403: { title: "权限被拒绝", kind: "auth" },
	404: { title: "接口不存在", kind: "other" },
	408: { title: "请求超时", kind: "timeout" },
	429: { title: "请求过于频繁", kind: "rate" },
	500: { title: "供应商服务端错误", kind: "server" },
	502: { title: "供应商网关错误", kind: "server" },
	503: { title: "供应商暂时不可用", kind: "server" },
	504: { title: "供应商网关超时", kind: "timeout" },
};

/**
 * 出错那一刻的 `provider: x · model: y` 行(设计稿原文框里的第三行)。
 *
 * 两个字段都来自 vendor 的报错消息本身(provider/model 是那一刻的实际取值,
 * 不是前端猜的)。缺一就不编:provider 与 model 都没有 → null,原文框只放原文。
 * `api`(openai-completions 之类)故意不写 —— 那是实现细节,供应商要的是
 * provider 与 model 名。
 */
export function providerModelLine(message: { provider?: string; model?: string }): string | null {
	const provider = typeof message.provider === "string" ? message.provider.trim() : "";
	const model = typeof message.model === "string" ? message.model.trim() : "";
	if (provider.length === 0 && model.length === 0) return null;
	const parts: string[] = [];
	if (provider.length > 0) parts.push(`provider: ${provider}`);
	if (model.length > 0) parts.push(`model: ${model}`);
	return parts.join(" · ");
}

/**
 * 原始错误文本 → 报错卡要显示的一切。**原文原样返回**(只 trim 首尾空白)。
 *
 * `title` 只做「标题」,`raw` 承担「照实」。两者分工是这一层的全部设计:
 * 归类错了顶多标题不精确,原文永远完整可复制 —— 这正是需求 1 要的兜底。
 */
export function describeChatError(raw: string, meta: string | null = null): ChatErrorInfo {
	const text = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
	const code = statusCodeOf(text);
	for (const rule of RULES) {
		if (rule.re.test(text)) {
			return { raw: text, title: rule.title, code, kind: rule.kind, hint: rule.hint ?? null, meta };
		}
	}
	const byCode = code !== null ? BY_CODE[code] : undefined;
	// 5xx 区间未逐码列出的一律按服务端错误(供应商侧问题,与本地配置无关)
	const serverSide = code !== null && code >= 500;
	return {
		raw: text,
		title: byCode?.title ?? (serverSide ? "供应商服务端错误" : "模型返回错误"),
		code,
		kind: byCode?.kind ?? (serverSide ? "server" : "other"),
		hint: null,
		meta,
	};
}

/** 报错卡图标:`key` 类用钥匙(设计稿 ★组件规范·回复渲染 v2 第二张卡),其余用圆形叹号。 */
export function chatErrorIcon(kind: ChatErrorKind): "key-round" | "circle-alert" {
	return kind === "key" ? "key-round" : "circle-alert";
}
