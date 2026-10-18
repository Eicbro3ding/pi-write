#!/usr/bin/env node
/**
 * 组件预览页(真浏览器里看 UI 房,不借用户数据、不借端口)。
 *
 * 为什么要有它(2026-10-18 拆文件时加的):改一个组件样式,想「看一眼」原本有三条路,
 * 三条都不干净 ——
 * ① `npm run web` 起真实服务:反代/别的实例已经占着端口,`--strictPort` 直接失败;
 * ② 起在别的端口:前端连不上 `/api`,整页停在「未打开书」,看不到要改的那块;
 * ③ `vite dev`:要在浏览器里手动点进设置 → 调试模式 → UI 房,而且 HMR 与后端 API
 *    混在一个端口上,改坏了谁也说不清是谁的错。
 *
 * 这里的做法是**进程内**:同一个脚本里
 * 1. 用 vite 的 `createServer({ middlewareMode: true })` 就地编译(不监听端口);
 * 2. 自己开一个 http server:`/` 回预览页 HTML,`/preview-entry.js` 回现编的 bundle,
 *    `/api/*` 一律空响应(UI 房里的组件不发请求,给了空响应就不会挂在 loading 上);
 * 3. 只监听回环地址。
 *
 * 预览页 `web/preview.html` 自己挑展品:URL 里带 `?g=<分组>&e=<展项>&v=<变体>`
 * 就直接跳到那一格,不带就铺一层索引。它是**开发脚手架**,不参与打包
 * (`vite build` 只认 `web/index.html` 这个入口;新增 html 入口要在这里显式声明)。
 *
 * 用法:
 *   node scripts/ui-preview.mjs            # 打印地址,常驻
 *   node scripts/ui-preview.mjs --print    # 只打印地址,不起服务(给截图脚本用)
 *   PORT=8950 node scripts/ui-preview.mjs
 */
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "web");
const port = Number(process.env.PORT ?? 8950);
const printOnly = process.argv.includes("--print");

/**
 * 预览页外壳:直接复用 `web/index.html` 的挂载点与 CSP,只换脚本与标题。
 *
 * 不另写一份 HTML —— 那份副本迟早与真实入口漂移(CSP 改了、字体预载改了,
 * 预览页却还是旧的,于是「预览里好好的,真机上报 CSP 错」)。
 */
async function previewHtml() {
	const raw = await readFile(join(webRoot, "index.html"), "utf8");
	return raw
		.replace(/<title>[^<]*<\/title>/, "<title>组件预览 · pi-writer</title>")
		// 真实入口是 `/src/main.tsx`,预览入口换成 bundle 名(由 bundle 中间件提供)
		.replace(/src="\/src\/main\.tsx"/, 'src="/preview-entry.js"');
}

async function start() {
	const vite = await createViteServer({
		root: webRoot,
		configFile: join(webRoot, "vite.config.ts"),
		appType: "custom",
		server: { middlewareMode: true, hmr: false },
	});

	/**
	 * 空 API:UI 房里所有组件都按「陈列」渲染,几处会拉 `/api/**` 的(备忘录、用量)
	 * 拿到 `{}` 后由其自身的容错路径落成空态 —— 比 404 好,404 会在控制台刷红。
	 */
	function apiStub(_req, res) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	}

	const server = createHttpServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		try {
			if (url.pathname.startsWith("/api/")) return apiStub(req, res);
			if (url.pathname === "/preview-entry.js") {
				const out = await vite.transformRequest("/src/preview-entry.tsx");
				if (!out) throw new Error("preview-entry.tsx 编译结果为空");
				res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
				return res.end(out.code);
			}
			if (url.pathname === "/" || url.pathname === "/preview.html") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				return res.end(await previewHtml());
			}
			// 其余走 vite 的中间件(它认 /src/**、/@vite/**、静态资源、字体)
			vite.middlewares(req, res, () => {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("not found");
			});
		} catch (err) {
			res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end(String(err && err.stack ? err.stack : err));
		}
	});

	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
	const addr = server.address();
	const shown = typeof addr === "object" && addr ? addr.port : port;
	console.log(`[ui-preview] http://127.0.0.1:${shown}/`);
	console.log(`[ui-preview] 指定展品:?g=chat&e=message-stream&v=对话`);
}

if (printOnly) {
	console.log(`http://127.0.0.1:${port}/`);
} else {
	await start();
}
