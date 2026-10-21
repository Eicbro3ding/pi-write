/**
 * 插件前端 JS 加载器:注入/回收 trusted 插件的 <script type="module">。
 *
 * 安全:只对「用户显式完全信任」的插件加载(trusted=true);脚本经
 * GET /api/plugins/<id>/<入口名>(服务端校验信任 + 声明名 + 路径防逃逸)。
 *
 * 三条约定:
 *  - **只在真有入口时注入**:列表里的 `hasFrontend` 由服务端按文件存在性算,
 *    没有入口却按缺省拼 URL 会每 30s 打一次 404;
 *  - **注入时带版本参数**:取消信任 → script 被移除,再开信任时要重新执行;
 *    ESM 的 module map 按 URL 缓存,不带版本会直接命中旧模块、代码不跑;
 *  - **失败短期不重试**:加载失败(文件被删/语法错)记 5 分钟,避免每轮对账刷 404。
 *
 * 已知边界:取消信任只能移除 script 标签,已经执行过的副作用(定时器、全局监听、
 * 已插进 DOM 的节点)不会自动撤销 —— 需要彻底清理时请刷新页面。
 */

/** 已注入的插件 script 元素(声明路径 → element;路径不带版本参数)。 */
const injectedScripts = new Map<string, HTMLScriptElement>();
/** 失败时刻(声明路径 → 时间戳);5 分钟内不再重试同一路径。 */
const failedAt = new Map<string, number>();
const RETRY_MS = 5 * 60_000;

/**
 * 按最新插件列表同步脚本:trusted 且 hasFrontend 的插件的 src 集合为当前集,
 * 差集注入,过期集移除。幂等;不触发重注入除非 src 变化(或重新开启信任)。
 */
export function syncPluginScripts(
	plugins: Array<{ id: string; trusted: boolean; hasFrontend?: boolean; frontend?: { frontend?: string } }>,
): void {
	const wanted = new Set<string>();
	for (const p of plugins) {
		if (!p.trusted) continue;
		// hasFrontend 缺省(旧服务端)按"可能有"处理;显式 false 才是真的没有
		if (p.hasFrontend === false) continue;
		// 入口文件名由 manifest 声明(缺省 frontend.mjs)
		const rel = p.frontend?.frontend ?? "frontend.mjs";
		wanted.add(`/api/plugins/${encodeURIComponent(p.id)}/${rel}`);
	}
	// 移除不再需要的(取消信任 / 插件删除 / 入口消失)
	for (const [src, el] of injectedScripts) {
		if (!wanted.has(src)) {
			el.remove();
			injectedScripts.delete(src);
			failedAt.delete(src);
		}
	}
	// 注入新增(版本参数让"重新信任"能重新执行,不吃 module map 的旧实例)
	for (const src of wanted) {
		if (injectedScripts.has(src)) continue;
		const failed = failedAt.get(src);
		if (failed !== undefined && Date.now() - failed < RETRY_MS) continue;
		const el = document.createElement("script");
		el.type = "module";
		el.src = `${src}${src.includes("?") ? "&" : "?"}v=${Date.now()}`;
		// 出错静默(插件前端 JS 失败不影响主界面;错误可由插件自身 console 观察)
		el.addEventListener("error", () => {
			el.remove();
			injectedScripts.delete(src);
			failedAt.set(src, Date.now());
		});
		document.head.appendChild(el);
		injectedScripts.set(src, el);
	}
}
