import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { getAgentDir, getBookDir, getBooksDir } from "../config.ts";
import { createBook, listBooks } from "../book-manager.ts";
import { formatStageLines } from "./assembler.ts";
import { readStage } from "./stage-store.ts";
import { loadCast } from "./cast.ts";
import { parseReviseArgs, StageOrchestrator } from "./orchestrator.ts";

/**
 * `pi-writer --stage`：舞台区共演 demo 的命令行交互。
 *
 * 命令：
 *   普通输入  → 发给导演会话（讨论/维护世界书/开一幕）
 *   /revise   → 修改当前剧本（k=v：min= max= wrap= shared= actor:<id>=），下一轮生效
 *   /wrap [N] → 注入收尾提示（默认剧本收尾窗口）
 *   /cut      → 立即收幕
 *   /stage    → 打印舞台区转录
 *   /script   → 打印当前剧本
 *   /cast     → 打印演员池编制
 *   /quit     → 退出
 */

export interface StageCliOptions {
	slug?: string;
	model?: string;
	thinking?: string;
}

const HELP = `舞台区命令：
  普通输入            与导演对话（讨论剧情、要求开一幕；自动回逐步模式）
  /next               逐步模式：演下一轮
  /auto               切换自动连续演
  /force <角色>       强制下一轮指定角色发言
  /retry [说明]       就地重试：截断最后一条，同演员重演
  /fix <序号> <反馈>  反馈导演修订剧本，从问题处续演
  /revise k=v ...     修改剧本：min= max= wrap= setting= goal= tone=
                      beats=|分隔 forbidden=|分隔 actor:<id>.<字段>=
  /wrap [N]           注入收尾提示（剩余约 N 条）
  /cut                立即收幕
  /stage              打印舞台区转录
  /script             打印当前剧本
  /cast               打印演员池编制
  /mode               显示导演当前模式（讨论/剧本/导演）
  /thoughts <1|2|3>   编剧思考链可见性（1 不看 / 2 导演提炼版 / 3 原始思考链）
  /quit               退出`;

export async function runStageCli(opts: StageCliOptions): Promise<void> {
	const booksDir = getBooksDir();
	if (!existsSync(booksDir)) await mkdir(booksDir, { recursive: true });
	let slug = opts.slug;
	if (!slug) {
		const books = await listBooks();
		slug = books[0]?.slug;
		if (!slug) slug = (await createBook("舞台 Demo")).slug;
	}
	const bookDir = getBookDir(slug);

	const orch = new StageOrchestrator({
		bookDir,
		agentDir: getAgentDir(),
		model: opts.model,
		thinkingLevel: opts.thinking,
		onEvent: (event) => {
			if (event.type === "stage") {
				const text = event.entry.content.map((b) => b.text).join("");
				const prefix = event.entry.character === "叙述者" ? "叙述" : event.entry.character;
				process.stdout.write(`\n[舞台] ${prefix}: ${text}\n`);
			} else if (event.type === "system") {
				process.stdout.write(`\n[系统] ${event.text}\n`);
			}
			// tool_start/tool_end:CLI 无预览 UI,忽略(web 端消费)
		},
	});
	await orch.start();
	process.stdout.write(`pi-writer 舞台模式 — 书：${slug}\n导演已就位。输入内容与导演对话；/help 查看命令。\n`);

	const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
	rl.prompt();
	rl.on("line", (line) => {
		// 任何命令失败都不能让 REPL 崩溃（unhandled rejection 会炸掉整个进程）
		void handleLine(line, orch)
			.catch((error) => {
				process.stdout.write(`\n[系统] 舞台异常：${error instanceof Error ? error.message : String(error)}\n`);
			})
			.finally(() => rl.prompt());
	});
	rl.on("SIGINT", () => {
		process.stdout.write("\n退出舞台模式\n");
		rl.close();
	});
	await new Promise<void>((resolve) => rl.on("close", () => resolve()));
	await orch.dispose();
}

