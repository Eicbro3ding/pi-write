/**
 * 创建 GitHub Release 并上传资产(无 gh CLI 时的替代)。
 * 用法:TOKEN=xxx node scripts/upload-release.mjs <version> [--tag v0.0.1] [--notes file]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "Eicbro3ding/pi-writer";
const token = process.env.GH_TOKEN;
if (!token) {
	console.error("缺少 GH_TOKEN 环境变量");
	process.exit(1);
}
const version = process.argv[2] ?? "0.0.1";
const tag = `v${version}`;
const notes = readFileSync(join(process.cwd(), "release", `release-notes-${tag}.md`), "utf-8");

const api = async (url, init = {}) => {
	const res = await fetch(url, {
		...init,
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", ...(init.headers ?? {}) },
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
	return body ? JSON.parse(body) : null;
};

// 1. 创建 release(tag 不存在则自动创建)
console.log(`创建 release ${tag} …`);
let release = await api(`https://api.github.com/repos/${REPO}/releases`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ tag_name: tag, name: `pi-writer ${tag}`, body: notes, target_commitish: "main" }),
});

// 2. 上传资产
const assets = [
	`release/release-zips/pi-writer-${version}-win-x64.zip`,
	`release/release-zips/pi-writer-${version}-win-arm64.zip`,
	`release/release-zips/pi-writer-${version}-linux-x64.zip`,
	`release/release-zips/pi-writer-${version}-linux-arm64.zip`,
	`release/release-zips/pi-writer-${version}-darwin-x64.zip`,
	`release/release-zips/pi-writer-${version}-darwin-arm64.zip`,
	`release/electron/pi-writer-web-${version}.exe`,
	`release/electron/pi-writer-web-${version}-arm64.exe`,
];

for (const rel of assets) {
	const abs = join(process.cwd(), rel);
	const name = rel.split(/[\\/]/).at(-1);
	const buf = readFileSync(abs);
	console.log(`上传 ${name} (${(buf.length / 1024 / 1024).toFixed(1)} MB) …`);
	await api(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: new Blob([buf]),
	});
	console.log(`  ✓ ${name}`);
}
console.log("全部资产上传完成");
