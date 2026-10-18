/**
 * 组件预览页入口(开发脚手架,不参与打包)。
 *
 * 与 `main.tsx` 的关系:两者**共享同一份主题、同一份样式闭包、同一个 UI 房**,
 * 差别只有两点 ——
 * 1. 不挂 App 壳(nullah 的整套路由 / 书库 / 会话 / 首启向导),省掉「未打开书」那一片;
 * 2. 展品由 URL 指定,不用在页面里点五层才能到:`?e=message-stream&v=对话`。
 *
 * 样式必须显式 import:预览入口若漏了它,组件在预览里是裸 `<div>` 堆叠,
 * 而真实界面好看得多 —— 这种「预览比真机丑」的假象比没有预览更浪费时间。
 * 所以 `styles.ts` 是唯一入口,`main.tsx` 与这里都引它,不存在第二份清单。
 */
import { StrictMode, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { UIRoom } from "./pages/UIRoom.tsx";
import { demoLibrary, stubClient } from "./uiroom-runtime.tsx";
import { initTheme } from "./theme.ts";
import "./styles.ts";

initTheme();

/** URL 参数:`?e=<展项 id>&v=<状态档文案>`(缺省 `v` 取第一档)。 */
const params = new URLSearchParams(location.search);
const exhibit = params.get("e") ?? "";
const variant = params.get("v") ?? undefined;

/** 书库替身与隔离客户端:预览页绝不碰真实数据(与 UI 房的默认档一致)。 */
const library = demoLibrary();
const client = stubClient("组件预览页:请求被拦下(这里只负责画,不负责取数)");

createRoot(document.getElementById("root")!).render(
	createElement(
		StrictMode,
		null,
		createElement(
			MotionConfig,
			{ reducedMotion: "user" },
			exhibit
				? createElement(UIRoom, { client, slug: null, library, classicMode: false, focus: { exhibit, variant } })
				: createElement(Index),
		),
	),
);

/**
 * 没指定展项时给一张索引:手写 URL 太难记,这里把「所有展项 × 状态档」列成链接,
 * 点一下就是那一格。列表来自 UI 房的同一张表(不是另抄一份)。
 */
function Index() {
	const [entries, setEntries] = useState<{ id: string; title: string; group: string; variants: string[] }[]>([]);
	useEffect(() => {
		void (async () => {
			const [{ CHAT_ENTRIES, CHAT_SECTION }, { ATOMS_ENTRIES, ATOMS_SECTION }, { WORLD_ENTRIES, WORLD_SECTION }, { STAGE_ENTRIES, STAGE_SECTION }, { SETTINGS_ENTRIES, SETTINGS_SECTION }, { TOKENS_ENTRIES, TOKENS_SECTION }] =
				await Promise.all([
					import("./uiroom/chat.tsx"),
					import("./uiroom/atoms.tsx"),
					import("./uiroom/world.tsx"),
					import("./uiroom/stage.tsx"),
					import("./uiroom/settings.tsx"),
					import("./uiroom/tokens.tsx"),
				]);
			const sections = { ...ATOMS_SECTION, ...CHAT_SECTION, ...WORLD_SECTION, ...STAGE_SECTION, ...SETTINGS_SECTION, ...TOKENS_SECTION };
			const all = [...ATOMS_ENTRIES, ...CHAT_ENTRIES, ...WORLD_ENTRIES, ...STAGE_ENTRIES, ...SETTINGS_ENTRIES, ...TOKENS_ENTRIES];
			setEntries(
				all.map((e) => ({
					id: e.id,
					title: e.title,
					group: e.group,
					variants: (sections[e.id] ?? []).map((v) => v.label),
				})),
			);
		})();
	}, []);
	return createElement(
		"div",
		{ className: "uiroom uiroom--solo pv-index" },
		createElement("h1", null, "组件预览"),
		createElement("p", { className: "pv-note" }, "点展项直接看那一格;带状态档的参数会钉在那一档上。"),
		...entries.map((e) =>
			createElement(
				"section",
				{ key: e.id, className: "pv-entry" },
				createElement("a", { href: `?e=${encodeURIComponent(e.id)}` }, `${e.title} — ${e.id}`),
				e.variants.length > 0
					? createElement(
							"span",
							{ className: "pv-variants" },
							...e.variants.map((v) =>
								createElement("a", { key: v, href: `?e=${encodeURIComponent(e.id)}&v=${encodeURIComponent(v)}` }, v),
							),
						)
					: null,
			),
		),
	);
}

