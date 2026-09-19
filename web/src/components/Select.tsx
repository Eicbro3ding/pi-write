/**
 * 统一下拉(Select)——替代原生 <select>。
 * 原生 <select> 的展开层不可样式化(圆角/阴影/hover 高亮由系统画,macOS 上整行
 * CSS 无效),闭合态又在各面板各写一份;这里收敛成唯一实现,规范见设计稿
 * 03-组件规范/01。判定逻辑全在 select-logic.ts(有单测),本文件只管渲染与事件。
 *
 * 弹层挂在 body 下的 fixed 定位层:不受祖先 overflow/transform 裁剪,
 * 也不会被面板的 z-index 上下文吃掉;滚动/缩放时跟随重算。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lu } from "./Lu.tsx";
import {
	filterSelectRows,
	firstSelectableRow,
	flattenSelectRows,
	searchableByDefault,
	selectedRowIndex,
	type SelectGroup,
	type SelectOption,
	selectPopupPlacement,
	stepSelectRow,
} from "../select-logic.ts";

export function Select({
	value,
	onChange,
	options,
	groups,
	placeholder = "请选择",
	disabled = false,
	title,
	ariaLabel,
	searchable,
	className,
	dot,
	menuWidth,
}: {
	value: string;
	onChange: (value: string) => void;
	/** 平铺选项(与 groups 二选一)。 */
	options?: readonly SelectOption[];
	/** 分组选项(带组标题)。 */
	groups?: readonly SelectGroup[];
	/** 无选中值时的占位文案。 */
	placeholder?: string;
	disabled?: boolean;
	title?: string;
	ariaLabel?: string;
	/** 是否启用搜索框;缺省按选项条数自动判定(>12 才给)。 */
	searchable?: boolean;
	className?: string;
	/** 触发器左侧色点(如词条类型色);选项自带 dot 时以选项为准。 */
	dot?: string;
	/** 弹层宽度(缺省与触发器等宽)。 */
	menuWidth?: number;
}) {
	const rows = useMemo(() => flattenSelectRows(options ?? [], groups ?? []), [options, groups]);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(-1);
	const [place, setPlace] = useState({ top: 0, left: 0, width: 0, flip: false });
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const popupRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listId = useId();

	const shown = useMemo(() => filterSelectRows(rows, query), [rows, query]);
	const withSearch = searchable ?? searchableByDefault(rows.length);

	const selected = useMemo(() => {
		for (const r of rows) if (r.kind === "option" && r.option.value === value) return r.option;
		return null;
	}, [rows, value]);

	/** 触发器等宽定位(弹层 fixed,滚动/缩放时重算)。 */
	const reposition = useCallback(() => {
		const el = triggerRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const popup = popupRef.current;
		const h = popup?.offsetHeight ?? 260;
		setPlace(selectPopupPlacement(
			{ top: r.top, left: r.left, width: menuWidth ?? r.width, height: r.height },
			h,
			{ width: window.innerWidth, height: window.innerHeight },
		));
	}, [menuWidth]);

	useLayoutEffect(() => {
		if (!open) return;
		reposition();
	}, [open, reposition, shown.length]);

	useEffect(() => {
		if (!open) return;
		const onScroll = () => reposition();
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [open, reposition]);

	/** 打开:高亮当前选中项(无则首个可选),清空搜索。 */
	const openMenu = useCallback(() => {
		if (disabled) return;
		setQuery("");
		const idx = selectedRowIndex(rows, value);
		setActive(idx >= 0 ? idx : firstSelectableRow(rows));
		setOpen(true);
	}, [disabled, rows, value]);

	const close = useCallback(() => {
		setOpen(false);
		setQuery("");
	}, []);

	const commit = useCallback(
		(rowIndex: number) => {
			const row = shown[rowIndex];
			if (!row || row.kind !== "option" || row.option.disabled) return;
			onChange(row.option.value);
			close();
			triggerRef.current?.focus();
		},
		[shown, onChange, close],
	);

	// 点击外部关闭(弹层在 body 下,两侧都要判)
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
			close();
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open, close]);

	// 打开时聚焦搜索框(有搜索才聚焦;否则焦点留在触发器上走键盘导航)
	useEffect(() => {
		if (open && withSearch) inputRef.current?.focus();
	}, [open, withSearch]);

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (!open) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openMenu();
			}
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			triggerRef.current?.focus();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => stepSelectRow(shown, i < 0 ? -1 : i, 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => stepSelectRow(shown, i < 0 ? shown.length : i, -1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			commit(active);
		} else if (e.key === "Tab") {
			close();
		}
	};

	return (
		<>
			<button
				type="button"
				ref={triggerRef}
				className={`sel${open ? " open" : ""}${className ? ` ${className}` : ""}`}
				disabled={disabled}
				title={title}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => (open ? close() : openMenu())}
				onKeyDown={onKeyDown}
			>
				{(() => {
					const c = selected?.dot ?? dot;
					return c ? <span className="sel-dot" style={{ background: c }} /> : null;
				})()}
				<span className={`sel-value${selected ? "" : " empty"}`}>{selected ? selected.label : placeholder}</span>
				<Lu icon="chevron-down" size={14} className="sel-arrow" />
			</button>
			{open &&
				createPortal(
					<div
						ref={popupRef}
						className={`sel-menu${place.flip ? " flip" : ""}`}
						style={{ top: place.top, left: place.left, width: place.width }}
						role="listbox"
						onKeyDown={onKeyDown}
						aria-controls={listId}
					>
						{withSearch && (
							<div className="sel-search">
								<Lu icon="search" size={14} strokeWidth={1.4} />
								<input
									ref={inputRef}
									value={query}
									placeholder="搜索…"
									onChange={(e) => {
										setQuery(e.target.value);
										setActive(firstSelectableRow(filterSelectRows(rows, e.target.value)));
									}}
								/>
							</div>
						)}
						<div className="sel-list">
							{shown.map((row, i) =>
								row.kind === "group" ? (
									<div key={`g-${row.label}-${i}`} className="sel-group">{row.label}</div>
								) : (
									<div
										key={`o-${row.option.value}`}
										className={`sel-opt${i === active ? " active" : ""}${row.option.value === value ? " on" : ""}${row.option.disabled ? " disabled" : ""}`}
										role="option"
										aria-selected={row.option.value === value}
										onMouseEnter={() => !row.option.disabled && setActive(i)}
										onMouseDown={(e) => {
											e.preventDefault();
											commit(i);
										}}
									>
										{row.option.dot && <span className="sel-dot" style={{ background: row.option.dot }} />}
										<span className="sel-opt-label">{row.option.label}</span>
										{row.option.hint && <span className="sel-opt-hint">{row.option.hint}</span>}
										{row.option.value === value && (
											<Lu icon="check" size={13} className="sel-check" />
										)}
									</div>
								),
							)}
							{shown.length === 0 && <div className="sel-none">无匹配项</div>}
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}
