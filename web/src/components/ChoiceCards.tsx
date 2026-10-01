/**
 * 选择卡(单选,卡片形态):**唯一实现**。
 *
 * 三处共用同一套骨架与样式,各自只写「有哪些选项、文案是什么」:
 *   - `CreationModeCards.tsx`  —— 多 Agent / 单 Agent(向导「创作方式」步 + 设置页「Agent 形态」卡)
 *   - `ConversationScopeCards.tsx` —— 绑定章节 / 分离(向导「对话范围」步 + 设置页「对话与章节」卡)
 *   - `ShellCards.tsx`         —— 保持关闭 / 开启(向导「执行命令」步)
 * 2026-10-02 之前是三份各自实现(`cmode-*` / `cscope-*`),加第三处时收敛成这一份:
 * 骨架(图标底 + 标题 + 胶囊 + 一句话定位 + 要点列表 + 右上单选圈)只写一次,
 * 样式只有 `.choice-*` 一组(styles.css)。
 *
 * 语义:`role=radiogroup` + 每张卡 `role=radio`,再点已选中的那张**不会**重复回调
 * (调用方多数要发一次写服务端请求,连点会打出多余的请求);`busy` / `disabled`
 * 时整组进入禁用态,避免请求进行中再切一次。
 * 组件本身**不落盘**:调用方负责写服务端 + 失败回滚。
 */
import type { ComponentType } from "react";

/** 一个选项的展示数据(文案只在这里写一份)。 */
export interface ChoiceOption<V> {
	/** 选中它对应的值(卡片按 `value === 选中值` 判断选中态)。 */
	value: V;
	/** 卡片图标(与 Icons.tsx 同一条门面)。 */
	Icon: ComponentType<{ size?: number }>;
	title: string;
	/** 标题右侧的小胶囊(默认 / 自由 / 需确认…);没有就不画。 */
	tag?: string;
	/** 标题下的一句话定位。 */
	sub?: string;
	/** 「选它意味着什么」,三到四条;没有就不画要点区。 */
	points?: readonly string[];
}

export function ChoiceCards<V extends string | boolean>({
	options,
	value,
	onPick,
	busy = false,
	disabled = false,
	ariaLabel,
}: {
	options: readonly ChoiceOption<V>[];
	/** 当前选中值。 */
	value: V;
	/** 选中另一个选项;写服务端与失败回滚由调用方负责。 */
	onPick: (value: V) => void;
	/** 切换请求进行中(整组进入禁用态,避免连点)。 */
	busy?: boolean;
	/** 外部原因禁用(如向导正在完成)。 */
	disabled?: boolean;
	/** 无障碍组名(每组一处,如「创作方式」)。 */
	ariaLabel: string;
}) {
	const locked = busy || disabled;
	return (
		<div className="choice-cards" role="radiogroup" aria-label={ariaLabel} aria-busy={busy}>
			{options.map((o) => {
				const on = value === o.value;
				return (
					<button
						key={String(o.value)}
						type="button"
						role="radio"
						aria-checked={on}
						disabled={locked}
						className={`choice-card${on ? " on" : ""}`}
						onClick={() => {
							if (!on) onPick(o.value);
						}}
					>
						<span className="choice-head">
							<span className="choice-ico">
								<o.Icon size={18} />
							</span>
							<span className="choice-head-text">
								<span className="choice-title">
									{o.title}
									{o.tag !== undefined && <span className="choice-tag">{o.tag}</span>}
								</span>
								{o.sub !== undefined && <span className="choice-sub">{o.sub}</span>}
							</span>
							<span className="choice-radio" aria-hidden="true" />
						</span>
						{o.points !== undefined && o.points.length > 0 && (
							<ul className="choice-points">
								{o.points.map((p) => (
									<li key={p}>{p}</li>
								))}
							</ul>
						)}
					</button>
				);
			})}
		</div>
	);
}
