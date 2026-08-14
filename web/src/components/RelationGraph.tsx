import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
// cytoscape-cola 无类型声明,由 web/src/cytoscape-cola.d.ts 补充;
// 导出 register 函数,经全局 cytoscape.use() 注册(cola 布局名全局可用)
import cola from "cytoscape-cola";
import type { RelationArrowDto, WorldEntryDto, WorldRelationDto } from "../types.ts";
import { ENTRY_TYPES, ENTRY_TYPE_LABELS } from "./WorldTree.tsx";
import { newId } from "./id.ts";
import { disconnectEntry, genAvatarDataUrl } from "../graph-logic.ts";
import { imageUrl } from "../api/client.ts";
import { buildGraphStyles, themeVar, TYPE_FALLBACKS, TYPE_TOKENS } from "../graph-styles.ts";
import { loadPositions, loadViewport, savePositions, saveViewport } from "../graph-persistence.ts";

cytoscape.use(cola);

/**
 * 关系图(cytoscape 封装):节点 = 条目(按 type 配色,孤立节点也显示),
 * 边 = 关系(label || type,emphasized 强调色粗线)。交互:
 * - 单击节点 → onSelect(父组件联动词条面板);滚轮缩放;拖拽节点调整布局
 * - 节点位置存 localStorage(key 含书 slug,视图状态不入 world.json)
 * - 「连线」模式:选起始节点 → 点目标节点 → 弹关系表单(追加)
 * - 右键边 → 编辑/删除
 * 数据变更由父组件置脏后整体走 putWorld(与服务端 relations 校验对齐)。
 */

/** 节点展示标题:超长截断防巨节点(完整标题在词条面板可见)。 */
function nodeLabel(title: string): string {
	const t = title.trim() || "未命名";
	return t.length > 14 ? `${t.slice(0, 14)}…` : t;
}

interface RelationGraphProps {
	entries: WorldEntryDto[];
	relations: WorldRelationDto[];
	/** 书 slug:节点位置 localStorage 键隔离。 */
	slug: string;
	/** 父组件联动选中(词条面板跳转/列表选择);图上已选或不存在则不动。 */
	focusId: string | null;
	/** 单击节点。 */
	onSelect: (id: string) => void;
	/** 关系增删改(整体替换,父组件置脏并走 putWorld)。 */
	onUpdateRelations: (next: WorldRelationDto[]) => void;
	/** 节点右键快捷编辑:更新条目字段(重命名/正文)。 */
	onUpdateEntry?: (next: WorldEntryDto) => void;
	/** 节点右键快捷删除条目(父组件负责级联清理)。 */
	onDeleteEntry?: (id: string) => void;
	/** 撤销可用与触发(父组件持有撤销栈)。 */
	canUndo?: boolean;
	onUndo?: () => void;
}

type CtxMenu =
	| { x: number; y: number; kind: "edge"; relId: string }
	| { x: number; y: number; kind: "node"; entryId: string };

type RelFormState =
	| { mode: "create"; from: string; to: string }
	| { mode: "edit"; rel: WorldRelationDto };

