/**
 * 为 GitHub Release 打包各平台 TUI 发行包(zip):
 * 每个包 = 平台可执行文件 + skills/ + theme/ + README/CHANGELOG/package.json。
 * 用法:node scripts/make-release-zips.mjs <version> [--only win-x64]
 */
import { mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { ZipFile } from "yazl";

const version = process.argv[2] ?? "0.0.1";
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

const root = process.cwd();
const distTui = join(root, "release", "dist-tui");
const outDir = join(root, "release", "release-zips");
mkdirSync(outDir, { recursive: true });

const PLATFORMS = [
	{ dir: "win-x64", name: "pi-writer.exe" },
	{ dir: "win-arm64", name: "pi-writer.exe" },
	{ dir: "linux-x64", name: "pi-writer" },
	{ dir: "linux-arm64", name: "pi-writer" },
	{ dir: "darwin-x64", name: "pi-writer" },
	{ dir: "darwin-arm64", name: "pi-writer" },
];

/** 顶层附加文件(skills/theme/README 等),随每个平台包一起打进 zip。 */
const EXTRA = [
	"skills",
	"theme",
	"README.md",
	"CHANGELOG.md",
	"package.json",
];

/** Windows 包附带启动器:默认以 --web 模式启动(常驻本地服务并自动打开浏览器)。 */
const START_BAT = `@echo off
rem pi-writer 启动器:默认以 Web 模式启动(常驻本地服务并自动打开浏览器)
rem 需要其他模式时自行传入参数,如: pi-writer.exe --book <slug>
pi-writer.exe --web %*
`;

function addRecursive(zip, absDir, zipPrefix) {
	for (const entry of readdirSync(absDir)) {
		const abs = join(absDir, entry);
		const stat = statSync(abs);
		if (stat.isDirectory()) {
			addRecursive(zip, abs, `${zipPrefix}${entry}/`);
		} else {
			zip.addFile(abs, `${zipPrefix}${entry}`);
		}
	}
}

function buildZip(platform) {
	const srcDir = join(distTui, platform.dir);
	const srcExe = join(srcDir, platform.name);
	if (!statSync(srcExe, { throwIfNoEntry: false })) {
		console.error(`跳过 ${platform.dir}: 可执行文件不存在 ${srcExe}`);
		return null;
	}
	const zipPath = join(outDir, `pi-writer-${version}-${platform.dir}.zip`);
	const zip = new ZipFile();
	// 可执行文件在 zip 根目录
	zip.addFile(srcExe, platform.name);
	// Windows 包附带 start.bat 启动器(默认 --web)
	if (platform.name === "pi-writer.exe") {
		zip.addBuffer(Buffer.from(START_BAT, "utf8"), "start.bat");
	}
	// skills/theme 等附加文件
	for (const item of EXTRA) {
		const abs = join(root, "release", item);
		if (!statSync(abs, { throwIfNoEntry: false })) continue;
		if (statSync(abs).isDirectory()) addRecursive(zip, abs, `${item}/`);
		else zip.addFile(abs, item);
	}
	zip.end();
	return new Promise((resolve, reject) => {
		const stream = createWriteStream(zipPath);
		zip.outputStream.pipe(stream).on("close", () => resolve(zipPath)).on("error", reject);
	});
}

for (const platform of PLATFORMS) {
	if (only && platform.dir !== only) continue;
	const result = await buildZip(platform);
	if (result) console.log(`✓ ${platform.dir} → ${result}`);
}
