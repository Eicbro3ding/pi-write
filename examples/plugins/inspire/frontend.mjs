/**
 * inspire 插件前端 JS(仅「完全信任」后经 GET /api/plugins/inspire/frontend.mjs 加载)。
 *
 * 演示:在设置页插件分类(挂载点 data-plugin-mount="inspire")挂一个「灵感面板」:
 * 「抽一条」按钮调 trusted 后端路由 GET /api/plugins/inspire/inspire(生成并记历史),
 * 展示本条灵感与最近历史;「清空历史」调 POST /api/plugins/inspire/inspire-clear。
 *
 * 约定:挂载点由 pi-writer 提供(data-plugin-mount="<pluginId>"),
 * 插件 JS 自我管理该节点下的 DOM;失败/卸载静默。
 */
(function () {
	const MOUNT_ATTR = 'data-plugin-mount="inspire"';
	let container = null;
	let preview = null;
	let list = null;

	function ensureMounts() {
		// 设置页插件分类的主区(标题下)作为挂载点
		const host = document.querySelector(`[${MOUNT_ATTR}]`);
		if (!host) return null;
		if (container && host.contains(container)) return container;
		container = document.createElement("div");
		container.className = "inspire-panel";

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn-ghost";
		btn.textContent = "🎲 抽一条灵感";
		btn.addEventListener("click", draw);

		const clearBtn = document.createElement("button");
		clearBtn.type = "button";
		clearBtn.className = "btn-ghost";
		clearBtn.textContent = "清空历史";
		clearBtn.addEventListener("click", clear);

		preview = document.createElement("div");
		preview.className = "inspire-preview";
		preview.textContent = "点击「抽一条灵感」试试(结果同时记录到插件历史)。";

		list = document.createElement("div");
		list.className = "inspire-history";
		list.textContent = "最近历史:";

		const row = document.createElement("div");
		row.className = "inspire-actions";
		row.append(btn, clearBtn);
		container.append(row, preview, list);
		host.appendChild(container);
		return container;
	}

	function renderHistory(items) {
		if (!list) return;
		list.replaceChildren(
			Object.assign(document.createElement("div"), { className: "inspire-history-title", textContent: "最近历史:" }),
			...(Array.isArray(items) && items.length > 0
				? items.slice(0, 8).map((h) =>
					Object.assign(document.createElement("div"), {
						className: "inspire-history-item",
						textContent: `${h.at?.slice(11, 19) ?? ""} [${h.style ?? "?"}] ${h.line ?? ""}`,
					}))
				: [Object.assign(document.createElement("div"), { className: "inspire-history-item", textContent: "尚无记录" })]),
		);
	}

	async function draw() {
		if (!preview) return;
		preview.textContent = "抽取中…";
		try {
			const res = await fetch("/api/plugins/inspire/inspire?count=1", { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			preview.textContent = data.lines?.[0] ?? "(空)";
			renderHistory(data.history);
		} catch (e) {
			preview.textContent = `读取失败: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async function clear() {
		try {
			await fetch("/api/plugins/inspire/inspire-clear", { method: "POST" });
			renderHistory([]);
		} catch (e) {
			if (list) list.textContent = `清空失败: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	// 挂载点可能晚于 script 加载(设置页切分类后重建):MutationObserver 补挂
	const observer = new MutationObserver(() => { if (!container) ensureMounts(); });
	observer.observe(document.body, { childList: true, subtree: true });
	ensureMounts();
})();
