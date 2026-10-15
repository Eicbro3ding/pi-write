import { describe, expect, it } from "vitest";
import { copyrightLine, dayLabel, modelRef, pickFallbackModel, repositoryLabel, stampLabel, updateView } from "../web/src/pages/SettingsPage.tsx";
import type { UpdateCheckDto } from "../web/src/types.ts";

describe("SettingsPage 模型工具(纯函数)", () => {
	it("modelRef:对象元素归一为 provider/id", () => {
		expect(modelRef({ id: "claude-3-5-sonnet", provider: "anthropic" })).toBe("anthropic/claude-3-5-sonnet");
	});
	it("modelRef:字符串透传,空/形状不符返回 null", () => {
		expect(modelRef("anthropic/sonnet")).toBe("anthropic/sonnet");
		expect(modelRef("")).toBeNull();
		expect(modelRef(null)).toBeNull();
		expect(modelRef(undefined)).toBeNull();
		expect(modelRef({ id: "x" })).toBeNull();
		expect(modelRef({ provider: "anthropic" })).toBeNull();
		expect(modelRef(42)).toBeNull();
	});
});

describe("SettingsPage.pickFallbackModel", () => {
	const models = [
		{ id: "gpt-4o", provider: "openai" },
		{ id: "deepseek-chat", provider: "deepseek" },
	];
	it("当前模型仍在列表 → 不回退", () => {
		expect(pickFallbackModel("openai/gpt-4o", models)).toBeNull();
	});
	it("当前模型消失 → 回退第一个", () => {
		expect(pickFallbackModel("anthropic/sonnet", models)).toBe("openai/gpt-4o");
	});
	it("无当前模型或列表为空 → 不回退", () => {
		expect(pickFallbackModel(null, models)).toBeNull();
		expect(pickFallbackModel("anthropic/sonnet", [])).toBeNull();
	});
});

describe("SettingsPage.updateView(「关于」页版本卡的三态)", () => {
	const base: UpdateCheckDto = {
		ok: true,
		current: "0.3.3",
		latest: "0.3.3",
		hasUpdate: false,
		url: "https://github.com/Eicbro3ding/pi-write",
		notes: null,
		publishedAt: null,
		error: null,
	};

	it("还没查过 → 版本行仍然要有值(不能是空的)", () => {
		const v = updateView(null, "0.3.4");
		expect(v.version).toBe("v0.3.4");
		expect(v.action).toBe("检查更新");
		// 没查过就不该有状态行,也不该给下载按钮
		expect(v.status).toBe("");
		expect(v.download).toBeNull();
		expect(v.showNotes).toBe(false);
	});

	it("还没查过且版本号未知 → 回落到 —(不显示一个假的 v)", () => {
		expect(updateView(null, "").version).toBe("v—");
	});

	it("已是最新 → ok 语气、无徽标、无下载、**不出更新说明卡**", () => {
		const v = updateView(base, "0.3.3");
		expect(v.tone).toBe("ok");
		expect(v.status).toBe("已是最新");
		expect(v.versionLabel).toBe("当前版本");
		expect(v.chip).toBeNull();
		expect(v.download).toBeNull();
		// 设计稿状态 01(已是最新)只有版本卡 + 版权页:把上游那份说明摆出来,
		// 读者会以为「更新说明」讲的是自己该装的版本(其实已经装着了)。
		expect(v.showNotes).toBe(false);
	});

	it("有新版本 → warn 语气 + 徽标 + 主按钮指向 Release 页 + 版本区间 + 出更新说明卡", () => {
		const v = updateView({ ...base, latest: "0.3.4", hasUpdate: true, url: "https://github.com/o/r/releases/tag/v0.3.4" }, "0.3.3");
		expect(v.tone).toBe("warn");
		expect(v.versionLabel).toBe("最新版本");
		expect(v.version).toBe("v0.3.4");
		expect(v.chip).toBe("有新版本");
		expect(v.status).toContain("0.3.3");
		expect(v.download).toBe("https://github.com/o/r/releases/tag/v0.3.4");
		expect(v.range).toBe("v0.3.3 → v0.3.4");
		expect(v.showNotes).toBe(true);
	});

	it("上游没发过版(latest=null)**不等于**已是最新 —— 措辞必须分开,且不出说明卡", () => {
		const v = updateView({ ...base, latest: null }, "0.3.3");
		expect(v.status).not.toContain("已是最新");
		expect(v.status).toContain("还没有发布");
		expect(v.range).toBeNull();
		expect(v.showNotes).toBe(false);
	});

	it("没查成 → err 语气,原样带出服务端给的原因,按钮变「重试」", () => {
		const v = updateView({ ...base, ok: false, latest: null, error: "连不上 GitHub:ENOTFOUND" }, "0.3.3");
		expect(v.tone).toBe("err");
		expect(v.error).toContain("ENOTFOUND");
		expect(v.action).toBe("重试");
		// 失败时不摆状态行(错误走红框),版本行仍显示"你现在用的是哪个"
		expect(v.status).toBe("");
		expect(v.version).toBe("v0.3.3");
	});
});

describe("SettingsPage 关于页的文案函数", () => {
	it("copyrightLine:许可证 + 年份 + 著者", () => {
		const s = copyrightLine("MIT", "Eicbro3ding");
		expect(s).toContain("MIT");
		expect(s).toContain("Eicbro3ding");
		expect(s).toContain("©");
	});

	it("copyrightLine:缺项自动略掉,不留裸分隔符", () => {
		expect(copyrightLine("MIT", "")).toBe("MIT");
		expect(copyrightLine("", "Eicbro3ding")).not.toMatch(/^ ·| ·$/);
		expect(copyrightLine("", "")).toBe("");
	});

	it("dayLabel:按本机时区取到日,不是 UTC(深夜发布不能显示成前一天)", () => {
		// 本地 2026-10-15 01:00 对应的瞬时,在同一台机器上必须回落到 15 号
		const local = new Date(2026, 9, 15, 1, 0, 0);
		expect(dayLabel(local.toISOString())).toBe("2026-10-15");
	});

	it("dayLabel:空/非法时间回空串(界面据此显示 —)", () => {
		expect(dayLabel(null)).toBe("");
		expect(dayLabel("不是时间")).toBe("");
	});

	it("stampLabel:补零到 YYYY-MM-DD HH:mm", () => {
		expect(stampLabel(new Date(2026, 0, 5, 9, 7))).toBe("2026-01-05 09:07");
	});
});

describe("SettingsPage.repositoryLabel", () => {
	it("去掉协议头,其余原样(路径大小写不能动)", () => {
		expect(repositoryLabel("https://github.com/Eicbro3ding/pi-write")).toBe("github.com/Eicbro3ding/pi-write");
		expect(repositoryLabel("http://git.example.com/x/y")).toBe("git.example.com/x/y");
	});
});
