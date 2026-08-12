# 开发指南

运行、测试、构建与代码约定。

## 环境要求

- Node.js ≥ 18.20.4
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
# 单测(vitest;仓库缺 monorepo base 配置,必须用临时配置)
npx vitest run --config vitest.tmp.config.ts

# 类型检查(tsconfig.tmp.json 覆盖 src+vendor+electron;vendor 有既有类型错误,忽略)
npx tsc -p tsconfig.tmp.json

# 前端类型检查
cd web && npx tsc --noEmit -p tsconfig.json
```

测试纪律:

- 只测**纯逻辑**(book-manager / config / editor / extension / world-tree / world-data / tools / world-context / writer-host 等),不碰真实 provider;
- `globals: true`;
- **test/ 不在 tsconfig include 内**:改过测试文件后,用严格旗标单独检查一次:
  `npx tsc --noEmit --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --exactOptionalPropertyTypes --skipLibCheck --types node test/<file>.test.ts`

## 构建与打包

| 命令 | 产物 | 依赖 |
|------|------|------|
| `npm run bundle` | `release/pi-writer.exe`(TUI 单文件,交叉编译) | bun |
| `npm run build:web` | `dist/web/server.cjs`(esbuild 单文件,自包含检查)+ `web/dist` 前端(vite) | 无 bun |
| `npm run web` | 直接运行服务端产物(`node dist/web/server.cjs`) | — |
| `npm run build:electron` | `dist/electron/main.cjs` + preload | bun |
| `npm run electron` | 运行 Electron 冒烟 | 先 build:electron |
| `npx electron-builder --win nsis` | `release/electron/pi-writer-web-<version>.exe` 安装包 | 先 build:web |

服务端产物必须叫 `.cjs`(包根 `type: module`,`.js` 会被当 ESM 解析)。

## 代码约定

- 只用 **erasable TypeScript**(无 `enum` / `namespace` / 参数属性);
- 工具定义走 `defineTool` + typebox `Type.Object`,勿手写 schema;
- 用户可见 UI 文案**中文内联**;prompt.ts 以英文为主(模型指令);
- **web 永远无 bash**(安全设计,勿放宽,见 security.md);
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

