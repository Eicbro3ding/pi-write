# 插件开发指南

为 pi-writer 编写插件:定义目录、清单与入口,注册工具/事件/命令,接入会话、装载与错误处理。

> 适用版本:0.0.4+(插件系统自 0.0.4 引入)。文档与实现同步;新增能力见 `docs/design.md`(实现后补充)。

## 1. 快速上手

一个插件 = 一个目录,放在 `~/.pi/writer/plugins/<plugin-id>/`:

```
~/.pi/writer/plugins/
  my-plugin/            # 目录名即默认 plugin id(须小写字母/数字/连字符)
    plugin.json         # 清单(元数据)
    index.mjs           # 入口(default export = 插件工厂)
    README.md           # 可选:说明文档
```

`plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "插件做什么",
  "backend": "index.mjs",
  "enabled": true
}
```

`index.mjs`:

```js
export default function myPlugin(pi) {
  pi.registerTool({
    name: "hello_world",
    description: "返回一句问候。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ greeting: "你好,作者!" }),
  });
}
```

重启 pi-writer(Web/TUI)后,插件即被装载;`hello_world` 工具出现在对话工具列表。设置页「集成 → 插件」可查看/启停/删除。

## 2. 清单字段(plugin.json)

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 插件唯一标识(小写字母/数字/连字符,≤64 位;与目录名一致) |
| `version` | 是 | 语义化版本,如 `0.1.0` |
| `name` | 否 | 显示名(设置页列表;缺省 = id) |
| `description` | 否 | 一句话描述(设置页列表展示) |
| `backend` | 否 | 后端入口文件(相对插件目录;**缺省 `index.mjs`**) |
| `enabled` | 否 | 作者级禁用开关:false 时用户侧无法启用(`manifestDisabled`) |
| `frontend` | 否 | 声明式前端贡献:`slashCommands`(Web 斜杠命令)+ `ui.settingsItems`(设置菜单字段 schema,见第 7 节) |

**manifest 缺失/损坏**:插件仍以目录名兜底列出(version `0.0.0`),入口缺省 `index.mjs`;若也没有入口,列表显示「入口文件缺失」错误。

## 3. 入口与工厂函数

入口文件(缺省 `index.mjs`)用 **default export 导出一个工厂函数**:

```js
export default function myPlugin(pi) { ... }        // 同步
export default async function myPlugin(pi) { ... }  // 异步亦可
```

工厂的参数 `pi`(`ExtensionAPI`)是插件的能力面。**工厂在 pi-writer 启动装配会话时调用一次**;若抛错,该插件记为装载失败,不影响其他插件(错误经设置页展示),会话照常创建。

工厂内可用的主要 API(按使用频率排序):

| API | 用途 |
|---|---|
| `pi.registerTool(definition)` | 向 LLM 注册可调用工具(核心) |
| `pi.on(event, handler)` | 订阅会话事件(10+ 种,含修改型结果) |
| `pi.sendMessage({...})` / `pi.sendUserMessage(content)` | 主动向会话注入消息 |
| `pi.registerCommand(name, options)` | 注册 TUI `/` 命令(注意:不是 Web 输入框的斜杠命令) |
| `pi.getActiveTools()` / `getAllTools()` | 查询工具集 |
| `pi.exec(command, args)` | —— 请勿使用(等价 bash,违反 pi-writer 安全红线,会在审查期被拒) |

> 插件的安全边界:**与 pi-writer 主进程同权**,等价于本地受信任代码(类似 Obsidian / SillyTavern 社区插件,非沙箱)。pi-writer 不自动安装/更新插件;`exec` 等任意 shell 能力**不可用**(web 无 bash 是 2026-08-10 起的安全设计,插件同样不得绕过)。

更多能力(vendor `ExtensionAPI`):`registerShortcut` / `registerFlag` / `registerMessageRenderer`(自定义消息渲染,Web 端需额外桥接,慎用)/ `registerProvider`(与模型配置重叠,不建议)。

## 4. 开发工具(registerTool)

工具定义的结构与 pi-writer 内部工具(`src/tools.ts` 的 `word_count` 等)一致:

```js
pi.registerTool({
  name: "roll_dice",                       // 工具名(建议 下划线 命名,避免与内置冲突)
  description: "掷一个 N 面骰子(默认 d20)。", // 给 LLM 看的说明,描述越清楚越好
  inputSchema: {                            // 参数 schema(JSON Schema 子集)
    type: "object",
    properties: {
      sides: { type: "number", description: "骰面数,默认 20" },
    },
    additionalProperties: false,
  },
  // 执行逻辑:input 为按 schema 校验后的参数对象
  execute: async (input) => {
    const sides = Math.max(2, Math.min(1000, Number(input?.sides) || 20));
    return { roll: `d${sides} = ${1 + Math.floor(Math.random() * sides)}` };
  },
});
```

要点:
- **`execute` 返回值**:LLM 直接读到的结果;失败时 `throw new Error("错误信息")`,agent 会收到错误而非崩溃。
- **JSON Schema 用 typebox 写**:正式开发建议用 `typebox`(`import { Type } from "typebox"; inputSchema: Type.Object({...})`)——与 pi-writer/vendor 同款,可获得类型推导。js 里用 JSON 字面量也兼容。
- **工具名冲突**:与内置/其他插件同名时,先注册者生效,后注册者警告。建议用插件前缀(`myplugin_roll`),或让用户插件使用 `name: "roll"` 时文档提醒冲突风险。
- **不要给 execute 开 bash**:工具内的 `submit`/`exec` 通道归 pi-writer 管理,插件的 shell 能力不在开放面。

## 5. 事件订阅(pi.on)

`pi.on(event, handler)` 订阅会话生命周期事件:

```js
let round = 0;
pi.on("turn_start", (event) => { round += 1; console.log("回合", round); });

// 修改型事件:handler 返回结果可改变行为
pi.on("context", (event) => {
  return { messages: [...event.messages, { role: "user", content: "补充上下文" }] };
});
pi.on("tool_call", (event) => { return { block: true, reason: "本插件不允许该工具" }; });
```

常用事件(完整清单见 vendor `ExtensionAPI.on` 重载):

| 事件 | 说明 | 返回修改型 |
|---|---|---|
| `session_start` / `session_shutdown` | 会话开始/关闭 | 无 |
| `turn_start` / `turn_end` | 回合开始/结束 | 无 |
| `message_start` / `message_update` / `message_end` | 消息生命周期 | `message_end` 可替换消息 |
| `tool_call` | 工具调用前 | 可 block |
| `tool_result` | 工具结果 | 可改写内容 |
| `agent_start` / `agent_end` / `agent_settled` | agent 轮次 | `agent_start` 可注入系统提示词拼接 |
| `context` | 上下文注入前 | **可注入 messages**(写作插件的核心场景) |
| `input` | 用户输入 | 可改写输入内容 |

**注意**:`on("context")` 注入与世界书共用上下文预算——世界书优先,插件注入占剩余空间(超预算截断)。

## 6. 示例插件

仓库 `examples/plugins/dice/`(完整可运行,包含工具 + 设置菜单 + Web 命令):

```
examples/plugins/dice/
  plugin.json   # 声明工具设置(骰面/幸运感言/感言下拉/备注)+ /快骰 命令
  index.mjs     # default export 工厂(roll_dice 工具)+ webCommands 具名导出(/快骰)
  settings.json # 用户设置值(声明式表单保存后生成;不入库)
```

玩法:
1. 把目录复制到 `~/.pi/writer/plugins/dice`;
2. 重启/刷新 Web;
3. 对话里让 agent「掷个骰子」即可触发 `roll_dice` 工具;
4. 设置页「集成 → 插件」看到状态,点「设置」调默认骰面/感言;保存后重启生效;
5. 输入框开写 `/快骰`,回车选中命令——主进程掷骰,结果文本插回输入框。

## 7. 设置菜单(声明式表单)

插件在 plugin.json 声明设置字段,schema 是纯数据,**renderer 按白名单字段类型渲染**(不执行插件 JS)。值存 `~/.pi/writer/plugins/<id>/settings.json`(atomicWriteFile;未知键丢弃)。

**声明**(`frontend.ui.settingsItems`):

