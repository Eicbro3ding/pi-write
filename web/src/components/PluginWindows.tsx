import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { PLUGINS_CHANGED_EVENT } from "../plugin-events.ts";
import type { PluginInfoDto, PluginSettingsFieldDto, PluginWindowDto } from "../types.ts";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { Select } from "./Select.tsx";

/**
 * 声明式浮窗渲染器:把插件 `plugin.json` 的
 * `frontend.ui.windows` 渲染成挂在全局层 `.plugin-layer` 里的浮窗。
 *
 * 与设置页卡片同一条哲学:插件只声明数据(标题/位置/尺寸/字段),由这里的受信任
 * 渲染器画 —— renderer 不执行任何用户 JS,所以**非 trusted 插件也能开浮窗**。
 *
 * 三种内容形态:
 *  - fields:复用设置字段白名单(string/number/boolean/select/textarea);
 *    值**存进 settings.json**(与设置页同一份,保存按钮显式提交);
 *  - data + layout:"cards":按 `dataSource` 取数,渲染卡片组(大号数值 + 状态色),
 *    适合余额/统计这类数字面板;
 *  - data + 缺省 layout:"rows":紧凑键值表,适合多行明细。
 * data 形态只有 trusted 插件的路由可达(路由由插件后端注册)。
 *
 * 位置/关闭状态存 localStorage(按 pluginId:windowId 键),不落服务端 ——
 * 这是纯前端展示偏好,不值得一次网络往返。
 */

interface RenderableWindow {
	pluginId: string;
	pluginName: string;
	spec: PluginWindowDto;
}

const DEFAULT_POS = { x: 82, y: 78 };

/** 从插件列表抽出可渲染的浮窗(enabled 且声明了 windows;trusted 不是前提)。 */
export function collectWindows(plugins: PluginInfoDto[]): RenderableWindow[] {
	const out: RenderableWindow[] = [];
	for (const p of plugins) {
		if (!p.enabled) continue;
		for (const w of p.frontend?.ui?.windows ?? []) {
			out.push({ pluginId: p.id, pluginName: p.name, spec: w });
		}
	}
	return out;
}

/** 位置/关闭状态的 localStorage 键。 */
function stateKey(pluginId: string, windowId: string): string {
	return `piw-plugin-window:${pluginId}:${windowId}`;
}

interface WindowLocalState {
	x?: number;
	y?: number;
	closed?: boolean;
}

function readLocalState(pluginId: string, windowId: string): WindowLocalState {
	try {
		const raw = localStorage.getItem(stateKey(pluginId, windowId));
		if (!raw) return {};
		const parsed = JSON.parse(raw) as WindowLocalState;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function writeLocalState(pluginId: string, windowId: string, patch: WindowLocalState): void {
	try {
		const prev = readLocalState(pluginId, windowId);
		localStorage.setItem(stateKey(pluginId, windowId), JSON.stringify({ ...prev, ...patch }));
	} catch {
		/* localStorage 不可用(隐私模式):位置记不住而已,不影响使用 */
	}
}

/**
 * 插件浮窗状态钩子:拉插件列表(30s 对账),返回可渲染窗与全局层 ref。
 * layerRef 给浮窗定位用(相对定位容器);宿主把 .plugin-layer 挂上这个 ref。
 */
export function usePluginWindows(client: ApiClient, active: boolean) {
	const [plugins, setPlugins] = useState<PluginInfoDto[]>([]);
	const layerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const sync = () => {
			client
				.getPlugins()
				.then((list) => {
					if (!cancelled) setPlugins(list);
				})
				.catch(() => {
					/* 拉取失败:保留上一次的窗口,下次再对账 */
				});
		};
		sync();
		const timer = setInterval(sync, 30_000);
		// 安装 / 启停 / 信任变更后立刻对账:装完不必等下一轮 30 秒才看见浮窗
		window.addEventListener(PLUGINS_CHANGED_EVENT, sync);
		return () => {
			cancelled = true;
			clearInterval(timer);
			window.removeEventListener(PLUGINS_CHANGED_EVENT, sync);
		};
	}, [client, active]);
	return { windows: collectWindows(plugins), layerRef };
}

