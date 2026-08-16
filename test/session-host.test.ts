import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../vendor/pi-coding-agent/src/index.ts";
import { SessionHost } from "../src/web/session-host.ts";

// 最小 fake runtime:注入的工厂返回 CreateAgentSessionRuntimeResult 形状,
// 由 SessionHost 内部经 createAgentSessionRuntime 包装成 AgentSessionRuntime。
function makeFakeRuntime(modelRuntime: Record<string, unknown> = {}) {
	const listeners = new Set<(e: unknown) => void>();
	const session = {
		subscribe: (l: (e: unknown) => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		prompt: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(() => {}),
		sendCustomMessage: vi.fn(async () => {}),
		getContextUsage: vi.fn(() => ({ tokens: 1200, contextWindow: 2000, percent: 60 })),
		compact: vi.fn(async () => ({
			summary: "已压缩",
			tokensBefore: 1000,
			estimatedTokensAfter: 400,
		})),
		isStreaming: false,
	};
	return {
		session,
		listeners,
		factoryResult: {
			session,
			extensionsResult: {},
				services: {
					modelRuntime: {
						getModels: vi.fn(() => []),
						getProvider: vi.fn(),
						getProviderAuthStatus: vi.fn(() => ({ configured: false })),
						login: vi.fn(async () => ({})),
						logout: vi.fn(async () => {}),
						...modelRuntime,
					},
				},
			diagnostics: [],
		},
	};
}

// 构造 SessionHost:fake 工厂返回 CreateAgentSessionRuntimeResult 形状;
// fake sessionManager 的 getSessionFile 返回 undefined,assertSessionCwdExists 因此跳过 cwd 检查。
function makeHost(fake: ReturnType<typeof makeFakeRuntime>) {
	return new SessionHost({
		createRuntime: async () => fake.factoryResult as never,
		cwd: "/tmp",
		agentDir: "/tmp/agent",
		sessionManager: { getSessionFile: () => undefined } as never,
	});
}

describe("SessionHost", () => {
	it("start 后事件经 subscribe 扇出", async () => {
		const fake = makeFakeRuntime();
		const host = makeHost(fake);
		const seen: unknown[] = [];
		host.subscribe((e) => seen.push(e));
		await host.start();
		fake.listeners.forEach((l) => l({ type: "turn_start" }));
		expect(seen.map((e) => (e as { type: string }).type)).toContain("turn_start");
	});
	it("sendMessage 转发到 session.prompt", async () => {
		const fake = makeFakeRuntime();
		const host = makeHost(fake);
		await host.start();
		await host.sendMessage("你好");
		expect(fake.session.prompt).toHaveBeenCalledWith("你好");
	});
	it("injectContext 经 sendCustomMessage 以 nextTurn 投递", async () => {
		const fake = makeFakeRuntime();
		const host = makeHost(fake);
		await host.start();
		await host.injectContext("背景包文本");
		expect(fake.session.sendCustomMessage).toHaveBeenCalledWith(
			// vendor 的 CustomMessage.display 为必填布尔,注入通道以 true 表示不渲染
			{ customType: "world-context", content: [{ type: "text", text: "背景包文本" }], display: true },
			{ deliverAs: "nextTurn" },
		);
	});
	it("getContextUsage 转发 vendor 上下文占用", async () => {
		const fake = makeFakeRuntime();
		const host = makeHost(fake);
		await host.start();
		expect(host.getContextUsage()).toEqual({ tokens: 1200, contextWindow: 2000, percent: 60 });
	});
	it("compact 转发 vendor compact 并裁剪返回字段", async () => {
		const fake = makeFakeRuntime();
		const host = makeHost(fake);
		await host.start();
		await expect(host.compact("保留冲突")).resolves.toEqual({
			summary: "已压缩",
			tokensBefore: 1000,
			estimatedTokensAfter: 400,
		});
		expect(fake.session.compact).toHaveBeenCalledWith("保留冲突");
	});
	it("switchSession 转发绝对路径", async () => {
		const fake = makeFakeRuntime();
		const host = makeHost(fake);
		await host.start();
		// 真实 AgentSessionRuntime 的 switchSession 是原型方法,spy 拦截即可,
		// 避免走到内部真实的会话替换逻辑(fake session 撑不住)。
		// 返回类型与 vendor 一致:{ cancelled: boolean }。
		const spy = vi.spyOn(host.getRuntime(), "switchSession").mockResolvedValue({ cancelled: false });
		await host.switchSession("/tmp/book/ch02.jsonl");
		expect(spy).toHaveBeenCalledWith("/tmp/book/ch02.jsonl");
	});
	it("switchSession 后事件仍扇出(重新绑定新会话)", async () => {
		const fake = makeFakeRuntime();
		const host = makeHost(fake);
		await host.start();
		// 模拟 vendor switchSession 行为:内部 _session 被替换为新对象(agent-session-runtime.ts apply())
		const newListeners = new Set<(e: unknown) => void>();
		const newSession = {
			subscribe: (l: (e: unknown) => void) => {
				newListeners.add(l);
				return () => newListeners.delete(l);
			},
			prompt: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinkingLevel: vi.fn(() => {}),
			isStreaming: false,
		};
		const rt = host.getRuntime();
		vi.spyOn(rt, "switchSession").mockImplementation(async () => {
			(rt as unknown as { _session: unknown })._session = newSession;
			return { cancelled: false };
		});
		const seen: unknown[] = [];
		host.subscribe((e) => seen.push(e));
		await host.switchSession("/tmp/book/ch02.jsonl");
		// 旧订阅已退订、新会话事件经重绑扇出
		expect(fake.listeners.size).toBe(0);
		newListeners.forEach((l) => l({ type: "turn_end" }));
		expect(seen.map((e) => (e as { type: string }).type)).toContain("turn_end");
	});
	it("listProviders 归一形状并已配置置顶", async () => {
		const mr = {
			getModels: () => [
				{ id: "gpt-4o", provider: "openai" },
				{ id: "sonnet", provider: "anthropic" },
			],
			getProvider: (id: string) =>
				({ openai: { name: "OpenAI", auth: { apiKey: { login: async () => ({}) } } }, anthropic: { name: "Anthropic", auth: { apiKey: { login: async () => ({}) }, oauth: {} } } })[id as "openai" | "anthropic"],
			getProviderAuthStatus: (id: string) => (id === "anthropic" ? { configured: true, source: "stored" } : { configured: false }),
		};
		const fake = makeFakeRuntime(mr);
		const host = makeHost(fake);
		await host.start();
		const list = await host.listProviders();
		expect(list.map((p) => p.id)).toEqual(["anthropic", "openai"]);
		expect(list[0]).toMatchObject({ name: "Anthropic", configured: true, authKind: "both", source: "stored" });
		expect(list[1]).toMatchObject({ authKind: "api_key", configured: false });
	});
	it("setProviderApiKey 转发 key 到官方 login 路径", async () => {
		const login = vi.fn(async () => ({}));
		const fake = makeFakeRuntime({ login });
		const host = makeHost(fake);
		await host.start();
		await host.setProviderApiKey("anthropic", "sk-test");
		expect(login).toHaveBeenCalledTimes(1);
		const [, type, interaction] = login.mock.calls[0]!;
		expect(type).toBe("api_key");
		await expect(interaction.prompt({ type: "secret", message: "Enter API key" })).resolves.toBe("sk-test");
	});
	it("removeProvider 转发 logout", async () => {
		const logout = vi.fn(async () => {});
		const fake = makeFakeRuntime({ logout });
		const host = makeHost(fake);
		await host.start();
		await host.removeProvider("openai");
		expect(logout).toHaveBeenCalledWith("openai");
	});
});

// —— 撤回/编辑消息:真实 SessionManager + fake runtime ——

/** 真实内存 SessionManager(fake session 的 sessionManager 字段)。 */
function makeRealSm(): SessionManager {
	return SessionManager.inMemory("/tmp/book");
}

/** 把真实 sessionManager 与 agent.state 注入 fake runtime 的 session。 */
function wireRealSm(fake: ReturnType<typeof makeFakeRuntime>, sm: SessionManager): SessionManager {
	(fake.session as unknown as { sessionManager: SessionManager }).sessionManager = sm;
	(fake.session as unknown as { agent: { state: { messages: unknown[] } } }).agent = { state: { messages: [] } };
	return sm;
}

/** 追加一条 user/assistant 消息到真实 sm;返回该 entry 的 id。 */
function pushMessage(sm: SessionManager, role: "user" | "assistant", text: string): string {
	sm.appendMessage({ role, content: [{ type: "text", text }], timestamp: Date.now() } as never);
	return sm.getBranch().at(-1)!.id;
}

/** 推一条带 thinking 块的 assistant 消息(模拟真实会话文件里 cot 落盘形态)。 */
function pushThinkingMessage(sm: SessionManager, text: string, thinking: string): string {
	sm.appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking, thinkingSignature: "reasoning_content" },
			{ type: "text", text },
		],
		timestamp: Date.now(),
	} as never);
	return sm.getBranch().at(-1)!.id;
}

