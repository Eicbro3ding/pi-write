/**
 * 插件加载器测试(临时 PI_WRITER_DIR,真实磁盘):
 * 扫描/清单解析/启用状态/入口缺失/动态 import 工厂(真实 .mjs)/坏插件错误隔离。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPluginFrontendPath, getPluginsDir, getPluginStatePath, listPlugins, loadPlugins, readPluginSettings, removePlugin, writePluginEnabled, writePluginSettings, writePluginTrusted } from "../src/plugin-loader.ts";

const tmp = mkdtempSync(join(tmpdir(), "piw-plugins-"));
process.env.PI_WRITER_DIR = tmp;
const root = getPluginsDir();

/** 建一个标准插件目录(带 plugin.json + index.mjs)。 */
function writePlugin(id: string, opts: { manifest?: Record<string, unknown> | null; entry?: string | null; bad?: boolean } = {}) {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	if (opts.manifest !== null) {
		writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id, version: "0.1.0", name: `插件 ${id}`, ...(opts.manifest ?? {}) }));
	}
	if (opts.entry !== null) {
		writeFileSync(
			join(dir, "index.mjs"),
			opts.entry ??
				`export default function factory(pi) { pi.registered = true; return "ok"; }`,
		);
	}
}

beforeAll(() => {
	mkdirSync(root, { recursive: true });
});
beforeEach(() => {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	rmSync(getPluginStatePath(), { force: true });
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("listPlugins(扫描与清单)", () => {
	it("目录不存在 → 空列表", async () => {
		rmSync(root, { recursive: true, force: true });
		expect(await listPlugins()).toEqual([]);
	});

	it("读 manifest:name/version/description 上浮,error=null", async () => {
		writePlugin("dice", { manifest: { description: "掷骰子" } });
		const list = await listPlugins();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: "dice", version: "0.1.0", name: "插件 dice", description: "掷骰子", enabled: true, error: null });
	});

	it("无 plugin.json → 目录名兜底(id=name,version 0.0.0)", async () => {
		writePlugin("bare", { manifest: null });
		const list = await listPlugins();
		expect(list[0]).toMatchObject({ id: "bare", version: "0.0.0", name: "bare" });
	});

	it("入口缺失 → error 标明缺省路径;非法目录名(大写/下划线)不列出", async () => {
		writePlugin("noentry", { entry: null });
		writePlugin("BAD_NAME", {});
		const list = await listPlugins();
		expect(list.map((p) => p.id)).toEqual(["noentry"]);
		expect(list[0].error).toContain("入口文件缺失");
	});

	it("manifest.enabled:false → manifestDisabled 且 enabled=false(用户层不可覆盖)", async () => {
		writePlugin("disabled-plugin", { manifest: { enabled: false } });
		const list = await listPlugins();
		expect(list[0]).toMatchObject({ manifestDisabled: true, enabled: false });
	});
});

describe("writePluginEnabled(用户层开关)", () => {
	it("写入 → 覆盖缺省;读回一致;其他键保留", async () => {
		writePlugin("a", {});
		writePlugin("b", {});
		await writePluginEnabled("a", false);
		const list = await listPlugins();
		expect(list.find((p) => p.id === "a")?.enabled).toBe(false);
		expect(list.find((p) => p.id === "b")?.enabled).toBe(true);
		await writePluginEnabled("b", false);
		expect((await listPlugins()).find((p) => p.id === "a")?.enabled).toBe(false);
	});
});

describe("loadPlugins(动态 import)", () => {
	it("default export 为 function → 工厂可调用(真实 .mjs import)", async () => {
		writePlugin("dice", {
			entry: `export default function factory(pi) { pi.mark = "called"; }`,
		});
		const { factories, infos } = await loadPlugins();
		expect(factories).toHaveLength(1);
		const pi: { mark?: string } = {};
		// @ts-expect-error 故意拿真实工厂跑一次(pi 最小桩)
		await factories[0](pi);
		expect(pi.mark).toBe("called");
		expect(infos[0].error).toBeNull();
	});

	it("default export 非函数 → 该插件 error,不阻塞其他插件", async () => {
		writePlugin("bad-export", { entry: `export default "not-a-function";` });
		writePlugin("good", {});
		const { factories, infos } = await loadPlugins();
		expect(factories).toHaveLength(1);
		expect(infos.find((p) => p.id === "bad-export")?.error).toContain("工厂函数");
		expect(infos.find((p) => p.id === "good")?.error).toBeNull();
	});

	it("入口模块抛错(顶层)→ error 隔离,其他照常", async () => {
		writePlugin("boom", { entry: `throw new Error("boom-at-import");` });
		writePlugin("fine", {});
		const { factories, infos } = await loadPlugins();
		expect(factories).toHaveLength(1);
		expect(infos.find((p) => p.id === "boom")?.error).toContain("插件加载失败");
	});

	it("用户禁用 → 不加载;manifest 禁用 → 不加载", async () => {
		writePlugin("off", {});
		writePlugin("author-off", { manifest: { enabled: false } });
		await writePluginEnabled("off", false);
		const { factories } = await loadPlugins();
		expect(factories).toHaveLength(0);
	});
});

describe("removePlugin(删除与防逃逸)", () => {
	it("删除目录后列表消失;状态文件残留不报错", async () => {
		writePlugin("victim", {});
		await writePluginEnabled("victim", true);
		await removePlugin("victim");
		expect((await listPlugins()).map((p) => p.id)).not.toContain("victim");
	});

	it("非法 id(路径穿越)→ 抛错不删", async () => {
		await expect(removePlugin("../evil")).rejects.toThrow("非法插件 id");
	});
});

