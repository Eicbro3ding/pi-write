/**
 * 「UI 房」契约测试(node 环境,无 DOM)。
 *
 * 它守四件事:
 * 1. **覆盖**:`web/src/components/` 下每个组件模块都必须在某个展项里出现,
 *    或在 `UIROOM_NOT_EXHIBITED` 里给出理由 —— 新加组件忘了进 UI 房 → 红。
 * 2. **接线**:每个展项的 ENTRIES.variants 与 SECTION 的状态档逐字一致(数量 + 文案 + 顺序),
 *    SECTION 里不许有未登记的 id,也不许登记了却不渲染。
 * 3. **真存在**:module 路径在磁盘上、symbols 在该模块源码里确实被导出。
 * 4. **真能渲染**:每个状态档都用 react-dom/server 渲染一遍(除注明 ssrSkip 的 DOM 独占件),
 *    渲染期抛错 → 红。这是「各 UI 组件有没有问题」的自动化那一半。
 *
 * 注意:展项文件用**动态 import**,缺的分组会 skip 而不是整体炸掉 —— 这样写某一个
 * 分组的人能单独跑自己的部分(最后一个用例专门盯「分组文件齐全」)。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	UIROOM_GROUP_FILES,
	UIROOM_GROUPS,
	UIROOM_LIVE_MODULES,
	UIROOM_NOT_EXHIBITED,
	uiroomCoverage,
	uiroomStats,
	type UIRoomEntry,
	type UIRoomGroupId,
	type UIRoomSection,
} from "../web/src/uiroom-types.ts";
import { UIRoomRuntimeProvider, demoLibrary, demoRuntime } from "../web/src/uiroom-runtime.tsx";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SRC = path.join(ROOT, "web/src");
const COMPONENTS_DIR = path.join(WEB_SRC, "components");

/** 磁盘上真实的组件模块(相对 web/src),覆盖检查的唯一来源。 */
const COMPONENT_MODULES = readdirSync(COMPONENTS_DIR)
	.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
	.map((f) => `components/${f}`)
	.sort();

