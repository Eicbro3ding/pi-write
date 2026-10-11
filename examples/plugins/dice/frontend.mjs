/**
 * dice 插件前端 JS(仅「完全信任」后经 GET /api/plugins/dice/frontend.mjs 加载)。
 *
 * 演示:往**设置页插件卡内的扩展位**(槽位 `app.view.settings.plugin`,key = 插件 id)
 * 注册一块「掷骰历史」界面,点击调 trusted 后端路由 GET /api/plugins/dice/roll-history，
 * 渲染最近骰史。
 *
 * 与旧写法的区别(2026-10-11 槽位树):
 *  旧:querySelector('[data-plugin-mount="dice"]') + MutationObserver 补挂 + appendChild。
 *      —— 宿主一改 DOM 结构插件就瞎,还得自己写 observer 兜「挂载点晚于脚本」。
 *  新:window.piWriter.slots.register("app.view.settings.plugin", {...})。
 *      —— 只声明「往哪个槽位放什么」,宿主在正确时机把它挂到正确位置,
 *         插件不碰任何宿主 DOM,也不需要 observer。
 *
 * 约定:
 *  - 槽位名从 slots.list() 里查得到才能注册(未声明会抛错,当场暴露拼写错误);
 *  - 条目 render 返回一个节点工厂,DOM 由插件自管;
 *  - 失败静默(插件前端不影响主界面)。
 */
(function () {
	// 老宿主没有这套 API:直接退出,行为退回到「什么都不加」(不抛错、不打扰用户)
	const slots = window.piWriter && window.piWriter.slots;
	if (!slots) return;

	const SLOT = "app.view.settings.plugin";
	if (!slots.list().includes(SLOT)) return; // 宿主未声明这个槽位:不硬塞

	/** 构造插件自己的 DOM:一个按钮 + 一个列表区。 */
	function buildPanel() {
		const root = document.createElement("div");
		root.className = "dice-history";

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn-ghost";
		btn.textContent = "掷骰历史";

		const list = document.createElement("div");
		list.className = "dice-history-list";

		async function loadHistory() {
			list.textContent = "加载中…";
			try {
				const res = await fetch("/api/plugins/dice/roll-history", { headers: { accept: "application/json" } });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const { history } = await res.json();
				list.replaceChildren(
					...(Array.isArray(history) && history.length > 0
						? history.map((h) =>
								Object.assign(document.createElement("div"), {
									className: "dice-history-item",
									textContent: `${h.at?.slice(11, 19) ?? ""} → ${h.text ?? ""}`,
								}),
							)
						: [Object.assign(document.createElement("div"), { className: "dice-history-item", textContent: "尚无记录" })]),
				);
			} catch (e) {
				list.textContent = `读取失败: ${e instanceof Error ? e.message : String(e)}`;
			}
		}

		btn.addEventListener("click", loadHistory);
		root.append(btn, list);
		return root;
	}

	try {
		// 条目 id 带插件前缀(约定 pluginId:...),owner 由宿主从 id 前缀推断 → 便于整批回收。
		// key = 插件 id:目标槽位 app.view.settings.plugin 是 keyed 形态,按插件 id 分派,
		// 宿主设置页在「掷骰子」这张卡里只渲染 key=dice 的那一格。
		slots.register(SLOT, {
			id: "dice:roll-history",
			key: "dice",
			order: 10,
			render: () => buildPanel(),
		});
	} catch (e) {
		// 未声明槽位 / id 冲突:吞掉即可(信任态切换会整批重挂,下次还有机会)
		console.warn("[dice] 注册槽位条目失败:", e);
	}
})();
