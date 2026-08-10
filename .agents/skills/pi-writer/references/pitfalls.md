# pi-writer 常见坑与修复记录

## 1. tsc 的 vendor 类型错误(不是你的问题)

`npx tsc -p tsconfig.tmp.json` 会报 vendor 既有错误:
- `vendor/pi-ai/src/api/openai-codex-responses.ts` — fetch BodyInit 类型不兼容(Node/undici 版本)
- `vendor/pi-coding-agent/src/core/http-dispatcher.ts` — undici `clientFactory`/`install` 类型

**处理**:`grep -v "^vendor/"` 过滤,只看 src/ 与 test/ 的错误。不要"修" vendor 类型(会破坏与 monorepo 同步)。

## 2. 冒烟服务写进真实数据目录(事故记录)

```bash
# 错误:分号使 env 前缀失效,node 读不到 PI_WRITER_DIR,服务操作真实 ~/.pi/writer
PI_WRITER_DIR="/tmp/x"; node dist/web/server.cjs ...
# 正确
env PI_WRITER_DIR="/tmp/x" node dist/web/server.cjs ...
```
事故后果:在用户真实目录创建了测试书、touch 了 book.json、覆盖了 draft 文件。**排查污染**:`ls ~/.pi/writer/books/*/book.json` 按 createdAt/updatedAt 找异常;book 目录缺 book.json 会从列表消失(listBooks 跳过)。

## 3. @modelcontextprotocol/sdk 顶层导出缺陷

1.30.0 的 package.json `exports["."]` 指向 `./dist/esm/index.js`(不存在)。**必须从子路径导入**:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
```
esbuild 能正确解析(`./*` 通配映射)。SDK 的 `CallToolResult.isError` 类型是 unknown,转 boolean 再传。

## 4. 服务端产物 .cjs 后缀

包根 `package.json` 是 `type: module`,`dist/web/server.cjs` 必须保持 .cjs(esbuild 打 CJS;.js 会被当 ESM 解析报 "require is not defined")。esbuild 打 CJS 时 `import.meta` 恒空对象,web-build.mjs 的 importMetaUrlPlugin 把 `import.meta.url` 烘焙为源文件 URL 常量。

## 5. Windows 文件 mtime 精度

短间隔两次写入可能共享 mtime(NTFS 时间戳缓存),If-Match 比较有 1ms 容差。测试里模拟"外部修改"用:
```ts
writeFileSync(f, "新内容");
const st = statSync(f);
utimesSync(f, st.atime, new Date(st.mtimeMs + 5000)); // 明确推进 5s
```

## 6. Git Bash curl 中文乱码

curl 发中文 body/URL 会按本地编码发送,服务端收到乱码(建出标题乱码的书)。**用 node fetch 或 python requests 发请求**;URL 编码用 `encodeURIComponent`。

## 7. 服务残留进程

- ZCode 的 TaskStop/后台任务停止可能杀不干净 node 子进程(tsx/npx 包装)。
- 端口占用排查:`netstat -ano | grep ":PORT" | grep LISTEN` → `taskkill //PID <pid> //F`。
- 残留服务跑的是**旧代码**(改代码后必须重启才能生效),可能让人误判 bug。

## 8. 分支状态只在内存

`SessionManager` 的 leaf 指针**不落盘**:服务重启/SessionManager.open 后 leaf 回到文件最深路径。已修复点:
- `SessionHost.reloadRuntime()` 保存 `prevLeafId` 并在 open 后 `branch(prevLeafId)` 恢复(MCP 配置保存不再串分支)。
- 手工改会话文件/重启不会丢消息(文件里全保留),只会丢"当前分支位置"。

## 9. 前端 SSE 分支处理

WritePage 的 SSE 订阅里,拦截事件(如 agent_settled)后**必须 dispatch(e)**,否则 reducer 状态卡死:
- 事故:agent_settled 被 return 跳过 → isStreaming 恒 true → 指示器不停、按钮一直是"中断"。
- 同理:切书/切章后分支树 state 残留旧书(串书)→ resetChat 里 setBranchTree(null),applyMessages 完成后 refreshBranchTree。

## 10. extractMessages 分组规则(服务端是唯一分组权威)

前端水合(applyMessages/alignWithServer)与 SSE 实时路径的合并规则必须一致:
- user 消息开新组;同轮(同一 user 之后)多条 assistant 合并为一条气泡(text 空行拼接、thinking 拼接、工具卡片顺序保留)。
- 服务端 `extractMessages` 按 getBranch() 提取(撤回后旧分支自然消失),id 取组内最后一条 entry 的 id。
- 分支栏摘要:summary 取路径上**最后一条 user 消息**(分支共享前缀时第一条相同,无法区分),tail 取最后一条消息。
