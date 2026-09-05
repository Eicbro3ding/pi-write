/**
 * 首次启动配置向导(五步:功能介绍 → 接入模型服务商 → 选默认模型+思考级别 →
 * 建第一本书 → 界面偏好)。完成后经 client.completeSetup 把标记写到服务端
 * ~/.pi/writer/setup.json(跨窗口/跨浏览器一致),onFinished 交还控制权。
 *
 * 两种打开形态(由 App 控制):
 * - 首次启动:向导独占渲染,主界面四页尚未挂载——完成后才挂载,WritePage 的
 *   挂载效应会拉书列表并自动打开第一本书(向导建的书一进界面就打开);
 * - 设置页「重新运行配置向导」:作为全屏覆盖层叠加在已挂载页面上,不打断
 *   流式状态;此时建的书经 onBooksChanged 通知 App 刷新书库列表。
 *
 * 各步骤「真正做过」的标记(点了什么、存了什么)随完成请求一并上报;
 * 「跳过向导」同样置完成标记(空 steps),避免每次启动重复弹。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { UserThemeInfo } from "../types.ts";
import { NIGHT_THEME, themeLabelFromCss, type ThemeId } from "../themes.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import { ProviderList } from "./ProviderList.tsx";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { IconEdit, IconGear, IconGlobe, IconStage } from "./Icons.tsx";

/** 思考级别选项(与后端 session-host 的 ThinkingLevel 对齐;同 SettingsPage)。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 向导步骤(id 与服务端 src/setup.ts 的 SETUP_STEPS 对齐;顺序即展示顺序)。 */
const WIZARD_STEPS = [
	{ id: "intro", label: "介绍" },
	{ id: "provider", label: "模型服务" },
	{ id: "model", label: "默认模型" },
	{ id: "book", label: "第一本书" },
	{ id: "prefs", label: "界面偏好" },
] as const;

type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/** 各步骤是否真正走过(完成请求的 steps 载荷)。 */
type StepFlags = Record<WizardStepId, boolean>;

/** vendor 模型元素最小形状(同 SettingsPage 的 ModelInfo)。 */
interface ModelInfo {
	id: string;
	provider: string;
}

/** 归一模型引用为 "provider/id"(与服务端 canonical 格式一致)。 */
function modelRef(m: unknown): string | null {
	if (typeof m === "string") return m.length > 0 ? m : null;
	if (typeof m !== "object" || m === null) return null;
	const o = m as Record<string, unknown>;
	if (typeof o.provider !== "string" || typeof o.id !== "string") return null;
	return `${o.provider}/${o.id}`;
}

/** 从 getModels 的 models 数组提取最小形状(形状不符跳过)。 */
function extractModels(models: readonly unknown[]): ModelInfo[] {
	const out: ModelInfo[] = [];
	for (const m of models) {
		if (typeof m !== "object" || m === null) continue;
		const o = m as Record<string, unknown>;
		if (typeof o.id === "string" && typeof o.provider === "string") out.push({ id: o.id, provider: o.provider });
	}
	return out;
}

/** 从主题 CSS 抽取 [背景, 强调, 文字] 三色做卡片预览;缺失回退中性色(同 SettingsPage)。 */
function swatchFromCss(css: string): [string, string, string] {
	const pick = (name: string): string => {
		const m = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
		return m ? m[1]!.trim() : "";
	};
	return [pick("--bg") || "#141414", pick("--amber") || "#d9a84e", pick("--ink") || "#e8e6e1"];
}

