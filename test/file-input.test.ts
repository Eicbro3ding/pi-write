import { describe, expect, it } from "vitest";
import { snapshotFiles } from "../web/src/components/file-input.ts";

describe("file input", () => {
	it("copies selected files before the input is reset", () => {
		const file = new File(["avatar"], "avatar.png", { type: "image/png" });
		const selected = { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) } as unknown as FileList;
		const files = snapshotFiles(selected);
		expect(files).toEqual([file]);
		expect(files).not.toBe(selected);
	});
});