describe("settings 读写(白名单字段)", () => {
	it("read 缺省 {};write 只收白名单字段(未知键丢弃)", async () => {
		writePlugin("config", {
			manifest: {
				frontend: {
					ui: {
						settingsItems: [
							{
								title: "掷骰子",
								fields: [
									{ key: "max", label: "骰面", type: "number", default: 20 },
									{ key: "lucky", label: "幸运", type: "boolean" },
									{ key: "greet", label: "感言", type: "string" },
								],
							},
						],
					},
				},
			},
		});
		expect(await readPluginSettings("config")).toEqual({});
		const list = await listPlugins();
		expect(list[0].frontend?.ui?.settingsItems?.[0].fields).toHaveLength(3);
		await writePluginSettings(
			"config",
			{ max: 6, lucky: true, greet: "好", hacked: "x", evil: 42 },
			list[0].frontend!.ui!.settingsItems![0].fields,
		);
		expect(await readPluginSettings("config")).toEqual({ max: 6, lucky: true, greet: "好" });
	});

	it("类型不匹配的值丢弃(boolean 字段收到 string 不收)", async () => {
		writePlugin("typed", {
			manifest: {
				frontend: { ui: { settingsItems: [{ title: "t", fields: [{ key: "flag", label: "开关", type: "boolean" }] }] } },
			},
		});
		const list = await listPlugins();
		await writePluginSettings("typed", { flag: "yes" }, list[0].frontend!.ui!.settingsItems![0].fields);
		expect(await readPluginSettings("typed")).toEqual({});
	});
});

describe("frontend 声明校验(字段级白名单)", () => {
	it("非法字段类型丢弃,合法透传;select 无 options 丢弃", async () => {
		writePlugin("badfields", {
			manifest: {
				frontend: {
					ui: {
						settingsItems: [
							{
								title: "坏字段",
								fields: [
									{ key: "ok", label: "好", type: "string" },
									{ key: "badtype", label: "坏", type: "color_picker" },
									{ key: "noopts", label: "选择", type: "select" },
									{ label: "缺key", type: "string" },
								],
							},
						],
					},
				},
			},
		});
		const list = await listPlugins();
		const fields = list[0].frontend?.ui?.settingsItems?.[0].fields ?? [];
		expect(fields).toHaveLength(1);
		expect(fields[0]).toMatchObject({ key: "ok", type: "string" });
	});

	it("slashCommands 声明校验:含斜杠或空 hint 丢弃;合法透传", async () => {
		writePlugin("cmds", {
			manifest: {
				frontend: {
					slashCommands: [
						{ trigger: "roll", hint: "掷骰子" },
						{ trigger: "/bad", hint: "带斜杠" },
						{ trigger: "empty", hint: "" },
					],
				},
			},
		});
		const list = await listPlugins();
		expect(list[0].frontend?.slashCommands).toEqual([{ trigger: "roll", hint: "掷骰子" }]);
	});
});

describe("Web 命令注册表(webCommands 具名导出)", () => {
	it("入口导出 webCommands 且 trigger 在 manifest 声明内 → 注册;未声明忽略", async () => {
		writePlugin("cmd", {
			manifest: { frontend: { slashCommands: [{ trigger: "roll", hint: "掷骰子" }] } },
			entry: `export default function factory(pi) {}
export const webCommands = { roll: async () => "d20 = 7", ghost: async () => "未声明" };`,
		});
		const { webCommands } = await loadPlugins();
		const cmds = webCommands.get("cmd");
		expect(Object.keys(cmds ?? {})).toEqual(["roll"]);
		expect(await cmds!.roll({})).toBe("d20 = 7");
	});

	it("无 manifest 声明(未配置 slashCommands)时即使导出也不注册", async () => {
		writePlugin("nospec", {
			entry: `export default function factory(pi) {}
export const webCommands = { roll: async () => "x" };`,
		});
		const { webCommands } = await loadPlugins();
		expect(webCommands.has("nospec")).toBe(false);
	});
});

describe("trusted(完全信任)状态与 merge 语义", () => {
	it("readState 多键透传;改 enabled 不丢 trusted(merge 而非整体替换)", async () => {
		writePlugin("t1", {});
		await writePluginEnabled("t1", false);
		await writePluginTrusted("t1", true);
		let list = await listPlugins();
		expect(list[0]).toMatchObject({ enabled: false, trusted: true });
		// 再改 enabled:trusted 必须保留
		await writePluginEnabled("t1", true);
		list = await listPlugins();
		expect(list[0]).toMatchObject({ enabled: true, trusted: true });
	});

	it("trusted 缺省 false;writePluginTrusted 往返", async () => {
		writePlugin("t2", {});
		expect((await listPlugins())[0].trusted).toBe(false);
		await writePluginTrusted("t2", true);
		expect((await listPlugins())[0].trusted).toBe(true);
	});

	it("getPluginFrontendPath:存在返回绝对路径;不存在/逃逸返回 null", async () => {
		const dir = join(root, "fe");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "frontend.mjs"), "export default 1;");
		expect(getPluginFrontendPath("fe")).toBe(join(dir, "frontend.mjs"));
		expect(getPluginFrontendPath("fe", "custom.mjs")).toBeNull(); // 不存在
		expect(getPluginFrontendPath("fe", "../x.mjs")).toBeNull(); // 逃逸
		expect(getPluginFrontendPath("../evil")).toBeNull();
	});
});