export function SetupWizard({
	client,
	simplifiedTools,
	onSimplifiedToolsChange,
	autoExpandThinking,
	onAutoExpandThinkingChange,
	autoConfirmEdits,
	onAutoConfirmEditsChange,
	onBooksChanged,
	onFinished,
}: {
	client: ApiClient;
	/** 简化输出开关(工具调用卡片隐藏;缺省开启)。 */
	simplifiedTools: boolean;
	onSimplifiedToolsChange: (enabled: boolean) => void;
	/** 自动展开思考开关(思考块默认展开;缺省开启)。 */
	autoExpandThinking: boolean;
	onAutoExpandThinkingChange: (enabled: boolean) => void;
	/** 编辑免确认开关(缺省关闭)。 */
	autoConfirmEdits: boolean;
	onAutoConfirmEditsChange: (enabled: boolean) => void;
	/** 向导创建了书后回调(重运行形态下 App 刷新书库列表;首启形态不需要)。 */
	onBooksChanged?: () => void | Promise<void>;
	/** 向导完成(含跳过)后回调;完成标记已写到服务端。 */
	onFinished: () => void;
}) {
	/** 当前步骤下标(0..4)。 */
	const [step, setStep] = useState(0);
	const [flags, setFlags] = useState<StepFlags>({ intro: false, provider: false, model: false, book: false, prefs: false });
	const mark = useCallback((id: WizardStepId) => {
		setFlags((f) => (f[id] ? f : { ...f, [id]: true }));
	}, []);

	// —— 完成请求 ——
	const [finishing, setFinishing] = useState(false);
	const [finishErr, setFinishErr] = useState<string | null>(null);

	// —— 模型步状态 ——
	/** null = 未加载(进入模型步时拉取;provider 认证变化后置空重拉)。 */
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [currentModel, setCurrentModel] = useState<string | null>(null);
	const [modelSel, setModelSel] = useState("");
	const [thinkingCur, setThinkingCur] = useState<string | null>(null);
	const [thinkingSel, setThinkingSel] = useState("");
	const [modelBusy, setModelBusy] = useState(false);

	// —— 建书步状态 ——
	const [bookTitle, setBookTitle] = useState("");
	const [chapterTitle, setChapterTitle] = useState("");
	const [bookBusy, setBookBusy] = useState(false);

	// —— 界面偏好步状态 ——
	const [theme, setTheme] = useState<ThemeId>(() => currentTheme());
	const [builtinThemes, setBuiltinThemes] = useState<UserThemeInfo[]>([]);
	const [userThemes, setUserThemes] = useState<UserThemeInfo[]>([]);

	/** 当前步骤内的操作错误(模型设置失败/建书失败等;切步清除)。 */
	const [stepErr, setStepErr] = useState<string | null>(null);

	/** 主题清单:挂载时拉一次(失败只剩 night,不挡向导)。 */
	useEffect(() => {
		let cancelled = false;
		void client
			.getThemes()
			.then((m) => {
				if (cancelled) return;
				setBuiltinThemes(m.builtin);
				setUserThemes(m.user);
			})
			.catch(() => {
				/* 拉取失败:主题列表为空,仅展示 night */
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	/** 拉取模型列表/当前模型/思考级别并回填选择器。 */
	const loadModels = useCallback(async () => {
		const r = await client.getModels();
		const list = extractModels(r.models);
		const cur = modelRef(r.current);
		setModels(list);
		setCurrentModel(cur);
		setModelSel(cur ?? "");
		const t = typeof r.thinking === "string" ? r.thinking : null;
		setThinkingCur(t);
		setThinkingSel(t ?? "");
	}, [client]);

	/** 进入模型步且未加载过 → 拉取(models 置空表示需要重拉,如 provider 认证变化)。 */
	useEffect(() => {
		if (step !== 2 || models !== null) return;
		let cancelled = false;
		setStepErr(null);
		void loadModels().catch((e) => {
			if (cancelled) return;
			setModels([]);
			setStepErr(`模型加载失败: ${friendlyError(e)}`);
		});
		return () => {
			cancelled = true;
		};
	}, [step, models, loadModels]);

	/** provider 步认证变化:标记步骤走过 + 模型列表置空(下一步重新拉)。 */
	function handleAuthChanged() {
		mark("provider");
		setModels(null);
	}

	/** 模型下拉按 provider 分组(组内按 id 排序)。 */
	const groups = useMemo(() => {
		const byProvider = new Map<string, ModelInfo[]>();
		for (const m of models ?? []) {
			const arr = byProvider.get(m.provider) ?? [];
			arr.push(m);
			byProvider.set(m.provider, arr);
		}
		return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [models]);

	/** 联网刷新模型目录(远程 catalog / 动态 provider),成功后回填选择器。 */
	async function refreshModels() {
		if (modelBusy) return;
		setModelBusy(true);
		setStepErr(null);
		try {
			await client.refreshModels();
			await loadModels();
		} catch (e) {
			setStepErr(`模型列表刷新失败: ${friendlyError(e)}`);
		} finally {
			setModelBusy(false);
		}
	}

	/** 选主题:立即应用(所见即所得)+ 标记偏好步走过。 */
	function selectTheme(id: ThemeId) {
		setTheme(id);
		applyTheme(id);
		mark("prefs");
	}

	/** 偏好开关:即时生效(经 App 的持久化 setter)+ 标记偏好步走过。 */
	function togglePref(key: "simplified" | "autoExpand" | "autoConfirm", v: boolean) {
		if (key === "simplified") onSimplifiedToolsChange(v);
		else if (key === "autoExpand") onAutoExpandThinkingChange(v);
		else onAutoConfirmEditsChange(v);
		mark("prefs");
	}

	/** 上一步(回到模型步时保留已选值;错误清除)。 */
	function back() {
		setStepErr(null);
		setStep((s) => Math.max(0, s - 1));
	}

	/** 下一步/完成:各步收口(模型与建书是异步操作,失败留在原步显示错误)。 */
	async function next() {
		setStepErr(null);
		if (step === 0) {
			mark("intro");
			setStep(1);
			return;
		}
		if (step === 1) {
			// provider 步不强求配置(列表内部自行处理错误);认证与否都放行
			setStep(2);
			return;
		}
		if (step === 2) {
			if (modelBusy) return;
			setModelBusy(true);
			try {
				if (modelSel && modelSel !== currentModel) await client.setModel(modelSel);
				if (thinkingSel && thinkingSel !== thinkingCur) await client.setThinking(thinkingSel);
				if (modelSel || thinkingSel) mark("model");
				setStep(3);
			} catch (e) {
				setStepErr(`模型设置失败: ${friendlyError(e)}`);
			} finally {
				setModelBusy(false);
			}
			return;
		}
		if (step === 3) {
			// 建第一本书:标题留空 = 跳过(不创建);填写则建书 + 可选首章
			const title = bookTitle.trim();
			if (title === "") {
				setStep(4);
				return;
			}
			if (bookBusy) return;
			setBookBusy(true);
			try {
				const book = await client.createBook(title);
				if (chapterTitle.trim().length > 0) await client.createChapter(book.slug, chapterTitle.trim());
				mark("book");
				try {
					await onBooksChanged?.();
				} catch {
					/* 列表刷新失败不影响向导(首启形态下页面挂载时会全量重拉) */
				}
				setStep(4);
			} catch (e) {
				setStepErr(`建书失败: ${friendlyError(e)}`);
			} finally {
				setBookBusy(false);
			}
			return;
		}
		// step === 4:完成
		await finish();
	}

	/** 完成向导:写服务端标记 → onFinished。失败显示错误并提供两条出路(重试/仍要进入)。 */
	async function finish() {
		if (finishing) return;
		setFinishing(true);
		setFinishErr(null);
		try {
			await client.completeSetup(flags);
			onFinished();
		} catch (e) {
			setFinishErr(`向导状态保存失败: ${friendlyError(e)}`);
			setFinishing(false);
		}
	}

	const busy = finishing || modelBusy || bookBusy;
	const isLast = step === WIZARD_STEPS.length - 1;

	return (
		<div className="wz-overlay" role="dialog" aria-modal="true" aria-label="首次启动配置向导">
			<div className="wz-panel">
				<header className="wz-head">
					<div className="wz-title">首次启动配置</div>
					<div className="wz-steps">
						{WIZARD_STEPS.map((s, i) => (
							<div key={s.id} className={`wz-step${i === step ? " active" : ""}${i < step ? " done" : ""}`}>
								<span className="wz-step-dot">{i < step ? "✓" : i + 1}</span>
								<span className="wz-step-label">{s.label}</span>
							</div>
						))}
					</div>
				</header>

				<div className="wz-body">
					{stepErr && <div className="notice err">{stepErr}</div>}

					{step === 0 && (
						<div className="wz-intro">
							<div className="wz-intro-brand">
								pi<i>·writer</i>
							</div>
							<h1>欢迎使用 pi-writer</h1>
							<p>AI 长篇写作工作台。只需一分钟完成初始配置:</p>
							<div className="wz-feature-grid">
								<div className="wz-feature">
									<IconStage size={16} />
									<div>
										<b>舞台</b>
										<span>多角色即兴演出,导演控制节奏</span>
									</div>
								</div>
								<div className="wz-feature">
									<IconEdit size={16} />
									<div>
										<b>编辑</b>
										<span>章节正文 + 常驻编剧 AI 伙伴</span>
									</div>
								</div>
								<div className="wz-feature">
									<IconGlobe size={16} />
									<div>
										<b>世界书</b>
										<span>人物、设定、时间线与关系图</span>
									</div>
								</div>
								<div className="wz-feature">
									<IconGear size={16} />
									<div>
										<b>设置</b>
										<span>模型、主题与 MCP 集成</span>
									</div>
								</div>
							</div>
						</div>
					)}

					{step === 1 && (
						<>
							<div className="wz-desc">
								为你的模型提供商添加 API key,其模型即可在下一步选为默认。key 存储在本地
								~/.pi/writer/agent/auth.json,不会上传。也可以稍后在「设置 → 模型」中配置。
							</div>
							<ProviderList client={client} onAuthChanged={handleAuthChanged} />
						</>
					)}

					{step === 2 && (
						<>
							<div className="wz-desc">选择默认模型与思考级别;列表为空时请先配置服务商或联网刷新。</div>
							<div className="s-field">
								<label className="s-field-label">默认模型</label>
								<div className="s-field-row">
									<select
										className="s-select s-select-full"
										value={modelSel}
										onChange={(e) => setModelSel(e.target.value)}
										disabled={modelBusy || models === null}
									>
										<option value="">{models === null ? "加载中…" : "暂不设置"}</option>
										{groups.map(([provider, list]) => (
											<optgroup key={provider} label={provider}>
												{list.map((m) => (
													<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
														{m.provider} · {m.id}
													</option>
												))}
											</optgroup>
										))}
									</select>
									<button type="button" className="btn-ghost" disabled={modelBusy} onClick={() => void refreshModels()}>
										{modelBusy ? "刷新中…" : "联网刷新"}
									</button>
								</div>
							</div>
							<div className="s-field" style={{ marginBottom: 0 }}>
								<label className="s-field-label">思考级别</label>
								<div className="s-field-row">
									<select
										className="s-select s-select-full"
										value={thinkingSel}
										onChange={(e) => setThinkingSel(e.target.value)}
										disabled={modelBusy}
									>
										<option value="">保持现状</option>
										{THINKING_LEVELS.map((l) => (
											<option key={l} value={l}>
												{l}
											</option>
										))}
									</select>
								</div>
								<div className="s-field-desc">off = 关闭思考; max = 最强思考深度</div>
							</div>
						</>
					)}

					{step === 3 && (
						<>
							<div className="wz-desc">创建你的第一本书;标题留空则跳过,之后随时在编辑页新建。</div>
							<div className="s-field">
								<label className="s-field-label">书名</label>
								<input
									className="s-input"
									placeholder="如:星槎远航志"
									value={bookTitle}
									disabled={bookBusy}
									onChange={(e) => setBookTitle(e.target.value)}
								/>
							</div>
							<div className="s-field" style={{ marginBottom: 0 }}>
								<label className="s-field-label">首章标题(可选)</label>
								<input
									className="s-input"
									placeholder="如:第一章 · 夜航船"
									value={chapterTitle}
									disabled={bookBusy}
									onChange={(e) => setChapterTitle(e.target.value)}
								/>
							</div>
						</>
					)}

					{step === 4 && (
						<>
							<div className="wz-desc">挑选主题与界面偏好,立即生效,随时可在设置中修改。</div>
							<div className="theme-cards wz-theme-cards">
								<button
									key={NIGHT_THEME.id}
									type="button"
									className={`theme-card${theme === NIGHT_THEME.id ? " active" : ""}`}
									onClick={() => selectTheme(NIGHT_THEME.id)}
								>
									<span className="theme-swatch">
										{NIGHT_THEME.swatch.map((c) => (
											<i key={c} style={{ background: c }} />
										))}
									</span>
									<span className="theme-label">{NIGHT_THEME.label}</span>
									<span className="theme-desc">内置 · 默认</span>
								</button>
								{builtinThemes.map((bt) => {
									const id = bt.file.replace(/\.css$/, "");
									const swatch = swatchFromCss(bt.css);
									return (
										<button
											key={bt.file}
											type="button"
											className={`theme-card${theme === id ? " active" : ""}`}
											onClick={() => selectTheme(id)}
										>
											<span className="theme-swatch">
												{swatch.map((c) => (
													<i key={c} style={{ background: c }} />
												))}
											</span>
											<span className="theme-label">{themeLabelFromCss(bt.css, bt.file)}</span>
											<span className="theme-desc">内置</span>
										</button>
									);
								})}
								{userThemes.map((ut) => {
									const id = `user:${ut.file.replace(/\.css$/, "")}`;
									const swatch = swatchFromCss(ut.css);
									return (
										<button
											key={ut.file}
											type="button"
											className={`theme-card${theme === id ? " active" : ""}`}
											onClick={() => selectTheme(id)}
										>
											<span className="theme-swatch">
												{swatch.map((c) => (
													<i key={c} style={{ background: c }} />
												))}
											</span>
											<span className="theme-label">{ut.file.replace(/\.css$/, "")}</span>
											<span className="theme-desc">自定义</span>
										</button>
									);
								})}
							</div>
							<div className="s-pref-list">
								<div className="s-pref-item">
									<div className="s-pref-text">
										<div className="s-pref-title">简化输出</div>
										<div className="s-pref-desc">开启后对话中不显示工具调用卡片,以「正在阅读 / 正在编辑」等动态提示代替。</div>
									</div>
									<ToggleSwitch checked={simplifiedTools} onChange={(v) => togglePref("simplified", v)} ariaLabel="简化输出" />
								</div>
								<div className="s-pref-item">
									<div className="s-pref-text">
										<div className="s-pref-title">自动展开思考</div>
										<div className="s-pref-desc">开启后思考块默认展开,无需逐条点击;关闭后回到手动展开。</div>
									</div>
									<ToggleSwitch
										checked={autoExpandThinking}
										onChange={(v) => togglePref("autoExpand", v)}
										ariaLabel="自动展开思考"
									/>
								</div>
								<div className="s-pref-item">
									<div className="s-pref-text">
										<div className="s-pref-title">编辑免确认</div>
										<div className="s-pref-desc">开启后编剧的修改落盘即生效,不再弹「待确认」卡。</div>
									</div>
									<ToggleSwitch
										checked={autoConfirmEdits}
										onChange={(v) => togglePref("autoConfirm", v)}
										ariaLabel="编辑免确认"
									/>
								</div>
							</div>
						</>
					)}
				</div>

				{finishErr && (
					<div className="notice err wz-finish-err">
						<span>{finishErr}</span>
						<button type="button" className="btn-ghost notice-action" onClick={() => void finish()}>
							重试
						</button>
						<button type="button" className="btn-ghost notice-action" onClick={onFinished}>
							仍要进入
						</button>
					</div>
				)}

				<footer className="wz-foot">
					<button type="button" className="wz-skip" disabled={finishing} onClick={() => void finish()}>
						跳过向导
					</button>
					<div className="wz-foot-actions">
						{step > 0 && (
							<button type="button" className="btn-ghost" disabled={busy} onClick={back}>
								上一步
							</button>
						)}
						<button type="button" className="wz-primary" disabled={busy} onClick={() => void next()}>
							{isLast
								? finishing
									? "保存中…"
									: "完成"
								: modelBusy && step === 2
									? "设置中…"
									: bookBusy && step === 3
										? "创建中…"
										: "下一步"}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
