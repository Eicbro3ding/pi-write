# 第三方组件与许可(Third-party notices)

本仓库自己的代码以 **MIT** 发布 —— 全文见根目录 [`LICENSE`](LICENSE),
Copyright (c) 2026 Eicbro3ding。

下面列出随本仓库/发行物一起分发的第三方内容及其许可。MIT 的义务只有一条:**版权声明与
许可全文必须随每一份拷贝或实质部分一起分发** —— 所以「发行物」一节不是可选项。

## 组件

| 组件 | 位置 | 来源 | 许可 | 许可全文 |
|---|---|---|---|---|
| pi 核心包(6 个) | `vendor/pi-*` | [earendil-works/pi](https://github.com/earendil-works/pi) | MIT,Copyright (c) 2025 Mario Zechner | [`vendor/LICENSE-pi.txt`](vendor/LICENSE-pi.txt) |
| 网文创作方法论文库(76 份) | `skills/craft-outline/references/`、`craft-prose/`、`craft-deslop/`、`craft-review/`(按阶段拆 4 个技能,每个目录各带一份许可与来源说明) | [zenstory-ai/oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode)(收录 commit 见 ATTRIBUTION) | MIT,Copyright (c) 2025-2026 oh-story-claudecode | [`skills/craft-outline/references/LICENSE-oh-story-claudecode.txt`](skills/craft-outline/references/LICENSE-oh-story-claudecode.txt)(4 份内容相同) |
| npm 依赖(生产,含传递依赖) | `node_modules` → 内联进 `dist/` | npm registry | 全部为宽松许可(MIT / ISC / Apache-2.0 / BSD 等),**无 GPL / AGPL / LGPL** | 各包自带的 LICENSE 文件 |

`vendor/` 与技能库的详细来源、修改说明见 [`vendor/NOTICE.md`](vendor/NOTICE.md) 与
[`skills/craft-outline/references/ATTRIBUTION.md`](skills/craft-outline/references/ATTRIBUTION.md)
（4 个技能目录下各一份、内容相同；`test/skill-references.test.ts` 会断言它们逐字节一致，
改一处要四处同步）。

## 发行物:必须携带的声明

三种发行形态都会把上面的代码**内联**进产物(`dist/web/server.cjs` 是 esbuild 全量内联,
含 vendor 与 500+ npm 模块;`web/dist/assets/*.js` 内联前端依赖),因此必须随附声明:

| 发行形态 | 构建入口 | 带到发行目录的文件 |
|---|---|---|
| npm 包 | `package.json` 的 `files` | `LICENSE`(npm 自动带)+ `THIRD-PARTY.md` + `vendor/LICENSE-pi.txt` + `vendor/NOTICE.md` |
| 单文件可执行(`pi-writer.exe`) | `npm run bundle` | 同上,由脚本 `cp` 进 `release/` |
| Electron 桌面端 | `electron-builder.yml` 的 `files` | 同上,进 app 包根目录 |

> 改了打包白名单后请顺手确认:解压任一发行物,根目录能看到 `LICENSE`、`THIRD-PARTY.md`、
> `LICENSE-pi.txt`。

## 已知待办

- **生成的 npm 依赖声明尚未做**:目前只声明了「生产依赖全为宽松许可、无 copyleft」这个
  事实,没有逐包汇总许可全文。要彻底闭环,应加一个脚本(遍历 lockfile 的生产依赖,汇总
  `name@version` + license + LICENSE 正文)在打包时生成 `THIRD-PARTY-NOTICES.txt` 并塞进
  三种发行物。注意 `busboy` / `streamsearch` / `rechoir` 的 `package.json` **缺 `license`
  字段**(实际是 MIT,只能读 LICENSE 文件),自动化工具容易漏。
