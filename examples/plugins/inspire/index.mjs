/**
 * 测试插件:灵感笔(与 docs/plugin-development.md 配套)。
 * - inspire:LLM 可调工具(对话里说「给我一个灵感」触发);
 * - /灵感:web 斜杠命令(前端声明 + 本文件 webCommands 具名导出,主进程执行);
 * - 完全信任(trusted)后:后端路由(生成/历史/清空)+ 前端 JS(frontend.mjs)。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** 插件根目录(随 PI_WRITER_DIR 迁移)。 */
function pluginDir() {
	const dir = process.env.PI_WRITER_DIR || join(homedir(), ".pi", "writer");
	return join(dir, "plugins", "inspire");
}

/** 读插件设置(settings.json;损坏按空处理)。 */
async function readSettings() {
	try {
		const raw = JSON.parse(await readFile(join(pluginDir(), "settings.json"), "utf8"));
		return typeof raw === "object" && raw !== null ? raw : {};
	} catch {
		return {};
	}
}

/** 内置灵感库(按风格;每款 4 条,随版本可扩充)。 */
const BUILTIN = {
	literary: [
		"雨停之后,街角修鞋摊的老头把一首诗压进了皮鞋底。",
		"窗户是为一整面墙准备的唯一的出口。",
		"他们交换的那把钥匙,其实只能锁住彼此的名字。",
		"深夜的自动售货机替城市收留了最后一枚硬币。",
	],
	plot: [
		"主角收到一封落款是明天的信。",
		"婚礼进行曲响到一半,新娘却只说了一句「现在,轮到你了」。",
		"动物园最后一次闭馆前,看守发现每只动物都变成了守门人的样子。",
		"失踪七年的青梅竹马,如今是拆解小镇的拆迁队队长。",
	],
	image: [
		"清晨的菜市场,鱼鳞在摊主的围裙上闪着碎银。",
		"废弃的绿皮火车静静停着,车窗里长出了整座山。",
		"停电的一分钟,城市的霓虹全部倒进了江里。",
		"老相册最后一页,夹着一根褪成月色的发带。",
	],
	verse: [
		"月光从不投在它照不见的地方。",
		"所有告别都写在同一张车票上。",
		"我们隔着一条河,各自打捞各自的月亮。",
		"时间把名字磨成砂,又装进同一个沙漏。",
	],
};

/** 自定义库:按行拆分;空行/空白丢弃。 */
function customLines(text) {
	return typeof text === "string"
		? text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
		: [];
}

/** 一次抽几条(公共逻辑:工具/命令/路由共用);自定义库开启优先。 */
function pickLines(style, count, settings) {
	const styleKey = typeof style === "string" && BUILTIN[style] ? style : ("literary");
	const onlyCustom = settings.only_custom === true;
	const custom = customLines(settings.custom);
	const pool = onlyCustom && custom.length > 0 ? custom
		: custom.length > 0 ? custom.concat(BUILTIN[styleKey])
		: BUILTIN[styleKey];
	const n = Math.max(1, Math.min(5, Number(count) || Number(settings.count) || 1));
	// 洗牌后取前 n 条(不重复;池小于 n 时全给)
	const shuffled = pool.slice().sort(() => Math.random() - 0.5);
	return { style: styleKey, lines: shuffled.slice(0, n) };
}

/** 记录(最近 20 条)到 history.json(trusted 路由演示)。 */
async function pushHistory(entry) {
	const file = join(pluginDir(), "history.json");
	let list = [];
	try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		if (Array.isArray(raw)) list = raw;
	} catch { /* 首写 */ }
	list.unshift(entry);
	await writeFile(file, JSON.stringify(list.slice(0, 20), null, 2));
}

/** 读历史(损坏/缺失按空)。 */
async function readHistory() {
	try {
		const raw = JSON.parse(await readFile(join(pluginDir(), "history.json"), "utf8"));
		return Array.isArray(raw) ? raw : [];
	} catch {
		return [];
	}
}

function historyToText(history) {
	return history.map((h) => {
		const at = typeof h?.at === "string" ? h.at.slice(11, 19) : "";
		return `[${at}] ${h?.style ?? "?"} · ${h?.line ?? ""}`;
	});
}

export default function inspirePlugin(pi) {
	pi.registerTool({
		name: "inspire",
		description: "随机返回若干条写作灵感(风格可选:literary 文学梗 / plot 剧情钩子 / image 画面 / verse 诗句;缺省取插件设置)。适合在情节推进前找点子。",
		inputSchema: {
			type: "object",
			properties: {
				style: { type: "string", description: "灵感风格(literary/plot/image/verse;缺省取插件设置)" },
				count: { type: "number", description: "条数(1-5;缺省取插件设置)" },
			},
			additionalProperties: false,
		},
		execute: async (input) => {
			const r = pickLines(input?.style, input?.count, await readSettings());
			for (const line of r.lines) {
				await pushHistory({ at: new Date().toISOString(), style: r.style, line });
			}
			return { result: r.lines.join("\n") };
		},
	});
}

/** web 斜杠命令(/灵感):主进程执行,读设置后抽条,结果插回输入框。 */
export const webCommands = {
	"灵感": async () => {
		const r = pickLines(undefined, undefined, await readSettings());
		for (const line of r.lines) {
			await pushHistory({ at: new Date().toISOString(), style: r.style, line });
		}
		return r.lines.join("\n");
	},
};

/**
 * 后端自定义路由(仅「完全信任」后生效;segments 自动加插件 id 前缀
 * → GET /api/plugins/inspire/inspire)。handler 返回 JSON,由插件自控响应。
 */
export const routes = [
	{
		method: "GET",
		segments: ["inspire"],
		handler: async (ctx) => {
			const count = ctx.url.searchParams.get("count") ?? undefined;
			const style = ctx.url.searchParams.get("style") ?? undefined;
			const r = pickLines(style, count, await readSettings());
			for (const line of r.lines) {
				await pushHistory({ at: new Date().toISOString(), style: r.style, line });
			}
			ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			ctx.res.end(JSON.stringify({ lines: r.lines, style: r.style, history: await readHistory() }));
		},
	},
	{
		method: "POST",
		segments: ["inspire-clear"],
		handler: async (ctx) => {
			await writeFile(join(pluginDir(), "history.json"), "[]\n");
			ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			ctx.res.end(JSON.stringify({ ok: true }));
		},
	},
	{
		method: "GET",
		segments: ["inspire-text"],
		handler: async (ctx) => {
			ctx.res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			ctx.res.end(historyToText(await readHistory()).join("\n") || "尚无记录");
		},
	},
];