/** 浮窗容器:遍历可渲染窗,逐个渲染 PluginWindow(各自持有位置/关闭状态)。 */
export function PluginWindows({
	plugins,
	layerRef,
	client,
}: {
	plugins: RenderableWindow[];
	layerRef: React.RefObject<HTMLDivElement | null>;
	client: ApiClient;
}) {
	return (
		<>
			{plugins.map((w) => (
				<PluginWindow
					key={`${w.pluginId}:${w.spec.id}`}
					pluginId={w.pluginId}
					pluginName={w.pluginName}
					spec={w.spec}
					layerRef={layerRef}
					client={client}
				/>
			))}
		</>
	);
}

/** 单个浮窗:标题栏(可拖拽)+ 内容(fields / data)+ 刷新 / 关闭按钮。 */
function PluginWindow({
	pluginId,
	pluginName,
	spec,
	layerRef,
	client,
}: {
	pluginId: string;
	pluginName: string;
	spec: PluginWindowDto;
	layerRef: React.RefObject<HTMLDivElement | null>;
	client: ApiClient;
}) {
	const [local, setLocal] = useState<WindowLocalState>(() => readLocalState(pluginId, spec.id));
	const [open, setOpen] = useState(() => !readLocalState(pluginId, spec.id).closed);
	/** 手动刷新计数:data 形态的取数 effect 依赖它,点一次重新拉一次。 */
	const [refreshTick, setRefreshTick] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	// 拖拽期间的最新位置放 ref,不动 state —— 移动一步就 setState 会让 React 重渲染,
	// 而「位移换算」其实只需要读写 DOM,不需要参与渲染,节流全靠浏览器合成。
	const posRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);

	// x/y 落位:改成直接写内联样式(left/top 百分比),不与 React 渲染抢
	useEffect(() => {
		const box = ref.current;
		if (!box || !open) return;
		const x = local.x ?? spec.position?.x ?? DEFAULT_POS.x;
		const y = local.y ?? spec.position?.y ?? DEFAULT_POS.y;
		box.style.left = `${x}%`;
		box.style.top = `${y}%`;
		posRef.current = { x, y };
	}, [local.x, local.y, open, spec.id, spec.position?.x, spec.position?.y]);

	// 拖拽:pointermove 期间把鼠标位移换算成视口百分比,指到哪算哪
	useEffect(() => {
		if (!dragging) return;
		const onMove = (e: PointerEvent) => {
			const box = ref.current;
			if (!box) return;
			// 定位基准取宿主挂的全局层;ref 万一没接上,退到窗口自身尺寸的 viewport
			// (getBoundingClientRect 的相对原点仍是视口,行为一致)——不再静默不动。
			const layer = layerRef.current;
			const rect = layer ? layer.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
			// 以窗口左上角为准,钳制在视口内(留 8px 边距)
			const w = box.offsetWidth;
			const h = box.offsetHeight;
			const left = Math.min(Math.max(0, e.clientX - dragOffset.current.px), Math.max(0, rect.width - w - 8));
			const top = Math.min(Math.max(0, e.clientY - dragOffset.current.py), Math.max(0, rect.height - h - 8));
			const x = rect.width > 0 ? (left / rect.width) * 100 : 0;
			const y = rect.height > 0 ? (top / rect.height) * 100 : 0;
			posRef.current = { x, y };
			box.style.left = `${x}%`;
			box.style.top = `${y}%`;
		};
		const onUp = () => {
			setDragging(false);
			// 拖拽结束才落盘,避免拖动过程中频繁写 localStorage
			setLocal(posRef.current);
			writeLocalState(pluginId, spec.id, posRef.current);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [dragging, layerRef, pluginId, spec.id]);

	// 按下点相对窗口左上角的偏移(视口坐标),拖拽期间不变
	const dragOffset = useRef({ px: 0, py: 0 });

	function startDrag(e: React.PointerEvent) {
		if (e.button !== 0) return;
		const box = ref.current;
		if (!box) return;
		const rect = box.getBoundingClientRect();
		dragOffset.current = { px: e.clientX - rect.left, py: e.clientY - rect.top };
		// 指针捕获:指针移出标题栏/窗口仍持续收到事件(拖出手感更顺)
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* 某些环境不支持捕获:退回 window 监听,行为一致 */
		}
		setDragging(true);
	}

	function close() {
		setOpen(false);
		writeLocalState(pluginId, spec.id, { closed: true });
	}

	function reopen() {
		setOpen(true);
		writeLocalState(pluginId, spec.id, { closed: false });
	}

	// 关闭态:只在左下角留一个小胶囊(能重新打开),不占地方
	if (!open && spec.closable !== false) {
		return (
			<button type="button" className="pw-chip" onClick={reopen} title={`打开 ${pluginName} · ${spec.title}`}>
				{spec.title}
			</button>
		);
	}

	return (
		<div
			ref={ref}
			className="pw"
			style={{
				...(spec.size?.width ? { width: spec.size.width } : {}),
				...(spec.size?.height ? { maxHeight: spec.size.height } : {}),
			}}
		>
			<div className="pw-bar" onPointerDown={startDrag}>
				<span className="pw-titles">
					<span className="pw-title">{spec.title}</span>
					{spec.subtitle && <span className="pw-subtitle">{spec.subtitle}</span>}
				</span>
				<span className="pw-from">{pluginName}</span>
				{spec.contentKind === "data" && (
					<button
						type="button"
						className="pw-refresh"
						onPointerDown={(e) => e.stopPropagation()}
						onClick={() => setRefreshTick((t) => t + 1)}
						title="刷新"
						aria-label={`刷新 ${spec.title}`}
					>
						↻
					</button>
				)}
				{spec.closable !== false && (
					<button
						type="button"
						className="pw-close"
						onPointerDown={(e) => e.stopPropagation()}
						onClick={close}
						aria-label={`关闭 ${spec.title}`}
					>
						×
					</button>
				)}
			</div>
			<div className="pw-body">
				{spec.contentKind === "data" ? (
					<>
						<WindowData pluginId={pluginId} spec={spec} tick={refreshTick} />
						{/* data 窗口也可以带字段:收在卡片下方的抽屉里,保存后立刻重新取数。
						    否则「看数」与「调阈值」要拆成两个浮窗,平白多占一块屏幕。 */}
						{spec.fields.length > 0 && (
							<details className="pw-drawer">
								<summary>{spec.settingsLabel ?? "设置"}</summary>
								<WindowFields
									pluginId={pluginId}
									spec={spec}
									client={client}
									onSaved={() => setRefreshTick((t) => t + 1)}
								/>
							</details>
						)}
					</>
				) : (
					<WindowFields pluginId={pluginId} spec={spec} client={client} />
				)}
			</div>
		</div>
	);
}

