import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { McpServerInfo, McpServerStatus } from "../types.ts";

/** 表单草稿:与 McpServerInfo 一致,args/env 在表单层用逗号分隔字符串。 */
interface Draft {
	name: string;
	type: "stdio" | "sse" | "http";
	command: string;
	args: string;
	env: string;
	url: string;
}

const EMPTY_DRAFT: Draft = { name: "", type: "stdio", command: "", args: "", env: "", url: "" };

function draftFromServer(s: McpServerInfo): Draft {
	return {
		name: s.name,
		type: s.type,
		command: s.command ?? "",
		args: (s.args ?? []).join(","),
		env: Object.entries(s.env ?? {})
			.map(([k, v]) => `${k}=${v}`)
			.join(","),
		url: s.url ?? "",
	};
}

/** 表单草稿 → 提交体;名称/命令必填校验在组件层先做,其余交给服务端。 */
function draftToServer(d: Draft): McpServerInfo {
	const args = d.args
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const env: Record<string, string> = {};
	for (const pair of d.env.split(",")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const k = pair.slice(0, eq).trim();
		const v = pair.slice(eq + 1).trim();
		if (k.length > 0) env[k] = v;
	}
	const base: McpServerInfo = { name: d.name.trim(), type: d.type };
	if (d.type === "stdio") {
		base.command = d.command.trim();
		if (args.length > 0) base.args = args;
		if (Object.keys(env).length > 0) base.env = env;
	} else {
		base.url = d.url.trim();
	}
	return base;
}

/**
 * MCP 服务器管理区:服务器列表(名称 + 类型 + 连接状态/工具数)+
 * 行内表单(新增/编辑,字段按类型切换 stdio/sse)+ 删除确认。
 * 保存/删除后服务端会重连并重建会话,新工具即时生效——提示文案随之说明。
 */
