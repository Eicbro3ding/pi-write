import { describe, expect, it } from "vitest";
import { formatMcpCallResult, jsonSchemaToTypebox, mcpToolToDefinition, mcpUsageToPi, MAX_RESOURCE_TEXT } from "../src/mcp/tools.ts";

/** 断言 typebox schema 的 JSON 形状包含期望片段(不依赖 typebox 内部表示)。 */
function shapeOf(schema: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

describe("jsonSchemaToTypebox", () => {
	it("converts scalars with description", () => {
		const s = shapeOf(jsonSchemaToTypebox({ type: "string", description: "书名" }));
		expect(s.type).toBe("string");
		expect(s.description).toBe("书名");
		expect(shapeOf(jsonSchemaToTypebox({ type: "integer" })).type).toBe("integer");
		expect(shapeOf(jsonSchemaToTypebox({ type: "boolean" })).type).toBe("boolean");
		expect(shapeOf(jsonSchemaToTypebox({ type: "number" })).type).toBe("number");
	});

	it("converts arrays", () => {
		const s = shapeOf(jsonSchemaToTypebox({ type: "array", items: { type: "string" } }));
		expect(s.type).toBe("array");
		expect((s.items as Record<string, unknown>).type).toBe("string");
	});

	it("converts objects with required/optional properties", () => {
		const s = shapeOf(
			jsonSchemaToTypebox({
				type: "object",
				properties: { title: { type: "string" }, count: { type: "integer" } },
				required: ["title"],
			}),
		);
		expect(s.type).toBe("object");
		const props = s.properties as Record<string, Record<string, unknown>>;
		expect(props.title.type).toBe("string");
		expect(props.count.type).toBe("integer");
		// typebox 1.x 的 Optional 是运行时语义,JSON 序列化不体现;额外属性放宽
		expect(s.additionalProperties).toBe(true);
	});

	it("converts enums and const", () => {
		const e = shapeOf(jsonSchemaToTypebox({ enum: ["a", "b"] }));
		expect(e.anyOf).toBeDefined();
		const c = shapeOf(jsonSchemaToTypebox({ const: 3 }));
		expect(c.const).toBe(3);
	});

	it("degrades unknown shapes to any (never throws)", () => {
		// Type.Any() 的 JSON 形状是无 type 字段的空对象(宽松匹配)
		expect(shapeOf(jsonSchemaToTypebox({ $ref: "#/definitions/X" })).type).toBeUndefined();
		expect(shapeOf(jsonSchemaToTypebox({ type: "weird" })).type).toBeUndefined();
		expect(shapeOf(jsonSchemaToTypebox(null)).type).toBeUndefined();
		expect(shapeOf(jsonSchemaToTypebox(undefined)).type).toBeUndefined();
	});

	it("carries string/number constraints (minLength/pattern/minimum)", () => {
		const s = shapeOf(jsonSchemaToTypebox({ type: "string", minLength: 2, maxLength: 10, pattern: "^\\d+$" }));
		expect(s.minLength).toBe(2);
		expect(s.maxLength).toBe(10);
		expect(s.pattern).toBe("^\\d+$");
		const n = shapeOf(jsonSchemaToTypebox({ type: "number", minimum: 1, maximum: 5, exclusiveMinimum: 0 }));
		expect(n.minimum).toBe(1);
		expect(n.maximum).toBe(5);
		expect(n.exclusiveMinimum).toBe(0);
	});

	it("preserves additionalProperties:false on objects", () => {
		const s = shapeOf(jsonSchemaToTypebox({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }));
		expect(s.additionalProperties).toBe(false);
	});

	it("merges allOf object branches and keeps last non-object branch", () => {
		const s = shapeOf(
			jsonSchemaToTypebox({
				allOf: [
					{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
					{ type: "object", properties: { b: { type: "integer" } } },
				],
			}),
		);
		expect(s.type).toBe("object");
		const props = s.properties as Record<string, Record<string, unknown>>;
		expect(props.a.type).toBe("string");
		expect(props.b.type).toBe("integer");
		const onlyNonObject = shapeOf(jsonSchemaToTypebox({ allOf: [{ type: "string" }, { type: "string", minLength: 3 }] }));
		expect(onlyNonObject.type).toBe("string");
		expect(onlyNonObject.minLength).toBe(3);
	});

	it("converts not to Type.Not", () => {
		const s = shapeOf(jsonSchemaToTypebox({ not: { type: "string" } }));
		expect(s.not).toBeDefined();
	});
});

describe("formatMcpCallResult", () => {
	it("joins text parts and skips empty content", () => {
		expect(formatMcpCallResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toEqual([
			{ type: "text", text: "a\nb" },
		]);
		expect(formatMcpCallResult({ content: [] })).toEqual([{ type: "text", text: "(无输出)" }]);
	});

	it("degrades images to descriptions", () => {
		const out = formatMcpCallResult({ content: [{ type: "image", mimeType: "image/png", data: "abc" }] });
		expect(out[0]?.text).toContain("图片");
	});

	it("passes through resource text content (was degraded to uri only)", () => {
		const out = formatMcpCallResult({
			content: [
				{ type: "resource", uri: "file:///data/outline.md", text: "第一章:雨夜\n第二章:灯下" },
				{ type: "resource", uri: "file:///data/empty.bin" },
			],
		});
		expect(out[0]?.text).toContain("第一章:雨夜");
		expect(out[0]?.text).toContain("file:///data/outline.md");
		expect(out[0]?.text).toContain("无文本内容");
	});

	it("truncates oversized resource text with a marker", () => {
		const out = formatMcpCallResult({ content: [{ type: "resource", uri: "u", text: "字".repeat(MAX_RESOURCE_TEXT + 100) }] });
		expect(out[0]?.text).toContain("已截断");
		expect(out[0]!.text.length).toBeLessThan(MAX_RESOURCE_TEXT + 200);
	});
});

describe("mcpUsageToPi", () => {
	it("converts anthropic-style tokens", () => {
		expect(mcpUsageToPi({ input_tokens: 10, output_tokens: 5 })).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
	});
	it("accepts camelCase and openai-style aliases", () => {
		expect(mcpUsageToPi({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 2 })).toMatchObject({ input: 3, output: 4, cacheRead: 2 });
		expect(mcpUsageToPi({ prompt_tokens: 7, completion_tokens: 1 })).toMatchObject({ input: 7, output: 1 });
	});
	it("returns undefined when nothing reported", () => {
		expect(mcpUsageToPi(undefined)).toBeUndefined();
		expect(mcpUsageToPi({})).toBeUndefined();
		expect(mcpUsageToPi({ foo: "bar" })).toBeUndefined();
	});
});

describe("mcpToolToDefinition", () => {
	it("builds a ToolDefinition with snippet and working execute", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const def = mcpToolToDefinition(
			{ name: "fetch_url", description: "抓取网页", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
			async (args) => {
				calls.push(args);
				return { content: [{ type: "text", text: `ok:${String(args.url)}` }] };
			},
		);
		expect(def.name).toBe("fetch_url");
		expect(def.promptSnippet).toContain("抓取网页");
		const result = await def.execute("call-1", { url: "https://example.com" } as never, undefined, undefined, {} as never);
		expect(result.content).toEqual([{ type: "text", text: "ok:https://example.com" }]);
		expect(calls).toEqual([{ url: "https://example.com" }]);
	});

	it("throws when the server reports isError", async () => {
		const def = mcpToolToDefinition(
			{ name: "boom", inputSchema: {} },
			async () => ({ content: [{ type: "text", text: "权限不足" }], isError: true }),
		);
		await expect(def.execute("c", {} as never, undefined, undefined, {} as never)).rejects.toThrow(/权限不足/);
	});

	it("passes through _meta.usage as pi Usage (token 字段)", async () => {
		const def = mcpToolToDefinition(
			{ name: "tokenized", inputSchema: {} },
			async () => ({
				content: [{ type: "text", text: "ok" }],
				_meta: { usage: { input_tokens: 12, output_tokens: 3 } },
			}),
		);
		const result = await def.execute("c", {} as never, undefined, undefined, {} as never);
		expect(result.usage).toMatchObject({ input: 12, output: 3, totalTokens: 15 });
	});
});
