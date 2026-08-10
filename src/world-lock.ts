/**
 * 进程内互斥:按 key 串行化异步任务。world_update 的读-改-写整体持锁,
 * 消除并发调用间的丢失更新与共享 tmp 竞态;前一任务失败不阻塞后续。
 */
const queues = new Map<string, Promise<void>>();

export function withWorldLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = queues.get(key) ?? Promise.resolve();
	const run = prev.then(fn, fn);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, settled);
	// 队尾任务完成后清理条目,避免 map 无限增长(仅保留在途队列)
	void settled.then(() => {
		if (queues.get(key) === settled) queues.delete(key);
	});
	return run;
}
