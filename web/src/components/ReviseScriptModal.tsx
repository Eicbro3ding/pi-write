/**
 * 修订剧本模态(设计稿 02-模态与面板/01)。
 *
 * 原形态是 320px 侧栏里的一条纵列表单(11 个字段挤在两三屏),改成 860px 独立窗口:
 * 左栏「本幕文本」(场景意象 / 本幕任务 / 基调 / 节拍),右栏「规则与约束」
 * (禁区 + 三个数字输入并排)+「演员指令」(演员 Select / 本幕欲望 / 演出边界 /
 * 说话方式),一屏放下。
 *
 * 表单状态与提交逻辑**完全留在 StagePanel**(buildRevisePatch 是唯一实现,有单测);
 * 本组件只负责渲染 + 把交互回抛,零新逻辑。
 */
import type { StageScriptDto } from "../types.ts";
import type { ReviseFormState } from "../stage-web.ts";
import { Select } from "./Select.tsx";

/** 表单字段写入(局部 patch,保持其余字段不变)。 */
export type ReviseFieldPatch = (patch: Partial<ReviseFormState>) => void;

export function ReviseScriptModal({
	script,
	castNames,
	form,
	onField,
	onSubmit,
	onClose,
	busy = false,
}: {
	/** 当前在演/待确认的剧本(版本号与演员 id 映射来源)。 */
	script: StageScriptDto;
	/** 演员 id → 角色名(演员 Select 的选项)。 */
	castNames: Record<string, string>;
	form: ReviseFormState;
	onField: ReviseFieldPatch;
	/** 提交修订(buildRevisePatch(form) → /revise);成功后由调用方关闭。 */
	onSubmit(): void;
	onClose(): void;
	/** 长命令进行中:提交按钮禁用(避免重复提交)。 */
	busy?: boolean;
}) {
	return (
		<div
			className="rsm-mask"
			role="dialog"
			aria-modal="true"
			aria-label="修订剧本"
			onMouseDown={(e) => {
				// 点遮罩关闭(点窗口内部不关):mousedown 判 target 是遮罩自身
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="rsm-panel">
				<header className="rsm-head">
					<span className="rsm-title">修订剧本</span>
					<span className="rsm-ver">
						v{script.version} → v{script.version + 1}
					</span>
					<span className="rsm-desc">提交后下一轮生效,留空的字段保持原值</span>
					<button type="button" className="rsm-close" aria-label="关闭" onClick={onClose}>
						✕
					</button>
				</header>

				<div className="rsm-body" onKeyDown={(e) => e.key === "Escape" && onClose()}>
					{/* —— 左栏:本幕文本 —— */}
					<section className="rsm-col">
						<div className="rsm-group">本幕文本</div>
						<label className="rsm-field">
							<span className="rsm-label">场景意象</span>
							<input value={form.setting} onChange={(e) => onField({ setting: e.target.value })} placeholder={script.text.shared.setting} />
						</label>
						<label className="rsm-field">
							<span className="rsm-label">本幕任务</span>
							<input value={form.goal} onChange={(e) => onField({ goal: e.target.value })} placeholder={script.text.shared.goal} />
						</label>
						<label className="rsm-field">
							<span className="rsm-label">基调</span>
							<input value={form.tone} onChange={(e) => onField({ tone: e.target.value })} placeholder={script.text.shared.tone} />
						</label>
						<label className="rsm-field rsm-field-grow">
							<span className="rsm-label">节拍(每行一拍)</span>
							<textarea value={form.beats} onChange={(e) => onField({ beats: e.target.value })} placeholder={script.text.shared.beats.join("\n")} />
						</label>
					</section>

					{/* —— 右栏:规则与约束 + 演员指令 —— */}
					<section className="rsm-col">
						<div className="rsm-group">规则与约束</div>
						<label className="rsm-field">
							<span className="rsm-label">禁区(每行一条)</span>
							<textarea
								className="rsm-tall"
								value={form.forbidden}
								onChange={(e) => onField({ forbidden: e.target.value })}
								placeholder={script.text.shared.forbidden.join("\n")}
							/>
						</label>
						<div className="rsm-nums">
							<label className="rsm-field">
								<span className="rsm-label">下限条数</span>
								<input
									type="number"
									value={form.minLines}
									onChange={(e) => onField({ minLines: e.target.value })}
									placeholder={String(script.definition.rules.minLines)}
								/>
							</label>
							<label className="rsm-field">
								<span className="rsm-label">上限条数</span>
								<input
									type="number"
									value={form.maxLines}
									onChange={(e) => onField({ maxLines: e.target.value })}
									placeholder={String(script.definition.rules.maxLines)}
								/>
							</label>
							<label className="rsm-field">
								<span className="rsm-label">收尾窗口</span>
								<input
									type="number"
									value={form.wrapUpWindow}
									onChange={(e) => onField({ wrapUpWindow: e.target.value })}
									placeholder={String(script.definition.rules.wrapUpWindow)}
								/>
							</label>
						</div>

						<div className="rsm-group">演员指令</div>
						<div className="rsm-field">
							<span className="rsm-label">演员</span>
							<Select
								className="sel-block"
								value={form.actorId}
								onChange={(v) => onField({ actorId: v })}
								options={[
									{ value: "", label: "(不改演员指令)" },
									...Object.entries(castNames).map(([actorId, name]) => ({ value: actorId, label: name })),
								]}
							/>
						</div>
						<label className="rsm-field">
							<span className="rsm-label">本幕欲望</span>
							<input
								value={form.objective}
								onChange={(e) => onField({ objective: e.target.value })}
								placeholder={form.actorId ? script.text.perActor[form.actorId]?.objective : "objective"}
							/>
						</label>
						<label className="rsm-field">
							<span className="rsm-label">演出边界</span>
							<input
								value={form.boundary}
								onChange={(e) => onField({ boundary: e.target.value })}
								placeholder={form.actorId ? script.text.perActor[form.actorId]?.boundary : "boundary"}
							/>
						</label>
						<label className="rsm-field">
							<span className="rsm-label">说话方式</span>
							<input
								value={form.voice}
								onChange={(e) => onField({ voice: e.target.value })}
								placeholder={form.actorId ? script.text.perActor[form.actorId]?.voice : "voice"}
							/>
						</label>
					</section>
				</div>

				<footer className="rsm-foot">
					<span className="rsm-note">修订只影响下一轮。本幕正在进行的演出不受影响</span>
					<span className="rsm-foot-actions">
						<button type="button" className="btn" onClick={onClose}>
							取消
						</button>
						<button type="button" className="btn primary rsm-submit" disabled={busy} onClick={onSubmit}>
							✓ 提交修订
						</button>
					</span>
				</footer>
			</div>
		</div>
	);
}