/**
 * fields 形态:字段渲染 + 读写 settings.json。
 *
 * 值不再只活在 React state 里(此前关窗即丢),与设置页共用同一份文件;
 * 提交是显式的「保存」,不自动写盘 —— 免得拖一个数字滑块就打一次 API。
 */
function WindowFields({
	pluginId,
	spec,
	client,
	onSaved,
}: {
	pluginId: string;
	spec: PluginWindowDto;
	client: ApiClient;
	/** 保存成功后回调(data 窗口用它立即重新取数,阈值改了卡片马上变色)。 */
	onSaved?: () => void;
}) {
	const defaults = useMemo(() => {
		const init: Record<string, unknown> = {};
		for (const f of spec.fields) if (f.default !== undefined) init[f.key] = f.default;
		return init;
	}, [spec.fields]);
	const [values, setValues] = useState<Record<string, unknown>>(defaults);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

	useEffect(() => {
		let cancelled = false;
		client
			.getPluginSettings(pluginId)
			.then((r) => {
				if (cancelled) return;
				// 只取本窗口声明的键,别把设置页的字段也塞进来
				const picked: Record<string, unknown> = {};
				for (const f of spec.fields) if (f.key in r.values) picked[f.key] = r.values[f.key];
				setValues({ ...defaults, ...picked });
			})
			.catch(() => {
				/* 读失败:先用声明默认值,保存时会报错 */
			});
		return () => {
			cancelled = true;
		};
		// 依赖里刻意不放 spec.fields / defaults:浮窗列表 30 秒对账一次,
		// 字段数组每次都是新引用;跟着重跑会把用户**正在编辑、还没保存**的值冲回旧值。
		// 字段列表只在插件升级时变化,那种情况刷新页面即可。
	}, [client, pluginId]);

	async function save() {
		if (busy) return;
		setBusy(true);
		setMsg(null);
		try {
			const payload: Record<string, unknown> = {};
			for (const f of spec.fields) if (f.key in values) payload[f.key] = values[f.key];
			const saved = await client.putPluginSettings(pluginId, payload);
			const picked: Record<string, unknown> = {};
			for (const f of spec.fields) if (f.key in saved) picked[f.key] = saved[f.key];
			setValues((prev) => ({ ...prev, ...picked }));
			setMsg({ ok: true, text: "已保存" });
			setTimeout(() => setMsg(null), 2500);
			onSaved?.();
		} catch (e) {
			setMsg({ ok: false, text: friendlyError(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<div className="pw-fields">
				{spec.fields.map((f) => (
					<div className="pw-field" key={f.key}>
						<span className="pw-field-label" title={f.desc}>
							{f.label}
						</span>
						{renderInlineField(f, values[f.key], (v) => setValues((prev) => ({ ...prev, [f.key]: v })))}
					</div>
				))}
			</div>
			<div className="pw-fields-actions">
				<button type="button" className="btn-ghost" disabled={busy} onClick={() => void save()}>
					{busy ? "保存中…" : "保存"}
				</button>
				{msg && <span className={msg.ok ? "pw-msg ok" : "pw-msg err"}>{msg.text}</span>}
			</div>
		</>
	);
}

/** data 取数结果的两种视图。 */
export type PluginDataView =
	| { kind: "cards"; cards: Array<{ label: string; value: string; hint?: string; tone?: "ok" | "warn" | "err" }> }
	| { kind: "rows"; rows: Array<{ label: string; value: string }> };

/** 卡片状态色白名单(插件只能声明这三种;其他值忽略)。 */
const TONES = new Set(["ok", "warn", "err"]);

/**
 * data 形态的结果归一化:
 *  - layout:"cards" 且返回体含 `cards` 数组 → 卡片组;
 *  - 其余(含 cards 缺省/空)→ 键值表(不猜结构,见 normalizeRows)。
 * 导出即为了单测(纯函数,无 DOM 依赖)。
 */
export function normalizeData(body: unknown, layout?: "rows" | "cards"): PluginDataView {
	if (layout === "cards" && typeof body === "object" && body !== null && !Array.isArray(body)) {
		const raw = (body as Record<string, unknown>).cards;
		if (Array.isArray(raw)) {
			const cards = raw
				.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && !Array.isArray(c))
				.map((c) => {
					const tone = typeof c.tone === "string" && TONES.has(c.tone) ? (c.tone as "ok" | "warn" | "err") : undefined;
					return {
						label: String(c.label ?? ""),
						value: formatValue(c.value),
						...(typeof c.hint === "string" && c.hint.length > 0 ? { hint: c.hint } : {}),
						...(tone ? { tone } : {}),
					};
				});
			if (cards.length > 0) return { kind: "cards", cards };
		}
	}
	return { kind: "rows", rows: normalizeRows(body) };
}

/** data 形态:按 dataSource 取数,渲染卡片组或键值表。 */
function WindowData({ pluginId, spec, tick }: { pluginId: string; spec: PluginWindowDto; tick: number }) {
	const [view, setView] = useState<PluginDataView | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [at, setAt] = useState<number | null>(null);

	useEffect(() => {
		if (!spec.dataSource) return;
		let cancelled = false;
		const load = () => {
			fetch(`/api/plugins/${encodeURIComponent(pluginId)}/${spec.dataSource}`, { headers: { accept: "application/json" } })
				.then(async (res) => {
					if (!res.ok) throw new Error(res.status === 404 ? "HTTP 404(未开启完全信任时,取数路由不可用)" : `HTTP ${res.status}`);
					return (await res.json()) as unknown;
				})
				.then((body) => {
					if (!cancelled) {
						setView(normalizeData(body, spec.layout));
						setErr(null);
						setAt(Date.now());
					}
				})
				.catch((e) => {
					if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
				});
		};
		load();
		const timer = setInterval(load, 30_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [pluginId, spec.dataSource, spec.layout, tick]);

	if (err) return <div className="pw-err">读取失败: {err}</div>;
	if (!view) return <div className="pw-loading">读取中…</div>;
	if (view.kind === "cards") {
		return (
			<>
				<div className="pw-cards">
					{view.cards.map((c, i) => (
						<div className={`pw-card${c.tone ? ` tone-${c.tone}` : ""}`} key={`${c.label}-${i}`}>
							<span className="pw-card-label">{c.label}</span>
							<span className="pw-card-value">{c.value}</span>
							{c.hint && <span className="pw-card-hint">{c.hint}</span>}
						</div>
					))}
				</div>
				{at !== null && <div className="pw-stamp">更新于 {new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}</div>}
			</>
		);
	}
	if (view.rows.length === 0) return <div className="pw-loading">暂无数据</div>;
	return (
		<div className="pw-rows">
			{view.rows.map((r, i) => (
				<div className="pw-row" key={`${r.label}-${i}`}>
					<span className="pw-row-label">{r.label}</span>
					<span className="pw-row-value">{r.value}</span>
				</div>
			))}
		</div>
	);
}

/**
 * 把插件路由返回体归一成 [{label,value}]:
 *  - { rows: [{label,value}] } → 直接用;
 *  - 平铺对象 { 余额: "¥12.30", 状态: "正常" } → 逐键成行;
 *  - 其他(数组/标量/嵌套)→ JSON 字符串化兜底,不猜。
 * 导出即为了单测(纯函数,无 DOM 依赖)。
 */
export function normalizeRows(body: unknown): Array<{ label: string; value: string }> {
	if (typeof body === "object" && body !== null && !Array.isArray(body)) {
		const rec = body as Record<string, unknown>;
		if (Array.isArray(rec.rows)) {
			return rec.rows
				.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
				.map((r) => ({ label: String(r.label ?? ""), value: formatValue(r.value) }));
		}
		return Object.entries(rec).map(([k, v]) => ({ label: k, value: formatValue(v) }));
	}
	return [{ label: "", value: formatValue(body) }];
}

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return "—";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return JSON.stringify(v);
}

/** 浮窗内的紧凑字段控件(与 PluginSettings.renderField 同款,尺寸收紧)。 */
function renderInlineField(field: PluginSettingsFieldDto, value: unknown, onChange: (v: unknown) => void) {
	switch (field.type) {
		case "boolean":
			return <ToggleSwitch checked={value === true} onChange={onChange} ariaLabel={field.label} />;
		case "select":
			return (
				<Select
					className="sel-row"
					value={typeof value === "string" ? value : ""}
					onChange={onChange}
					options={field.options ?? []}
				/>
			);
		case "number":
			return (
				<input
					className="s-input s-input-short"
					type="number"
					value={typeof value === "number" ? value : ""}
					onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
				/>
			);
		case "textarea":
			return (
				<textarea
					className="s-input"
					rows={2}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
		default:
			return <input className="s-input" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
	}
}
