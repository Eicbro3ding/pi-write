# pi-write 前端 UI 评审 · 修复计划

> 依据：2026-08 UI 评审（Bug / 友好度 / 一致性 / 美观度 四表），逐条核对源码后确认 **8 条属实、1 条部分属实、1 条无法证实、1 条误报**。本文件记录确认待修项的修复方案与进度。

## 范围与状态总览

| 编号 | 问题 | 严重度 | 结论 | 状态 |
|---|---|---|---|---|
| B1 | 世界书「新增节点」「添加」按钮窄容器内文字竖排折行 | P1 | ✅ 属实 | ✅ 已完成并验证 |
| B2 | 设置页错误提示内联硬编码 `#e08a8a` | P2 | ✅ 属实 | ✅ 已完成并验证 |
| F2 | 顶栏书名重复《X》· X（title===slug） | P1 | ✅ 属实 | ✅ 已完成并验证 |
| F3 | 移动端纸张底部仍显示 Alt+E / Ctrl+S 快捷键 | P1 | ✅ 属实 | ✅ 已完成并验证 |
| F4 | 保存状态双份显示（顶栏 + 纸张底部） | P2 | ✅ 属实 | ✅ 已完成并验证 |
| F5 | 舞台空态暴露内部工具名 stage_script | P2 | ✅ 属实 | ✅ 已完成并验证 |
| C1 | 中文标点混排（全角分号 + 半角逗号） | P1 | ✅ 属实 | ✅ 已完成并验证 |
| F1 | 发展线「下一步」placeholder 语义 | P1 | ⚠️ 部分属实 | ✅ 已完成并验证 |
| C3 | 图标按钮 title/aria-label 覆盖不均 | P2 | ⚠️ 大体属实 | ✅ 已完成并验证 |
| B3 | activeLine 是 basicSetup 默认样式 | P2 | ❌ 误报 | — 不动 |
| C2 | 同一模型两种拼写 | P1 | ❓ 无法证实 | — 待数据佐证 |

---

## A. Bug 修复

### B1 · 按钮文字竖排折行（世界书「新增节点」「添加」）
- **根因**：`.w-story-add` / `.w-timeline-add` 是 flex 行，内部 `.btn-ghost` 无 `white-space: nowrap` 也无 `flex: none`，窄容器下按钮被压缩、CJK 文字竖排。
- **方案**：给 `.btn-ghost` 基础规则加 `flex: none; white-space: nowrap;`（全局幽灵按钮通用，不影响其他用法）。
- **文件**：`web/src/styles.css` `.btn-ghost`

### B2 · 设置页错误提示硬编码颜色
- **根因**：`pages/SettingsPage.tsx:710` `<span className="s-busy" style={{ color: "#e08a8a" }}>`，绕过 `--red` token，不随主题适配。
- **方案**：删内联 style，改用 `className="s-busy err"`；在 `styles.css` 新增 `.s-busy.err { color: var(--red); }`。
- **文件**：`pages/SettingsPage.tsx`、`web/src/styles.css`

---

## B. 友好度修复

### F2 · 顶栏书名重复
- **根因**：`App.tsx:64` 无条件拼 `` 《${bookTitle}》 · ${bookSlug} ``，title===slug（默认书）时重复。
- **方案**：仅当 `bookSlug !== bookTitle` 时追加 slug 段。
- **文件**：`web/src/App.tsx`

### F3 · 移动端键盘快捷键提示
- **根因**：`DraftWorkspace.tsx:334` 的 `.d-hint` 无窄屏处理，触屏下仍显示「Alt+E 进入编辑 · Ctrl+S 保存」。
- **方案**：键位段包 `<span className="d-keys">`，新增 `@media (max-width: 768px) { .d-hint .d-keys { display:none; } }`。
- **文件**：`web/src/components/DraftWorkspace.tsx`、`web/src/styles.css`

### F4 · 保存状态双份显示
- **根因**：顶栏 stat + 纸张底部 `.d-hint` 各显示一次「已保存 · N 字」。
- **方案**：稳态 `status === "saved"` 时底部不再重复「✓ 已保存」，保留异常态（加载中/未保存/保存中/失败）本地提示与字数。
- **文件**：`web/src/components/DraftWorkspace.tsx`

### F5 · 舞台空态黑话
- **根因**：`StagePanel.tsx:84`「导演会用 stage_script 工具开演」暴露内部工具名。
- **方案**：改为「导演就会开演。」（对作者友好，隐藏工具实现）。
- **文件**：`web/src/components/StagePanel.tsx`

---

## C. 一致性修复

### C1 · 中文标点混排
- **根因**：placeholder/说明文案同一句内全角分号「；」+ 半角逗号「,」混用（如 `StagePage.tsx:767`、`WritePage.tsx:1200`、`McpServerList.tsx:220`）。
- **方案**：用户可见中文文案统一为全角标点（，；）。逐处替换。
- **文件**：`pages/StagePage.tsx`、`pages/WritePage.tsx`、`components/McpServerList.tsx`、`components/StorylinePanel.tsx`、`components/TimelinePanel.tsx`

### C3 · 图标按钮 title/aria-label 补齐
- **根因**：抽查 4 组件 36 个 `<button>`，仅 11 个开标签带 title/aria-label；图标按钮确有遗漏。
- **方案**：扫描纯图标按钮（children 只有 Icon 组件）无 title/aria-label 者补齐；有可见文本的按钮不强制。
- **文件**：相关 `components/*.tsx`、`pages/*.tsx`

---

## D. 涉及设计决策的两条（附处理意见）

### F1 · 发展线「下一步」暴露原始 id
- **核对结论**：该字段是**自由文本**，语义是「该节点完成后的剧情走向」，**不是节点引用**——placeholder 已写「非 id」。评审建议改成「下拉选已有节点」与数据模型冲突，**不应采纳**。
- **方案**：优化 placeholder 文案，明确「不要填节点编号」。如：`下一步(该节点完成后的剧情走向,而非节点编号)`。
- **文件**：`components/StorylinePanel.tsx`

### C2 · 同一模型两种拼写
- **核对结论**：当前行 `current.split("/")[1]` 与下拉项 `{m.id}` **同源**（均来自 `/api/models`），代码无 dash→underscore 变换。差异只可能来自 models.json 数据本身。
- **处理**：保留现状，请评审方提供出现差异的实际数据（models.json + session state）再定。

---

## 误报说明（无需改动）

- **B3 activeLine**：`editor/CodeMirrorBox.tsx` 的 `EditorView.theme` 已显式覆写 `.cm-activeLine: { backgroundColor: "var(--hover-tint)" }`，注释即说明「basicSetup 默认冷灰蓝不搭」。评审结论与代码相反，属误报。

---

## 验证与质量门

1. `npm run build:web`（server.cjs + 前端 dist，导出契约冒烟）
2. `npm test`（vitest 全量）
3. `cd web && npx tsc --noEmit -p tsconfig.json`
4. 无头浏览器回归截图：世界书按钮横排、顶栏书名去重、移动端底部无快捷键、舞台空态文案、设置错误态
5. 全量 UI 冒烟确认无新 console/HTTP 报错
