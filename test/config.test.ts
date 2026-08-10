import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir, getBookDir, getBooksDir, getWriterDir, slugify } from "../src/config.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

describe("slugify", () => {
	it("lowercases and dash-joins Latin titles", () => {
		expect(slugify("My Novel")).toBe("my-novel");
		expect(slugify("A/B: C?")).toBe("a-b-c");
	});

	it("keeps CJK characters as-is", () => {
		expect(slugify("我的小说")).toBe("我的小说");
		expect(slugify("你好 World")).toBe("你好-world");
	});

	it("falls back for empty titles", () => {
		expect(slugify("   ")).toBe("untitled");
		expect(slugify("---")).toBe("untitled");
	});
});

describe("config paths", () => {
	it("uses PI_WRITER_DIR for the writer root and books dir", () => {
		expect(getWriterDir()).toBe(tmp);
		expect(getBooksDir()).toBe(join(tmp, "books"));
		expect(getBookDir("my-novel")).toBe(join(tmp, "books", "my-novel"));
	});

	it("defaults the agent dir under the writer root", () => {
		expect(getAgentDir()).toBe(join(tmp, "agent"));
	});

	it("honors PI_WRITER_AGENT_DIR", () => {
		vi.stubEnv("PI_WRITER_AGENT_DIR", join(tmp, "custom-agent"));
		expect(getAgentDir()).toBe(join(tmp, "custom-agent"));
	});
});
