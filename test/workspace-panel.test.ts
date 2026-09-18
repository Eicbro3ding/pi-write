/**
 * 工作区面板工具(纯函数)测试:体积与相对时间格式化。
 * 面板把「多大 / 多久以前」当主信息展示,格式边界(进位、四舍五入到单位切换)
 * 直接影响可读性,所以逐档固定住。
 */
import { describe, expect, it } from "vitest";
import { formatAgo, formatBytes } from "../web/src/components/WorkspacePanel.tsx";

describe("formatBytes", () => {
	it("B / KB / MB 三档", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(4)).toBe("4 B");
		expect(formatBytes(1023)).toBe("1023 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(5210)).toBe("5.1 KB");
		expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(412000)).toBe("402.3 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
	});
});

describe("formatAgo", () => {
	const now = Date.parse("2026-09-18T20:00:00+08:00");
	const ago = (minutes: number) => formatAgo(now - minutes * 60_000, now);

	it("刚刚 / 分钟 / 小时 / 天 / 月", () => {
		expect(ago(0.4)).toBe("刚刚");
		expect(ago(1)).toBe("1 分钟前");
		expect(ago(59)).toBe("59 分钟前");
		expect(ago(60)).toBe("1 小时前");
		expect(ago(60 * 23)).toBe("23 小时前");
		expect(ago(60 * 24)).toBe("1 天前");
		expect(ago(60 * 24 * 30)).toBe("30 天前");
		expect(ago(60 * 24 * 60)).toBe("2 个月前");
	});

	it("未来时间(钟差)不出现负数", () => {
		expect(formatAgo(now + 60_000, now)).toBe("刚刚");
	});
});
