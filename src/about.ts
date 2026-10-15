/**
 * 「关于」应用信息与检查更新(2026-10-14)。
 *
 * 检查更新只做一件事:**查 GitHub Releases 的最新 tag,和当前版本比大小**。
 * 不下载、不安装、不常驻 —— 这里给出的信息是「有没有新版 + 去哪拿」,
 * 安装仍是用户自己动手(桌面版与 Web 版更新方式不同,不该由程序代劳)。
 *
 * 三条纪律:
 *
 * 1. **失败必须说人话。** 国内网络直连 api.github.com 大概率不通,而
 *    Electron 从桌面图标启动时读不到 shell 里的 `HTTPS_PROXY`(GUI 不读 .zshrc)。
 *    所以错误文案要带上「怎么配代理」,而不是只回一个 ECONNRESET。
 * 2. **只在你点按钮时发一次请求。** 不后台轮询、不自动重试 —— 写作工具没什么
 *    可自动更新的东西,为它常驻一个定时器不值。
 * 3. **tag 不比当前新,一律算「已是最新」。** 开发版跑在发布版前面时不能报
 *    「有更新」;tag 解析不出来时也不能瞎报。
 *
 * 网络层用 `node:https` + `https-proxy-agent`(两者都已在依赖里,不引入新包)。
 * 不用全局 fetch:它读不了环境变量代理,而代理正是这里最需要的。
 */
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { sep } from "node:path";
import { gt, valid } from "semver";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getBooksDir, getWriterDir, packageAuthor, packageHomepage, packageLicense, packageRepository, VERSION } from "./config.ts";

/** 运行形态:决定「检查更新」给出的后续动作怎么说。 */
export type Edition = "electron" | "web" | "cli";

/**
 * 「关于」页侧栏「相关」里的外链。全部由仓库地址推导,推不出来就是 null
 * (前端据此隐藏该条,不显示死链)。
 */
export interface AboutLinks {
	changelog: string | null;
	thirdParty: string | null;
	issues: string | null;
}

/** 「关于」页要展示的静态信息。 */
export interface AboutInfo {
	name: string;
	version: string;
	author: string;
	/** SPDX 标识符(package.json 的 license);读不到为空串。 */
	license: string;
	/** 规范化后的仓库地址(https://host/owner/repo);读不到为空串。 */
	repository: string;
	homepage: string;
	/** 数据根目录,家目录部分缩写成 `~`(「本机」那一组用)。 */
	dataDir: string;
	/** 书稿目录(<数据根>/books)。 */
	booksDir: string;
	/** 由仓库地址推导的相关外链;非 github.com 形态时全为 null。 */
	links: AboutLinks;
	edition: Edition;
}

/** 一次检查更新的结果(失败也是结果 —— ok=false 时看 error)。 */
export interface UpdateCheckResult {
	ok: boolean;
	/** 当前版本(与「关于」页显示的一致)。 */
	current: string;
	/** 上游最新 tag(规范化后);没发布过 Release 时为 null。 */
	latest: string | null;
	hasUpdate: boolean;
	/** 有更新时指向该 Release 页面,否则仓库页(便于用户自己去看)。 */
	url: string;
	/** Release 说明(截断)。 */
	notes: string | null;
	publishedAt: string | null;
	/** ok=false 时的可读原因(含代理提示)。 */
	error: string | null;
}

/** Release 说明在界面上的展示上限 —— 再多也不该塞进设置页。 */
const NOTES_LIMIT = 600;
/** 单次请求超时。GitHub 正常 1s 内回,给 8s 是照顾挂代理的情况。 */
export const UPDATE_TIMEOUT_MS = 8000;

/**
 * 规范化仓库地址:吃掉 `git+` 前缀、结尾 `.git`、scp 形态(`git@host:owner/repo`)
 * 与 `git://` / `ssh://` 协议,统一成 https 形式(直接可以给浏览器打开)。
 */
