import { ApiError } from "./api/client.ts";
import type { ProviderRefreshError } from "./types.ts";

const FILE_MSG = "暂时无法读取该文件,可能尚未创建或已被移动";
const MODEL_MSG = "当前模型不可用,请到设置页检查模型与 API key";
const NET_MSG = "网络连接失败,请检查服务是否在运行后重试";

/**
 * 技术错误 → 产品语言(纯函数)。匹配顺序:HTTP 状态码 → 消息模式 → 原文。
 * 未知错误保留原文,不吞信息;调用方负责加操作前缀(如「世界书加载失败: 」)。
 */
export function friendlyError(e: unknown): string {
	if (e instanceof ApiError) {
		if (e.status === 404) return FILE_MSG;
		if (e.status === 401 || e.status === 403) return MODEL_MSG;
	}
	const msg = e instanceof Error ? e.message : String(e);
	if (/ENOENT|no such file|Path not found|path not found|not_found/i.test(msg)) return FILE_MSG;
	if (/model|模型|api ?key|认证|auth|unauthorized|insufficient_quota/i.test(msg)) return MODEL_MSG;
	if (/failed to fetch|network|ECONNREFUSED|socket hang up|连接被拒绝/i.test(msg)) return NET_MSG;
	return msg;
}

/**
 * 把模型目录刷新的错误列表格式化成一句人话(2026-10 审计 BUG-001)。
 *
 * 服务端与 DTO 给的是 `{ provider, message }` 对象数组;此前调用方直接
 * `errors.join("; ")` —— 对象默认字符串化就是 `[object Object]`,用户既看不到哪个
 * 供应商、也看不到具体错误。这里统一成 `provider: message`:
 * - 空数组 / 非数组 → 空串(调用方据此判定"没有错误")
 * - 结构不完整(缺 provider/message、或整条是字符串)→ 稳定降级,不吐 `[object Object]`
 */
export function formatProviderRefreshErrors(errors: unknown): string {
	if (!Array.isArray(errors) || errors.length === 0) return "";
	const parts: string[] = [];
	for (const raw of errors) {
		if (typeof raw === "string") {
			if (raw.length > 0) parts.push(raw);
			continue;
		}
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Partial<ProviderRefreshError> & { provider?: unknown; message?: unknown };
		const provider = typeof e.provider === "string" && e.provider.length > 0 ? e.provider : "未知供应商";
		const message = typeof e.message === "string" && e.message.length > 0 ? e.message : "目录刷新失败(无错误详情)";
		parts.push(`${provider}: ${message}`);
	}
	return parts.join("; ");
}
