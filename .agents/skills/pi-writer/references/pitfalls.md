# pi-writer 常见坑与修复记录

## 1. `npm run build` ≠ `npm run build:web`(2026-10-05 踩过)

`npm run build` 只产 `dist/cli.js` / `dist/index.js` / 声明;`npm run web` 跑的是 **`dist/web/server.cjs`**,那个文件**只由 `npm run build:web` 产出**。

于是最自然的路径「改源码 → `npm run build` → `npm run web`」会**跑在旧产物上**:旧文件还在、能正常启动、**不报任何错**。2026-10-05 T13 端到端排查时真踩过 —— 据此一度判定「MCP 配置迁移完全没生效」,实际是产物停在旧版本,白查半小时。

**兜底**:`npm run web` 已前置 `scripts/check-web-fresh.mjs`,递归取 `src` / `web/src` / `electron` / `scripts/web-build.mjs` 的最新 mtime 与产物比对,过期就打醒目警告 + 给出正确命令(`exit 0` 不阻断 —— 「跑旧产物看别的功能」有时是合理的)。`test/build-scripts.test.ts` 钉住这个契约,别把自检从 web 脚本里摘掉。

## 2. 冒烟服务写进真实数据目录(事故记录)

```bash
# 错误:分号使 env 前缀失效,node 读不到 PI_WRITER_DIR,服务操作真实 ~/.pi/writer
PI_WRITER_DIR="/tmp/x"; node dist/web/server.cjs ...
# 正确
env PI_WRITER_DIR="/tmp/x" node dist/web/server.cjs ...
```
事故后果:在用户真实目录创建了测试书、touch 了 book.json、覆盖了 draft 文件。**排查污染**:`ls ~/.pi/writer/books/*/book.json` 按 createdAt/updatedAt 找异常;book 目录缺 book.json 会从列表消失(listBooks 跳过)。

## 3. 改 pi 包要走 patches,别直接改 node_modules

本地对 pi 的改动**只放 `patches/`**,由 `scripts/apply-patches.mjs` 在 `postinstall` 施加(幂等)。直接改 `node_modules/@earendil-works/...` 的后果:下次 `npm install` 被覆盖,改动无声消失。

现有两个补丁(见 `NOTICE-pi.md` §3):
- `pi-coding-agent-pathguard.patch` —— **安全边界**。给 `core/tools/path-utils` 注入 `setToolPathGuard`,并让 `write`/`edit`/`edit-diff` 三处调用方传 `mode`。上游 1.0.2 没有这个能力,自研侧经 `src/pi-adapter/guard.ts` 收口。
- 脚本注入(非补丁):给包 `exports` 加 `./core/tools/path-utils` 与 `./core/usage-totals` 两个子路径。

**路径守卫是唯一会静默失效的东西**:补丁只改 `path-utils.js` 而不改三个调用方,守卫装上了却没人传 `mode`,越权写入一次都不会被拦 —— 编译不报错、运行不报错,只有 `test/tool-guard.test.ts` 能发现。判据见 `patches/README.md`。

补丁失配表现为 `postinstall` 报 `Hunk #1 FAILED` —— 多半是版本号漂移(`package.json` 里四个 pi 包锁**精确版本** `1.0.2`,不要改回 `^`)。

## 4. `@modelcontextprotocol/sdk` 已是孤儿依赖

2026-10-05 T9-A 把 MCP 换成上游 pi 扩展后,`src/` 内**已无 SDK 引用**(只剩 `McpServerList.tsx` 一处占位符文案)。传输、OAuth、资源列表全由上游负责。**别为 MCP 把 SDK 用回来** —— 那是回退到 T9-A 之前(自研 843 行重造上游已有的东西)。

## 5. 服务端产物 .cjs 后缀

包根 `package.json` 是 `type: module`,`dist/web/server.cjs` 必须保持 .cjs(esbuild 打 CJS;.js 会被当 ESM 解析报 "require is not defined")。esbuild 打 CJS 时 `import.meta` 恒空对象,web-build.mjs 的 importMetaUrlPlugin 把 `import.meta.url` 烘焙为源文件 URL 常量。

## 6. Windows 文件 mtime 精度

短间隔两次写入可能共享 mtime(NTFS 时间戳缓存),If-Match 比较有 1ms 容差。测试里模拟"外部修改"用:
```ts
writeFileSync(f, "新内容");
const st = statSync(f);
utimesSync(f, st.atime, new Date(st.mtimeMs + 5000)); // 明确推进 5s
```

## 7. Git Bash curl 中文乱码

