import { describe, expect, expectTypeOf, it } from "vitest";
import type { DraftStatus } from "../web/src/types.ts";
import { resolveSaveOutcome } from "../web/src/workspace.ts";

describe("DraftWorkspace 保存状态联合类型契约", () => {
	it("保存状态联合类型只能出现 loading | saved | dirty | saving | save-error", () => {
		expectTypeOf<DraftStatus>().toEqualTypeOf<"loading" | "saved" | "dirty" | "saving" | "save-error">();
		// 穷举联合成员,保证五个状态全部存在且无重复
		const statuses: DraftStatus[] = ["loading", "saved", "dirty", "saving", "save-error"];
		expect(statuses).toHaveLength(5);
		expect(new Set(statuses).size).toBe(5);
	});
});

describe("resolveSaveOutcome 保存完成竞态决策", () => {
	const base = {
		startedFile: "draft/ch01.md",
		currentFile: "draft/ch01.md",
		savedText: "潮声。",
		currentText: "潮声。",
		autosavePending: false,
		error: null as string | null,
	};

	it("保存期间文件已切换:静默放弃,即使有错误或文本变化也不更新状态", () => {
		// 切章后旧文件的保存成功返回:不得把新文件状态翻成 saved
		expect(resolveSaveOutcome({ ...base, currentFile: "draft/ch02.md" })).toEqual({ kind: "abandon" });
		// 文本变化同样不能生效(不得清掉/改写新文件的 dirty 状态)
		expect(resolveSaveOutcome({ ...base, currentFile: "draft/ch02.md", currentText: "海风。" })).toEqual({
			kind: "abandon",
		});
		// 过期失败也放弃:不得把新文件状态翻成 save-error / 覆盖新文件的错误文案
		expect(resolveSaveOutcome({ ...base, currentFile: "draft/ch02.md", error: "网络错误" })).toEqual({
			kind: "abandon",
		});
	});

	it("文件未变、保存成功、文本未变:回到 saved", () => {
		expect(resolveSaveOutcome(base)).toEqual({ kind: "saved" });
	});

	it("文件未变、保存失败:进入 save-error 并携带错误信息", () => {
		expect(resolveSaveOutcome({ ...base, error: "网络错误" })).toEqual({ kind: "save-error", message: "网络错误" });
	});

	it("文件未变、保存期间有新编辑:回 dirty;已有自动保存定时器则不重复排", () => {
		// 无 pending timer:需要重新排队自动保存
		expect(resolveSaveOutcome({ ...base, currentText: "潮声。她抬起头。" })).toEqual({ kind: "dirty", reschedule: true });
		// handleChange 已排 800ms 定时器:不再重复排,避免两次相同 PUT
		expect(resolveSaveOutcome({ ...base, currentText: "潮声。她抬起头。", autosavePending: true })).toEqual({
			kind: "dirty",
			reschedule: false,
		});
	});
});
