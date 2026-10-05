# patches/ —— 上游 npm 包的本地补丁

> T11（D2 决策：npm 依赖 + patch）的落地物。每个 patch 都必须附一条**可重放的验证脚本**，
> 见 `scripts/t11/`。

## 为什么需要 patch

pi-write 对上游 `@earendil-works/pi-coding-agent` 有一处**能力性依赖**：工具路径守卫
（`setToolPathGuard`）。上游 1.0.2 **没有导出这个能力**，且 `exports` 字段未开
`./core/tools/*` 子路径，所以无法从包外接入。只能 patch。

## 文件清单

| patch | 上游版本 | 影响文件数 |
|---|---|---|
| `pi-coding-agent@1.0.2-pathguard.patch` | 1.0.2 | **5**（4 个 dist 模块 + package.json） |

## ⚠️ 核心风险：这不是 1 个文件，是 5 个文件的协同改造

`resolveToCwd` 在原版只有一个签名 `(filePath, cwd)`，**没有 mode 概念**。
自研侧的守卫阀门按 mode 区分**只读放行 / 写入拒绝**。所以：

```
path-utils.js   → 加 setToolPathGuard / clearToolPathGuard，resolveToCwd 加第 3 参数 mode
write.js        → resolveToCwd(path, ctx?.cwd || cwd, "write")   ← 必须改
edit.js         → resolveToCwd(path, ctx?.cwd || cwd, "write")   ← 必须改
edit-diff.js    → resolveToCwd(path, cwd, "write")               ← 必须改
package.json    → 补 exports 子路径 ./core/tools/path-utils、./core/usage-totals
```

**如果只改 `path-utils.js` 而不改三个调用方**，所有调用都会落到默认值 `"read"`，
而 `"read"` 是放行模式 → **写入守卫静默失效**：编译通过、运行无报错、越权写入悄悄成功。
`scripts/t11/verify-pathguard-patch.mjs` 里有一条**反证测试**专门锁住这个形态。

## 应用方式

T11 步骤 4 会把它接进构建链（`patch-package` 或自建 apply 脚本）。手动应用：

```bash
cd <项目根>
patch -p1 < patches/pi-coding-agent@1.0.2-pathguard.patch
```

## 回归验证（必须跑）

```bash
node scripts/t11/verify-pathguard-patch.mjs
```

期望：`总判定：✅ 全部通过`，且含
`✅ 确认：漏传 mode 时写入守卫静默失效（反证成立，说明 3 处 caller 必须改）`。
