/**
 * 构建脚本契约 —— 钉住「`npm run web` 之前必须做产物新鲜度自检」。
 *
 * ## 背景(为什么这条值得单测)
 *
 * `npm run build` 产 `dist/cli.js` / `dist/index.js`,而 `npm run web` 跑的是
 * **`dist/web/server.cjs`**(只由 `npm run build:web` 产出)。于是最自然的路径
 * 「改源码 → build → web」会**静默跑在旧产物上**:旧文件还在、能正常启动、不报错。
 *
 * 2026-10-05 T13 端到端排查时真踩过:误跑过期产物,一度判定「MCP 配置迁移完全没生效」,
 * 实际是产物停在旧版本。代价是半小时的无效排查。
 *
 * 当时的补救是给 `web` 脚本前置 `scripts/check-web-fresh.mjs`。这份测试钉住它 ——
 * 否则哪天有人重排 `scripts` 区块、或换个启动命令,自检会**悄悄消失**,
 * 而症状(跑旧代码)要等下一次踩坑才浮现。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readScripts(): Record<string, string> {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
		scripts?: Record<string, string>;
	};
	return pkg.scripts ?? {};
}

describe("构建脚本契约(npm run web 的产物新鲜度自检)", () => {
	it("web 脚本先跑自检再启动 server.cjs", () => {
		const web = readScripts().web;
		expect(web, "package.json 里应有 web 脚本").toBeTruthy();
		expect(web).toContain("check-web-fresh.mjs");
		expect(web).toContain("dist/web/server.cjs");
		// 自检必须在启动之前(&& 短路),不能是 || 或反向
		expect(web.indexOf("check-web-fresh.mjs")).toBeLessThan(web.indexOf("dist/web/server.cjs"));
	});

	it("自检脚本存在且可被 node --check 解析", () => {
		expect(existsSync(join(root, "scripts", "check-web-fresh.mjs"))).toBe(true);
	});

	it("build 与 build:web 是两个不同产物(这个事实本身是坑的来源)", () => {
		const scripts = readScripts();
		// build 产 cli/index,不产 server.cjs
		expect(scripts.build).toContain("build-cli.mjs");
		expect(scripts.build).not.toContain("server.cjs");
		// build:web 才是产 server.cjs 的那个
		expect(scripts["build:web"]).toContain("web-build.mjs");
	});
});
