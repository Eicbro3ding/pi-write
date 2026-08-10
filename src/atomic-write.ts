/**
 * 原子写 —— 写入唯一 tmp 文件后 rename 覆盖目标。
 *
 * 统一 book-manager / world-data / mcp 三处的 tmp+rename 样板:
 * - 唯一 tmp(pid + 随机后缀)消除跨进程/跨客户端并发写共享同一 tmp 的竞态;
 * - rename 覆盖目标在 Windows 上可能被并发读句柄阻塞(EPERM):短暂重试。
 * 备份/写后校验等语义由调用方负责(见 world-data.saveWorld 的 .bak 恢复点)。
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** rename 重试退避基数(ms)与次数(与旧 saveWorld 行为一致)。 */
const RENAME_RETRY_MS = 15;
const RENAME_ATTEMPTS = 3;

/** 随机后缀(与 world-data.newId 同款 6 位小写字母数字)。 */
function randomSuffix(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
	return s;
}

/**
 * 原子写文件:确保父目录存在 → 写唯一 tmp → rename 覆盖(EPERM 短暂重试)。
 * 失败时 tmp 残留由调用方/系统清理,目标文件保持原状。
 */
export async function atomicWriteFile(file: string, content: string | Uint8Array): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${process.pid}.${randomSuffix()}`;
	await writeFile(tmp, content, typeof content === "string" ? "utf-8" : undefined);
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmp, file);
			return;
		} catch (err) {
			if (attempt >= RENAME_ATTEMPTS - 1) throw err;
			await new Promise((r) => setTimeout(r, RENAME_RETRY_MS * (attempt + 1)));
		}
	}
}
