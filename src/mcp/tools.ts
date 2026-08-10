/**
 * MCP 工具适配 —— 把 MCP 服务器的工具列表转成 pi 的 ToolDefinition。
 *
 * 纯逻辑层,不 import @modelcontextprotocol/sdk(便于 vitest 单测):
 * 输入是 SDK listTools 结果的最小形状(McpToolInfo),输出是
 * defineTool 兼容的 ToolDefinition。JSON Schema → typebox 用有限转换器,
 * 覆盖常见子集(string/number/integer/boolean/array/object/enum/const/
 * anyOf/oneOf/null),不认识的形态降级 Type.Any()(宽松,不丢工具)。
 */

import { Type, type TSchema } from "typebox";
import { defineTool, type ToolDefinition } from "../../vendor/pi-coding-agent/src/index.ts";
import type { Usage } from "../../vendor/pi-ai/src/index.ts";

/** SDK listTools 返回的 MCP 工具最小形状(load 层负责转换,本层不依赖 SDK 类型)。 */
export interface McpToolInfo {
	name: string;
	description?: string;
	/** JSON Schema(inputSchema)。 */
	inputSchema?: unknown;
}

/**
 * MCP tools/call 的结果(结构化内容数组)。
 * resource 内容带 text 时(TextResourceContents)直接透传正文,避免 agent
 * 只看到 uri 拿不到内容;_meta.usage 是服务器上报的 token 消耗(命名各异,
 * 常见 input_tokens/output_tokens、inputTokens/outputTokens、prompt_tokens/
 * completion_tokens),转换后透传到 pi 的 Usage。
 */
export interface McpCallResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string; uri?: string }>;
	isError?: boolean;
	_meta?: { usage?: Record<string, unknown> };
}

/** resource 正文透传上限(字符):防服务器把超大文档直接灌进上下文。 */
export const MAX_RESOURCE_TEXT = 20_000;

/** MCP 上报的 usage → pi Usage(input/output 必填,其余归零);取不到返回 undefined。 */
export function mcpUsageToPi(usage: Record<string, unknown> | undefined): Usage | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	const pick = (...keys: string[]): number => {
		for (const k of keys) {
			if (typeof usage[k] === "number") return num(usage[k]);
		}
		return 0;
	};
	const input = pick("input_tokens", "inputTokens", "prompt_tokens", "input");
	const output = pick("output_tokens", "outputTokens", "completion_tokens", "output");
	const cacheRead = pick("cacheReadTokens", "cache_read_tokens", "cacheRead");
	const cacheWrite = pick("cacheWriteTokens", "cache_write_tokens", "cacheWrite");
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
	const total = input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** 把 JSON Schema 转成 typebox schema;不认识的形态降级宽松。 */
