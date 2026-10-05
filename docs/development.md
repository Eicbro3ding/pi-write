# 开发指南

运行、测试、构建与代码约定。

> **首次 clone 后先 `npm install`**:`postinstall` 会跑 `scripts/apply-patches.mjs`,把
> `patches/` 下的本地补丁施加到 pi 的 npm 包(幂等)。补丁失配会报 `Hunk #1 FAILED`
> —— 多半是版本号漂移(`package.json` 里四个 pi 包锁的是**精确版本** `1.0.2`,不要改回 `^`)。

## 环境要求

- Node.js ≥ 22.19.0（pi 1.0.2 的硬性要求；写 18.x 会让人装完在运行时才崩）
- 可选:[bun](https://bun.sh)——`npm run bundle`(TUI 单文件可执行与交叉编译)和 `npm run build:electron` 需要;`npm run build:web` 不需要

## 运行

```bash
# TUI(交互式)
npx tsx src/cli.ts --book <slug>

# TUI:单次提示(print 模式)
npx tsx src/cli.ts -p "提示词"

# TUI:新建书
npx tsx src/cli.ts --new-book "标题"

# Web 服务(默认 127.0.0.1:8811,自动开浏览器)
npx tsx src/cli.ts --web

# Web 服务 + 前端热更新(双终端)
# 终端一:
npx tsx src/cli.ts --web --no-browser
# 终端二:
cd web && npx vite dev        # vite 代理 /api → 8811

# 舞台区 CLI
npx tsx src/cli.ts --stage --book <slug>
```

web 模式与 TUI 共存:共用 `~/.pi/writer` 数据,可开不同端口并行。

## 测试与类型检查

```bash
# 单测(vitest;仓库已补本地 vitest.base.ts,直接运行默认配置)
npm test

# 单测指定文件
npx vitest --run test/server.test.ts

# 后端类型检查(仓库根 tsconfig.json)
npm run typecheck
# 等价写法(必须显式 -p,见下方警告):
npx tsc -p tsconfig.json --noEmit

# 前端类型检查
npx tsc -p web/tsconfig.json --noEmit
```

> ⚠️ **类型检查必须显式指定 `-p tsconfig.json`。**
> 在 2026-10-04(T6)之前,仓库**没有**根 `tsconfig.json` —— 那时裸跑 `npx tsc --noEmit`
> 会因找不到配置而**静默退回宽松默认设置**,对所有类型错误视而不见。当时它掩盖了 4 个
> 既有类型错误,直到补上 tsconfig 才暴露。
> **检查手段失效比没有检查更危险**:绿灯会让人以为验证过了。任何新增的检查脚本都要
> 先确认「它真的在检查东西」(用一个故意的错误验证一次)。

> **`skipLibCheck: true` 是必需品**:`pi-ai` 在 NodeNext 下有约 30 个 TS1543。关掉会看到一片噪音。

测试纪律:

- 只测**纯逻辑**(book-manager / config / editor / extension / world-tree / world-data / tools / world-context / writer-host 等),不碰真实 provider;
- `globals: true`;
- **test/ 不在 tsconfig include 内**:改过测试文件后,用严格旗标单独检查一次:
  `npx tsc --noEmit --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --exactOptionalPropertyTypes --skipLibCheck --types node test/<file>.test.ts`
  (已知技术债:全量纳入严格检查会暴露约 200 个既有错误,见 `PI_WRITER_IMPLEMENTATION.md` 的「登记项」)

## 构建与打包

| 命令 | 产物 | 依赖 |
|------|------|------|
| `npm run build` | `dist/cli.js` + `dist/index.js` + 声明(**注意:不产 server.cjs**) | — |
| `npm run build:web` | `dist/web/server.cjs`(esbuild 单文件,自包含检查)+ `web/dist` 前端(vite) | 无 bun |
| `npm run web` | 直接运行服务端产物(`node dist/web/server.cjs`,带产物新鲜度自检) | — |
| `npm run bundle` | `release/pi-writer.exe`(TUI 单文件,交叉编译) | bun |
| `npm run build:electron` | `dist/electron/main.cjs` + preload | bun |
| `npm run electron` | 运行 Electron 冒烟 | 先 build:electron |
| `npx electron-builder --win nsis` | `release/electron/pi-writer-web-<version>.exe` 安装包 | 先 build:web |

服务端产物必须叫 `.cjs`(包根 `type: module`,`.js` 会被当 ESM 解析)。

> ⚠️ **`npm run build` 与 `npm run build:web` 是两个不同的产物。**
> `npm run build` 只产 `dist/cli.js` / `dist/index.js`(tsc 声明 + esbuild),**不产** `dist/web/server.cjs`;
> 后者只由 `npm run build:web` 产出。所以「改源码 → `npm run build` → `npm run web`」会
> **跑在旧产物上,且不报任何错**(旧文件还在、能正常启动)。2026-10-05 T13 端到端排查时真踩过,
> 白查半小时。**兜底**:`npm run web` 已前置 `scripts/check-web-fresh.mjs`——比源码与产物的
> mtime,过期打醒目警告并给出正确命令(`exit 0` 不阻断);`test/build-scripts.test.ts` 钉住该契约。

## 代码约定

- 只用 **erasable TypeScript**(无 `enum` / `namespace` / 参数属性);
- **pi 框架的 import 一律走 `src/pi-adapter/`**:自研代码不准直接 `import "@earendil-works/pi-*"`,也禁止深层子路径(`.../dist/...`);`test/pi-adapter.test.ts` 有护栏。唯一例外是 `src/mcp/`(从包根 import `createMcpExtension`,理由见 `docs/architecture.md` §9 的坑 3);
- 工具定义走 `defineTool` + typebox `Type.Object`,勿手写 schema;
- 用户可见 UI 文案**中文内联**;prompt.ts 以英文为主(模型指令);
- **web 默认无 bash**(设置页「外部命令」可显式放开:缺省关 + 风险确认 + 命令与输出实时可见;改动这条边界前先读 security.md);
- 保持独立身份:不读取 `~/.pi/agent` 配置,不引入 coding-agent 的扩展 / 技能;
- 舞台提示词是模板字符串,内部**不要用反引号**。

### (禁止再造副本)

| 唯一实现 | 用途 |
|----------|------|
| `src/session-factory.ts` `createSessionRuntimeFactory` | 会话装配样板(cli/web/stage 共用) |
| `src/cjk.ts` `cjkCount` / `isCjkChar` | CJK 字符计数|
| `src/atomic-write.ts` `atomicWriteFile` | 文件原子写 |
| `src/session-text.ts` | 会话消息文本提取 |
| `src/config.ts` `resolveSkillsDir` | skills 目录三态探测 |
| `src/world-data.ts` `WORLD_FILES` / `WORLD_FILE_TITLES` | 世界书文件布局表 |

### 手写边界

- 允许手写(≤50 行且无安全边界):HTTP 路由表、SSE 帧协议、CLI 参数解析、If-Match 条件写、回环 Host/Origin 守卫。
- 必须用库:multipart → **busboy**;zip → **yazl/yauzl**;JSON Schema → **typebox**。

