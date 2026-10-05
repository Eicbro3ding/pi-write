/**
 * DeepSeek 动态目录的模型能力推断(2026-10 审计 BUG-003)。
 *
 * 静态目录收录的模型保留精确元数据;`/models` 里出现的新模型此前一律被写成
 * `reasoning: false` —— 刚发布的推理模型在「思考等级」里连 low 都选不到(被 clamp 回
 * off)。现在按 id 命名约定确认(纯函数,不联网)。
 */
import { describe, expect, it } from "vitest";
// ⚠️ **这条 import 故意留在 vendor**:`deepSeekDynamicModel` 是 pi-write 自研的
// 能力(vendor/pi-ai 相对上游 0.83.0 的 B 类语义改动),上游 1.0.2 的
// `pi-ai/providers/deepseek` 只导出 `deepseekProvider`,**没有这个符号**。
//
// 依赖化(T11)时它需要迁到自研侧(约 60 行),而不是继续从 vendor 取 ——
// 届时本条 import 连同 vendor 目录一起消失。此处保留 vendor 引用是有意的,
// 不是漏改:TODO(T11) 迁出为 src/providers/deepseek-dynamic.ts。
import { deepSeekDynamicModel } from "../vendor/pi-ai/src/providers/deepseek.ts";

describe("deepSeekDynamicModel(未收录模型的保守能力推断)", () => {
	it("reasoner / reasoning / think 命名 → 确认支持思考,并带 DeepSeek 档位映射", () => {
		for (const id of ["deepseek-reasoner", "deepseek-v5-reasoning", "deepseek-v5-think", "deepseek-v5-thinking-preview"]) {
			const m = deepSeekDynamicModel(id);
			expect(m.reasoning, id).toBe(true);
			expect(m.thinkingLevelMap, id).toEqual({ minimal: null, low: null, medium: null, high: "high", max: "max" });
		}
	});
	it("非推理命名的未收录模型保持保守默认(false),不凭空宣称支持", () => {
		for (const id of ["deepseek-v5-flash", "deepseek-coder-v5", "deepseek-embedding"]) {
			const m = deepSeekDynamicModel(id);
			expect(m.reasoning, id).toBe(false);
			expect(m.thinkingLevelMap, id).toBeUndefined();
		}
	});
	it("vision 命名 → 输入含图片;其余只有 text", () => {
		expect(deepSeekDynamicModel("deepseek-v5-vision-exp").input).toEqual(["text", "image"]);
		expect(deepSeekDynamicModel("deepseek-v5-flash").input).toEqual(["text"]);
	});
	it("公共字段齐备(协议 / 地址 / 窗口 / 兼容开关)", () => {
		const m = deepSeekDynamicModel("deepseek-v5-flash");
		expect(m).toMatchObject({
			id: "deepseek-v5-flash",
			name: "deepseek-v5-flash",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			contextWindow: 128000,
			maxTokens: 32768,
		});
		expect(m.compat?.thinkingFormat).toBe("deepseek");
	});
});