/** 展项文件是否真的导出「某符号被 export」——粗粒度源码扫描,够用且不依赖编译。 */
function moduleExportsSymbol(source: string, symbol: string): boolean {
	const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class|interface|type)\\s+${symbol}\\b`);
	return re.test(source);
}

interface GroupBundle {
	group: UIRoomGroupId;
	file: string;
	entries: readonly UIRoomEntry[];
	section: UIRoomSection;
	/** 载入失败(语法错/运行时抛错)—— 并行写分组文件时,这能把锅扣在正确的分组上。 */
	error: string | null;
}

/** 动态载入所有已存在的分组文件(缺的由「分组文件齐全」用例报告)。 */
async function loadGroups(): Promise<GroupBundle[]> {
	const out: GroupBundle[] = [];
	for (const spec of UIROOM_GROUP_FILES) {
		const abs = path.join(ROOT, spec.file);
		if (!existsSync(abs)) continue;
		try {
			const mod = (await import(abs)) as Record<string, unknown>;
			const entries = mod[spec.entries] as readonly UIRoomEntry[] | undefined;
			const section = mod[spec.section] as UIRoomSection | undefined;
			if (!entries) throw new Error(`没有导出 ${spec.entries}`);
			if (!section) throw new Error(`没有导出 ${spec.section}`);
			out.push({ group: spec.group, file: spec.file, entries, section, error: null });
		} catch (err) {
			out.push({ group: spec.group, file: spec.file, entries: [], section: {}, error: (err as Error).message });
		}
	}
	return out;
}

const bundles = await loadGroups();
const allEntries = bundles.flatMap((b) => b.entries);
const stats = uiroomStats(allEntries);

describe("uiroom: 覆盖与元数据", () => {
	it("每个组件模块都被陈列,或登记了不陈列的理由", () => {
		const cov = uiroomCoverage(COMPONENT_MODULES, allEntries);
		expect(cov.missing, `这些组件没有展项,也没有登记理由:\n${cov.missing.join("\n")}`).toEqual([]);
	});

	it("展项指向的模块都存在,理由登记不指向不存在的模块", () => {
		const cov = uiroomCoverage(COMPONENT_MODULES, allEntries);
		expect(cov.unknownModules).toEqual([]);
		for (const excused of UIROOM_NOT_EXHIBITED) {
			expect(existsSync(path.join(WEB_SRC, excused.module)), `UIROOM_NOT_EXHIBITED 里有不存在的模块: ${excused.module}`).toBe(true);
		}
	});

	it("id 全局唯一", () => {
		expect(uiroomCoverage(COMPONENT_MODULES, allEntries).duplicatedIds).toEqual([]);
	});

	it("「直连真实服务」清单里的模块都存在且都被陈列(否则标记没意义)", () => {
		for (const module of UIROOM_LIVE_MODULES) {
			expect(existsSync(path.join(WEB_SRC, module)), `UIROOM_LIVE_MODULES 里有不存在的模块: ${module}`).toBe(true);
			expect(
				allEntries.some((e) => e.module === module),
				`${module} 被标成「直连真实服务」,但没有任何展项用隔离客户端渲染它`,
			).toBe(true);
		}
	});

	it("分组表与展项分组一致:每个分组都有展项,每个展项的分组都在表里", () => {
		const known = new Set(UIROOM_GROUPS.map((g) => g.id));
		expect(UIROOM_GROUPS.length).toBe(6);
		expect(new Set(UIROOM_GROUPS.map((g) => g.id)).size).toBe(UIROOM_GROUPS.length);
		for (const e of allEntries) expect(known.has(e.group), `${e.id} 的分组 ${e.group} 不在 UIROOM_GROUPS`).toBe(true);
		for (const g of UIROOM_GROUPS) {
			expect(allEntries.filter((e) => e.group === g.id).length, `分组 ${g.id} 一个展项都没有`).toBeGreaterThan(0);
		}
	});

	it("计数口径可用于页头", () => {
		expect(stats.exhibits).toBe(allEntries.length);
		expect(stats.groups).toBeGreaterThan(0);
		expect(stats.variants).toBeGreaterThanOrEqual(stats.exhibits);
	});
});

for (const spec of UIROOM_GROUP_FILES) {
	const bundle = bundles.find((b) => b.group === spec.group);
	describe.skipIf(!bundle)(`uiroom: 分组 ${spec.group}`, () => {
		const entries = bundle?.entries ?? [];
		const section = bundle?.section ?? {};

		it("分组文件能载入并导出约定的两个符号", () => {
			expect(bundle?.error, `${spec.file} 载入失败`).toBeNull();
		});

		it("每个展项的 module/symbols 在源码里成立", () => {
			for (const e of entries) {
				const abs = path.join(WEB_SRC, e.module);
				expect(existsSync(abs), `${e.id}: 模块不存在 ${e.module}`).toBe(true);
				const source = readFileSync(abs, "utf8");
				expect(e.symbols.length, `${e.id}: symbols 不能为空`).toBeGreaterThan(0);
				for (const sym of e.symbols) {
					expect(moduleExportsSymbol(source, sym), `${e.id}: ${e.module} 没有导出 ${sym}`).toBe(true);
				}
			}
		});

		it("ENTRIES.variants 与 SECTION 逐字一致", () => {
			for (const e of entries) {
				const variants = section[e.id];
				expect(variants, `${e.id}: SECTION 里没有这一格`).toBeTruthy();
				expect((variants ?? []).map((v) => v.label), `${e.id}: 状态档标签/顺序与 ENTRIES.variants 不一致`).toEqual([...e.variants]);
				expect(e.variants.length, `${e.id}: 至少要有一个状态档`).toBeGreaterThan(0);
			}
		});

		it("SECTION 里没有未登记的 id", () => {
			const known = new Set(entries.map((e) => e.id));
			const extra = Object.keys(section).filter((id) => !known.has(id));
			expect(extra, `SECTION 多出来的格子没有写进 ENTRIES:\n${extra.join("\n")}`).toEqual([]);
		});

		it("每个状态档都能 SSR 渲染出来", () => {
			const failures: string[] = [];
			let rendered = 0;
			for (const e of entries) {
				if (e.ssrSkip) continue;
				for (const v of section[e.id] ?? []) {
					try {
						const html = renderToStaticMarkup(
							createElement(UIRoomRuntimeProvider, { value: demoRuntime() }, createElement(v.render)),
						);
						rendered += 1;
						if (html.trim().length === 0) failures.push(`${e.id}/${v.label}: 渲染结果是空 HTML`);
					} catch (err) {
						failures.push(`${e.id}/${v.label}: ${(err as Error).message.split("\n")[0]}`);
					}
				}
			}
			expect(rendered, "一个状态档都没渲染,展项表大概是空的").toBeGreaterThan(0);
			expect(failures, `这些状态档渲染期抛错:\n${failures.join("\n")}`).toEqual([]);
		});
	});
}

describe("uiroom: 分组文件齐全", () => {
	it("六个分组文件都存在", () => {
		const absent = UIROOM_GROUP_FILES.filter((f) => !existsSync(path.join(ROOT, f.file))).map((f) => f.file);
		expect(absent, `这些分组文件还没写:\n${absent.join("\n")}`).toEqual([]);
	});

	it("所有分组文件都能载入", () => {
		const broken = bundles.filter((b) => b.error).map((b) => `${b.file}: ${b.error}`);
		expect(broken, `这些分组文件载入抛错:\n${broken.join("\n")}`).toEqual([]);
	});

	it("页面壳能把每个展项都渲染成一格", async () => {
		// 组合冒烟:整页一次性挂起 40+ 个组件,证明「注册了 N 格,页面真的渲染 N 格」。
		// 逐档的严格 SSR 契约在上面的用例里(那边不给任何 DOM 兜底),这里只补两个
		// 浏览器里总有的值:window 尺寸与 matchMedia(不受控组件退化成底部居中时要用)。
		// document 仍然不提供 —— 要量 DOM 的组件应当自己兜底(AskUserCard 的浮层、
		// graph-styles 的 themeVar 都是这么写的),兜不住的话这个用例就该红。
		const g = globalThis as unknown as { window?: unknown };
		const hadWindow = "window" in g;
		if (!hadWindow) {
			g.window = {
				innerWidth: 1200,
				innerHeight: 800,
				matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
			};
		}
		try {
			const { UIRoom } = await import("../web/src/pages/UIRoom.tsx");
			const html = renderToStaticMarkup(
				createElement(UIRoom, {
					client: demoRuntime().client,
					slug: "demo-book",
					library: demoLibrary(),
					classicMode: false,
				}),
			);
			const missing = allEntries.filter((e) => !html.includes(`id="exhibit-${e.id}"`)).map((e) => e.id);
			expect(missing, `页面壳没有渲染这些展项(ENTRIES 里有、SECTION 里没有?):\n${missing.join("\n")}`).toEqual([]);
		} finally {
			if (!hadWindow) delete g.window;
		}
	});

	it("ssrSkip 必须写明原因(DOM 独占),note 里也要有交代", () => {
		for (const e of allEntries) {
			if (e.ssrSkip === undefined) continue;
			expect(e.ssrSkip.trim().length, `${e.id}: ssrSkip 要写清为什么`).toBeGreaterThan(20);
			// 单元格会把 ssrSkip 原文印在标题下,note 只需再交代一句人话(别只写个跳过)
			expect((e.note ?? "").trim().length, `${e.id}: ssrSkip 的展项要在 note 里说明`).toBeGreaterThan(10);
		}
	});
});
