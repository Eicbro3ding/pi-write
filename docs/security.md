# 安全模型

pi-writer 是本地创作工具:web 服务默认绑定 `127.0.0.1`,agent 拥有文件读写与网络能力。本文档说明信任边界与防护措施。

## 威胁模型

默认信任边界是「本机用户」。web 服务无鉴权,任何本机进程或本机浏览器标签页都能驱动 agent,因此防护重点是:

1. **不越界**:agent 的能力不超出书目录与显式放行目录;
2. **不被利用**:本机恶意网页 / 进程不能借服务做危险操作(任意命令执行、读写任意文件);
3. **数据不损坏**:世界书、草稿不被并发写坏或静默覆盖。

## 工具路径守卫

`installToolPathGuard(bookDir, readOnlyDirs)`:

- read / write / edit / grep / find / ls 等文件工具限制在**书目录内**;
- `skills/` 目录**只读**放行(模型经 read 加载技能文件);
- 编剧会话额外有 draft 文件名白名单(只允许写当前章节文件,防 agent 自创文件名导致前端读不到)。

## 世界书写保护

- **`world_update` 是唯一变更通道**:提示词 + 守卫双重约束禁止 edit/write 直改 world.json;结构化校验(重复 id、悬空引用、多个 in-progress、自环关系等)由程序执行;
- **读-改-写整体持锁**(`withWorldLock`):并行 world_update 串行化,消除丢失更新与共享 tmp 竞态;
- **原子写**(`saveWorld`):校验 → 备份 → 唯一 tmp + rename 重试(Windows EPERM 兜底)→ 写后校验失败回滚;
- **If-Match 条件写**:web 端 `PUT /api/world` / `PUT /api/draft` 支持 `If-Match`(mtime 比较,不符 → 409),防本地旧文本覆盖 AI / 其他窗口的新修改。

## 服务端防护

- **回环绑定**:默认 127.0.0.1,不对外网暴露;
- **Host / Origin 守卫**:拒绝非回环 Host 与非本机 Origin(防 DNS rebinding 与跨站请求驱动 agent);
- **可选鉴权**:`PI_WRITER_TOKEN` env 启用 Bearer / cookie token(Android 移植预留,`WriterServerOptions.authToken`);
- **multipart 用 busboy**:手写 boundary 切分是安全 bug 高发区,已替换;错误契约:非 multipart → 400、超限 → 400 `too_large`;
- **路径防穿越**:book-zip 导出 / 导入(50MB zip / 100MB 解压总量 / 2000 条目 / 路径安全校验)、预览卡持久化、draft 白名单均校验路径;
- **静态服务**:`web/dist` 存在时对非 /api 提供静态页面(生产模式),SPA fallback。

## MCP 安全

- 配置在本地 `~/.pi/writer/agent/mcp.json`(被 gitignore,密钥不提交);
- stdio 服务器即本地进程——只挂可信的、最小权限的服务器;
- 断线自动重连(3-30s 退避);stdio 失败带 stderr 尾部;
- OAuth 授权流**未实现**,遇到 OAuth 端点明确报错提示,不做静默降级。

## 数据与密钥

- API 密钥只存在于本地文件(`auth.json` / `models.json` / `mcp.json`,均被 gitignore);
- 删除书:`handleDeleteBook` 先释放内存会话(防 AI 继续写 draft/world.json 导致目录「复活」),rmSync 带 EPERM 重试;
- 世界书 md 视图是导出(头部注明「编辑请走界面」),手动编辑会被下一次保存覆盖。

## 已知边界(注意)

- web 服务无鉴权(默认):同机任意进程可驱动 agent;token 鉴权为可选加固;
- 提示词约束(如「工作目录为书目录」)是软约束,硬边界由工具守卫承担;
- 舞台 / 编剧会话与主会话共用同一 agent 运行时,权限面一致。
