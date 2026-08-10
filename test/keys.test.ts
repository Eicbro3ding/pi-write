import { describe, expect, it } from "vitest";
import { keysFromInput, resolveKeysCommit } from "../web/src/keys.ts";

describe("keysFromInput 解析", () => {
	it("中英文逗号分隔,trim 去空", () => {
		expect(keysFromInput("凯文, 老 K，kevin")).toEqual(["凯文", "老 K", "kevin"]);
	});
	it("去重保持首次出现顺序", () => {
		expect(keysFromInput("a, b, a, c")).toEqual(["a", "b", "c"]);
	});
	it("全分隔符/空白 → 空数组", () => {
		expect(keysFromInput(" , ， ")).toEqual([]);
		expect(keysFromInput("")).toEqual([]);
	});
});

describe("resolveKeysCommit 提交决策", () => {
	it("真空输入 → 提交 [] 清空,草稿置空", () => {
		expect(resolveKeysCommit("   ", ["a"])).toEqual({ draft: "", keys: [] });
	});
	it("仅分隔符 → 不提交(null),草稿回退原值", () => {
		expect(resolveKeysCommit("， ,", ["a"])).toEqual({ draft: "a", keys: null });
	});
	it("正常输入 → 提交解析结果,草稿规范化", () => {
		expect(resolveKeysCommit("凯文,凯文, 老 K", ["x"])).toEqual({ draft: "凯文, 老 K", keys: ["凯文", "老 K"] });
	});
});
