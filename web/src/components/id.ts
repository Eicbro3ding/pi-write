/** 与后端 world-data.newId 同款:`prefix-` + 6 位随机小写字母数字。 */
export function newId(prefix: string): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
	return `${prefix}-${s}`;
}
