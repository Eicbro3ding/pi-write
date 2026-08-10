import { ApiError } from "./api/client.ts";

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
