# patches/ —— 上游 npm 包的本地补丁

> T11（D2 决策：npm 依赖 + patch）的落地物。
> **应用方式**：`node scripts/apply-patches.mjs`（已挂在 `postinstall`，装包后自动执行）。

## 为什么需要 patch

pi-write 对上游 `@earendil-works/pi-coding-agent` 有一处**能力性依赖**：工具路径守卫
（`setToolPathGuard`）。上游发布版**没有导出这个能力**，且 `exports` 未开
`./core/tools/*` 子路径，自研侧无法从包外接入。只能 patch。

## 文件清单

| patch | 影响文件 | 说明 |
|---|---|---|
| `pi-coding-agent-pathguard.patch` | **5**（4 个 `dist` 模块 + 1 个 `.d.ts`） | 路径守卫能力 |

**刻意不含 `package.json`**：它会被 `npm install` 重写，固化进 diff 会每次失配。
`exports` 子路径改由 `scripts/apply-patches.mjs` 注入，与版本解耦。

## ⚠️ 核心风险：这不是 1 个文件，是 5 个文件的协同改造

`resolveToCwd` 在原版只有一个签名 `(filePath, cwd)`，**没有 mode 概念**。
自研侧的守卫阀门按 mode 区分**只读放行 / 写入拒绝**。所以：

```
dist/core/tools/path-utils.js    → 加 setToolPathGuard / clearToolPathGuard，resolveToCwd 加第 3 参数 mode
dist/core/tools/path-utils.d.ts  → 同步类型声明（漏了它 TS 会报「无导出成员」）
dist/core/tools/write.js         → resolveToCwd(path, ctx?.cwd || cwd, "write")   ← 必须改
dist/core/tools/edit.js          → resolveToCwd(path, ctx?.cwd || cwd, "write")   ← 必须改
dist/core/tools/edit-diff.js     → resolveToCwd(path, cwd, "write")               ← 必须改
```

**错误形态一：只改 `path-utils.js` 而不改三个调用方**
所有调用都落到默认值 `"read"`（放行模式）→ **写入守卫静默失效**：
编译通过、运行无报错、越权写入悄悄成功。

**错误形态二：只改 `.js` 不改 `.d.ts`**
运行时正确，但 TypeScript 报 `has no exported member 'setToolPathGuard'` —— 类型层直接拦住编译。

`scripts/t11/verify-pathguard-patch.mjs` 里有一条**反证测试**专门锁住第一种形态。

## 版本兼容

patch 的 5 个锚点在 **1.0.2 与 1.0.3 上均命中**（实测），二者 dist 结构一致。
`package.json` 已锁定 `1.0.2` 精确版本，使「探针报告–patch–测试」三者自洽。

## 回归验证（必须跑）

```bash
node scripts/t11/verify-pathguard-patch.mjs
```

期望：`总判定：✅ 全部通过`，且含
`✅ 确认：漏传 mode 时写入守卫静默失效（反证成立，说明 3 处 caller 必须改）`。
