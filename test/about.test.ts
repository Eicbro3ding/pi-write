/**
 * 「关于」与检查更新的反证(2026-10-14)。
 *
 * 检查更新是 pi-writer 里**唯一会主动出网**的读接口,而它的失败形态比成功
 * 形态多得多(没网 / 限流 / 仓库没发过版 / 代理没配 / 响应不是 JSON)。所以
 * 这里逐条钉住每种结局的**判定与措辞**,重点是三种「没有新版本」不能互相混淆:
 *
 *   ok=false        —— 没查成(要看 error)
 *   latest=null     —— 查成了,但上游压根没发过 Release
 *   hasUpdate=false —— 查成了,确实是最新
 *
 * 全部走注入的 httpGet,不真联网。
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { abbreviateHome, aboutInfo, checkForUpdate, proxyFromEnv, repositoryLinks, repositorySlug, repositoryUrl, type HttpGet } from "../src/about.ts";

/** 测试用仓库地址(与 package.json 同形:带 git+ 前缀与 .git 后缀)。 */
const REPO = "git+https://github.com/Eicbro3ding/pi-write.git";

interface Call {
	url: string;
	proxy: string | null;
	headers: Record<string, string>;
}

/** 假请求器:回固定状态与 body,并记下每次调用的参数(供断言 URL/代理/请求头)。 */
function fakeGet(status: number, body: unknown, headers: Record<string, string> = {}): { httpGet: HttpGet; calls: Call[] } {
	const calls: Call[] = [];
	const httpGet: HttpGet = async (url, opts) => {
		calls.push({ url, proxy: opts.proxy, headers: opts.headers });
		return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) };
	};
	return { httpGet, calls };
}

/** 假请求器:直接抛错(模拟 DNS/连接失败)。 */
function throwingGet(message: string): HttpGet {
	return async () => {
		throw new Error(message);
	};
}

function releaseBody(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		tag_name: tag,
		html_url: `https://github.com/Eicbro3ding/pi-write/releases/tag/${tag}`,
		body: `## ${tag}\n修了几个东西。`,
		published_at: "2026-10-14T00:00:00Z",
		...extra,
	};
}

