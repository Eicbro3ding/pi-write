/**
 * 护栏装配防回归(2026-10-05)。
 *
 * ## 为什么需要这个测试
 *
 * `src/tool-rails.ts` 里的两条护栏(write 拦空内容、read 拦循环)一开始注册在
 * `writerExtension` 上,而 `writerExtension` 只在两个地方装配:cli.ts(TUI 主会话)
 * 与 web.ts(web 主会话)。真正调用 `write` 写正文的会话 —— writer-host 的**编剧
 * agent**、stage 的**导演/演员/收幕编剧** —— 都不在那两个装配点上,于是
 * `writer-c-v05ij1` 那次「空内容把 2824 字第二章清零」的事故在护栏"上线"后依然可达。
 *
 * 修法是把护栏做成 `writeRailsExtension`,由 `createSessionRuntimeFactory`
 * **统一并入**所有会话。这个测试盯的就是那条不变量:
 *
 *   ① 护栏必须出现在 session-factory 的统一注入里(而不是散在各装配点);
 *   ② 各装配点不得再自己补装一份(否则两套机制并存,下次又漏在别处)。
 *
 * 这是「源码扫描式」护栏 —— 与 test/world-context.test.ts 的采样单源护栏同款。
 * 之所以不用行为断言:`createSessionRuntimeFactory` 的工厂体依赖 vendor 服务装配,
 * 在单测里驱动成本高且脆弱;而这里要钉的是一个**结构性**事实(谁并入什么),
 * 扫源码比跑装配更直接、报错也更清楚。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

function read(rel: string): string {
	return readFileSync(`${ROOT}${rel}`, "utf8");
}

describe("护栏统一注入(writeRailsExtension)", () => {
	const factory = read("src/session-factory.ts");

	it("session-factory 把 writeRailsExtension 并入 extensionFactories", () => {
		expect(factory).toContain('import { writeRailsExtension } from "./write-rails-extension.ts"');
		// 不能只 import 不并入(那是最容易犯的错:加了导入忘了用)
		expect(factory).toContain("writeRailsExtension,");
	});

	it("护栏排在调用方扩展之前(保护性扩展先生效)", () => {
		const idx = factory.indexOf("writeRailsExtension,");
		const optsIdx = factory.indexOf("...opts.extensionFactories");
		expect(idx).toBeGreaterThan(-1);
		expect(optsIdx).toBeGreaterThan(-1);
		expect(idx).toBeLessThan(optsIdx);
	});

	it("护栏扩展文件自己声明了三个运行时钩子", () => {
		const rails = read("src/write-rails-extension.ts");
		// 三个钩子缺一不可:没有 tool_call 就拦不住,没有 tool_result 字数与丢内容
		// 告警就缺席,没有 before_agent_start 读取护栏的按轮重置就失效
		expect(rails).toContain('pi.on("tool_call"');
		expect(rails).toContain('pi.on("tool_result"');
		expect(rails).toContain('pi.on("before_agent_start"');
		expect(rails).toContain("export const writeRailsExtension");
	});

	it("各装配点不得再自行补装护栏(避免两套机制并存)", () => {
		// 如果某天有人在 writer-host 里又写一份 extensionFactories: [writeRailsExtension, ...],
		// 那就回到「两套机制」的局面:统一注入改了、这里没跟,又会出现新的静默缺口。
		for (const rel of ["src/web/writer-host.ts", "src/stage/stage-extension.ts", "src/web.ts", "src/cli.ts"]) {
			expect(read(rel), `${rel} 不应直接引用 writeRailsExtension`).not.toContain("writeRailsExtension");
		}
	});

	it("护栏已从 extension.ts 的 writerFactory 里移出(不再是 TUI 专属)", () => {
		const ext = read("src/extension.ts");
		// writerFactory 里不该再注册这两个钩子(它们现在由统一注入提供)
		expect(ext).not.toContain('pi.on("tool_call"');
		expect(ext).not.toContain('pi.on("tool_result"');
		// 但 TUI 的 UI 钩子必须仍在(TUI 冻结,但行为不能被这次搬动改坏)
		expect(ext).toContain('pi.on("session_start"');
		expect(ext).toContain('pi.on("turn_end"');
	});
});
