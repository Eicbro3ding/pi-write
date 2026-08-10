import { describe, expect, it } from "vitest";
import {
	deleteEntryWithRelations,
	disconnectEntry,
	genAvatarDataUrl,
} from "../web/src/graph-logic.ts";
import type { WorldEntryDto, WorldRelationDto } from "../web/src/types.ts";

function entry(id: string, parent: string | null = null): WorldEntryDto {
	return {
		id,
		type: "character",
		title: id,
		keys: [],
		chapters: [],
		status: "active",
		active: true,
		parent,
		tags: [],
		body: "",
		avatar: null,
		images: [],
		updatedAt: 0,
	};
}

function rel(id: string, from: string, to: string): WorldRelationDto {
	return { id, from, to, type: "盟友", label: "", emphasized: false, arrow: "double" };
}

const R = [
	rel("r1", "a", "b"),
	rel("r2", "b", "a"), // 反向(双箭头常态下成对)
	rel("r3", "a", "c"),
	rel("r4", "d", "e"), // 与 a 无关
];

describe("disconnectEntry", () => {
	it("移除 from 命中的连线", () => {
		expect(disconnectEntry(R, "a").map((r) => r.id)).not.toContain("r1");
	});
	it("移除 to 命中的连线(反向也断)", () => {
		expect(disconnectEntry(R, "a").map((r) => r.id)).not.toContain("r2");
	});
	it("保留不相关的连线", () => {
		const next = disconnectEntry(R, "a");
		expect(next).toHaveLength(1);
		expect(next[0].id).toBe("r4");
	});
	it("无连线时原样返回", () => {
		const next = disconnectEntry(R, "e");
		expect(next.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
	});
	it("不修改原数组", () => {
		const copy = [...R];
		disconnectEntry(R, "a");
		expect(R).toEqual(copy);
	});
});

describe("deleteEntryWithRelations", () => {
	const E = [entry("a"), entry("b", "a"), entry("c", "b")]; // a→b→c 层级

	it("移除条目与相关连线", () => {
		const next = deleteEntryWithRelations(E, R, "a");
		expect(next.entries.map((e) => e.id)).toEqual(["b", "c"]);
		expect(next.relations.map((r) => r.id)).toEqual(["r4"]);
	});
	it("直接子条目 parent 清空转根,孙条目不受影响", () => {
		const next = deleteEntryWithRelations(E, R, "a");
		expect(next.entries.find((e) => e.id === "b")?.parent).toBeNull();
		expect(next.entries.find((e) => e.id === "c")?.parent).toBe("b");
	});
	it("不存在的 id 返回原状", () => {
		const next = deleteEntryWithRelations(E, R, "nope");
		expect(next.entries).toHaveLength(3);
		expect(next.relations).toHaveLength(4);
	});
});

describe("genAvatarDataUrl", () => {
	it("返回 SVG data URL 且含标题首字", () => {
		const url = genAvatarDataUrl("林婉", "#e8b56d");
		expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
		expect(decodeURIComponent(url)).toContain("林");
		expect(decodeURIComponent(url)).toContain("#e8b56d");
	});
	it("空标题回退问号", () => {
		expect(decodeURIComponent(genAvatarDataUrl("   ", "#e8b56d"))).toContain("?");
		expect(decodeURIComponent(genAvatarDataUrl("", "#e8b56d"))).toContain("?");
	});
	it("XML 特殊字符转义", () => {
		const url = decodeURIComponent(genAvatarDataUrl("<林&", "#e8b56d"));
		expect(url).toContain("&lt;");
		expect(url).not.toContain("<林");
	});
});
