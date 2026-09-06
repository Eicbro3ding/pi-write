/**
 * 插件前端 JS 加载器:注入/回收 trusted 插件的 <script type="module">。
 *
 * 安全:只对「用户显式完全信任」的插件加载(trusted=true);脚本经
 * GET /api/plugins/:id/frontend.mjs(服务端校验信任 + 路径防逃逸)。
 * 同步策略:对比已注入 script 的 src 集合,增/删(trusted 关闭或插件删除即回收)。
 */

/** 已注入的插件 script 元素(src → element)。 */
const injectedScripts = new Map<string, HTMLScriptElement>();

/**
 * 按最新插件列表同步脚本:trusted 且声明了 frontend 的插件的 src 集合为当前集,
 * 差集注入,过期集移除。幂等;不触发重注入除非 src 变化。
 */
export function syncPluginScripts(plugins: Array<{ id: string; trusted: boolean; frontend?: { frontend?: string } }>): void {
	const wanted = new Set<string>();
	for (const p of plugins) {
		if (!p.trusted) continue;
		// 缺省入口 frontend.mjs(manifest 声明的重路径见 frontend?.frontend)
		const rel = p.frontend?.frontend ?? "frontend.mjs";
		const src = `/api/plugins/${encodeURIComponent(p.id)}/${rel}`;
		wanted.add(src);
	}
	// 移除不再需要的
	for (const [src, el] of injectedScripts) {
		if (!wanted.has(src)) {
			el.remove();
			injectedScripts.delete(src);
		}
	}
	// 注入新增
	for (const src of wanted) {
		if (injectedScripts.has(src)) continue;
		const el = document.createElement("script");
		el.type = "module";
		el.src = src;
		// 出错静默(插件前端 JS 失败不影响主界面;错误可由插件自身 console 观察)
		el.addEventListener("error", () => {
			el.remove();
			injectedScripts.delete(src);
		});
		document.head.appendChild(el);
		injectedScripts.set(src, el);
	}
}
