/**
 * CJK 字符统计 —— 统一口径的共用实现。
 *
 * 范围:Ext A (0x3400-0x4DBF) + Unified (0x4E00-0x9FFF) + Compat (0xF900-0xFAFF)。
 * 不用 `\p{Script=Han}` 正则:Android(nodejs-mobile)无 full ICU,`\p{` 正则禁用
 * (tools.ts word_count 曾因此存在 Android 崩溃风险,2026-08-10 收敛)。
 * 原 tools.ts / world-context.ts / stage/counters.ts 各持一份,现统一到此。
 */

/** CJK 码点范围(含注释范围名)。 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x3400, 0x4dbf], // CJK Ext A
	[0x4e00, 0x9fff], // CJK Unified
	[0xf900, 0xfaff], // CJK Compat
];

/** 单码点是否为 CJK 字符(UTF-16 code unit;上述范围全在 BMP 内,charCodeAt 即可)。 */
export function isCjkChar(code: number): boolean {
	for (const [lo, hi] of CJK_RANGES) {
		if (code >= lo && code <= hi) return true;
	}
	return false;
}

/** 统计字符串中的 CJK 字符数。 */
export function cjkCount(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (isCjkChar(text.charCodeAt(i))) count++;
	}
	return count;
}
