import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { PluginInfoDto } from "../types.ts";

/**
 * 插件列表(设置页「集成」分类):显示名称/版本/描述/状态徽章/装载错误,
 * 操作 = 启用/禁用开关 + 删除(确认态)。状态变更即重建会话,新工具生效。
 *
 * 边界:插件与主进程同权(似 Obsidian/酒馆社区插件),本页只做管理,
 * 不执行/预览插件代码;安装 = 手动放插件目录(见 plugin.json 约定)。
 */
export function PluginList({ client }: { client: ApiClient }) {
	const [plugins, setPlugins] = useState<PluginInfoDto[] | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	/** 正在确认删除的插件 id(null = 无)。 */
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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
		} catch (e) {
			setRowErr(`状态切换失败: ${friendlyError(e)}`);
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
						</div>
					))}
				</div>
			)}
			{rowErr && <div className="notice err">{rowErr}</div>}
		</>
	);
}