curl 发中文 body/URL 会按本地编码发送,服务端收到乱码(建出标题乱码的书)。**用 node fetch 或 python requests 发请求**;URL 编码用 `encodeURIComponent`。

## 8. 服务残留进程

- ZCode 的 TaskStop/后台任务停止可能杀不干净 node 子进程(tsx/npx 包装)。
- 端口占用排查:`netstat -ano | grep ":PORT" | grep LISTEN` → `taskkill //PID <pid> //F`。
- 残留服务跑的是**旧代码**(改代码后必须重启才能生效),可能让人误判 bug。

## 9. 分支状态只在内存

`SessionManager` 的 leaf 指针**不落盘**:服务重启/SessionManager.open 后 leaf 回到文件最深路径。已修复点:
- `SessionHost.reloadRuntime()` 保存 `prevLeafId` 并在 open 后 `branch(prevLeafId)` 恢复(MCP 配置保存不再串分支)。
- 手工改会话文件/重启不会丢消息(文件里全保留),只会丢"当前分支位置"。

## 10. 前端 SSE 分支处理

WritePage 的 SSE 订阅里,拦截事件(如 agent_settled)后**必须 dispatch(e)**,否则 reducer 状态卡死:
- 事故:agent_settled 被 return 跳过 → isStreaming 恒 true → 指示器不停、按钮一直是"中断"。
- 同理:切书/切章后分支树 state 残留旧书(串书)→ resetChat 里 setBranchTree(null),applyMessages 完成后 refreshBranchTree。

## 11. extractMessages 分组规则(服务端是唯一分组权威)

前端水合(applyMessages/alignWithServer)与 SSE 实时路径的合并规则必须一致:
- user 消息开新组;同轮(同一 user 之后)多条 assistant 合并为一条气泡(text 空行拼接、thinking 拼接、工具卡片顺序保留)。
- 服务端 `extractMessages` 按 getBranch() 提取(撤回后旧分支自然消失),id 取组内最后一条 entry 的 id。
- 分支栏摘要:summary 取路径上**最后一条 user 消息**(分支共享前缀时第一条相同,无法区分),tail 取最后一条消息。

## 12. 解耦只做了「会话身份」,提示词没跟上(2026-10-03 修)

**现象**:设置里切成「对话与章节分离」(或首启向导「对话范围」选分离)后,AI 仍然按「一段对话绑一章」行事 —— 用户让它改第二章,它说这属于另一章的对话 / 只肯写当前章。

**根因**:`2b4ab48`(对话与章节解耦)改了 `writer-host` 的会话身份、`writerDraftFile` 的正文白名单、`createConversation`,**没动 `prompts/`**。于是:
- `writer-main.md` 仍写「每个 pi-writer *会话*对应书的一章」「散文只有一个落点:当前章节的 `draft/<章节id>.md`」;
- `writer-editor.md` 仍写「正文文件**固定**为 `draft/<章节id>.md`,**由当前章节决定**……写其他路径会被工具拒绝」—— 而分离模式下 `writerDraftFile()` 返回 `undefined`,白名单根本没设,这是一句**与事实相反**的假约束。

**修法**(三处同源):
1. `prompts/writer-main.md` / `writer-editor.md` 里凡随 `conversationScope` 变的事实一律写成 `{SCOPE_SECTION}` / `{SESSION_SCOPE_LINE}` / `{DRAFT_MIRROR_LINE}` / `{EDITOR_SCOPE_LINE}` / `{EDITOR_DRAFT_RULE}` 占位;
2. 值只放 `src/prompt.ts` 的 `SCOPE_VARS`(唯一实现);渲染入口 `buildWriterSystemPrompt(tools, shell, scope)`、`buildEditorSystemPrompt(scope)`;
3. **哪个宿主用哪套**由 `web/writer-host.ts` 的 `hostPromptScope(conversationScope, key)` 定:key 是 `<id>.jsonl` 才算绑章。分离模式下自由对话(`c-xxxx` / `default`)走分离叙述,而**收幕成文**(`chatAndWait` 永远按章节键取宿主)拿的必须是绑章那套 —— 它这次就是要落某一章的正文。

**不可回退的契约**:chapter 一列的文本是解耦前原话,`SCOPE_SECTION` 在 chapter 下渲染成空串 —— 默认模式的系统提示**逐字节不变**(`test/prompt.test.ts` 钉住:绑定原话在、《对话范围》整节不在、两种范围都不残留 `{占位}`)。改提示词时同时看 `test/prompts.test.ts` 的中间产物护栏(`散文只有一个落点` / `draft/<章节id>.md` 必须还在)。
