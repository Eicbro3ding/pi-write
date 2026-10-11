/**
 * 打包 examples/plugins/ 下的示例插件为可安装的 zip。
 *
 * 产物落在 release/plugins/<id>-<version>.zip,可直接在
 * 设置 → 集成 → 插件 → 「安装插件」里上传。
 *
 * 布局:外层带一层 `<id>/` 目录(服务端安装时会剥掉单层包裹),
 * 这样解压后的目录名与 plugin.json 的 id 对齐,也便于人工查看。
 *
 * 用法:
 *   node scripts/make-plugin-zips.mjs            # 打全部示例插件
 *   node scripts/make-plugin-zips.mjs balance    # 只打指定 id
 */
import { mkdirSync, readdirSync, statSync, readFileSync, createWriteStream } from "node:fs";
import { join, relative } from "node:path";
import { ZipFile } from "yazl";

const root = process.cwd();
const srcRoot = join(root, "examples", "plugins");
const outDir = join(root, "release", "plugins");
mkdirSync(outDir, { recursive: true });

/** 不进 zip 的噪音(编辑器/系统生成的临时文件)。 */
const SKIP = new Set([".DS_Store", "Thumbs.db"]);
const SKIP_DIRS = new Set(["node_modules", "__MACOSX", ".git"]);

function addRecursive(zip, absDir, zipPrefix) {
	for (const entry of readdirSync(absDir)) {
		if (SKIP.has(entry)) continue;
		const abs = join(absDir, entry);
		const stat = statSync(abs);
		if (stat.isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue;
			addRecursive(zip, abs, `${zipPrefix}${entry}/`);
		} else {
			zip.addFile(abs, `${zipPrefix}${entry}`);
		}
	}
}

/** zip 里所有文件读完后才能收尾 —— yazl 是流式的,故用 Promise 包一层。 */
function writeZip(zip, outPath) {
	return new Promise((resolve, reject) => {
		zip.outputStream
			.pipe(createWriteStream(outPath))
			.on("close", resolve)
			.on("error", reject);
		zip.end();
	});
}

const only = process.argv[2];
const ids = readdirSync(srcRoot).filter((d) => statSync(join(srcRoot, d)).isDirectory());
const targets = only ? ids.filter((id) => id === only) : ids;
if (targets.length === 0) {
	console.error(only ? `没有找到示例插件:${only}` : "examples/plugins/ 下没有插件");
	process.exit(1);
}

for (const id of targets) {
	const dir = join(srcRoot, id);
	const manifestPath = join(dir, "plugin.json");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (e) {
		console.error(`✗ ${id}: 读不到/解析不了 plugin.json (${e instanceof Error ? e.message : String(e)})`);
		process.exitCode = 1;
		continue;
	}
	if (manifest.id !== id) {
		console.error(`✗ ${id}: plugin.json 的 id 是 "${manifest.id}",与目录名不一致,跳过`);
		process.exitCode = 1;
		continue;
	}
	const outPath = join(outDir, `${id}-${manifest.version ?? "0.0.0"}.zip`);
	const zip = new ZipFile();
	// 外层包一层目录(单层包裹,服务端会剥),内部保持原相对结构
	addRecursive(zip, dir, `${id}/`);
	await writeZip(zip, outPath);
	console.log(`✓ ${relative(root, outPath)}  (id=${id} v${manifest.version ?? "?"})`);
}
