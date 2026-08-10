import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listScripts, loadScript, renderTextFor, reviseScript, saveScript } from "../src/stage/script-store.ts";
import { type SceneScript } from "../src/stage/types.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-stage-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function baseScript(): SceneScript {
	return {
		scene: "s1",
		chapter: "第一章",
		version: 1,
		definition: {
			cast: { "actor-1": ["李四"] },
			inject: { "actor-1": { characters: ["李四"], budget: 2000 } },
			rules: { minLines: 10, maxLines: 20, wrapUpWindow: 3, turn: "round-robin" },
		},
		text: {
			shared: {
				setting: "暮色中的酒馆。",
				goal: "重逢中揭开三年前的债",
				beats: ["拍1·寒暄试探", "拍2·冲突点"],
				tone: "克制、压抑",
				forbidden: ["禁用现代词汇"],
			},
			perActor: {
				"actor-1": { objective: "证明自己还清了债", state: "愧疚又恼怒", examples: ["王五: 三年了。", "李四: ……嗯。"] },
			},
		},
	};
}

describe("script-store", () => {
	it("save/load 往返一致", async () => {
		const script = baseScript();
		await saveScript(tmp, "s1", script);
		expect(await loadScript(tmp, "s1")).toEqual(script);
	});

	it("不存在的剧本返回 null", async () => {
		expect(await loadScript(tmp, "ghost")).toBeNull();
	});

	it("listScripts 只列 .json 文件", async () => {
		await saveScript(tmp, "s1", baseScript());
		await saveScript(tmp, "s2", baseScript());
		expect((await listScripts(tmp)).sort()).toEqual(["s1", "s2"]);
	});
});

describe("reviseScript（/revise 字段级合并语义）", () => {
	it("版本 +1 且 previous 快照上一版", () => {
		const revised = reviseScript(baseScript(), { text: { shared: { tone: "更欢快" } } });
		expect(revised.version).toBe(2);
		expect(revised.previous?.version).toBe(1);
		expect(revised.previous?.text.shared.tone).toBe("克制、压抑");
	});

	it("shared 字段级合并：改一处不动其余", () => {
		const revised = reviseScript(baseScript(), { text: { shared: { tone: "更欢快" } } });
		expect(revised.text.shared.tone).toBe("更欢快");
		expect(revised.text.shared.setting).toBe("暮色中的酒馆。");
		expect(revised.text.shared.beats).toEqual(["拍1·寒暄试探", "拍2·冲突点"]);
	});

	it("数组字段（beats/forbidden）整体替换", () => {
		const revised = reviseScript(baseScript(), { text: { shared: { beats: ["新拍1"] } } });
		expect(revised.text.shared.beats).toEqual(["新拍1"]);
	});

	it("perActor 字段级合并：只改 objective 保留 examples", () => {
		const revised = reviseScript(baseScript(), {
			text: { perActor: { "actor-1": { objective: "新任务" } } },
		});
		expect(revised.text.perActor["actor-1"].objective).toBe("新任务");
		expect(revised.text.perActor["actor-1"].examples).toEqual(["王五: 三年了。", "李四: ……嗯。"]);
	});

	it("rules 数值字段合并覆盖", () => {
		const revised = reviseScript(baseScript(), { rules: { minLines: 5 } });
		expect(revised.definition.rules.minLines).toBe(5);
		expect(revised.definition.rules.maxLines).toBe(20);
		expect(revised.definition.rules.turn).toBe("round-robin");
	});

	it("连续修订链式快照", () => {
		const v2 = reviseScript(baseScript(), { rules: { minLines: 5 } });
		const v3 = reviseScript(v2, { text: { shared: { tone: "第三次" } } });
		expect(v3.version).toBe(3);
		expect(v3.previous?.version).toBe(2);
		expect(v3.previous?.rules.minLines).toBe(5);
	});
});

describe("renderTextFor（结构化渲染）", () => {
	it("shared 全部字段按序渲染", () => {
		const lines = renderTextFor(baseScript(), "actor-9");
		expect(lines[0]).toContain("【场景】暮色中的酒馆。");
		expect(lines[1]).toContain("【本幕目标】重逢中揭开三年前的债");
		expect(lines.join("\n")).toContain("【节拍】\n1. 拍1·寒暄试探\n2. 拍2·冲突点");
		expect(lines.join("\n")).toContain("【基调】克制、压抑");
		expect(lines.join("\n")).toContain("【禁区】禁用现代词汇");
	});

	it("perActor 字段渲染含示例禁止复述标记", () => {
		const lines = renderTextFor(baseScript(), "actor-1");
		expect(lines.join("\n")).toContain("【角色任务】证明自己还清了债");
		expect(lines.join("\n")).toContain("【内心状态】愧疚又恼怒");
		expect(lines.join("\n")).toContain("【风格示例·仅参考语气，禁止复述】\n王五: 三年了。\n李四: ……嗯。");
	});

	it("未定向的演员只拿 shared（含空字段省略）", () => {
		const script = baseScript();
		script.text.perActor = {};
		script.text.shared.tone = "";
		const lines = renderTextFor(script, "actor-9");
		expect(lines.join("\n")).not.toContain("【基调】");
	});
});
