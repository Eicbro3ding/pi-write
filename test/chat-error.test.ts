import { describe, expect, it } from "vitest";
import { chatErrorIcon, describeChatError, providerModelLine, statusCodeOf } from "../web/src/chat-error.ts";

/** 设计稿 ★组件规范·回复渲染 v2 右列第一张卡的原文(逐字)。 */
const BALANCE_RAW = [
	"401 Insufficient balance: your account balance is insufficient. Please top up.",
	"request id: req_9f2c1a48",
	"provider: openai-compatible · model: gpt-4o-mini",
].join("\n");

/** 设计稿第二张卡的原文(逐字)。 */
const KEY_RAW = "401 Invalid API key: the API key provided is invalid or has been revoked.";

describe("statusCodeOf(从原文提状态码,**不猜**)", () => {
	it("认开头的裸码(provider SDK 最常见的写法)", () => {
		expect(statusCodeOf(BALANCE_RAW)).toBe(401);
		expect(statusCodeOf("429 Too Many Requests")).toBe(429);
		expect(statusCodeOf("503 Service Unavailable")).toBe(503);
	});
	it("认 status: / HTTP 两种显式写法", () => {
		expect(statusCodeOf("provider error, status: 500")).toBe(500);
		expect(statusCodeOf("request failed (HTTP 429)")).toBe(429);
	});
	it("正文里的三位数字不算码(猜错的状态码徽标比没有徽标更坏)", () => {
		expect(statusCodeOf("写入 draft/ch01.md 失败: 401 字节超出单段限制")).toBeNull();
		expect(statusCodeOf("failed at line 404 of tokens.json")).toBeNull();
	});
	it("2xx/3xx 不当作错误码", () => {
		expect(statusCodeOf("HTTP 200 OK, but body was not JSON")).toBeNull();
	});
});

describe("describeChatError(原文 → 标题/码/类别;原文永远照实)", () => {
	it("余额不足:归类出类别,原文逐字保留(含 request id / provider / model)", () => {
		const info = describeChatError(BALANCE_RAW);
		expect(info.raw).toBe(BALANCE_RAW);
		expect(info.code).toBe(401);
		expect(info.title).toBe("余额不足");
		expect(info.kind).toBe("balance");
	});
	it("API key 无效:归类优先于 401 兜底(泛化规则不会先吃掉它)", () => {
		const info = describeChatError(KEY_RAW);
		expect(info.title).toBe("API key 无效");
		expect(info.kind).toBe("key");
		expect(info.code).toBe(401);
		// 重试救不了这一类,所以给处置提示行(设计稿第二张卡底下的那句话)
		expect(info.hint).not.toBeNull();
		expect(info.hint).toContain("设置");
	});
	it("本地前置检查类(vendor 文案):未配置密钥 / 认证失效 / 未选模型", () => {
		// 原文是 `No API key found for deepseek.\n\nUse /login …`(vendor auth-guidance)
		const noKey = describeChatError("No API key found for deepseek.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /home/yan/pi-writer/docs/providers.md");
		expect(noKey.title).toBe("未配置 API key");
		expect(noKey.kind).toBe("key");
		expect(noKey.code).toBeNull(); // 请求没发出去,没有状态码可给
		expect(noKey.hint).toContain("设置");

		expect(describeChatError('Authentication failed for "deepseek". Credentials may have expired or network is unavailable.').title).toBe("认证失效");
		expect(describeChatError("No model selected.\n\nUse /login …").title).toBe("未选择模型");
		expect(describeChatError("No models available. Use /login …").title).toBe("未选择模型");
	});
	it("模型不存在 vs 未选择模型:两条不同的规则,别互相吃掉", () => {
		expect(describeChatError("404 model gpt-4o-mini not found").title).toBe("模型不存在");
		expect(describeChatError("No model selected.").title).toBe("未选择模型");
	});
	it("限流 / 超时 / 模型不存在 / 上下文超长 / 网络 各自归类", () => {
		expect(describeChatError("429 rate limit exceeded").kind).toBe("rate");
		expect(describeChatError("Request timed out after 60000ms").kind).toBe("timeout");
		expect(describeChatError("404 model gpt-4o-mini not found").kind).toBe("model");
		expect(describeChatError("maximum context length is 128000 tokens").kind).toBe("context");
		expect(describeChatError("fetch failed").kind).toBe("network");
	});
	it("限流/超时/网络不给处置提示(点重试就是答案,不塞没用的建议)", () => {
		expect(describeChatError("429 rate limit exceeded").hint).toBeNull();
		expect(describeChatError("Request timed out").hint).toBeNull();
		expect(describeChatError("fetch failed").hint).toBeNull();
	});
	it("具体错因认不出时按状态码定性,5xx 一律归供应商侧", () => {
		expect(describeChatError("401 nope").title).toBe("认证失败");
		expect(describeChatError("403 forbidden by policy").title).toBe("权限被拒绝");
		expect(describeChatError("HTTP 507 something odd").title).toBe("供应商服务端错误");
		expect(describeChatError("HTTP 507 something odd").kind).toBe("server");
	});
	it("完全认不出:标题退回通用文案,原文照旧完整、不给假提示", () => {
		const raw = "something went sideways in the provider pipeline";
		const info = describeChatError(raw);
		expect(info.title).toBe("模型返回错误");
		expect(info.kind).toBe("other");
		expect(info.code).toBeNull();
		expect(info.hint).toBeNull();
		expect(info.raw).toBe(raw);
	});
	it("空原文不炸(raw 为空串,标题仍是通用文案)", () => {
		const info = describeChatError("");
		expect(info.raw).toBe("");
		expect(info.title).toBe("模型返回错误");
	});
	it("原文只去首尾空白,中间一个字符都不动", () => {
		expect(describeChatError(`\n  ${KEY_RAW}  \n`).raw).toBe(KEY_RAW);
	});
});