export function repositoryUrl(raw: string): string {
	let s = raw.trim().replace(/^git\+/, "").replace(/\.git$/, "");
	// git@github.com:owner/repo → https://github.com/owner/repo
	// (去掉 `user@` 前缀,再把分隔 host 与 path 的那个冒号换成斜杠)
	if (/^[\w.-]+@[\w.-]+:/.test(s)) s = `https://${s.replace(/^[\w.-]+@/, "").replace(":", "/")}`;
	s = s.replace(/^git:\/\//i, "https://").replace(/^ssh:\/\/(?:git@)?/i, "https://");
	return s.replace(/\/+$/, "");
}

/** 从仓库地址取 `owner/repo`;不是托管站形态(自建 git 等)时回 null。 */
export function repositorySlug(raw: string): string | null {
	const m = repositoryUrl(raw).match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
	return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * 从环境变量取代理。**只认 http(s) 代理**:`https-proxy-agent` 走 CONNECT 隧道,
 * socks5 得换别的实现,所以这里显式跳过而不是拿一个跑不通的值去试。
 */
export function proxyFromEnv(env: Record<string, string | undefined> = process.env): string | null {
	for (const key of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]) {
		const raw = (env[key] ?? "").trim();
		if (!raw) continue;
		if (/^socks/i.test(raw)) continue;
		return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
	}
	return null;
}

/** 家目录缩写成 `~`:设置页把本机路径摆出来时,`~/.pi/writer` 比绝对路径可读。 */
export function abbreviateHome(path: string): string {
	const home = homedir();
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * 从仓库地址推导「相关」外链。**只认 github.com** —— CHANGELOG / THIRD-PARTY
 * 的网页路径与 issues 路由各家托管站都不一样(gitlab 是 `/-/blob/` 等),
 * 猜错就是一个 404 死链。认不出就全回 null,让前端整组不显示。
 */
export function repositoryLinks(raw: string): AboutLinks {
	const none: AboutLinks = { changelog: null, thirdParty: null, issues: null };
	const url = repositoryUrl(raw);
	if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) return none;
	return {
		changelog: `${url}/blob/main/CHANGELOG.md`,
		thirdParty: `${url}/blob/main/THIRD-PARTY.md`,
		issues: `${url}/issues`,
	};
}

/** 组装「关于」信息(version 可由 Electron 主进程覆盖 —— 见 aboutInfo 的参数)。 */
export function aboutInfo(opts: { version?: string; edition?: Edition } = {}): AboutInfo {
	const version = (opts.version ?? "").trim() || VERSION;
	const repository = repositoryUrl(packageRepository());
	return {
		name: "pi-writer",
		version,
		author: packageAuthor(),
		license: packageLicense(),
		repository,
		homepage: packageHomepage() || repository,
		dataDir: abbreviateHome(getWriterDir()),
		booksDir: abbreviateHome(getBooksDir()),
		links: repositoryLinks(repository),
		edition: opts.edition ?? "web",
	};
}

/** 一次 HTTP GET 的产物(够用即可:状态、几个头、正文)。 */
export interface HttpGetResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

/** 可注入的 GET 实现(测试用假的,避免真联网)。 */
export type HttpGet = (
	url: string,
	opts: { proxy: string | null; timeoutMs: number; headers: Record<string, string> },
) => Promise<HttpGetResult>;

/** 默认实现:`node:https`,配了代理就走 CONNECT 隧道。 */
export const nodeHttpGet: HttpGet = (url, { proxy, timeoutMs, headers }) =>
	new Promise((resolve, reject) => {
		const req = httpsRequest(url, { method: "GET", headers, ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}) }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }),
			);
			res.on("error", reject);
		});
		req.on("error", reject);
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`超过 ${timeoutMs / 1000} 秒没有响应`)));
		req.end();
	});

/** 把 tag 规范化成可比大小的版本号;`v1.2.3` / `1.2.3` 都吃,其他回 null。 */
function normalizeTag(tag: string): string | null {
	return valid(tag.trim().replace(/^v/i, "")) ?? null;
}

/**
 * 截断 Release 说明。**按整行截断,不按字符** —— 说明是 CHANGELOG 的 markdown 原文
 * (CI 直接抽出来当 body),从字符中间切会把 `**` / 反引号 / 列表标记切成两半,
 * 渲染出一堆残缺符号。宁可少一条,不要给出坏标记。
 */
function clip(text: string, limit: number): string {
	const t = text.trim();
	if (t.length <= limit) return t;
	let out = "";
	for (const line of t.split("\n")) {
		const next = out ? `${out}\n${line}` : line;
		if (next.length > limit) break;
		out = next;
	}
	// 首行本身就超限(没有可退的整行)→ 只能硬截,这是唯一的例外。
	if (!out) out = t.slice(0, limit);
	return `${out.trimEnd()}…(已截断)`;
}

