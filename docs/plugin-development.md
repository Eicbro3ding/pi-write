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
| `frontend` | 否 | 声明式前端贡献;当前支持 `slashCommands`(斜杠命令),`ui`(设置页菜单)为预留字段 |

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

仓库 `examples/plugins/dice/`(完整可运行):

```
examples/plugins/dice/
  plugin.json
  index.mjs
```

玩法:
1. 把目录复制到 `~/.pi/writer/plugins/dice`;
2. 重启/刷新 Web;
3. 对话里让 agent「掷个骰子」即可触发 `roll_dice` 工具;
4. 设置页「集成 → 插件」看到状态,启用/禁用/删除。

## 7. 装载与错误行为

| 阶段 | 失败表现 |
|---|---|
| 扫描 | 目录名非法(大写/下划线)跳过;plugin.json 损坏 → 目录名兜底;入口缺失 → 列表显示「入口文件缺失」 |
| import | 模块顶层抛错 → 该插件 `error`,其他插件照常;服务器不崩 |
| 工厂调用 | 抛错(注册阶段被 vendor 捕获)→ 会话装配继续,该插件工具不可用 |
| 运行时 | 工具 execute 抛错 → 返回错误给 agent(常规);事件 handler 抛错 → 单次隔离 |

装载错误经 `GET /api/plugins` / 设置页「集成 → 插件」列表展示(`s-plugin-err` 红字)。

**启停语义**:
- 用户级启用状态存 `~/.pi/writer/plugin-state.json`(禁用 ≠ 删除,插件目录可被 git 管理);
- `plugin.json` 的 `enabled: false` 是作者级禁用,用户侧无法启用;
- 切换启用后 pi-writer **重建会话**(与 MCP 配置变更同款),新工具即时生效;
- 删除 = 移除插件目录(路径经防逃逸校验,插件根目录外不可删)。

## 8. 开发调试

**临时目录隔离(避免污染写作用数据)**:

```bash
env PI_WRITER_DIR=/tmp/piw-dev npx tsx src/cli.ts --web --no-browser
# 插件目录: /tmp/piw-dev/plugins/<id>/
```

**查看装载状态**:

```bash
curl http://127.0.0.1:8811/api/plugins   # 列表(含 error)
```

**写测试**:装载器逻辑(`test/plugin-loader.test.ts` 已有范例)放在 `test/`,只测纯逻辑(临时 PI_WRITER_DIR + 真实磁盘插件目录),不碰真实 provider。

## 9. Web 斜杠命令(声明式)

`description` 节预留的 `frontend.slashCommands`(已实现的注册缝,见 `web/src/slash-commands.ts`):

```json
{
  "frontend": {
    "slashCommands": [{ "trigger": "roll", "hint": "掷骰子" }]
  }
}
```

当前执行逻辑仍须走**内置 executor**(受信任服务端实现);插件自带 executor 属于后续声明式协议演进(UI/菜单扩展与 0.0.4 插件系统同批设计)。现阶段建议:用户通过对话调用工具(工具能力已完备),而不要依赖 Web 输入框斜杠命令作为插件入口。

## 10. 常见问题(FAQ)

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

## 11. 上线前 checklist

- [ ] `plugin.json` 与目录名一致、`version` 语义化
- [ ] 工具名带插件前缀(降低冲突)
- [ ] `inputSchema` 完整声明(execute 内不要容忍任意字段)
- [ ] execute 抛错信息对人类/LLM 都有指导性
- [ ] 无 `exec` / 无 shell 通道
- [ ] 不直接改 world.json / draft(走 world_update 与现有工具)
- [ ] `examples/plugins/` 或仓库文档给出最小复现
