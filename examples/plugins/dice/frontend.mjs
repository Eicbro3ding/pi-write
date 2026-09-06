/**
 * dice 插件前端 JS(仅「完全信任」后经 GET /api/plugins/dice/frontend.mjs 加载)。
 *
 * 演示:在设置页插件分类(挂载点 data-plugin-mount)挂一个「掷骰历史」按钮,
 * 点击调 trusted 后端路由 GET /api/plugins/dice/roll-history,渲染最近骰史。
 *
 * 约定:挂载点由 pi-writer 提供(data-plugin-mount="<pluginId>"),
 * 插件 JS 自我管理该节点下的 DOM;失败/卸载静默。
 */
(function () {
	const MOUNT_ATTR = 'data-plugin-mount="dice"';
	let container = null;
	let btn = null;
	let list = null;

	function ensureMounts() {
		// 设置页插件分类的主区(标题下)作为挂载点
		const host = document.querySelector(`[${MOUNT_ATTR}]`);
		if (!host) return null;
		if (container && host.contains(container)) return container;
		container = document.createElement("div");
		container.className = "dice-history";
		btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn-ghost";
		btn.textContent = "掷骰历史";
		btn.addEventListener("click", loadHistory);
		list = document.createElement("div");
		list.className = "dice-history-list";
		container.append(btn, list);
		host.appendChild(container);
		return container;
	}

	async function loadHistory() {
		if (!list) return;
		list.textContent = "加载中…";
		try {
			const res = await fetch("/api/plugins/dice/roll-history", { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const { history } = await res.json();
			list.replaceChildren(
				...(Array.isArray(history) && history.length > 0
					? history.map((h) => Object.assign(document.createElement("div"), { className: "dice-history-item", textContent: `${h.at?.slice(11, 19) ?? ""} → ${h.text ?? ""}` }))
					: [Object.assign(document.createElement("div"), { className: "dice-history-item", textContent: "尚无记录" })]),
			);
		} catch (e) {
			list.textContent = `读取失败: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	// 挂载点可能晚于 script 加载(设置页切分类后重建):MutationObserver 补挂
	const observer = new MutationObserver(() => { if (!container) ensureMounts(); });
	observer.observe(document.body, { childList: true, subtree: true });
	ensureMounts();
})();
