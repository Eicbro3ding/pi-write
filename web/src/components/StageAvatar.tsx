import { imageUrl } from "../api/client.ts";
import { genAvatarDataUrl } from "../graph-logic.ts";

/**
 * 角色头像:有头像用世界书主图(imageUrl 通路),无头像用「首字 + 角色色」兜底
 * (genAvatarDataUrl 同款——与关系图/词条卡的视觉语言一致,零新实现)。
 * 颜色只作用于头像图像内部(浅底深字),不参与正文文字,无对比度测试约束。
 */

/** 头像底色(在 #f5f0e6 浅底上对比度足够的深色系;与关系图 TYPE_FALLBACKS 同思路)。 */
const AVATAR_COLORS = ["#9a6524", "#5f7d4e", "#4a6d8c", "#8c5a66"] as const;
/** 叙述者固定灰(舞台指示的弱化语言)。 */
const NARRATOR_COLOR = "#8a8178";

/** 角色名 → 头像色(哈希取色,同角色跨条目稳定;叙述者固定灰)。 */
export function characterColor(name: string, narrator: boolean): string {
	if (narrator) return NARRATOR_COLOR;
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

/** 角色头像(img = 世界书 avatar 文件引用;缺省走首字兜底)。 */
export function StageAvatar({
	slug,
	name,
	narrator = false,
	img = null,
	size = "md",
}: {
	slug: string;
	name: string;
	narrator?: boolean;
	img?: string | null;
	size?: "md" | "sm" | "xs";
}) {
	const src = img ? imageUrl(slug, img) : genAvatarDataUrl(name, characterColor(name, narrator));
	return (
		<span className={`st-avatar ${size}`}>
			<img src={src} alt={name} />
		</span>
	);
}