```json
{
  "frontend": {
    "ui": {
      "settingsItems": [
        {
          "title": "掷骰子",
          "description": "设置影响 roll_dice 工具与 /快骰 命令",
          "fields": [
            { "key": "max", "label": "默认骰面", "type": "number", "default": 20, "desc": "范围 2-1000" },
            { "key": "lucky", "label": "幸运叙事", "type": "boolean", "default": true },
            { "key": "flavor", "label": "感言", "type": "select", "default": "mild",
              "options": [{ "value": "mild", "label": "含蓄" }, { "value": "silly", "label": "无厘头" }] },
            { "key": "note", "label": "备注", "type": "textarea", "default": "" }
          ]
        }
      ]
    }
  }
}
```

**字段类型白名单**:`string | number | boolean | select | textarea`。select 必须带 `options`(至少一项);字段 key 须小写字母/数字/连字符/点/下划线。非法字段(未知 type/缺 key/select 无 options)**整条丢弃**,不阻塞插件装载。

**读取设置**:插件自己在主进程读 `settings.json`(示例见 dice 的 `readSettings()`);也可在 Web 命令 handler 里读。设置保存后 pi-writer 重建会话(工具即时用新值)。

## 8. 装载与错误行为

| 阶段 | 失败表现 |
|---|---|
| 扫描 | 目录名非法(大写/下划线)跳过;plugin.json 损坏 → 目录名兜底;入口缺失 → 列表显示「入口文件缺失」 |
| import | 模块顶层抛错 → 该插件 `error`,其他插件照常;服务器不崩 |
| 工厂调用 | 抛错(注册阶段被 vendor 捕获)→ 会话装配继续,该插件工具不可用 |
| 运行时 | 工具 execute 抛错 → 返回错误给 agent(常规);事件 handler 抛错 → 单次隔离 |
| 命令执行 | webCommands handler 抛错 → 该命令 500,对话不中断 |

装载错误经 `GET /api/plugins` / 设置页「集成 → 插件」列表展示(`s-plugin-err` 红字)。

**启停语义**:
- 用户级启用状态存 `~/.pi/writer/plugin-state.json`(禁用 ≠ 删除,插件目录可被 git 管理);
- `plugin.json` 的 `enabled: false` 是作者级禁用,用户侧无法启用;
- 切换启用后 pi-writer **重建会话**(与 MCP 配置变更同款),新工具即时生效;
- 删除 = 移除插件目录(路径经防逃逸校验,插件根目录外不可删)。

## 9. 开发调试

**临时目录隔离(避免污染写作用数据)**:

```bash
env PI_WRITER_DIR=/tmp/piw-dev npx tsx src/cli.ts --web --no-browser
# 插件目录: /tmp/piw-dev/plugins/<id>/
```

**查看装载状态**:

```bash
curl http://127.0.0.1:8811/api/plugins              # 列表(含 error/frontend 声明)
curl http://127.0.0.1:8811/api/plugins/dice/settings  # schema + 值
```

**写测试**:装载器/校验逻辑(`test/plugin-loader.test.ts`)放在 `test/`,只测纯逻辑(临时 PI_WRITER_DIR + 真实磁盘插件目录),不碰真实 provider。

## 10. Web 斜杠命令(声明式 + 后端执行器)

**两步**:

1. **声明**(plugin.json):`frontend.slashCommands:[{ trigger, hint }]`——trigger 不含斜杠,为命令面板的 `/trigger`。
2. **执行器**(入口模块):具名导出 `webCommands = { trigger: async ({ term, bookSlug }) => "结果文本" }`,**在主进程执行**(renderer 零 JS)。

```js
// index.mjs
export default function dicePlugin(pi) { /* 工厂:注册工具等 */ }

export const webCommands = {
  "快骰": async () => "d20 = 7",
};
```

**调用链**:前端 `/快骰` → `POST /api/plugins/dice/command/快骰`(服务端注册表;trigger 必须已在 manifest 声明,否则忽略)→ 主进程 handler → `{text}` 结果插回输入框(用户看过再发送)。

**约束**:
- 命令 handler 参数 `{ term?, bookSlug? }`(term = 命令后的参数文本;结果 > 4000 字符截断);
- 未声明的 trigger 即使导出也**不注册**(白名单);
- handler 抛错 → 该命令报错(500),会话不受影响。

