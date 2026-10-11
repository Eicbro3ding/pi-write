import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import type { PluginInfoDto, PluginSettingsFieldDto, PluginWindowDto } from "../types.ts";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { Select } from "./Select.tsx";
import { listEntries, listSlots, registerEntry, unregisterEntry, unregisterOwner, type SlotEntry } from "../slots.ts";
import { SLOT_OVERLAY } from "../shell-slots.ts";
import { bumpSlots } from "./Slot.tsx";

/**
 * 声明式浮窗渲染器(2026-10-11):把插件 `plugin.json` 的
 * `frontend.ui.windows` 渲染成挂在全局层 `.plugin-layer` 里的浮窗。
 *
 * 与设置页卡片同一条哲学:插件只声明数据(标题/位置/尺寸/字段),由这里的受信任
 * 渲染器画 —— renderer 不执行任何用户 JS,所以**非 trusted 插件也能开浮窗**。
 *
 * **浮窗不是另一条渲染路径,而是槽位的一种条目**(2026-10-11 槽位树合并):
 * `syncPluginWindows()` 把每个 window 声明编译成一个纯数据条目注册进目标槽位
 * (`ui.windows` 落 overlay;`ui.slots` 可显式指定槽位),宿主用 `renderWindowEntry()`
 * 当 `renderEntry` 把它画成浮窗。于是「插件界面」与「核心浮层」在同一张表里排队,
 * 由 `order` 定层级,删掉了原先 App.tsx 里那条 `<Slot fallback={<PluginWindows/>}>` 的双轨。
 *
 * 两种内容形态:
 *  - fields:复用设置字段白名单(string/number/boolean/select/textarea)静态渲染;
 *  - data:按 window.dataSource 调 /api/plugins/<id>/<path> 取数,渲染键值表
 *    (仅 trusted 插件的路由可达,路由由插件后端注册)。
 *
 * 位置/关闭状态存 localStorage(按 pluginId:windowId 键),不落服务端 ——
 * 这是纯前端展示偏好,不值得一次网络往返。
 */

/** 浮窗条目的纯数据 payload(与 SlotEntry 的 `render` 字段同形)。 */
export interface WindowEntryPayload {
	kind: "window";
	pluginId: string;
	pluginName: string;
	spec: PluginWindowDto;
}

/** 条目 id 前缀:浮窗在 overlay 槽位里的 id 是这个 + `pluginId:windowId`。 */
const ENTRY_PREFIX = "plugin.window:";

const DEFAULT_POS = { x: 82, y: 78 };

/** 从插件列表抽出可渲染的浮窗声明(enabled 且声明了 windows;trusted 不是前提)。 */
export function collectWindows(plugins: PluginInfoDto[]): WindowEntryPayload[] {
	const out: WindowEntryPayload[] = [];
	for (const p of plugins) {
		if (!p.enabled) continue;
		for (const w of p.frontend?.ui?.windows ?? []) {
			out.push({ kind: "window", pluginId: p.id, pluginName: p.name, spec: w });
		}
	}
	return out;
}

/** 一条「已定位到槽位」的声明式浮窗:哪个槽位 + 浮窗 payload + 排序权重 + 可选分派键。 */
export interface PlacedWindow {
	slot: string;
	order: number;
	/** 目标槽位是 keyed 形态时的分派键。 */
	key?: string;
	payload: WindowEntryPayload;
}

/**
 * 把所有插件的浮窗声明编译成「槽位 + 条目」的列表:
 *  - `ui.windows` 是老出口(2026-10-11 前):一律落 overlay 槽位,order 100;
 *  - `ui.slots` 是新出口(槽位树):插件显式写目标槽位,order 由声明给(缺省 100)。
 * 两条出口对浮窗一视同仁 —— 都是纯数据条目,只是目标槽位不同。
 *
 * `ui.slots` 里未声明槽位的条目会被 `syncPluginSlots()` 抛错挡下(装载期严格)。
 */