describe("repositoryUrl", () => {
	it("吃掉 git+ 前缀与 .git 后缀", () => {
		expect(repositoryUrl(REPO)).toBe("https://github.com/Eicbro3ding/pi-write");
	});

	it("scp 形态(git@host:owner/repo)转成 https", () => {
		expect(repositoryUrl("git@github.com:Eicbro3ding/pi-write.git")).toBe("https://github.com/Eicbro3ding/pi-write");
	});

	it("git:// 与 ssh:// 一并归到 https", () => {
		expect(repositoryUrl("git://github.com/o/r.git")).toBe("https://github.com/o/r");
		expect(repositoryUrl("ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r");
	});

	it("空串原样回空(不编一个地址出来)", () => {
		expect(repositoryUrl("")).toBe("");
		expect(repositoryUrl("   ")).toBe("");
	});
});

describe("repositorySlug", () => {
	it("取 owner/repo", () => {
		expect(repositorySlug(REPO)).toBe("Eicbro3ding/pi-write");
	});

	it("带子路径 / 自建站形态回 null(不能瞎拼 API 地址)", () => {
		expect(repositorySlug("https://gitlab.example.com/g/sub/r")).toBeNull();
		expect(repositorySlug("")).toBeNull();
	});
});

describe("proxyFromEnv", () => {
	it("按 https_proxy → HTTPS_PROXY → http_proxy … 的顺序取第一个", () => {
		expect(proxyFromEnv({ https_proxy: "http://127.0.0.1:7897" })).toBe("http://127.0.0.1:7897");
		expect(proxyFromEnv({ HTTPS_PROXY: "http://a:1", http_proxy: "http://b:2" })).toBe("http://a:1");
		expect(proxyFromEnv({ http_proxy: "http://b:2" })).toBe("http://b:2");
	});

	it("没写协议时补 http://", () => {
		expect(proxyFromEnv({ https_proxy: "127.0.0.1:7897" })).toBe("http://127.0.0.1:7897");
	});

	it("跳过 socks —— 只实现了 http 隧道,拿个跑不通的值去试不如明说", () => {
		expect(proxyFromEnv({ all_proxy: "socks5h://127.0.0.1:7897" })).toBeNull();
	});

	it("没配就回 null(直连)", () => {
		expect(proxyFromEnv({})).toBeNull();
	});
});

describe("repositoryLinks(侧栏「相关」由仓库地址推导)", () => {
	it("GitHub 仓库 → 三条链接都拼得出来", () => {
		const l = repositoryLinks(REPO);
		expect(l.changelog).toBe("https://github.com/Eicbro3ding/pi-write/blob/main/CHANGELOG.md");
		expect(l.thirdParty).toBe("https://github.com/Eicbro3ding/pi-write/blob/main/THIRD-PARTY.md");
		expect(l.issues).toBe("https://github.com/Eicbro3ding/pi-write/issues");
	});

	it("非 GitHub 托管站 → 全 null(路径约定不同,猜错就是 404 死链)", () => {
		expect(repositoryLinks("https://gitlab.example.com/o/r")).toEqual({ changelog: null, thirdParty: null, issues: null });
	});

	it("没配仓库 → 全 null", () => {
		expect(repositoryLinks("")).toEqual({ changelog: null, thirdParty: null, issues: null });
	});
});

describe("abbreviateHome", () => {
	it("家目录下的路径缩写成 ~", () => {
		const home = homedir();
		expect(abbreviateHome(join(home, ".pi", "writer"))).toBe("~/.pi/writer");
	});

	it("家目录本身 / 家目录外的路径不动", () => {
		const home = homedir();
		expect(abbreviateHome(home)).toBe("~");
		expect(abbreviateHome("/opt/elsewhere")).toBe("/opt/elsewhere");
		// 前缀像但不同级(/home/user2 vs /home/user)不能被误缩
		expect(abbreviateHome(`${home}2/x`)).toBe(`${home}2/x`);
	});
});

describe("aboutInfo(「关于」页的单一组装点)", () => {
	it("带出版本/作者/许可证/仓库/本机目录/相关链接", () => {
		const a = aboutInfo();
		expect(a.version).not.toBe("0.0.0");
		expect(a.author).toBeTruthy();
		expect(a.license).toBeTruthy();
		expect(a.repository).toContain("github.com/Eicbro3ding/pi-write");
		expect(a.dataDir).toContain(".pi/writer");
		expect(a.booksDir).toContain(".pi/writer/books");
		expect(a.links.issues).toContain("/issues");
	});

	it("version 可由宿主覆盖(Electron 传 app.getVersion(),打包后读不到 package.json)", () => {
		expect(aboutInfo({ version: "9.9.9" }).version).toBe("9.9.9");
		// 空串等于没传 —— 不能把版本号覆盖成空
		expect(aboutInfo({ version: "  " }).version).toBe(aboutInfo().version);
	});
});

describe("checkForUpdate", () => {
	it("上游更新 → hasUpdate + 指向该 Release 页", async () => {
		const { httpGet, calls } = fakeGet(200, releaseBody("v0.3.4"));
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.ok).toBe(true);
		expect(r.latest).toBe("0.3.4");
		expect(r.hasUpdate).toBe(true);
		expect(r.url).toBe("https://github.com/Eicbro3ding/pi-write/releases/tag/v0.3.4");
		expect(r.notes).toContain("修了几个东西");
		// 打的是 api.github.com 的 owner/repo 路径,且带 User-Agent(GitHub 强制)
		expect(calls[0]!.url).toBe("https://api.github.com/repos/Eicbro3ding/pi-write/releases/latest");
		expect(calls[0]!.headers["user-agent"]).toContain("pi-writer/");
	});

	it("tag 没有 v 前缀也认", async () => {
		const { httpGet } = fakeGet(200, releaseBody("0.4.0"));
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.hasUpdate).toBe(true);
	});

	it("同版本 → 已是最新", async () => {
		const { httpGet } = fakeGet(200, releaseBody("v0.3.3"));
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.ok).toBe(true);
		expect(r.hasUpdate).toBe(false);
		expect(r.latest).toBe("0.3.3");
	});

	it("上游 tag 比当前**旧**(开发版领先)→ 不报有更新", async () => {
		const { httpGet } = fakeGet(200, releaseBody("v0.2.0"));
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.hasUpdate).toBe(false);
	});

	it("当前版本不是合法版本号 → 不报更新(宁可漏报,不可误导)", async () => {
		const { httpGet } = fakeGet(200, releaseBody("v9.9.9"));
		const r = await checkForUpdate("dev-build", { repository: REPO, httpGet });
		expect(r.ok).toBe(true);
		expect(r.hasUpdate).toBe(false);
	});

	it("pre-release 小于同号正式版(semver 语义,不特殊照顾)", async () => {
		const { httpGet } = fakeGet(200, releaseBody("v0.4.0-beta.1"));
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.latest).toBe("0.4.0-beta.1");
		expect(r.hasUpdate).toBe(true);
	});

	it("404(上游没发过 Release)→ 不算失败,但 latest 为 null 以示区分", async () => {
		const { httpGet } = fakeGet(404, { message: "Not Found" });
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.ok).toBe(true);
		expect(r.latest).toBeNull();
		expect(r.hasUpdate).toBe(false);
		expect(r.error).toBeNull();
		// 仍给出仓库页,让用户自己去看
		expect(r.url).toBe("https://github.com/Eicbro3ding/pi-write");
	});

	it("403 且匿名额度用尽 → 说清是限流,并提示过一会儿再来", async () => {
		const { httpGet } = fakeGet(403, { message: "rate limit" }, { "x-ratelimit-remaining": "0" });
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("60 次");
	});

	it("连接失败 + 没配代理 → 错误里带上「怎么配」", async () => {
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet: throwingGet("getaddrinfo ENOTFOUND"), env: {} });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("ENOTFOUND");
		expect(r.error).toContain("HTTPS_PROXY");
	});

	it("连接失败 + 配了代理 → 提示去查代理是否在跑", async () => {
		const r = await checkForUpdate("0.3.3", {
			repository: REPO,
			httpGet: throwingGet("socket hang up"),
			env: { https_proxy: "http://127.0.0.1:7897" },
		});
		expect(r.error).toContain("127.0.0.1:7897");
	});

	it("只有 socks 代理时,错误里点明本功能只支持 http 代理", async () => {
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet: throwingGet("boom"), env: { all_proxy: "socks5://127.0.0.1:7897" } });
		expect(r.error).toContain("socks");
	});

	it("代理被真的用上了(传给请求器)", async () => {
		const { httpGet, calls } = fakeGet(200, releaseBody("v0.3.3"));
		await checkForUpdate("0.3.3", { repository: REPO, httpGet, env: { https_proxy: "http://127.0.0.1:7897" } });
		expect(calls[0]!.proxy).toBe("http://127.0.0.1:7897");
	});

	it("响应不是 JSON → 说人话,不抛异常", async () => {
		const { httpGet } = fakeGet(200, "<html>502 Bad Gateway</html>");
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("JSON");
	});

	it("其他状态码 → 带上状态码", async () => {
		const { httpGet } = fakeGet(500, {});
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("500");
	});

	it("没配仓库地址 → 直接说查不了,不发请求", async () => {
		const { httpGet, calls } = fakeGet(200, releaseBody("v0.3.4"));
		const r = await checkForUpdate("0.3.3", { repository: "", httpGet });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("仓库");
		expect(calls).toHaveLength(0);
	});

	it("长说明按整行截断 —— 不把 markdown 标记切成两半", async () => {
		// 说明是 CHANGELOG 原文,渲染成 HTML 后才上界面。若从字符中间切,
		// `**` / 反引号 / `- ` 会留下半个标记,前端渲染出残缺符号。
		const lines = Array.from(
			{ length: 20 },
			(_, i) => `- [feat] **第 ${i} 条**:这是一条足够长的说明,用来把总长度推过六百字符的上限。`,
		);
		const { httpGet } = fakeGet(200, releaseBody("v0.3.4", { body: lines.join("\n") }));
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });

		const notes = r.notes!;
		expect(notes.endsWith("…(已截断)")).toBe(true);
		// 去掉截断提示后,留下来的每一行都必须与原文某一行**逐字相同**
		const kept = notes.replace(/…\(已截断\)$/, "").split("\n");
		expect(kept.length).toBeGreaterThan(1);
		expect(kept.every((l) => lines.includes(l))).toBe(true);
		expect(kept.join("\n").length).toBeLessThanOrEqual(600);
	});

	it("单行就超限(没有可退的整行)→ 硬截,不返回空", async () => {
		const { httpGet } = fakeGet(200, releaseBody("v0.3.4", { body: "长".repeat(900) }));
		const r = await checkForUpdate("0.3.3", { repository: REPO, httpGet });
		expect(r.ok).toBe(true);
		expect(r.notes).toBeTruthy();
		expect(r.notes!.length).toBeLessThanOrEqual(600 + "…(已截断)".length);
	});
});