/** 关系创建/编辑表单(模态覆盖层):type 自由文本 + label + emphasized 开关。 */
function RelationForm({
	state,
	entries,
	relations,
	onCancel,
	onSave,
}: {
	state: RelFormState;
	entries: WorldEntryDto[];
	relations: WorldRelationDto[];
	onCancel: () => void;
	onSave: (next: WorldRelationDto[]) => void;
}) {
	const titleOf = (id: string) => entries.find((e) => e.id === id)?.title || "未命名";
	const isCreate = state.mode === "create";
	const [type, setType] = useState(isCreate ? "" : state.rel.type);
	const [label, setLabel] = useState(isCreate ? "" : state.rel.label);
	const [emphasized, setEmphasized] = useState(isCreate ? false : state.rel.emphasized);
	const [arrow, setArrow] = useState<RelationArrowDto>(isCreate ? "double" : state.rel.arrow);
	/** 常用关系类型(供 datalist 快速选择)+ 已有类型合并去重排序。 */
	const COMMON_REL_TYPES = ["家人", "师徒", "盟友", "敌对", "恋人", "旧识", "同事", "仇敌", "主仆", "师生"];
	const knownTypes = useMemo(
		() =>
			Array.from(new Set([...COMMON_REL_TYPES, ...relations.map((r) => r.type)])).sort((a, b) =>
				a.localeCompare(b, "zh"),
			),
		[relations],
	);
	const canSave = type.trim() !== "" || label.trim() !== "";
	// 重复防护:两节点间已存在关系(任一方向)则阻止创建,与服务端「from/to 存在 + 非自环」校验互补
	const duplicate =
		isCreate &&
		relations.some(
			(r) =>
				(r.from === state.from && r.to === state.to) || (r.from === state.to && r.to === state.from),
		);

	return (
		<div
			className="graph-modal-mask"
			// cytoscape 在容器 mousedown 时 preventDefault + blurActiveDomElement,
			// modal 内的 input/checkbox 因此无法聚焦输入;阻断冒泡隔离事件。
			onMouseDown={(e) => e.stopPropagation()}
			onTouchStart={(e) => e.stopPropagation()}
		>
			<form
				className="rel-form"
				onSubmit={(e) => {
					e.preventDefault();
					if (!canSave || duplicate) return;
					const rel: WorldRelationDto = {
						id: isCreate ? newId("rel") : state.rel.id,
						from: isCreate ? state.from : state.rel.from,
						to: isCreate ? state.to : state.rel.to,
						type: type.trim(),
						label: label.trim(),
						emphasized,
						arrow,
					};
					onSave(isCreate ? [...relations, rel] : relations.map((r) => (r.id === rel.id ? rel : r)));
				}}
			>
				<div className="rel-form-head">
					<span>{isCreate ? "新建关系" : "编辑关系"}</span>
					<button type="button" className="rel-form-close" onClick={onCancel} title="关闭">
						✕
					</button>
				</div>
				<div className="rel-form-ends">
					<span className="rel-end" title={titleOf(isCreate ? state.from : state.rel.from)}>
						{titleOf(isCreate ? state.from : state.rel.from)}
					</span>
					<span className="rel-arrow">→</span>
					<span className="rel-end" title={titleOf(isCreate ? state.to : state.rel.to)}>
						{titleOf(isCreate ? state.to : state.rel.to)}
					</span>
				</div>
				<label className="rel-field">
					<span>关系类型(可手动输入任意内容)</span>
					<input
						type="text"
						value={type}
						onChange={(e) => setType(e.target.value)}
						placeholder="如: 盟友 / 师徒 / 敌对"
					/>
					{knownTypes.length > 0 && (
						<div className="rel-type-chips">
							{knownTypes.map((t) => (
								<button
									key={t}
									type="button"
									className={type === t ? "on" : ""}
									onClick={() => setType(t)}
								>
									{t}
								</button>
							))}
						</div>
					)}
				</label>
				<label className="rel-field">
					<span>备注(可选)</span>
					<input
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="边上的说明,如: 姐弟 / 瞒着对方"
					/>
				</label>
				<div className="rel-field">
					<span>箭头方向</span>
					<div className="rel-arrow-opts">
						{(["none", "single", "double"] as const).map((a) => (
							<button
								key={a}
								type="button"
								className={arrow === a ? "on" : ""}
								onClick={() => setArrow(a)}
								title={a === "none" ? "无箭头" : a === "single" ? "单向(from → to)" : "双向"}
							>
								{a === "none" ? "无箭头" : a === "single" ? "单向" : "双向"}
							</button>
						))}
					</div>
				</div>
				<label className="rel-switch">
					<input type="checkbox" checked={emphasized} onChange={(e) => setEmphasized(e.target.checked)} />
					<span>强调关系(粗线高亮)</span>
				</label>
				{duplicate && (
					<div className="rel-form-dup">
						已存在「{titleOf(state.from)} — {titleOf(state.to)}」关系,请勿重复创建
					</div>
				)}
				<div className="rel-form-actions">
					<button type="button" className="btn-ghost" onClick={onCancel}>
						取消
					</button>
					<button type="submit" className="rel-submit" disabled={!canSave || duplicate}>
						{isCreate ? "创建" : "保存"}
					</button>
				</div>
			</form>
		</div>
	);
}

