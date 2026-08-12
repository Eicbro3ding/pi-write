/**
 * 提示词外置加载器(2026-08-12):所有 agent 系统提示词独立成文件(prompts/*.md),
 * 代码只负责装配——高内聚,提示词可独立编辑/版本化(借鉴 AI-Novel-Writing-Assistant
 * 的 PromptAsset 资产化与 oh-story 的 skill 包思路)。
 *
 * 目录探测三态(与 resolveSkillsDir 同款):env PI_WRITER_PROMPTS_DIR → exe 旁
 * prompts/ → 源码树 ../prompts。提示词是 agent 必需品:文件缺失直接抛错
 * (fail fast,尽早暴露打包问题——与 skills 的「缺失即少技能」容忍模式不同)。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 定位 prompts 目录(env 优先,其次 bun 单文件 exe 旁,回退源码树)。 */
export function resolvePromptsDir(env: Record<string, string | undefined> = process.env): string {
	const override = env.PI_WRITER_PROMPTS_DIR;
	if (override) return override;
	const exePrompts = join(dirname(process.execPath), "prompts");
	if (existsSync(exePrompts)) return exePrompts;
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "prompts");
}

/** 加载提示词文件(UTF-8);缺失抛错并提示探测路径。 */
export function loadPromptText(file: string): string {
	const dir = resolvePromptsDir();
	const abs = join(dir, file);
	if (!existsSync(abs)) {
		throw new Error(`提示词文件缺失: ${abs}(prompts 目录探测: PI_WRITER_PROMPTS_DIR → exe 旁 → 源码树,请检查打包是否包含 prompts/)`);
	}
	return readFileSync(abs, "utf8");
}

/**
 * 提示词模板渲染:替换 {KEY} 占位(与 buildWriterSystemPrompt 的 {SHELL_LINE} 同款)。
 * 未出现在 vars 里的 {key} 原样保留(提示词正文中的花括号不受影响)。
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
}
