import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { PluginInfoDto, PluginSettingsFieldDto } from "../types.ts";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { Select } from "./Select.tsx";

/**
 * 插件设置菜单(声明式渲染):按 plugin.json 的 frontend.ui.settingsItems
 * 字段 schema 渲染一个通用表单,值存服务端 plugins/<id>/settings.json。
 *
 * 安全模型:字段类型白名单(string/number/boolean/select/textarea)由协议限定,
 * renderer 不执行任何用户 JS——这里只做「schema → 控件」的受信任映射。
 */
export function PluginSettings({ client, plugin }: { client: ApiClient; plugin: PluginInfoDto }) {
	const items = plugin.frontend?.ui?.settingsItems ?? [];
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		let cancelled = false;
		client
			.getPluginSettings(plugin.id)
			.then((r) => {
				if (cancelled) return;
				// 初始值 = 声明 default 优先(未保存时),已保存值覆盖
				const defaults: Record<string, unknown> = {};
				for (const field of items.flatMap((i) => i.fields)) {
					if (field.default !== undefined) defaults[field.key] = field.default;
				}
				setValues({ ...defaults, ...r.values });
			})
			.catch((e) => {
				if (cancelled) return;
				setErr(`设置加载失败: ${friendlyError(e)}`);
			});
		return () => {
			cancelled = true;
		};
	}, [client, plugin.id]);

	async function save() {
		if (busy) return;
		setBusy(true);
		setErr(null);
		try {
			// 只发送已声明字段(后端仍会白名单校验;发全量已渲染字段)
			const allowedKeys = new Set(items.flatMap((i) => i.fields).map((f) => f.key));
			const payload: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(values)) if (allowedKeys.has(k)) payload[k] = v;
			setValues(await client.putPluginSettings(plugin.id, payload));
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
		} catch (e) {
			setErr(`保存失败: ${friendlyError(e)}`);
		} finally {
			setBusy(false);
		}
	}

	function reset() {
		const defaults: Record<string, unknown> = {};
		for (const field of items.flatMap((i) => i.fields)) {
			if (field.default !== undefined) defaults[field.key] = field.default;
		}
		setValues(defaults);
		setErr(null);
	}

	function renderField(field: PluginSettingsFieldDto) {
		const value = values[field.key];
		let control: React.ReactNode;
		switch (field.type) {
			case "boolean":
				control = (
					<ToggleSwitch
						checked={value === true}
						disabled={busy}
						onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
						ariaLabel={field.label}
					/>
				);
				break;
			case "number":
				control = (
					<input
						className="s-input s-input-short"
						type="number"
						value={typeof value === "number" ? value : ""}
						disabled={busy}
						onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value === "" ? "" : Number(e.target.value) }))}
					/>
				);
				break;
			case "select":
				control = (
					<Select
						className="sel-row"
						value={typeof value === "string" ? value : ""}
						disabled={busy}
						onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
						options={field.options ?? []}
					/>
				);
				break;
			case "textarea":
				control = (
					<textarea
						className="s-input"
						rows={3}
						value={typeof value === "string" ? value : ""}
						disabled={busy}
						onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
					/>
				);
				break;
			default:
				control = (
					<input
						className="s-input"
						value={typeof value === "string" ? value : ""}
						disabled={busy}
						onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
					/>
				);
		}
		return (
			<div className="s-field" key={field.key}>
				<label className="s-field-label">{field.label}</label>
				{control}
				{field.desc && <div className="s-field-desc">{field.desc}</div>}
			</div>
		);
	}

	if (items.length === 0) return null;

	return (
		<div className="ps-settings">
			{items.map((item) => (
				<div key={item.title} className="ps-section">
					<div className="ps-section-title">{item.title}</div>
					{item.description && <div className="ps-section-desc">{item.description}</div>}
					{item.fields.map(renderField)}
				</div>
			))}
			<div className="s-field-row" style={{ marginTop: 4 }}>
				<button type="button" className="btn-ghost" disabled={busy} onClick={() => void save()}>
					{busy ? "保存中…" : "保存设置"}
				</button>
				<button type="button" className="btn-ghost" disabled={busy} onClick={reset}>
					重置
				</button>
				{saved && <span className="s-busy ok">已保存</span>}
				{err && <span className="s-busy err">{err}</span>}
			</div>
		</div>
	);
}