## 11. 完全信任(trusted)

**默认安全模型**:插件只能声明式 UI(设置菜单 schema)+ 主进程逻辑(工具/webCommands/事件);renderer 绝不执行插件 JS。

**「完全信任」开启后**(设置页「集成 → 插件」每插件一个开关,需二次确认)解锁两种能力:

| 能力 | 说明 |
|---|---|
| 后端自定义路由 | 入口 `export const routes = [{ method, segments, handler }]`;自动挂 `/api/plugins/<id>/...`(segments 加插件 id 前缀),**仅 trusted 插件注册** |
| 前端 JS | 入口 `frontend.mjs`(manifest `frontend.frontend` 可换路径),经 `GET /api/plugins/:id/frontend.mjs` 返回 `text/javascript`,**仅 trusted 插件可加载** |

**前端 JS 约定**:
- pi-writer 在设置页插件分类提供挂载点 `data-plugin-mount="<pluginId>"`;插件 JS 自我管理该节点下 DOM(示例:掷骰历史按钮);
- 插件 JS 调自己注册的后端路由(`/api/plugins/<id>/...`)取数据;
- 插件前端失败静默(不影响主界面),错误可经插件自身 console 观察。

**风险**:trusted 插件与 pi-writer **主进程/渲染进程同权**(可在渲染进程执行任意 JS,并凭同族 HTTP 端点访问本地数据)。开启=用户声明"我信任这个插件的作者"。**仅信任你自己安装的插件**。

**关闭信任**:开关取关即回收(frontend.mjs 的 script 标签移除、路由不注册)。

示例见 `examples/plugins/dice/`(index.mjs 的 routes 导出 + frontend.mjs + json 历史演示)。

## 12. 常见问题(FAQ)

**Q:插件写了但不生效?**
A:①确认目录在 `~/.pi/writer/plugins/<id>/`(`PI_WRITER_DIR` 覆盖时换路径);②`plugin.json` 的 `id` 与目录名一致;③设置页插件列表看有无错误(入口缺失/工厂抛错);④重启 pi-writer(Web 服务),装载发生在启动时。

**Q:插件工具 LLM 说不存在?**
A:工具在「注册成功但初始激活名单外」时可能不出现在系统提示的工具段——内置工具经 `initialActiveToolNames` 激活,插件工具经 vendor 的 `includeAllExtensionTools` 自动激活。若仍不可见,检查工具名冲突(与内置同名的注册被拒绝)。

**Q:插件能改世界书/正文吗?**
A:间接可以——`registerTool` 的 execute 内读写书目录文件(插件与主进程同权),但**不要绕过 `world_update` 通道**直接改 world.json(会破坏结构校验与预览卡确认流)。写作建议:插件提供辅助工具(统计/生成/检索),世界文档变更交给 `world_update`。

**Q:插件可以写 UI 吗?**
A:本期(0.0.4)**不能**。renderer 不执行用户 JS 是安全红线,前端 UI 注入需声明式渲染协议(定义 → 注册 → 渲染),列入开发计划(见 `src/plugins.ts` 的 `PluginUiSpec` 预留类型);插件只能声明数据(`plugin.json`),由 pi-writer 受信任部分渲染。

**Q:插件与 MCP 是什么关系?**
A:两条独立通道——MCP 解决「接外部服务器」,插件解决「本地注册工具/事件/命令」。插件 = 受信任本地代码(不做沙箱);MCP = 远端服务器工具(经 `mcp.json`)。插件可以封装 MCP 客户端,但不在本期开放面。

## 13. 上线前 checklist

- [ ] `plugin.json` 与目录名一致、`version` 语义化
- [ ] 工具名带插件前缀(降低冲突)
- [ ] `inputSchema` 完整声明(execute 内不要容忍任意字段)
- [ ] execute 抛错信息对人类/LLM 都有指导性
- [ ] 无 `exec` / 无 shell 通道
- [ ] 不直接改 world.json / draft(走 world_update 与现有工具)
- [ ] `examples/plugins/` 或仓库文档给出最小复现