describe("SessionHost retractMessage", () => {
	it("撤回用户消息后 getState 只含其之前的消息,且消息带 entry id", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		const u1 = pushMessage(sm, "user", "你好");
		pushMessage(sm, "assistant", "你好!有什么可以帮你?");
		const u2 = pushMessage(sm, "user", "写一段开场");
		pushMessage(sm, "assistant", "好的,这是开场……");

		const state = host.getState();
		expect(state.messages).toHaveLength(4);
		expect(state.messages[0]?.id).toBe(u1);
		expect(state.messages[2]?.id).toBe(u2);

		await host.retractMessage(u2);
		const after = host.getState();
		expect(after.messages.map((m) => m.text)).toEqual(["你好", "你好!有什么可以帮你?"]);
		expect(after.messages.some((m) => m.id === u2)).toBe(false);
		// AI 上下文同步截断(buildSessionContext 重建后不含被撤回消息)
		const ctx = (fake.session as unknown as { agent: { state: { messages: Array<{ role?: string }> } } }).agent.state.messages;
		expect(ctx.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("允许撤回任意用户消息:较早的消息被撤回后,其及之后内容离开当前对话", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		const u1 = pushMessage(sm, "user", "你好");
		pushMessage(sm, "assistant", "回复一");
		pushMessage(sm, "user", "第二条");
		pushMessage(sm, "assistant", "回复二");

		// 撤回较早的 u1:该消息及之后全部离开当前对话(保留在会话文件,分支可回)
		await host.retractMessage(u1);
		expect(host.getState().messages).toEqual([]);
		// AI 上下文同步截断(buildSessionContext 重建后不含被撤回消息)
		const ctx = (fake.session as unknown as { agent: { state: { messages: Array<{ role?: string }> } } }).agent.state.messages;
		expect(ctx).toEqual([]);
	});

	it("撤回第一条(也是唯一一条)用户消息也能工作", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		const u1 = pushMessage(sm, "user", "唯一消息");
		pushMessage(sm, "assistant", "回复");
		await host.retractMessage(u1);
		expect(host.getState().messages).toEqual([]);
	});

	it("拒绝未知 id / 非用户消息 / 流式中撤回", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		const u1 = pushMessage(sm, "user", "你好");
		const a1 = pushMessage(sm, "assistant", "回复");

		await expect(host.retractMessage("no-such-entry")).rejects.toThrow();
		await expect(host.retractMessage(a1)).rejects.toThrow(/只能撤回用户消息/);
		// 流式中:isStreaming 置 true 后拒绝
		(fake.session as unknown as { isStreaming: boolean }).isStreaming = true;
		await expect(host.retractMessage(u1)).rejects.toThrow(/正在回复/);
	});

	it("message_end 转发事件附加 entryId(实时消息获得稳定 id)", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();
		const seen: Array<Record<string, unknown>> = [];
		host.subscribe((e) => seen.push(e as Record<string, unknown>));

		const id = pushMessage(sm, "user", "你好");
		// 模拟 vendor:appendMessage 后 leaf 已推进,再发 message_end
		fake.listeners.forEach((l) =>
			l({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "你好" }] } }),
		);
		const end = seen.find((e) => e.type === "message_end") as { entryId?: string };
		expect(end?.entryId).toBe(id);
	});

	it("extractMessages 按轮分组合并:同轮多段 assistant 合并为一条气泡", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		pushMessage(sm, "user", "写一段");
		pushMessage(sm, "assistant", "场景一……");
		const a1Last = pushMessage(sm, "assistant", "场景二……"); // 组内最后一条 entry
		pushMessage(sm, "user", "继续");
		const a2 = pushMessage(sm, "assistant", "后续……");

		const msgs = host.getState().messages;
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		// 同轮(同一 user 之后)的两段 assistant 输出合并,空行拼接
		expect(msgs[1]!.text).toBe("场景一……\n\n场景二……");
		expect(msgs[1]!.id).toBe(a1Last); // 组内取最后一条 entry id
		expect(msgs[2]!.text).toBe("继续");
		expect(msgs[3]!.text).toBe("后续……");
		expect(msgs[3]!.id).toBe(a2);
		// 撤回定位:user 消息 id 即该组起点 entry 的 id(不受合并影响)
		expect(msgs[0]!.id).toBeDefined();
		expect(msgs[2]!.id).toBeDefined();
	});

	it("extractMessages 提取思考链(历史水合后 cot 仍在)", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		pushMessage(sm, "user", "写一段");
		pushThinkingMessage(sm, "场景一……", "先想好场景结构……");
		const lastId = pushThinkingMessage(sm, "场景二……", "再补一段……"); // 同轮第二段:thinking 拼接
		pushMessage(sm, "user", "继续");
		pushThinkingMessage(sm, "后续……", "后续思路……");

		const msgs = host.getState().messages;
		// 同轮合并:thinking 也拼接,不含 thinking 的 user 消息无该字段
		expect(msgs[1]!.text).toBe("场景一……\n\n场景二……");
		expect(msgs[1]!.thinking).toContain("先想好场景结构……");
		expect(msgs[1]!.thinking).toContain("再补一段……");
		expect(msgs[1]!.id).toBe(lastId);
		expect(msgs[2]!.thinking).toBeUndefined();
		expect(msgs[3]!.thinking).toBe("后续思路……");
	});
});

