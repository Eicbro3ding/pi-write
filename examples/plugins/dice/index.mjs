/**
 * 示例插件:掷骰子(与 docs/plugin-development.md 配套)。
 * - roll_dice:LLM 可调工具(对话让 agent「掷个骰子」触发);
 * - /快骰:web 斜杠命令(前端声明 + 本文件 webCommands 具名导出,主进程执行);
 * - 完全信任(trusted)后:后端路由(roll-history 最近骰史)+ 前端 JS(frontend.mjs)。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** 插件根目录(随 PI_WRITER_DIR 迁移)。 */
function pluginDir() {
	const dir = process.env.PI_WRITER_DIR || join(homedir(), ".pi", "writer");
	return join(dir, "plugins", "dice");
}

/** 读插件设置(settings.json;损坏按空处理)。 */
async function readSettings() {
	try {
		const raw = JSON.parse(await readFile(join(pluginDir(), "settings.json"), "utf8"));
		return (typeof raw === "object" && raw !== null) ? raw : {};
	} catch {
		return {};
	}
}

/** 掷骰(公共逻辑:工具/命令/历史路由共用)。 */
function roll(sides, settings) {
	const n = Math.max(2, Math.min(1000, Number(sides) || Number(settings.max) || 20));
	const roll = 1 + Math.floor(Math.random() * n);
	const lucky = settings.lucky === true;
	const flavor = settings.flavor === "dramatic" ? `掷出点数为 ${roll},骰子低语:命运在此刻转弯。`
		: settings.flavor === "silly" ? `掷出点数为 ${roll},骰子笑出了声。`
		: `掷出点数为 ${roll}`;
	const luck = roll >= n ? "大成功" : roll === 1 ? "大失败" : "普通";
	const note = lucky ? `(${luck})` : "";
	const extra = typeof settings.note === "string" && settings.note.length > 0 ? `\n附注:${settings.note}` : "";
	return { text: `d${n} = ${roll}${note} · ${flavor}${extra}`, roll, sides: n };
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

export default function dicePlugin(pi) {
	pi.registerTool({
		name: "roll_dice",
		description: "掷一个 N 面骰子(默认取设置中的骰面),返回点数和一句剧情提示。适合做不确定性判定。",
		inputSchema: {
			type: "object",
			properties: { sides: { type: "number", description: "骰面数(缺省取插件设置)" } },
			additionalProperties: false,
		},
		execute: async (input) => {
			const r = roll(input?.sides, await readSettings());
			await pushHistory({ at: new Date().toISOString(), ...r });
			return { result: r.text };
		},
	});
}

/** web 斜杠命令(/快骰):主进程执行,读设置后掷骰,结果插回输入框。 */
export const webCommands = {
	"快骰": async () => {
		const r = roll(undefined, await readSettings());
		await pushHistory({ at: new Date().toISOString(), ...r });
		return r.text;
	},
};

/**
 * 后端自定义路由(仅「完全信任」后生效;segments 自动加插件 id 前缀
 * → GET /api/plugins/dice/roll-history)。handler 返回 JSON,由插件自控响应。
 */
export const routes = [
	{
		method: "GET",
		segments: ["roll-history"],
		handler: async (ctx) => {
			let list = [];
			try {
				list = JSON.parse(await readFile(join(pluginDir(), "history.json"), "utf8"));
			} catch { /* 无历史 */ }
			ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			ctx.res.end(JSON.stringify({ history: Array.isArray(list) ? list : [] }));
		},
	},
];
