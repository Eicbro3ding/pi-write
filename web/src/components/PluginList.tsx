import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { PluginInfoDto } from "../types.ts";
import { ToggleSwitch } from "./ToggleSwitch.tsx";

/**
 * 插件列表(设置页「集成」分类):显示名称/版本/描述/状态徽章/装载错误,
 * 操作 = 启用/禁用 + 完全信任(确认态)+ 删除(确认态)。状态变更即重建会话。
 *
 * 边界:插件与主进程同权(似 Obsidian/酒馆社区插件);「完全信任」额外解锁
 * 插件后端自定义路由 + 前端 JS(renderer 执行插件代码),开启需二次确认。
 */
export function PluginList({ client, onChanged }: { client: ApiClient; onChanged?: () => void }) {
	const [plugins, setPlugins] = useState<PluginInfoDto[] | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	/** 正在确认删除的插件 id(null = 无)。 */
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	/** 正在确认信任的插件 id(null = 无;点击「完全信任」开关后弹确认)。 */
	const [confirmTrust, setConfirmTrust] = useState<string | null>(null);
	const [rowErr, setRowErr] = useState<string | null>(null);

	const load = () =>
		client
			.getPlugins()
			.then(setPlugins)
			.catch((e) => {
				setPlugins([]);
				setLoadErr(`插件列表加载失败: ${friendlyError(e)}`);
			});

	useEffect(() => {
		void load();
	}, [client]);

	async function toggleEnabled(p: PluginInfoDto) {
		if (busyId) return;
		setBusyId(p.id);
		setRowErr(null);
		try {
			setPlugins(await client.setPluginEnabled(p.id, !p.enabled));
			onChanged?.();
		} catch (e) {
			setRowErr(`状态切换失败: ${friendlyError(e)}`);
		} finally {
			setBusyId(null);
		}
	}

	async function toggleTrusted(p: PluginInfoDto) {
		if (busyId) return;
		setBusyId(p.id);
		setRowErr(null);
		try {
			setPlugins(await client.setPluginTrusted(p.id, !p.trusted));
			setConfirmTrust(null);
			onChanged?.();
		} catch (e) {
			setRowErr(`信任变更失败: ${friendlyError(e)}`);
		} finally {
			setBusyId(null);
		}
	}

	async function removePlugin(p: PluginInfoDto) {
		if (busyId) return;
		setBusyId(p.id);
		setRowErr(null);
		try {
			setPlugins(await client.deletePlugin(p.id));
			setConfirmDelete(null);
			onChanged?.();
		} catch (e) {
			setRowErr(`删除失败: ${friendlyError(e)}`);
		} finally {
			setBusyId(null);
		}
	}

	if (loadErr) return <div className="notice err">{loadErr}</div>;

	return (
		<>
			{plugins === null ? (
				<div className="s-empty-row">
					<span className="s-val muted">加载中…</span>
				</div>
			) : plugins.length === 0 ? (
				<div className="s-empty-row">
					<span className="s-val muted">无插件。将插件目录放入 ~/.pi/writer/plugins/&lt;id&gt;/(含 plugin.json 与入口 index.mjs)。</span>
				</div>
			) : (
				<div className="s-plugin-list">
					{plugins.map((p) => (
						<div className={`s-plugin-row${p.enabled ? "" : " disabled"}`} key={p.id}>
						<div className="s-plugin-main">
							<span className="s-plugin-name">{p.name}</span>
							<span className="s-plugin-id mono">v{p.version}</span>
							{p.enabled ? (
								<span className="s-tag ok">已启用</span>
							) : p.manifestDisabled ? (
								<span className="s-tag muted">作者禁用</span>
							) : (
								<span className="s-tag muted">已禁用</span>
							)}
							<span className="s-actions">
								{/* 完全信任开关(点击弹确认;未启用时也可信任) */}
								<ToggleSwitch
									checked={p.trusted}
									disabled={busyId !== null}
									onChange={() => setConfirmTrust(p.id)}
									ariaLabel={`完全信任 ${p.name}`}
								/>
								<span className="s-note-inline" title="开启后插件可注册后端自定义路由并加载前端 JS;插件与主进程同权,仅信任你自己安装的插件">完全信任</span>
								<button
									type="button"
									className="btn-ghost"
									disabled={busyId !== null || p.manifestDisabled}
									onClick={() => void toggleEnabled(p)}
								>
									{busyId === p.id ? "切换中…" : p.enabled ? "禁用" : "启用"}
								</button>
								{confirmDelete === p.id ? (
									<>
										<span className="s-note-inline">确认删除?</span>
										<button type="button" className="btn-ghost danger" disabled={busyId !== null} onClick={() => void removePlugin(p)}>
											{busyId === p.id ? "删除中…" : "确认"}
										</button>
										<button type="button" className="btn-ghost" disabled={busyId !== null} onClick={() => setConfirmDelete(null)}>
													取消
												</button>
											</>
										) : (
											<button type="button" className="btn-ghost danger" disabled={busyId !== null} onClick={() => setConfirmDelete(p.id)}>
												删除
											</button>
										)}
							</span>
							</div>
							{p.description && <div className="s-plugin-desc">{p.description}</div>}
							{p.error ? <div className="s-plugin-err">{p.error}</div> : null}
							{confirmTrust === p.id && (
								<div className="s-plugin-trust-confirm">
									<div className="s-plugin-trust-warn">
										开启「完全信任」后,插件可以注册后端自定义路由并在渲染进程执行其前端 JS——
										与 pi-writer 主进程/渲染进程同权。仅信任你自己安装的插件。
									</div>
									<div className="s-field-row">
										<button type="button" className="btn-ghost danger" disabled={busyId !== null} onClick={() => void toggleTrusted(p)}>
											{busyId === p.id ? "设置中…" : p.trusted ? "取消信任" : "确认开启"}
										</button>
										<button type="button" className="btn-ghost" disabled={busyId !== null} onClick={() => setConfirmTrust(null)}>
											取消
										</button>
									</div>
								</div>
							)}
						</div>
					))}
				</div>
			)}
			{rowErr && <div className="notice err">{rowErr}</div>}
		</>
	);
}