async function handleLine(line: string, orch: StageOrchestrator): Promise<void> {
	const text = line.trim();
	if (!text) return;
	if (text === "/help") {
		process.stdout.write(`${HELP}\n`);
		return;
	}
	if (text.startsWith("/")) {
		const parts = text.split(/\s+/);
		const cmd = parts[0];
		const rest = parts.slice(1);
		// 演出控制命令不回 step（避免误触发）；其余输入回 step（§10.1 输入即停）
		if (!["/next", "/auto", "/stage", "/script", "/cast", "/mode", "/help", "/quit"].includes(cmd)) {
			orch.backToStep();
		}
		switch (cmd) {
			case "/revise": {
				const patch = parseReviseArgs(rest);
				if (patch.text === undefined && patch.rules === undefined) {
					process.stdout.write("未解析到修改项。示例：/revise min=5 actor:actor-1=以李四的身份（更冷淡）\n");
					return;
				}
				process.stdout.write(`${await orch.userRevise(patch)}\n`);
				return;
			}
			case "/wrap": {
				const n = rest[0] !== undefined ? Number(rest[0]) : undefined;
				process.stdout.write(`${await orch.userWrap(Number.isNaN(n) ? undefined : n)}\n`);
				return;
			}
			case "/cut":
				process.stdout.write(`${await orch.userCut()}\n`);
				return;
			case "/stage": {
				if (!orch.sceneId) {
					process.stdout.write("（尚未开演）\n");
					return;
				}
				const entries = await readStage(orch.bookDir, orch.sceneId);
				process.stdout.write(`${formatStageLines(entries).join("\n") || "（舞台为空）"}\n`);
				return;
			}
			case "/script":
				process.stdout.write(`${orch.script ? JSON.stringify(orch.script, null, 2) : "（尚无剧本）"}\n`);
				return;
			case "/cast": {
				const cast = await loadCast(orch.bookDir);
				process.stdout.write(`${JSON.stringify(cast, null, 2)}\n`);
				return;
			}
			case "/thoughts": {
				const level = Number(rest[0]);
				if (!Number.isInteger(level)) {
					process.stdout.write("用法：/thoughts <1|2|3>（1 不看 / 2 导演提炼版 / 3 原始思考链）\n");
					return;
				}
				process.stdout.write(`${await orch.userThoughts(level)}\n`);
				return;
			}
			case "/mode": {
				const label: Record<string, string> = { discussion: "讨论", scripting: "剧本", directing: "导演" };
				process.stdout.write(`导演当前模式：${label[orch.getDirectorMode()] ?? orch.getDirectorMode()}\n`);
				return;
			}
			case "/next":
				process.stdout.write(`${await orch.userNext()}\n`);
				return;
			case "/auto":
				process.stdout.write(`${await orch.userAuto()}\n`);
				return;
			case "/force": {
				const target = rest[0];
				if (!target) {
					process.stdout.write("用法：/force <角色名或演员id>\n");
					return;
				}
				process.stdout.write(`${await orch.userForce(target)}\n`);
				return;
			}
			case "/retry": {
				const note = rest.join(" ") || undefined;
				process.stdout.write(`${await orch.userRetry(note)}\n`);
				return;
			}
			case "/fix": {
				const idx = Number(rest[0]);
				const feedback = rest.slice(1).join(" ");
				if (!Number.isInteger(idx) || idx < 1 || !feedback) {
					process.stdout.write("用法：/fix <条目序号> <反馈内容>\n");
					return;
				}
				process.stdout.write(`${await orch.userFix(idx, feedback)}\n`);
				return;
			}
			case "/quit":
				process.exit(0);
				return;
			default:
				process.stdout.write("未知命令，/help 查看\n");
				return;
		}
	}
	await orch.directorSay(text);
	const last = orch.getDirectorLast();
	if (last) process.stdout.write(`\n[导演] ${last}\n`);
}