/**
 * 查最新 Release 并和 `current` 比大小。
 *
 * 失败路径**一律回 ok=false + 人话 error**,由前端原样展示 —— 这里不抛异常:
 * 「检查更新」的失败是常态(没网、限流、仓库没有 Release),不该让页面炸掉。
 */
export async function checkForUpdate(
	current: string,
	opts: { repository?: string; edition?: Edition; httpGet?: HttpGet; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<UpdateCheckResult> {
	const httpGet = opts.httpGet ?? nodeHttpGet;
	const env = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? UPDATE_TIMEOUT_MS;
	const rawRepo = opts.repository ?? packageRepository();
	const base: UpdateCheckResult = {
		ok: false,
		current,
		latest: null,
		hasUpdate: false,
		url: repositoryUrl(rawRepo),
		notes: null,
		publishedAt: null,
		error: null,
	};

	const slug = repositorySlug(rawRepo);
	if (!slug) {
		return { ...base, error: "这个构建没有配置可查的仓库地址,无法检查更新。" };
	}
	const proxy = proxyFromEnv(env);
	const api = `https://api.github.com/repos/${slug}/releases/latest`;
	let res: HttpGetResult;
	try {
		res = await httpGet(api, {
			proxy,
			timeoutMs,
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": `pi-writer/${current}`,
				"x-github-api-version": "2022-11-28",
			},
		});
	} catch (e) {
		// 连不上是这里最常见的失败。把「怎么办」写进文案 —— 只说 ECONNRESET
		// 等于没说,而用户能做的恰恰只有配代理这一件事。
		const detail = e instanceof Error ? e.message : String(e);
		const socksHint = ["all_proxy", "ALL_PROXY"].some((k) => /^socks/i.test((env[k] ?? "").trim()));
		const proxyHint = proxy
			? `(已尝试通过代理 ${proxy},检查它是否在运行)`
			: socksHint
				? "(检测到 socks 代理,本功能只支持 http 代理,请另设 HTTPS_PROXY=http://…)"
				: "(国内网络通常直连不通 api.github.com,可设 HTTPS_PROXY=http://127.0.0.1:7897 后重试)";
		return { ...base, error: `连不上 GitHub:${detail} ${proxyHint}` };
	}

	if (res.status === 404) {
		// 仓库没有发布过 Release(或者地址写错了 —— GitHub 对两者都回 404,
		// 这里分不出来)。**不算失败**:请求是通的,只是没有可比对的版本。
		// 前端据 latest === null 显示「上游还没有发布任何版本」,与「已是最新」区分开。
		return { ...base, ok: true };
	}
	if (res.status === 403 || res.status === 429) {
		const remaining = res.headers["x-ratelimit-remaining"];
		return {
			...base,
			error:
				remaining === "0"
					? "GitHub 的匿名接口用量用完了(每小时 60 次),过一会儿再试。"
					: "GitHub 拒绝了这次请求(可能是限流),过一会儿再试。",
		};
	}
	if (res.status !== 200) {
		return { ...base, error: `GitHub 返回了 ${res.status}。` };
	}

	let payload: { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown };
	try {
		payload = JSON.parse(res.body) as typeof payload;
	} catch {
		return { ...base, error: "GitHub 的响应看不懂(不是合法 JSON)。" };
	}
	const tagName = typeof payload.tag_name === "string" ? payload.tag_name : "";
	const latest = normalizeTag(tagName);
	const url = typeof payload.html_url === "string" && payload.html_url ? payload.html_url : base.url;
	if (latest === null) {
		return {
			...base,
			ok: true,
			url,
			error: null,
			notes: typeof payload.body === "string" ? clip(payload.body, NOTES_LIMIT) : null,
		};
	}

	const now = normalizeTag(current);
	return {
		ok: true,
		current,
		latest,
		// now=null(当前版本号非常规)时不报更新:宁可漏报,不可误导。
		hasUpdate: now !== null ? gt(latest, now) : false,
		url,
		notes: typeof payload.body === "string" && payload.body.trim() ? clip(payload.body, NOTES_LIMIT) : null,
		publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
		error: null,
	};
}
