/**
 * WorldWatcher —— 世界书与草稿文件的外部变更监听(无缝同步的核心)。
 *
 * 背景:web 前端只在 PUT /api/draft、PUT /api/world 时收到广播;AI 经工具
 * (TUI/CLI)或外部编辑器直接改文件时没有任何事件,前端停留在旧内容——
 * 「玄学同步」的根源。本类以 1s 轮询 stat(mtimeMs+size)发现这类外部变更,
 * 回调广播 world_changed / draft_changed(带 mtime,前端干净时重载、脏时提示)。
 *
 * 规则:
 * - 只监听当前会话书(world.json + draft/*.md);切章/改书名时 setBook 重置。
 * - 首次扫描只登记不广播(避免启动时误报);之后 mtime/size 任一变化即广播。
 * - 文件从存在变不存在也算变更(广播后前端重载可见)。
 * - 服务端自己的写入经 noteWritten 登记,不会触发重复广播(PUT 广播已有)。
 * - 仅在有 SSE 客户端时运行(setActive),无前端时零开销。
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getBookDir } from "../config.ts";

/** 已知文件状态(stat 快照)。 */
interface FileStamp {
	mtimeMs: number;
	size: number;
}

/** 外部变更回调:kind 区分世界书/草稿,rel 为书内相对路径,draft 事件按 file 匹配前端。 */
export type ExternalChangeHandler = (kind: "world" | "draft", rel: string, mtime: number) => void;

/** 已知文件状态:stat 快照 + 事件所需的 kind/rel(删除时也要能广播)。 */
interface KnownFile {
	stamp: FileStamp;
	kind: "world" | "draft";
	rel: string;
}

export class WorldWatcher {
	private known = new Map<string, KnownFile>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private slug: string | null = null;

	constructor(
		private readonly onExternalChange: ExternalChangeHandler,
		private readonly intervalMs = 1000,
	) {}

	/** 绑定/切换当前会话书;重置已知状态并做一次静默扫描(只登记不广播)。 */
	async setBook(slug: string | null): Promise<void> {
		this.slug = slug;
		this.known.clear();
		if (slug) await this.tick(true);
	}

	/** 服务端自己写入后登记(避免 watcher 重复广播);文件不存在时删除登记。 */
	async noteWritten(absPath: string): Promise<void> {
		const prev = this.known.get(absPath);
		try {
			const st = await stat(absPath);
			this.known.set(absPath, {
				stamp: { mtimeMs: st.mtimeMs, size: st.size },
				kind: prev?.kind ?? "draft",
				rel: prev?.rel ?? absPath,
			});
		} catch {
			this.known.delete(absPath);
		}
	}

	/** 有 SSE 客户端时启动轮询;无客户端时停止(避免空转)。 */
	setActive(active: boolean): void {
		if (active && this.timer === undefined) {
			this.timer = setInterval(() => void this.tick(), this.intervalMs);
		} else if (!active && this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** 轮询一轮:stat world.json 与 draft/*.md,发现外部变更即回调。 */
	async tick(quiet = false): Promise<void> {
		if (!this.slug) return;
		const bookDir = getBookDir(this.slug);
		const seen = new Set<string>();
		const worldFile = join(bookDir, "world.json");
		seen.add(worldFile);
		await this.check(worldFile, "world", "world.json", quiet);
		try {
			const draftDir = join(bookDir, "draft");
			for (const f of await readdir(draftDir)) {
				if (!f.endsWith(".md")) continue;
				const abs = join(draftDir, f);
				seen.add(abs);
				await this.check(abs, "draft", `draft/${f}`, quiet);
			}
		} catch {
			// draft 目录不存在(书刚建/已删):跳过
		}
		// 上次存在但本次未扫到(文件被删除):广播 + 清除登记
		for (const abs of [...this.known.keys()]) {
			if (seen.has(abs)) continue;
			const prev = this.known.get(abs)!;
			this.known.delete(abs);
			if (!quiet) this.onExternalChange(prev.kind, prev.rel, 0);
		}
	}

	/** 单个文件:不存在(且之前存在)→ 广播删除;mtime/size 变化 → 广播。 */
	private async check(abs: string, kind: "world" | "draft", rel: string, quiet: boolean): Promise<void> {
		const prev = this.known.get(abs);
		let st;
		try {
			st = await stat(abs);
		} catch {
			if (prev) {
				this.known.delete(abs);
				if (!quiet) this.onExternalChange(kind, rel, 0);
			}
			return;
		}
		const stamp = { mtimeMs: st.mtimeMs, size: st.size };
		if (!prev) {
			this.known.set(abs, { stamp, kind, rel });
			// 首次见到:setBook 静默扫描只登记不广播;运行期间的「新文件」是外部创建的
			// (服务端自己的新建会先经 noteWritten 登记,不会走到这里)→ 广播让前端看到
			if (!quiet) this.onExternalChange(kind, rel, st.mtimeMs);
			return;
		}
		if (prev.stamp.mtimeMs !== stamp.mtimeMs || prev.stamp.size !== stamp.size) {
			this.known.set(abs, { stamp, kind, rel });
			if (!quiet) this.onExternalChange(kind, rel, st.mtimeMs);
		}
	}

	/** 停止轮询(服务停止时)。 */
	dispose(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.known.clear();
	}
}