export function jsonSchemaToTypebox(schema: unknown): TSchema {
	if (schema === null || typeof schema !== "object") return Type.Any();
	const s = schema as {
		type?: unknown;
		description?: unknown;
		properties?: unknown;
		items?: unknown;
		required?: unknown;
		enum?: unknown;
		const?: unknown;
		anyOf?: unknown;
		oneOf?: unknown;
		allOf?: unknown;
		not?: unknown;
		$ref?: unknown;
		additionalProperties?: unknown;
		minLength?: unknown;
		maxLength?: unknown;
		pattern?: unknown;
		minimum?: unknown;
		maximum?: unknown;
		exclusiveMinimum?: unknown;
		exclusiveMaximum?: unknown;
	};
	const description = typeof s.description === "string" && s.description.length > 0 ? s.description : undefined;
	const opts = description !== undefined ? { description } : undefined;

	// 引用型/未知:不解析,降级宽松
	if (s.$ref !== undefined) return Type.Any();
	// 显式枚举
	if (Array.isArray(s.enum)) {
		const literals: TSchema[] = [];
		for (const v of s.enum) {
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") literals.push(Type.Literal(v));
			else if (v === null) literals.push(Type.Null());
		}
		return literals.length > 0 ? Type.Union(literals, opts) : Type.Any();
	}
	if (s.const !== undefined) {
		const v = s.const;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			return Type.Literal(v, opts);
		}
		return Type.Any();
	}
	// 联合(anyOf/oneOf):取并集
	if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
		return Type.Union(s.anyOf.map((c) => jsonSchemaToTypebox(c)), opts);
	}
	if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
		return Type.Union(s.oneOf.map((c) => jsonSchemaToTypebox(c)), opts);
	}
	// allOf:对象分支的属性合并进一个对象(required 并集),非对象分支取最后一个
	if (Array.isArray(s.allOf) && s.allOf.length > 0) {
		const branches = s.allOf.map((c) => jsonSchemaToTypebox(c));
		const mergedProps: Record<string, TSchema> = {};
		const mergedRequired = new Set<string>();
		let lastNonObject: TSchema | undefined;
		for (const b of branches) {
			const box = b as { type?: string; properties?: Record<string, TSchema>; required?: string[] };
			if (box?.properties) {
				for (const [k, v] of Object.entries(box.properties)) mergedProps[k] = v;
				for (const r of box.required ?? []) mergedRequired.add(r);
			} else {
				lastNonObject = b;
			}
		}
		if (Object.keys(mergedProps).length > 0) {
			const finalProps: Record<string, TSchema> = {};
			for (const [k, v] of Object.entries(mergedProps)) {
				finalProps[k] = mergedRequired.has(k) ? v : Type.Optional(v);
			}
			return Type.Object(finalProps, opts);
		}
		return lastNonObject ?? Type.Any();
	}
	// not:取反(typebox 1.x 无 Type.Not,用 Unsafe 塞原生关键字)
	if (s.not !== undefined) {
		return Type.Unsafe({ not: jsonSchemaToTypebox(s.not) });
	}
	// 对象(无 type 但有 properties 视为 object)
	if (s.type === "object" || (s.type === undefined && s.properties !== undefined)) {
		const props = (s.properties ?? {}) as Record<string, unknown>;
		const required = Array.isArray(s.required) ? new Set(s.required as string[]) : new Set<string>();
		const converted: Record<string, TSchema> = {};
		for (const [key, sub] of Object.entries(props)) {
			const subSchema = jsonSchemaToTypebox(sub);
			converted[key] = required.has(key) ? subSchema : Type.Optional(subSchema);
		}
		// additionalProperties: false 原样保留(缺省按 true——服务器 schema 常用
		// 显式 false 防止模型传多余字段,转 true 会悄悄放宽)
		const additional = s.additionalProperties === false ? false : true;
		return Type.Object(converted, { ...opts, additionalProperties: additional });
	}
	// 数组
	if (s.type === "array") {
		const items = s.items !== undefined ? jsonSchemaToTypebox(s.items) : Type.Any();
		return Type.Array(items, opts);
	}
	// 标量(带 JSON Schema 约束:长度/范围/正则)
	if (s.type === "string") {
		const strOpts: Record<string, unknown> = { ...opts };
		if (typeof s.minLength === "number") strOpts.minLength = s.minLength;
		if (typeof s.maxLength === "number") strOpts.maxLength = s.maxLength;
		if (typeof s.pattern === "string") strOpts.pattern = s.pattern;
		return Type.String(strOpts);
	}
	if (s.type === "number" || s.type === "integer") {
		const numOpts: Record<string, unknown> = { ...opts };
		if (typeof s.minimum === "number") numOpts.minimum = s.minimum;
		if (typeof s.maximum === "number") numOpts.maximum = s.maximum;
		if (typeof s.exclusiveMinimum === "number") numOpts.exclusiveMinimum = s.exclusiveMinimum;
		if (typeof s.exclusiveMaximum === "number") numOpts.exclusiveMaximum = s.exclusiveMaximum;
		return s.type === "integer" ? Type.Integer(numOpts) : Type.Number(numOpts);
	}
	switch (s.type) {
		case "boolean":
			return Type.Boolean(opts);
		case "null":
			return Type.Null();
		default:
			return Type.Any();
	}
}

/** MCP 工具调用结果 → pi 的 TextContent[]:文本直取,图片降级为描述,资源带正文则透传。 */
export function formatMcpCallResult(result: McpCallResult): Array<{ type: "text"; text: string }> {
	const parts: string[] = [];
	for (const item of result.content) {
		if (item.type === "text" && item.text !== undefined) {
			parts.push(item.text);
		} else if (item.type === "image") {
			parts.push(`[图片 ${item.mimeType ?? "未知格式"}](${(item.data ?? "").slice(0, 80)}…)`);
		} else if (item.type === "resource") {
			if (item.text !== undefined && item.text.length > 0) {
				// TextResourceContents:正文直接进模型上下文(超长截断兜底)
				const body = item.text.length > MAX_RESOURCE_TEXT ? `${item.text.slice(0, MAX_RESOURCE_TEXT)}\n…(资源正文过长已截断)` : item.text;
				parts.push(item.uri ? `[资源 ${item.uri}]\n${body}` : body);
			} else {
				parts.push(`[资源 ${item.uri ?? "未知 uri"}(无文本内容)]`);
			}
		}
	}
	if (parts.length === 0) return [{ type: "text", text: "(无输出)" }];
	return [{ type: "text", text: parts.join("\n") }];
}

/** MCP tool → pi ToolDefinition。call 由 manager 注入(闭包持有已连接的 client)。 */
export function mcpToolToDefinition(
	tool: McpToolInfo,
	call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpCallResult>,
): ToolDefinition {
	const description = tool.description?.trim() ?? `MCP 工具 ${tool.name}`;
	return defineTool({
		name: tool.name,
		label: tool.name,
		description,
		// 进系统提示的工具段(缺省 snippet 的自定义工具对模型不可见,必须提供)
		promptSnippet: `${tool.name}: ${description}`,
		parameters: jsonSchemaToTypebox(tool.inputSchema ?? {}),
		async execute(_callId, params, signal) {
			const result = await call(params as Record<string, unknown>, signal);
			// isError 时把错误文本抛给模型上下文(tool_execution_end 带 isError),
			// 让 AI 知道调用失败,而不是把错误当正常结果
			const text = formatMcpCallResult(result)
				.map((c) => c.text)
				.join("\n");
			if (result.isError) throw new Error(text || `MCP 工具 ${tool.name} 调用失败`);
			return { content: [{ type: "text", text }], details: {}, usage: mcpUsageToPi(result._meta?.usage) };
		},
	});
}