export function collectPlacedWindows(plugins: PluginInfoDto[]): PlacedWindow[] {
	const out: PlacedWindow[] = [];
	for (const p of plugins) {
		if (!p.enabled) continue;
		const ui = p.frontend?.ui;
		for (const w of ui?.windows ?? []) {
			out.push({ slot: SLOT_OVERLAY, order: 100, payload: { kind: "window", pluginId: p.id, pluginName: p.name, spec: w } });
		}
		for (const c of ui?.slots ?? []) {
			if (c.kind !== "window") continue;
			out.push({
				slot: c.slot,
				order: c.order ?? 100,
				...(c.key !== undefined ? { key: c.key } : {}),
				payload: { kind: "window", pluginId: p.id, pluginName: p.name, spec: c.window },
			});
		}
	}
	return out;
}

/**
 * 按最新插件列表把浮窗声明同步进各自槽位:先整批摘掉旧浮窗条目(按 owner 前缀粒度),
 * 再按当前列表重新注册。
 *
 * 为什么整批换而不是差量:浮窗声明是**纯数据**且量极小,重建一两个条目比维护
 * 一份 diff 便宜得多;而整批换能天然处理「插件禁用了 / 删了 / 改了 id」所有情形,
 * 不会留孤儿条目。条目 id 带上 pluginId:windowId,重注册后 React key 稳定,
 * 不会白白重挂浮窗、丢拖拽位置。
 *
 * **未声明槽位直接抛错**(声明 = 授权):弹窗声明写错槽位名,装载期就现形,
 * 而不是静默消失。
 */
export function syncPluginWindows(plugins: PluginInfoDto[]): void {
	// 摘掉全部浮窗条目(owner 用统一前缀标记,与核心/插件 JS 的条目区分开)
	for (const e of entriesByWindowOwner()) unregisterEntry(e.slotName, e.id);
	for (const placed of collectPlacedWindows(plugins)) {
		registerEntry(placed.slot, {
			id: `${ENTRY_PREFIX}${placed.payload.pluginId}:${placed.payload.spec.id}`,
			owner: WINDOW_OWNER,
			order: placed.order,
			...(placed.key !== undefined ? { key: placed.key } : {}),
			render: placed.payload,
		});
	}
	bumpSlots();
}

/** 浮窗条目在注册表里的统一 owner —— 便于一次摘干净(与真实插件 id 区分,不冲突)。 */
const WINDOW_OWNER = "__window__";

/**
 * 列出当前所有槽位里的浮窗条目(用于重注册前清场)。
 *
 * 注意:浮窗可能落在任何槽位(见 `ui.slots`),所以不能只看 overlay ——
 * 得扫全表。条目带 `slotName` 是为了摘的时候知道摘哪个槽位的。
 */
function entriesByWindowOwner(): Array<SlotEntry & { slotName: string }> {
	const out: Array<SlotEntry & { slotName: string }> = [];
	for (const s of listSlots()) {
		for (const e of listEntries(s.name)) {
			if (e.owner === WINDOW_OWNER) out.push({ ...e, slotName: s.name });
		}
	}
	return out;
}

/**
 * 宿主渲染器:把浮窗条目画成 `PluginWindow`。给 `<Slot renderEntry>` 用。
 * 不认识的条目返回 `undefined`,由 Slot 退回默认窄化(不会吞掉别人)。
 */
