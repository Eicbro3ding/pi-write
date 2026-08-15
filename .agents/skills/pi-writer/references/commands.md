# pi-writer 命令与操作手册

## 运行

```bash
# TUI(交互模式)
npx tsx src/cli.ts --book <slug>
npx tsx src/cli.ts -p "prompt"            # 单次打印模式(非交互)
npx tsx src/cli.ts --new-book "标题"

# web 模式(GUI 后端,常驻 HTTP 服务 127.0.0.1:8811)
npx tsx src/cli.ts --web [--port N] [--no-browser] [--electron] [--book <slug>] [--model <pattern>] [--thinking <level>]
#  --no-browser 只起服务;--electron 经 Electron 壳打开窗口

# 前端开发(双终端,刻意不用 concurrently)
# 终端一:
npx tsx src/cli.ts --web --no-browser
# 终端二:
cd web && npx vite dev                    # vite 代理 /api → 8811,前端热更新
```

## 测试与检查

```bash
# 测试(仓库已补本地 vitest.base.ts,默认配置可用)
npm test
npx vitest run test/server.test.ts   # 单个文件

# 类型检查
npx tsc -p tsconfig.build.json --noEmit   # src+vendor;vendor 有既有错误,过滤 vendor/
cd web && npx tsc --noEmit -p tsconfig.json   # 前端
```

## 构建与打包

```bash
npm run build:web      # esbuild 打服务端 server.cjs + 主进程/preload + vite 前端;含自包含与导出契约检查;不依赖 bun
npm run web            # node dist/web/server.cjs 直接跑服务端产物
npm run build:electron # 构建 Electron 产物
npm run electron       # electron dist/electron/main.cjs 冒烟
npm run bundle         # TUI 单文件 exe(需 bun)→ release/pi-writer.exe + skills/theme/文档复制
npx electron-builder --win nsis   # 桌面安装包 → release/electron/pi-writer-web-<version>.exe(先 build:web)
```

## 调试服务(重要:避免污染真实数据)

```bash
# 正确姿势:env 前缀**不能**以分号结束(否则不生效,服务会写真实 ~/.pi/writer!)
env PI_WRITER_DIR="C:/Users/.../AppData/Local/Temp/piw-debug" \
    PI_WRITER_AGENT_DIR="C:/.../agent" \
    node dist/web/server.cjs --no-browser --port 8899
# 或源码模式:
env PI_WRITER_DIR="..." npx tsx src/cli.ts --web --no-browser --port 8899
```

## 常用 API 冒烟(node fetch,避免 curl 中文乱码)

```js
const B = "http://127.0.0.1:8899";
// 切书
await fetch(B + "/api/books/" + encodeURIComponent("书") + "/session", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ chapterFile: "ch01.jsonl" }) });
// 会话/分支树
const s = await (await fetch(B + "/api/session")).json();          // messages 带 id(entryId)
const t = await (await fetch(B + "/api/session/tree")).json();     // branches: leafId/isCurrent/count/summary/tail
// 撤回/分支/导航
await fetch(B + "/api/messages/retract", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ entryId, replacement? }) });
await fetch(B + "/api/messages/branch",  { ... body: JSON.stringify({ entryId }) });
await fetch(B + "/api/messages/navigate",{ ... body: JSON.stringify({ entryId }) });
// MCP
await fetch(B + "/api/mcp", { method: "POST", ... body: JSON.stringify({ name, type: "stdio"|"http"|"sse", command?, args?, url? }) });
// If-Match 条件写
await fetch(B + "/api/draft", { method: "PUT", headers: { "content-type":"application/json", "if-match": String(mtime) }, body: JSON.stringify({ file, text }) });
```

## TUI 内部命令(/ 开头)

`/chapters` `/new-chapter` `/rename-chapter` `/rename-book` `/book` `/new-book` `/world` `/notice` `/storyline` `/constraints` `/relations` `/edit [path]` `/adopt-draft <file.md>`(共 13 个);技能经 `/skill:name`(outline/critique/revise/stage-scripting)。

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_WRITER_DIR` | 数据根(默认 ~/.pi/writer) |
| `PI_WRITER_AGENT_DIR` | agent 配置目录(默认 <writer>/agent;mcp.json/auth.json 在此) |
| `PI_WRITER_TOKEN` | web 服务可选 Bearer token(Android 壳注入) |
| `PI_WRITER_SKILLS_DIR` / `PI_WRITER_WEB_DIR` | skills/静态资源覆盖(Android) |
| `PI_WRITER_NO_SPAWN_TOOLS` | 剔除 grep/find(无 spawn 环境) |
