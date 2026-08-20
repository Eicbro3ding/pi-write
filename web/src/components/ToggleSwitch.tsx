/**
 * 现代化 Toggle Switch 开关。
 * 替代 checkbox 用于布尔状态切换,视觉更直观、更紧凑。
 */
export function ToggleSwitch({
	checked,
	onChange,
	disabled,
	id,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
	id?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			id={id}
			className={`toggle-switch${checked ? " on" : ""}${disabled ? " disabled" : ""}`}
			onClick={() => onChange(!checked)}
		>
			<span className="toggle-knob" />
		</button>
	);
}