export function RelationGraph({
	entries,
	relations,
	slug,
	focusId,
	onSelect,
	onUpdateRelations,
	onUpdateEntry,
	onDeleteEntry,
	canUndo,
	onUndo,
}: RelationGraphProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const cyRef = useRef<Core | null>(null);
	/** 缩放百分比(工具栏横条显示;zoom 事件同步)。 */
	const [zoomPct, setZoomPct] = useState(100);
	/** 图重建计数:驱动 focus 联动在重建后重新选中。 */
	const [epoch, setEpoch] = useState(0);
	/** 按 type 过滤开关;默认人物 + 世界(地点/设定)。 */
	const [typesOn, setTypesOn] = useState<Record<WorldEntryDto["type"], boolean>>(() => ({
		character: true,
		world: true,
		timeline: false,
		outline: false,
	}));
	const [linking, setLinking] = useState(false);
	const [linkFrom, setLinkFrom] = useState<string | null>(null);
	const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
	const [relForm, setRelForm] = useState<RelFormState | null>(null);
	/** 节点右键"重命名"弹层:待重命名的条目。 */
	const [renameTarget, setRenameTarget] = useState<WorldEntryDto | null>(null);

	// 回调/连线状态经 ref 传递:事件处理器读最新值,图重建 effect 依赖保持稳定
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const onUpdateRef = useRef(onUpdateRelations);
	onUpdateRef.current = onUpdateRelations;
	const onUpdateEntryRef = useRef(onUpdateEntry);
	onUpdateEntryRef.current = onUpdateEntry;
	const onDeleteEntryRef = useRef(onDeleteEntry);
	onDeleteEntryRef.current = onDeleteEntry;
	const linkingRef = useRef(linking);
	linkingRef.current = linking;
	const linkFromRef = useRef(linkFrom);
	linkFromRef.current = linkFrom;

	/** 图结构签名:仅条目增删/类型、关系增删改时重建图
	 * (标题/正文/keys 等文本编辑不重建;标题与激活经下方 effect 增量同步)。 */
	const graphSignature = useMemo(
		() =>
			JSON.stringify([
				entries.map((e) => [e.id, e.type]),
				relations.map((r) => [r.id, r.from, r.to, r.type, r.label, r.emphasized, r.arrow]),
			]),
		[entries, relations],
	);

	// 图初始化/重建(数据、slug 变化时;类型过滤不在此处理——见下方 show()/hide() effect)
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// 全量建图(不过滤):类型过滤经下方 show()/hide() effect 增量切换,不在构建期
		// 过滤——否则每次过滤切换都销毁重建整个实例(丢连线起点/右键菜单态 + 重跑
		// 布局/补位,P7,2026-08)
		const visible = entries;
		const visIds = new Set(visible.map((e) => e.id));
		const visRels = relations.filter((r) => visIds.has(r.from) && visIds.has(r.to));

		const stored = loadPositions(slug);
		const missing = stored ? visible.filter((e) => !stored[e.id]) : visible;
		// 至少一个节点有存档位置才走 preset 恢复;全为新节点则整图 cose(fit)
		const hasStored = missing.length < visible.length;

		const nodeElements: ElementDefinition[] = visible.map((e) => ({
					data: {
						id: e.id,
						label: nodeLabel(e.title),
						type: e.type,
						active: e.active,
						typeColor: themeVar(TYPE_TOKENS[e.type], TYPE_FALLBACKS[e.type]),
						// 主图优先;无图回退"白底+首字"文字头像(标题变化在增量 effect 同步)
						backgroundImage: e.avatar ? imageUrl(slug, e.avatar) : genAvatarDataUrl(e.title, themeVar(TYPE_TOKENS[e.type], TYPE_FALLBACKS[e.type])),
					},
					// preset 读取元素定义的顶层 position;放在 data 内会被 Cytoscape 忽略
					...(hasStored && stored?.[e.id] ? { position: stored[e.id] } : {}),
			}));
		const edgeElements: ElementDefinition[] = visRels.map((r) => ({
			data: {
				id: r.id,
				source: r.from,
				target: r.to,
				label: r.label || r.type || "关系",
				emphasized: r.emphasized,
				arrow: r.arrow ?? "double",
			},
		}));

		const cy = cytoscape({
			container,
			elements: hasStored ? nodeElements : [...nodeElements, ...edgeElements],
			style: buildGraphStyles(),
			// 有存档位置 → preset 恢复(缺失节点在下方补 cose);否则 cose 布局
			layout: hasStored ? { name: "preset", fit: true, animate: false } : { name: "cose", animate: false },
			// 原生滚轮缩放关闭(wheelSensitivity: 0 → diff 恒 0,zoom 不变):自定义滚轮
			// 处理接管「智能步长」;cytoscape 无 wheelEnabled 选项,不能靠它关原生
			wheelSensitivity: 0,
			minZoom: 0.15,
			maxZoom: 3,
		} as cytoscape.CytoscapeOptions);
		// cola 已在模块级经 cytoscape.use() 全局注册(见文件顶部)
		cyRef.current = cy;

		// 恢复按书持久化的视口(缩放/平移),保持编辑关系前后视野一致(仅 preset 场景)
			const vp = loadViewport(slug);
			if (vp && hasStored) {
				cy.zoom(vp.zoom);
				cy.pan(vp.pan);
			}

			// 旧版本可能保存了把节点/关系线推到画布外的 viewport。位置本身
			// 没坏,但恢复后用户只能看到部分节点;检测渲染包围盒越界并自动 fit,
			// 再把修正后的视口落盘,避免每次离开再回来重复越界。
			if (vp && hasStored && cy.nodes().length > 0) {
				const box = cy.nodes().renderedBoundingBox();
				const margin = 24;
				const outOfView =
					box.x1 < margin || box.y1 < margin || box.x2 > cy.width() - margin || box.y2 > cy.height() - margin;
				if (outOfView) {
					cy.fit(cy.nodes(), 40);
					saveViewport(slug, cy.zoom(), cy.pan());
				}
			}

			// 新节点(无存档位置)在已有节点包围盒右侧按网格展开,不动已有节点;
		// 同时自愈存量脏数据:历史版本把补位后的位置漏存,新节点被持久化为 (0,0)
		// 原点,preset 恢复后与既有节点重叠——对位置相同的重叠簇,多余节点重新展开。
		// 不用 cose 补位:cose 对单/少数节点几乎不产生位移,新节点会停在原点附近。
		// 补位用 position() 直接设置(不触发 layoutstop),完成后必须手动 savePositions,
		// 否则补位结果不落盘,下次恢复仍是旧的重叠位置(用户观察到的"离开后复原重叠")。
		if (hasStored) {
			const byPos = new Map<string, string[]>();
			for (const n of cy.nodes()) {
				const p = n.position();
				const key = `${Math.round(p.x)},${Math.round(p.y)}`;
				const arr = byPos.get(key) ?? [];
				arr.push(n.id());
				byPos.set(key, arr);
			}
			const missingIds = new Set(missing.map((e) => e.id));
			const dupIds: string[] = [];
			for (const [key, ids] of byPos) {
				if (ids.length > 1) {
					// 簇内保留第一个(可能是用户有意叠放),其余视为脏数据重新展开
					dupIds.push(...ids.slice(1));
				} else if (key === "0,0") {
					// 单个节点停在原点也是脏数据:preset 对无存档位置的节点默认 (0,0),
					// 历史版本补位后漏存,恢复时该节点堆在视图原点
					dupIds.push(...ids);
				}
			}
			const toPlace = [...missingIds, ...dupIds];
			if (toPlace.length > 0) {
				const placed = new Set(toPlace);
				const existing = cy.nodes().filter((n) => !placed.has(n.id()));
				const bbox = existing.boundingBox({ includeLabels: false });
				const cols = Math.ceil(Math.sqrt(toPlace.length));
				toPlace.forEach((id, i) => {
					const x = bbox.x1 + bbox.w + 80 + (i % cols) * 30;
					const y = bbox.y1 + (Math.floor(i / cols) + 1) * 44;
					cy.getElementById(id).position({ x, y });
				});
			}
		}

		// preset 恢复路径中先定位节点,再创建关系边,避免边在节点移动前缓存错误几何。
		if (hasStored && edgeElements.length > 0) {
			cy.add(edgeElements);
		}

		// 布局与补位/自愈全部完成后无条件持久化一次(对 hasStored 与 cose 首次布局都生效):
		// 构造时传入的 layout 在事件监听器注册前就已运行完毕,其 layoutstop 不会被下方
		// cy.on 捕获,导致首次布局结果从未落盘——loadPositions 恒空、hasStored 恒 false,
		// 每次进入都重新 cose 排列(表现为"回到默认排列状态")。
		savePositions(cy, slug);
		// position/pan/zoom 的初始化修改不会必然触发 renderer 重绘;
		// 拖动节点会触发重绘,这正是之前"拖一下线才出现"的表象来源。
		// 延后一帧,确保 canvas 完成首轮布局与尺寸测量后再刷新 renderer。
		const renderFrame = window.requestAnimationFrame(() => {
			cy.resize();
			cy.forceRender();
		});

		// 单击空白:取消连线起点、收起右键菜单
		cy.on("tap", (evt) => {
			if (evt.target === cy) {
				setLinkFrom(null);
				setCtxMenu(null);
			}
		});
		// 单击节点:连线模式走「选起点 → 选终点 → 表单」;普通模式选中 → onSelect
		cy.on("tap", "node", (evt) => {
			const id = evt.target.id();
			setCtxMenu(null);
			if (linkingRef.current) {
				const from = linkFromRef.current;
				if (from === null) {
					setLinkFrom(id);
					return;
				}
				setLinkFrom(null);
				if (from === id) return; // 点同一点取消
				setRelForm({ mode: "create", from, to: id });
				return;
			}
			onSelectRef.current(id);
		});
		// 右键节点 → 快捷编辑菜单(重命名/编辑正文/断开连线/删除)
		cy.on("cxttap", "node", (evt) => {
			evt.originalEvent.preventDefault();
			setCtxMenu({ x: evt.renderedPosition.x, y: evt.renderedPosition.y, kind: "node", entryId: evt.target.id() });
		});
		// 右键边 → 编辑/删除菜单(位置按画布渲染坐标;阻止浏览器原生菜单)
		cy.on("cxttap", "edge", (evt) => {
			evt.originalEvent.preventDefault();
			setCtxMenu({ x: evt.renderedPosition.x, y: evt.renderedPosition.y, kind: "edge", relId: evt.target.id() });
		});
		// 拖放/布局完成 → 位置持久化
		cy.on("dragfree", "node", () => savePositions(cy, slug));
		cy.on("layoutstop", () => savePositions(cy, slug));
		// 平移/缩放 → 视口持久化(节流 400ms,刷新后保持视野)。
		// cytoscape 3.34 只发射 "pan viewport" 与 "pan zoom viewport"(无 panzoom
		// 事件;zoom 变化也走 pan zoom viewport),两者都要听,按空格分隔注册。
		let lastViewportSave = 0;
		cy.on("pan viewport pan zoom viewport", () => {
			const now = Date.now();
			if (now - lastViewportSave < 400) return;
			lastViewportSave = now;
			saveViewport(slug, cy.zoom(), cy.pan());
		});

		// 智能滚轮:灵敏度随当前倍率动态调整——低倍率(全图)滚动步长小、
		// 精细定位;高倍率(局部放大)步长大、巡航快(对数映射)。
		cy.on("zoom", () => {
			// 函数式更新:百分比未变(如 fit/pan 微调)不触发重渲染,滚轮缩放不再每帧重绘整棵树
			setZoomPct((prev) => {
				const next = Math.round(cy.zoom() * 100);
				return prev === next ? prev : next;
			});
		});
		// 初始同步一次百分比(恢复存档视口后横条与实际一致)
		setZoomPct(Math.round(cy.zoom() * 100));

		// 自定义滚轮缩放(接管原生):构造时 wheelSensitivity: 0 已把原生缩放
		// 归零(原 wheelEnabled 选项不存在,静默忽略曾导致双重缩放);这里实现
		// 「智能步长」——滚轮增量越大步长越大,倍率越高步长越大(低倍率精细
		// 定位、高倍率巡航),以鼠标位置为缩放锚点。
		const onWheel = (e: WheelEvent) => {
			const c = cyRef.current;
			if (!c) return;
			e.preventDefault();
			const rect = container.getBoundingClientRect();
			const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
			const z = c.zoom();
			const dir = e.deltaY > 0 ? -1 : 1; // 向下滚动 = 缩小
			const base = 1 + (Math.min(Math.abs(e.deltaY), 240) / 100) * 0.12; // 一格 ≈ 1.12
			const smart = 1 + Math.log2(Math.max(z, 0.15)) * 0.15; // 倍率越高步长越大
			c.zoom({ level: z * Math.pow(base, dir * smart), renderedPosition: pos });
		};
		container.addEventListener("wheel", onWheel, { passive: false });

		// 窗口尺寸变化 → 画布自适应
		const onResize = () => cy.resize();
		window.addEventListener("resize", onResize);

		return () => {
			window.removeEventListener("resize", onResize);
			container.removeEventListener("wheel", onWheel);
			window.cancelAnimationFrame(renderFrame);
			// 卸载前保存当前位置:拖动后立即切走(dragfree 可能未触发)也不丢
			savePositions(cy, slug);
			saveViewport(slug, cy.zoom(), cy.pan());
			cy.destroy();
			cyRef.current = null;
		};
	}, [graphSignature, slug]);

	// 类型过滤:show()/hide() 增量切换,不重建 cytoscape 实例(P7,2026-08)。
	// 隐藏节点连带隐藏其关系边;再次显示时位置从 localStorage 恢复(全量建图已
	// 保存全部节点位置)。重建 effect 之后执行(声明顺序保证 cyRef 已就位)。
	// 用 display style 而非 ele.show()/hide() 简写(cytoscape 类型未声明,行为等价)。
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		const visIds = new Set(entries.filter((e) => typesOn[e.type]).map((e) => e.id));
		for (const n of cy.nodes()) {
			n.style("display", visIds.has(n.id()) ? "element" : "none");
		}
		for (const ed of cy.edges()) {
			const s = ed.data("source") as string;
			const t = ed.data("target") as string;
			ed.style("display", visIds.has(s) && visIds.has(t) ? "element" : "none");
		}
	}, [typesOn, entries, graphSignature, slug]);

	// 重建后 epoch+1,驱动 focus 联动重选
	useEffect(() => {
		setEpoch((e) => e + 1);
	}, [graphSignature, typesOn, slug]);

	// 主题切换(data-theme 变化)后重建图样式:themeVar 在构造时读取,
	// 不刷新则 night 下初始化的图在浅色主题下保持黑底标签/深色配色
	useEffect(() => {
		const observer = new MutationObserver(() => {
			const cy = cyRef.current;
			if (!cy) return;
			cy.style().fromJson(buildGraphStyles()).update();
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);

	// 连线起点高亮
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.nodes().removeClass("link-from");
		if (linkFrom) cy.getElementById(linkFrom).addClass("link-from");
	}, [linkFrom, epoch]);

	// 标题/激活/图片增量同步:文本与图片编辑不重建图,只更新节点 data(节点宽度按 label 自适应)
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		for (const e of entries) {
			const el = cy.getElementById(e.id);
			if (el.length === 0) continue;
			const typeColor = themeVar(TYPE_TOKENS[e.type], TYPE_FALLBACKS[e.type]);
			el.data("label", nodeLabel(e.title));
			el.data("active", e.active);
			el.data("backgroundImage", e.avatar ? imageUrl(slug, e.avatar) : genAvatarDataUrl(e.title, typeColor));
		}
	}, [entries, slug, epoch]);

	// 父组件联动选中(词条面板跳转 / 列表视图选择):选中 + 居中
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy || !focusId) return;
		const el = cy.getElementById(focusId);
		if (el.length === 0 || el.selected()) return;
		el.select();
		cy.animate({ center: { eles: el }, duration: 180 });
	}, [focusId, epoch]);

	// Escape:收起右键菜单、退出连线模式
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setCtxMenu(null);
			setLinkFrom(null);
			setLinking(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const visibleCount = entries.filter((e) => typesOn[e.type]).length;

	/** 缩放一步(相对当前倍率;以画布中心为锚)。cytoscape 3.34 无 zoomBy,用 cy.zoom({level})。 */
	function zoomBy(factor: number) {
		const cy = cyRef.current;
		if (!cy) return;
		const w = cy.width();
		const h = cy.height();
		cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: w / 2, y: h / 2 } });
	}

	/** 一键排列:cola 约束力导向布局(webcola)——cost 函数包含边交叉惩罚,
	 *  关系线尽量不交叉;avoidOverlap 防节点重叠;randomize 从随机初始位置
	 *  收敛(避免挤堆初始态收敛到局部极差解)。完成后持久化。
	 *  不用 fcose:2.2.0 依赖 cytoscape 已移除的 node.getRect,与 3.34 不兼容。 */
	function runAutoLayout() {
		const cy = cyRef.current;
		if (!cy || cy.nodes().length === 0) return;
		cy.layout({
			name: "cola",
			animate: false,
			// 注意是单数 avoidOverlap(cytoscape-cola 2.5.1 只读该键,复数拼写被静默忽略)
			avoidOverlap: true,
			randomize: true,
			edgeLength: 90,
			nodeSpacing: 30,
		} as cytoscape.LayoutOptions).run();
		// 布局完成(layoutstop)已统一 savePositions;fit 后的视口也落盘
		saveViewport(slug, cy.zoom(), cy.pan());
	}

	/** 适应画布:整图缩放平移入视野,并持久化视口。 */
	function fitGraph() {
		const cy = cyRef.current;
		if (!cy || cy.nodes().length === 0) return;
		cy.fit(cy.nodes(), 40);
		saveViewport(slug, cy.zoom(), cy.pan());
	}

	return (
		<div className="graph-wrap">
			<div className="graph-toolbar">
				<span className="graph-toolbar-title">关系图</span>
				{ENTRY_TYPES.map((t) => (
					<label key={t} className="graph-filter">
						<input
							type="checkbox"
							checked={typesOn[t]}
							onChange={(e) => {
								setTypesOn((prev) => ({ ...prev, [t]: e.target.checked }));
								// 过滤切换可能把连线起点/右键目标节点藏掉:清空相关状态
								setLinking(false);
								setLinkFrom(null);
								setCtxMenu(null);
							}}
						/>
						{ENTRY_TYPE_LABELS[t]}
					</label>
				))}
				<button
					type="button"
					className={linking ? "graph-link-btn on" : "graph-link-btn"}
					onClick={() => {
						setLinking((v) => !v);
						setLinkFrom(null);
					}}
				>
					{linking ? "取消连线" : "连线"}
				</button>
				<button type="button" className="graph-link-btn" disabled={!canUndo} onClick={() => onUndo?.()} title="撤销(Ctrl+Z)">
					撤销
				</button>
				<span className="graph-hint">
					{linking
						? linkFrom
							? "点击目标节点创建关系(再点同一点取消)"
							: "点击起始节点"
						: "单击节点查看词条 · 右键节点/连线快捷操作 · 拖拽节点调整布局"}
				</span>
			</div>
			{/* 画布恒挂载(过滤走 show()/hide() 不重建实例,P7);无可见条目时覆盖空态提示 */}
			<div className="graph-canvas">
				<div className="graph-cytoscape" ref={containerRef} />
				{visibleCount === 0 && <div className="graph-empty">没有符合条件的条目,请先在列表视图添加条目或调整类型过滤</div>}
						{/* 图操作条:一键排列 + 缩放横条(放缩/百分比/适应);滚轮缩放灵敏度随倍率自适应。
						    mousedown 阻断冒泡:cytoscape 容器空白 tap 会清选中/菜单 */}
						<div className="graph-zoom-bar" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
							<button type="button" className="graph-zoom-btn" onClick={runAutoLayout} title="一键排列(cola 力导向)">
								⟳ 排列
							</button>
							<span className="graph-zoom-sep" />
							<button type="button" className="graph-zoom-btn" onClick={() => zoomBy(1 / 1.3)} title="缩小">
								−
							</button>
							<span className="graph-zoom-pct">{zoomPct}%</span>
							<button type="button" className="graph-zoom-btn" onClick={() => zoomBy(1.3)} title="放大">
								+
							</button>
							<span className="graph-zoom-sep" />
							<button type="button" className="graph-zoom-btn" onClick={fitGraph} title="适应画布">
								⛶ 适应
							</button>
						</div>
					{ctxMenu && ctxMenu.kind === "edge" && (
						<div
							className="graph-ctx"
							style={{ left: ctxMenu.x, top: ctxMenu.y }}
							// 菜单是 cytoscape 容器子元素:mousedown 不阻断会冒泡成容器"空白 tap",
							// 在 click 到达前 setCtxMenu(null) 卸载菜单,按钮永远点不中
							onMouseDown={(e) => e.stopPropagation()}
							onTouchStart={(e) => e.stopPropagation()}
						>
							<button
								type="button"
								onClick={() => {
									const rel = relations.find((r) => r.id === ctxMenu.relId);
									setCtxMenu(null);
									if (rel) setRelForm({ mode: "edit", rel });
								}}
							>
								编辑关系
							</button>
							<button
								type="button"
								className="danger"
								onClick={() => {
									onUpdateRef.current(relations.filter((r) => r.id !== ctxMenu.relId));
									setCtxMenu(null);
								}}
							>
								删除关系
							</button>
						</div>
					)}
					{ctxMenu && ctxMenu.kind === "node" && (
						<div
							className="graph-ctx"
							style={{ left: ctxMenu.x, top: ctxMenu.y }}
							// 同 edge 菜单:阻断 mousedown 冒泡,防止被容器空白 tap 提前卸载
							onMouseDown={(e) => e.stopPropagation()}
							onTouchStart={(e) => e.stopPropagation()}
						>
							<button
								type="button"
								onClick={() => {
									const entry = entries.find((e) => e.id === ctxMenu.entryId);
									setCtxMenu(null);
									if (entry) setRenameTarget(entry);
								}}
							>
								重命名
							</button>
							<button
								type="button"
								onClick={() => {
									onSelectRef.current(ctxMenu.entryId);
									setCtxMenu(null);
								}}
							>
								编辑正文
							</button>
							<button
								type="button"
								onClick={() => {
									// 断开该节点参与的所有连线(双向)
									onUpdateRef.current(disconnectEntry(relations, ctxMenu.entryId));
									setCtxMenu(null);
								}}
							>
								断开所有连线
							</button>
							<button
								type="button"
								className="danger"
								onClick={() => {
									onDeleteEntryRef.current?.(ctxMenu.entryId);
									setCtxMenu(null);
								}}
							>
								删除节点
							</button>
						</div>
					)}
						{relForm && (
							<RelationForm
								state={relForm}
								entries={entries}
								relations={relations}
								onCancel={() => setRelForm(null)}
								onSave={(next) => {
									onUpdateRef.current(next);
									setRelForm(null);
								}}
							/>
						)}
						{renameTarget && (
							<div
								className="graph-modal-mask"
								// 同 relForm:阻断 cytoscape 容器 mousedown 的 preventDefault,保证输入可聚焦
								onMouseDown={(e) => e.stopPropagation()}
								onTouchStart={(e) => e.stopPropagation()}
							>
								<div className="rel-form">
									<div className="rel-form-head">
										<span>重命名节点</span>
										<button
											type="button"
											className="rel-form-close"
											onClick={() => setRenameTarget(null)}
											title="关闭"
										>
											✕
										</button>
									</div>
									<label className="rel-field">
										<span>新标题</span>
										<input
											type="text"
											value={renameTarget.title}
											onChange={(e) => setRenameTarget({ ...renameTarget, title: e.target.value })}
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													const t = renameTarget.title.trim();
													if (t) onUpdateEntryRef.current?.({ ...renameTarget, title: t });
													setRenameTarget(null);
												} else if (e.key === "Escape") {
													setRenameTarget(null);
												}
											}}
											autoFocus
										/>
									</label>
									<div className="rel-form-actions">
										<button
											type="button"
											onClick={() => {
												const t = renameTarget.title.trim();
												if (t) onUpdateEntryRef.current?.({ ...renameTarget, title: t });
												setRenameTarget(null);
											}}
										>
											确定
										</button>
										<button type="button" onClick={() => setRenameTarget(null)}>
											取消
										</button>
									</div>
								</div>
							</div>
						)}
						</div>
					</div>
			);


}
