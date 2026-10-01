/**
 * 进程内按 key 串行化的 Promise 队列 —— 配置类文件「读-改-写」的唯一互斥实现。
 *
 * 背景(2026-10 审计 BUG-011 / BUG-020):models.json 与 mcp.json 的增删改都是
 * 「读快照 → 内存变更 → atomicWriteFile」。原子写只保证**单次替换**是原子的,
 * 解决不了两个并发请求各自基于同一旧快照写回 —— 后完成的那份整份快照会覆盖掉
 * 先完成的新增/编辑(静默丢配置)。这里把同一文件的读改写排成一条链。
 *
 * 语义:
 * - 同一 key 的任务严格按调用顺序串行执行(前一个 settle 后才跑下一个);
 * - 前一个任务**失败**(reject)不掐断队列,后续任务照常执行(否则一次 4xx 会让
 *   这条队列永久卡死);
 * - 不同 key 互不阻塞;
 * - 只覆盖**单进程**竞争。多进程(同时开两个 pi-writer 指向同一配置目录)仍会互相
 *   覆盖,那需要文件锁或版本 CAS,本模块不宣称解决。
 */
export class WriteQueue {
	private tails = new Map<string, Promise<unknown>>();

	/**
	 * 把 task 排到 key 的队尾并返回其结果(失败原样抛出给调用方;队列本身继续)。
	 */
	run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		// 前一个任务无论成功失败都继续:settle 后执行 task
		const next = prev.then(task, task);
		// 队尾只保留「已吞掉错误」的版本,避免 unhandled rejection
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		// 队尾清空后移除条目,避免长期运行累积无关键(不改变串行语义)
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return next;
	}

	/** 当前排队中的 key 数(诊断/测试用)。 */
	pendingKeys(): number {
		return this.tails.size;
	}
}