describe("providerModelLine(原文框里那行 provider/model)", () => {
	it("两个字段都写(设计稿第三行的形状)", () => {
		expect(providerModelLine({ provider: "deepseek", model: "deepseek-v4-pro" })).toBe("provider: deepseek · model: deepseek-v4-pro");
	});
	it("只有一个字段就只写一个,两个都没有返回 null(不编)", () => {
		expect(providerModelLine({ model: "gpt-4o-mini" })).toBe("model: gpt-4o-mini");
		expect(providerModelLine({ provider: "deepseek" })).toBe("provider: deepseek");
		expect(providerModelLine({})).toBeNull();
		expect(providerModelLine({ provider: "", model: "  " })).toBeNull();
	});
	it("meta 经 describeChatError 原样带到卡片数据里", () => {
		const info = describeChatError(KEY_RAW, "provider: deepseek · model: deepseek-v4-pro");
		expect(info.meta).toBe("provider: deepseek · model: deepseek-v4-pro");
		expect(describeChatError(KEY_RAW).meta).toBeNull(); // 本地类错误没有 provider 可写
	});
	it("真实 deepseek 401 原文(实测抓下来的那种形状)归到 key 类", () => {
		// 原文来自实测:message_start 的 errorMessage 字段
		const raw = '401: {"message":"Authentication Fails, Your api key: ****test is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}';
		const info = describeChatError(raw, providerModelLine({ provider: "deepseek", model: "deepseek-v4-pro" }));
		expect(info.title).toBe("API key 无效");
		expect(info.code).toBe(401);
		expect(info.raw).toBe(raw);
		expect(info.hint).not.toBeNull();
	});
});

describe("chatErrorIcon(设计稿的图标选择)", () => {
	it("key 类用钥匙,其余用圆形叹号", () => {
		expect(chatErrorIcon("key")).toBe("key-round");
		expect(chatErrorIcon("balance")).toBe("circle-alert");
		expect(chatErrorIcon("other")).toBe("circle-alert");
	});
});