export function McpServerList({ client }: { client: ApiClient }) {
	const [servers, setServers] = useState<McpServerInfo[] | null>(null);
	const [status, setStatus] = useState<McpServerStatus[]>([]);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	/** 新增表单展开(false = 底部「＋ 添加服务器」按钮)。 */
	const [adding, setAdding] = useState(false);
	/** 编辑中的服务器名(null = 无)。 */
	const [editingName, setEditingName] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	/** 待确认删除的服务器名。 */
	const [confirmName, setConfirmName] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [rowErr, setRowErr] = useState<string | null>(null);
	/** 「直接编辑文件」展开(可写 imports/mcpServers 等表单表达不了的形状)。 */
	const [rawOpen, setRawOpen] = useState(false);
	const [rawText, setRawText] = useState("");
	const [rawErr, setRawErr] = useState<string | null>(null);

	const load = useCallback(async () => {
		const r = await client.getMcpServers();
		setServers(r.servers);
		setStatus(r.status);
	}, [client]);

	useEffect(() => {
		let cancelled = false;
		setLoadErr(null);
		void load().catch((e) => {
			if (cancelled) return;
			setServers([]);
			setLoadErr(`MCP 服务器加载失败: ${friendlyError(e)}`);
		});
		return () => {
			cancelled = true;
		};
	}, [load]);

	/** 按 name 查连接状态(展示 ok/失败/工具数)。 */
	function statusOf(name: string): McpServerStatus | undefined {
		return status.find((s) => s.name === name);
	}

	/** 保存(新增或更新):成功后刷新列表并收起表单。 */
	async function save() {
		if (busy) return;
		const server = draftToServer(draft);
		if (server.name.length === 0) {
			setRowErr("请填写服务器名称");
			return;
		}
		if (server.type === "stdio" && server.command?.length === 0) {
			setRowErr("stdio 类型必须填写命令(如 npx)");
			return;
		}
		if (server.type !== "stdio" && server.url?.length === 0) {
			setRowErr("http/sse 类型必须填写 URL");
			return;
		}
		setBusy(true);
		setRowErr(null);
		try {
			if (editingName !== null) {
				await client.updateMcpServer(editingName, server);
			} else {
				await client.addMcpServer(server);
			}
		} catch (e) {
			setRowErr(`保存失败: ${friendlyError(e)}`);
			setBusy(false);
			return;
		}
		setEditingName(null);
		setAdding(false);
		setDraft(EMPTY_DRAFT);
		try {
			await load();
		} catch {
			setRowErr("服务器列表刷新失败");
		}
		setBusy(false);
	}

	/** 删除:确认后删除 + 刷新。 */
	async function remove(name: string) {
		if (busy) return;
		setBusy(true);
		setRowErr(null);
		try {
			await client.deleteMcpServer(name);
		} catch (e) {
			setRowErr(`删除失败: ${friendlyError(e)}`);
			setBusy(false);
			return;
		}
		setConfirmName(null);
		try {
			await load();
		} catch {
			setRowErr("服务器列表刷新失败");
		}
		setBusy(false);
	}

	function startEdit(s: McpServerInfo) {
		setEditingName(s.name);
		setAdding(false);
		setDraft(draftFromServer(s));
		setConfirmName(null);
	}

	function startAdd() {
		setAdding(true);
		setEditingName(null);
		setDraft(EMPTY_DRAFT);
		setConfirmName(null);
	}

	/** 打开「直接编辑文件」:拉取 mcp.json 原始文本预填。 */
	async function openRaw() {
		setBusy(true);
		setRawErr(null);
		try {
			setRawText(await client.getMcpConfigRaw());
			setRawOpen(true);
		} catch (e) {
			setRawErr(`读取配置失败: ${friendlyError(e)}`);
		}
		setBusy(false);
	}

	/** 保存原始文本:服务端校验后落盘并重连,成功后刷新列表收起编辑区。 */
	async function saveRaw() {
		if (busy) return;
		setBusy(true);
		setRawErr(null);
		try {
			await client.saveMcpConfigRaw(rawText);
		} catch (e) {
			setRawErr(`保存失败: ${friendlyError(e)}`);
			setBusy(false);
			return;
		}
		setRawOpen(false);
		try {
			await load();
		} catch {
			setRowErr("服务器列表刷新失败");
		}
		setBusy(false);
	}

	const formOpen = adding || editingName !== null;

	return (
		<>
			{loadErr && <div className="notice err">{loadErr}</div>}
			{rowErr && <div className="notice err">{rowErr}</div>}
			<div className="s-hint">
				MCP 服务器为 AI 提供外部工具(stdio 本地命令 / http、sse 远端)。保存后立即重连并重建会话,新工具即时生效;连接意外断开会自动重连。
			</div>
			{(servers ?? []).length === 0 ? (
				<div className="s-row">
					<span className="s-val muted">尚未配置 MCP 服务器</span>
				</div>
			) : (
				(servers ?? []).map((s) => {
					const st = statusOf(s.name);
					return (
						<div className="s-row s-provider" key={s.name}>
							<span className="s-key mono">
								{s.type === "stdio" ? "⌘ " : "↗ "}
								{s.name}
							</span>
							{s.type === "stdio" ? (
								<span className="s-tag">{s.command}</span>
							) : (
								<span className="s-tag">{s.url}</span>
							)}
							{st === undefined ? (
								<span className="s-tag">状态未知</span>
							) : st.ok ? (
								<span className="s-tag ok">已连接 · {st.tools} 工具</span>
							) : (
								<span className="s-tag err" title={st.error}>
									连接失败
								</span>
							)}
							<span className="s-actions">
								<button className="btn-ghost" disabled={busy} onClick={() => startEdit(s)}>
									编辑
								</button>
								<button className="btn-ghost danger" disabled={busy} onClick={() => setConfirmName(s.name)}>
									删除
								</button>
							</span>
							{confirmName === s.name && (
								<div className="s-provider-confirm">
									<span>删除服务器《{s.name}》?其工具将不再可用。</span>
									<button className="btn-ghost danger" disabled={busy} onClick={() => void remove(s.name)}>
										{busy ? "删除中…" : "确认删除"}
									</button>
									<button className="btn-ghost" disabled={busy} onClick={() => setConfirmName(null)}>
										取消
									</button>
								</div>
							)}
						</div>
					);
				})
			)}
			{/* 添加/编辑共用表单:formOpen 时展开(替换「＋ 添加」按钮),点保存提交、取消收起 */}
			{formOpen && (
					<div className="s-provider-form">
						<input className="s-input" placeholder="名称" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
						<select
							className="s-input"
							value={draft.type}
							onChange={(e) => setDraft({ ...draft, type: e.target.value === "stdio" ? "stdio" : e.target.value === "sse" ? "sse" : "http" })}
						>
							<option value="stdio">stdio(本地命令)</option>
							<option value="http">http(streamable,现行标准)</option>
							<option value="sse">sse(旧版,兼容)</option>
						</select>
						{draft.type === "stdio" ? (
							<>
								<input className="s-input" placeholder="命令,如 npx" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
								<input className="s-input" placeholder="参数,逗号分隔,如 -y,@modelcontextprotocol/server-everything" value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
								<input className="s-input" placeholder="环境变量,逗号分隔 KEY=VALUE(可选)" value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} />
							</>
						) : (
							<input className="s-input" placeholder="URL,如 http://localhost:8765/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
						)}
					<div>
						<button className="btn-ghost" disabled={busy} onClick={() => void save()}>
							{busy ? "保存中…" : "保存"}
						</button>
						<button className="btn-ghost" disabled={busy} onClick={() => { setEditingName(null); setAdding(false); setDraft(EMPTY_DRAFT); }}>
							取消
						</button>
					</div>
				</div>
			)}
			{!formOpen && (
				<div className="s-actions">
					<button className="btn-ghost" disabled={busy} onClick={startAdd}>
						＋ 添加 MCP 服务器
					</button>
					<button className="btn-ghost" disabled={busy} onClick={() => void openRaw()}>
						✎ 直接编辑文件
					</button>
				</div>
			)}
			{/* 直接编辑文件:原样读写 mcp.json(支持 imports/mcpServers 等表单表达不了的形状) */}
			{rawOpen && (
				<div className="s-mcp-raw">
					<div className="s-hint">直接编辑 mcp.json(位于 ~/.pi/writer/agent/)。支持自有 servers 数组或 Claude Code 的 mcpServers 对象 + imports;保存时校验 JSON 与结构,原样落盘。</div>
					<textarea
						className="s-mcp-raw-input"
						spellCheck={false}
						value={rawText}
						onChange={(e) => setRawText(e.target.value)}
						placeholder='{\n  "imports": ["claude-code"],\n  "mcpServers": {\n    "tavily": { "command": "npx", "args": ["-y", "tavily-mcp"] }\n  }\n}'
					/>
					{rawErr && <div className="notice err">{rawErr}</div>}
					<div>
						<button className="btn-ghost" disabled={busy} onClick={() => void saveRaw()}>
							{busy ? "保存中…" : "保存"}
						</button>
						<button className="btn-ghost" disabled={busy} onClick={() => { setRawOpen(false); setRawErr(null); }}>
							取消
						</button>
					</div>
				</div>
			)}
		</>
	);
}
