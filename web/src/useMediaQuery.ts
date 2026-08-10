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