export function renderWindowEntry(entry: SlotEntry): React.ReactNode | undefined {
	const payload = entry.render as WindowEntryPayload | undefined;
	if (!payload || payload.kind !== "window") return undefined;
	return (
		<PluginWindow
			pluginId={payload.pluginId}
			pluginName={payload.pluginName}
			spec={payload.spec}
		/>
	);
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
 * 插件浮窗对账钩子:拉插件列表(30s 对账),把声明同步进 overlay 槽位。
 *
 * 返回的 `layerRef` 给浮窗定位用(相对定位容器)—— 但它的**归属已改**:容器
 * 现在由 overlay 槽位所在的宿主节点(`.plugin-layer`)持有,浮窗通过 context 拿到,
 * 不再是「App 建 ref 传给 PluginWindows」那条会脱钩的传参链。
 */
export function usePluginWindows(client: ApiClient, active: boolean): void {
	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const sync = () => {
			client
				.getPlugins()
				.then((list) => {
					if (!cancelled) syncPluginWindows(list);
				})
				.catch(() => {
					/* 拉取失败:保留上一次的窗口,下次再对账 */
				});
		};
		sync();
		const timer = setInterval(sync, 30_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
			// 卸载时摘掉浮窗条目:slot 表是模块级单例,不清会留到下次挂载
			unregisterOwner(WINDOW_OWNER);
			bumpSlots();
		};
	}, [client, active]);
}

/** 单个浮窗:标题栏(可拖拽)+ 内容(fields 或 data)+ 关闭按钮。 */
function PluginWindow({ pluginId, pluginName, spec }: { pluginId: string; pluginName: string; spec: PluginWindowDto }) {
	const [local, setLocal] = useState<WindowLocalState>(() => readLocalState(pluginId, spec.id));
	const [open, setOpen] = useState(() => !readLocalState(pluginId, spec.id).closed);
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
			// 定位基准取宿主挂的全局层;它挂在浮窗的父节点上,拿不到时退到窗口自身尺寸的
			// viewport(getBoundingClientRect 的相对原点仍是视口,行为一致)——不再静默不动。
			const layer = box.parentElement;
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
	}, [dragging, pluginId, spec.id]);

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
				<span className="pw-title">{spec.title}</span>
				<span className="pw-from">{pluginName}</span>
				{spec.closable !== false && (
					<button type="button" className="pw-close" onClick={close} aria-label={`关闭 ${spec.title}`}>
						×
					</button>
				)}
			</div>
			<div className="pw-body">{spec.contentKind === "data" ? <WindowData pluginId={pluginId} spec={spec} /> : <WindowFields spec={spec} />}</div>
		</div>
	);
}

/** fields 形态:静态字段渲染(与设置页同一套控件,只读展示 + 可交互控件)。 */
function WindowFields({ spec }: { spec: PluginWindowDto }) {
	const [values, setValues] = useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = {};
		for (const f of spec.fields) if (f.default !== undefined) init[f.key] = f.default;
		return init;
	});
	return (
		<div className="pw-fields">
			{spec.fields.map((f) => (
				<div className="pw-field" key={f.key}>
					<span className="pw-field-label">{f.label}</span>
					{renderInlineField(f, values[f.key], (v) => setValues((prev) => ({ ...prev, [f.key]: v })))}
				</div>
			))}
		</div>
	);
}

/** data 形态:按 dataSource 取数,渲染键值表。 */
function WindowData({ pluginId, spec }: { pluginId: string; spec: PluginWindowDto }) {
	const [rows, setRows] = useState<Array<{ label: string; value: string }> | null>(null);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		if (!spec.dataSource) return;
		let cancelled = false;
		const load = () => {
			fetch(`/api/plugins/${encodeURIComponent(pluginId)}/${spec.dataSource}`, { headers: { accept: "application/json" } })
				.then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return (await res.json()) as unknown;
				})
				.then((body) => {
					if (!cancelled) {
						setRows(normalizeRows(body));
						setErr(null);
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
	}, [pluginId, spec.dataSource]);

	if (err) return <div className="pw-err">读取失败: {err}</div>;
	if (!rows) return <div className="pw-loading">读取中…</div>;
	if (rows.length === 0) return <div className="pw-loading">暂无数据</div>;
	return (
		<div className="pw-rows">
			{rows.map((r, i) => (
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