describe("SessionHost branchMessage", () => {
	it("分支后该消息保留,其后消息离开当前对话", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		pushMessage(sm, "user", "你好");
		pushMessage(sm, "assistant", "回复一");
		const u2 = pushMessage(sm, "user", "第二条");
		pushMessage(sm, "assistant", "回复二");

		await host.branchMessage(u2);
		const after = host.getState();
		// 分支起点消息保留,其后(回复二)消失
		expect(after.messages.map((m) => m.text)).toEqual(["你好", "回复一", "第二条"]);
		// AI 上下文同步截断到分支起点
		const ctx = (fake.session as unknown as { agent: { state: { messages: Array<{ role?: string }> } } }).agent.state.messages;
		expect(ctx.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		// 之后发送的消息 append 到分支起点之下(新分支继续)
		await host.sendMessage("第三条");
		expect(fake.session.prompt).toHaveBeenCalledWith("第三条");
	});

	it("从第一条消息分支(根消息)也能工作;拒绝未知 id 与流式中", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		const u1 = pushMessage(sm, "user", "第一条");
		pushMessage(sm, "assistant", "回复");
		await host.branchMessage(u1);
		expect(host.getState().messages.map((m) => m.text)).toEqual(["第一条"]);

		await expect(host.branchMessage("no-such")).rejects.toThrow();
		(fake.session as unknown as { isStreaming: boolean }).isStreaming = true;
		await expect(host.branchMessage(u1)).rejects.toThrow(/正在回复/);
	});

	it("getSessionTree 枚举分支并标记当前;navigateTo 可来回切换", async () => {
		const sm = makeRealSm();
		const fake = makeFakeRuntime();
		wireRealSm(fake, sm);
		const host = makeHost(fake);
		await host.start();

		const u1 = pushMessage(sm, "user", "第一条消息");
		pushMessage(sm, "assistant", "回复一");
		const u2 = pushMessage(sm, "user", "第二条消息");
		pushMessage(sm, "assistant", "回复二");
		// 当前只有一个分支(主线)
		let tree = await host.getSessionTree();
		expect(tree.branches).toHaveLength(1);
		expect(tree.branches[0]).toMatchObject({ leafId: expect.any(String), isCurrent: true, count: 4, summary: "第二条消息" });

		// 从 u2 分支:出现两个分支
		await host.branchMessage(u2);
		tree = await host.getSessionTree();
		expect(tree.branches).toHaveLength(2);
		const current = tree.branches.find((b) => b.isCurrent);
		const other = tree.branches.find((b) => !b.isCurrent);
		// summary 取最后一条 user 消息(分支点),tail 取最后一条消息——组合可区分分支
		expect(current?.summary).toBe("第二条消息");
		expect(current?.count).toBe(3); // 第一条 + 回复一 + 第二条
		expect(current?.tail).toBe("第二条消息");
		expect(other?.count).toBe(4); // 主线保留
		expect(other?.tail).toBe("回复二");

		// 切回主线(navigateTo 到主线叶子 = 回复二所在路径的最后一条)
		await host.navigateTo(other!.leafId);
		expect(host.getState().messages).toHaveLength(4);
		tree = await host.getSessionTree();
		expect(tree.branches.find((b) => b.isCurrent)?.leafId).toBe(other?.leafId);
		// 再切回分支
		await host.navigateTo(current!.leafId);
		expect(host.getState().messages).toHaveLength(3);

		await expect(host.navigateTo("no-such")).rejects.toThrow();
	});
});
