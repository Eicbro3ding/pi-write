import { useEffect, useState } from "react";

/** 订阅媒体查询;SSR 安全(unmatch 时 false),窄屏抽屉判定用(max-width: 900px)。 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
	useEffect(() => {
		const mql = window.matchMedia(query);
		const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
		setMatches(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

/**
 * 手机端判定(≤700px)。
 *
 * 与「窄屏(≤900px)」分开:≤900px 只是把两侧栏变抽屉(平板竖屏也适用),
 * 手机端(设计稿 ★移动版,393×852)是另一套壳——52px 页头、底部常驻输入条、
 * 全屏抽屉/全屏对话。断点数值在 styles.css 里也有对应媒体查询,改一处要同步另一处。
 */
export const PHONE_QUERY = "(max-width: 700px)";

/** 手机端(≤700px):页头/底部输入条/全屏抽屉走移动版布局。 */
export function useIsPhone(): boolean {
	return useMediaQuery(PHONE_QUERY);
}
