/**
 * T11 步骤 4：构建链与打包适配（一次性脚本）
 *
 * 背景：pi 六个包从 `vendor/` 源码改为 npm 依赖（D2 / T11）。凡是构建链里
 * 「按 vendor 路径取文件」的地方都要改指 node_modules，否则 vendor 一删就断：
 *
 *   1. `bundle` 脚本拷主题 json  —— 发行物里没有主题会闪退到默认配色
 *   2. `files` / `electron-builder` 白名单里的 `vendor/LICENSE-pi.txt`、
 *      `vendor/NOTICE.md` —— MIT 要求许可全文随发行物分发，删了就违约
 *   3. 两个测试直接读 vendor 源码 —— 删了就红
 *
 * 为什么用脚本而不是逐个 Edit：这些替换分散在 5 个文件、且**替换前后差异很小**，
 * 手工改最容易漏掉其中一条（漏了构建链不报错，只在打包/发布时现形）。脚本对每条
 * 替换断言「出现次数必须为 N」，跑第二遍也不会重复改。
 *
 * 用法：node scripts/t11/step4-build-chain.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let changed = 0;
const failures = [];

/**
 * 精确替换并断言次数。
 * count 传 0 表示「允许已经改过」（幂等），会跳过写入。
 */
function replace(rel, from, to, count) {
	const abs = path.join(ROOT, rel);
	const text = readFileSync(abs, "utf-8");
	const hits = text.split(from).length - 1;
	if (hits === count) {
		if (hits > 0) {
			writeFileSync(abs, text.split(from).join(to), "utf-8");
			changed++;
			console.log(`  ✓ ${rel}: ${hits} 处  ${describe(from)}`);
		} else {
			console.log(`  · ${rel}: 已是目标形态（跳过）  ${describe(from)}`);
		}
		return;
	}
	failures.push(`${rel}: 期望 ${count} 处、实到 ${hits} 处 —— ${describe(from)}`);
}

function describe(s) {
	const one = s.replace(/\s+/g, " ");
	return one.length > 64 ? `${one.slice(0, 61)}…` : one;
}

function sh(cmd, args) {
	return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

console.log("\n[1/5] package.json —— 依赖锁版本 + bundle 取文件路径 + files 白名单");

// ① patch 是对 dist 做的文本补丁，靶心就是 1.0.2；`^1.0.2` 会装到 1.0.3 让 patch 失配
//    （1.0.3 的 pi-tui 有破坏性变更，已在 T11 前置核实中踩过一次）
replace(
	"package.json",
	'"@earendil-works/pi-coding-agent": "^1.0.2"',
	'"@earendil-works/pi-coding-agent": "1.0.2"',
	1,
);

// ② 主题 json：vendor 的 src/ 路径 → npm 包的 dist/ 路径
replace(
	"package.json",
	"shx cp vendor/pi-coding-agent/src/modes/interactive/theme/*.json release/theme/",
	"shx cp node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/*.json release/theme/",
	1,
);

// ③ 发行物里的 pi 许可声明：从 vendor/ 迁到仓库根（vendor 目录整体删除）
replace(
	"package.json",
	"shx cp vendor/LICENSE-pi.txt vendor/NOTICE.md release/",
	"shx cp LICENSE-pi.txt NOTICE-pi.md release/",
	1,
);

replace(
	"package.json",
	'    "vendor/LICENSE-pi.txt",\n    "vendor/NOTICE.md"',
	'    "LICENSE-pi.txt",\n    "NOTICE-pi.md"',
	1,
);

console.log("\n[2/5] electron-builder.yml —— 发行白名单同步");

replace(
	"electron-builder.yml",
	"  - vendor/LICENSE-pi.txt\n  - vendor/NOTICE.md",
	"  - LICENSE-pi.txt\n  - NOTICE-pi.md",
	1,
);

replace(
	"electron-builder.yml",
	"dist/web/server.cjs 全量内联了 vendor 的 pi 内核与 500+ npm 模块",
	"dist/web/server.cjs 全量内联了 pi 内核与 500+ npm 模块",
	1,
);

console.log("\n[3/5] git mv —— pi 许可全文迁出 vendor/（保留历史，便于追溯来源）");

const licenseExists = (() => {
	try {
		readFileSync(path.join(ROOT, "LICENSE-pi.txt"));
		return true;
	} catch {
		return false;
	}
})();
if (licenseExists) {
	console.log("  · LICENSE-pi.txt 已在根目录（跳过）");
} else {
	sh("git", ["mv", "vendor/LICENSE-pi.txt", "LICENSE-pi.txt"]);
	console.log("  ✓ git mv vendor/LICENSE-pi.txt → LICENSE-pi.txt");
	changed++;
}

console.log("\n[4/5] test/skill-invocation.test.ts —— 正则同源对照改指 npm 包产物");

// 这条测试钉的是「web 侧的展开态正则与上游 parseSkillBlock 逐字一致」：
// 上游换了写法而我们没跟上，技能展开态就会解析不出来（静默）。
// 原来读 vendor 源码，现在读 npm 包的 dist 产物 —— 已验证 dist 里正则字面量
// 与 vendor 源码逐字相同（编译不改写正则字面量）。
replace(
	"test/skill-invocation.test.ts",
	'readFileSync("vendor/pi-coding-agent/src/core/agent-session.ts", "utf-8")',
	'readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js", "utf-8")',
	1,
);

replace(
	"test/skill-invocation.test.ts",
	' * ① 展开态的正则与 vendor 的 `parseSkillBlock` 逐字同形(web 包不能 import vendor,',
	' * ① 展开态的正则与 pi 上游的 `parseSkillBlock` 逐字同形(web 包不能 import pi,',
	1,
);

replace("test/skill-invocation.test.ts", 'describe("与 vendor 的格式约定同源"', 'describe("与 pi 上游的格式约定同源"', 1);
replace("test/skill-invocation.test.ts", "展开态正则与 vendor parseSkillBlock 逐字一致", "展开态正则与 pi 上游 parseSkillBlock 逐字一致", 1);
replace("test/skill-invocation.test.ts", 'const vendor = skillRegexLiteral(', 'const upstream = skillRegexLiteral(', 1);
replace("test/skill-invocation.test.ts", "expect(mine).toBe(vendor);", "expect(mine).toBe(upstream);", 1);

console.log("\n[5/5] test/skill-references.test.ts —— 技能加载改走包入口");

// `loadSkills` / `formatSkillsForPrompt` 在 1.0.2 的**包主入口**就有导出
// （dist/index.d.ts 的 `export { formatSkillsForPrompt, loadSkills, … } from "./core/skills.ts"`），
// 所以这里不需要新增 exports 子路径 —— 直接走包入口，比深层路径更稳。
replace(
	"test/skill-references.test.ts",
	'\t\tconst { formatSkillsForPrompt, loadSkills } = await import(\n\t\t\t"../vendor/pi-coding-agent/src/core/skills.ts"\n\t\t);',
	'\t\tconst { formatSkillsForPrompt, loadSkills } = await import("@earendil-works/pi-coding-agent");',
	1,
);

replace(
	"test/skill-references.test.ts",
	"每个技能的 SKILL.md 都能被 vendor 加载",
	"每个技能的 SKILL.md 都能被 pi 加载",
	1,
);

console.log("\n" + "=".repeat(64));
if (failures.length > 0) {
	console.error(`✗ ${failures.length} 条替换未命中：\n`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(`✓ 步骤 4 完成：${changed} 处改动`);
console.log("  下一步：THIRD-PARTY.md / NOTICE-pi.md 需人工改写（许可声明措辞），再跑 typecheck + 全量测试");
