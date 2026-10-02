/**
 * 消息版本切换器的渲染契约(node SSR,无 DOM)。
 *
 * 为什么单独钉一条:user 消息的 `done` **恒为 false** —— store 的 done 只由
 * message_end 落在「最后一条未 done 的 assistant」上,user/toolResult 的消息被
 * 显式忽略(见 store.ts 的 message_end 分支)。2026-10-02 的无头 chromium 走查
 * 正是踩在这上面:切换器当年写成 `m.done && …`,于是 assistant 的能显示、user 的
 * 永远不显示 —— 而编辑重发产生的版本**恰恰都在 user 消息上**,功能等于没生效。
 *
 * 这里用 react-dom/server 把 MessageList 渲染一遍(与 UI 房同一套做法),把四种
 * 可见性都钉住,免得下次又拿 done 当门槛。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageList } from "../web/src/components/MessageList.tsx";
import type { ChatMessage, SessionVersionInfo } from "../web/src/types.ts";

const VERSION: SessionVersionInfo = { ids: ["e-u1", "e-u2"], leaves: ["e-a1", "e-a2"], index: 1 };

function render(messages: ChatMessage[], opts: { streaming?: boolean; versions?: ReadonlyMap<string, SessionVersionInfo> } = {}): string {
	return renderToStaticMarkup(
		createElement(MessageList, {
			messages,
			streaming: opts.streaming ?? false,
			debug: false,
			versions: opts.versions,
			onSwitchVersion: () => {},
		}),
	);
}

const userMsg = (done: boolean): ChatMessage => ({
	id: "u2",
	entryId: "e-u2",
	role: "user",
	done,
	blocks: [{ kind: "text", text: "改过的开头" }],
});

describe("MessageList · 消息版本切换器", () => {
	it("user 消息 done=false(store 的真形状)也照样画「2 / 2」", () => {
		const html = render([userMsg(false)], { versions: new Map([["e-u2", VERSION]]) });
		expect(html).toContain('class="msg-pager"');
		expect(html).toContain("2 / 2");
		expect(html).toContain('aria-label="消息版本 2 / 2"');
	});

	it("assistant 气泡未结束(done=false)不画:流式中途不许切", () => {
		const assistant: ChatMessage = {
			id: "a2",
			entryId: "e-a2",
			firstEntryId: "e-a2",
			role: "assistant",
			done: false,
			blocks: [{ kind: "text", text: "改过的回复" }],
		};
		const html = render([assistant], { versions: new Map([["e-a2", VERSION]]) });
		expect(html).not.toContain("msg-pager");
	});

	it("整条对话流式中不画(服务端此刻拒绝 navigate)", () => {
		const html = render([userMsg(false)], { streaming: true, versions: new Map([["e-u2", VERSION]]) });
		expect(html).not.toContain("msg-pager");
	});

	it("没有版本(或只有一版)不画", () => {
		const none = render([userMsg(false)]);
		expect(none).not.toContain("msg-pager");
		const single = render([userMsg(false)], {
			versions: new Map([["e-u2", { ids: ["e-u2"], leaves: ["e-a2"], index: 0 }]]),
		});
		expect(single).not.toContain("msg-pager");
	});

	it("键按 firstEntryId 优先取(assistant 组的首段才是版本位置)", () => {
		const assistant: ChatMessage = {
			id: "a2",
			entryId: "e-a2-last", // 组内最后一段
			firstEntryId: "e-a2", // 组首段 = 版本位置
			role: "assistant",
			done: true,
			blocks: [{ kind: "text", text: "改过的回复" }],
		};
		const html = render([assistant], { versions: new Map([["e-a2", VERSION]]) });
		expect(html).toContain("msg-pager");
		expect(html).toContain("2 / 2");
	});
});
