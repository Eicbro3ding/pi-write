/**
 * pi-adapter 的**类型别名区**(T7 批 2,2026-10-04)。
 *
 * ## 这个文件解决什么问题
 *
 * T6 把「自研自定义的接口」收进了 `domain.ts`(且要求它零 vendor import)。
 * 但还有另一类东西没处放:**自研侧直接使用的 vendor 类型**。
 *
 * 例如 `writerToolset()` 的返回类型是 `ToolDefinition[]`、提示词注入钩子收
 * `AgentMessage[]`、`roleFactory()` 返回 `CreateAgentSessionRuntimeFactory`。
 * 这些类型在 T6 之后仍然写着 `from "../../vendor/pi-coding-agent/src/index.ts"`
 * —— 上游一旦改名或挪包,20+ 个自研文件同时编译失败,而那些文件和「写作」
 * 毫无关系。
 *
 * ## 为什么是「别名」而不是「句柄」
 *
 * T6 给 `SessionManager` 用了**不透明句柄**(`declare const brand: unique symbol`)
 * 因为它符合「自研侧只搬运、从不读内部」的特征。
 *
 * 但 `ToolDefinition` / `AgentMessage` 这类**不符合**:
 * - 自研侧**真的要读字段**(`m.role`、`t.name`);
 * - 自研侧**真的要构造**(`writerToolset()` 从零拼出 `ToolDefinition[]`)。
 *
 * 套句柄等于让自研侧无法构造、只能加一层转发函数,那是「为隔离而隔离」,
 * 违反铁律 2(厚度控制)。所以这里用**别名**:保持 vendor 的结构形状,
 * 但把**名字的归属权**收到 adapter 里。
 *
 * ## 收益与边界
 *
 * | 场景 | T6 之前 | 现在 |
 * |---|---|---|
 * | 上游把 `ToolDefinition` 改名 | 20+ 自研文件同时红 | 只改本文件一行 |
 * | 上游给 `ToolDefinition` 加必填字段 | 自研侧构造点报错(合理) | 同左(别名不隐藏结构) |
 * | 自研侧想读 vendor 内部深层路径 | 直接 import | **本文件不提供**;要新开适配函数 |
 *
 * **注意**:别名只改名字、不隐藏结构 —— 上游给类型加字段时,自研侧的构造点
 * 仍会报错。这是**好事**:那是真实的行为变更,不该被隔离层掩盖。
 *
 * ## 检查方式
 *
 * ```bash
 * # 除 pi-adapter 外,不应有文件直接 import vendor
 * grep -rn "vendor/pi-" src/ --exclude-dir=pi-adapter
 * ```
 */

// —— pi-coding-agent ——
import type {
	AgentSessionEvent as VendorAgentSessionEvent,
	AgentSessionRuntime as VendorAgentSessionRuntime,
	CreateAgentSessionRuntimeFactory as VendorCreateAgentSessionRuntimeFactory,
	ExtensionAPI as VendorExtensionAPI,
	ExtensionCommandContext as VendorExtensionCommandContext,
	ExtensionContext as VendorExtensionContext,
	ExtensionFactory as VendorExtensionFactory,
	InlineExtension as VendorInlineExtension,
	ParsedSkillBlock as VendorParsedSkillBlock,
	ResolveCliModelResult as VendorResolveCliModelResult,
	SessionEntry as VendorSessionEntry,
	SessionTreeNode as VendorSessionTreeNode,
	ToolDefinition as VendorToolDefinition,
	ToolResultEvent as VendorToolResultEvent,
} from "../../vendor/pi-coding-agent/src/index.ts";
import type {
	AgentMessage as VendorAgentMessage,
	ThinkingLevel as VendorThinkingLevel,
} from "../../vendor/pi-agent-core/src/index.ts";
import type {
	AuthInteraction as VendorAuthInteraction,
	Usage as VendorUsage,
} from "../../vendor/pi-ai/src/index.ts";

// —— pi-coding-agent ——

/** 工具定义(`writerToolset()` 的构造产物,也是 MCP 工具的注入形态)。 */
export type ToolDefinition = VendorToolDefinition;

/** 内联扩展工厂:既接受 `(pi) => void` 裸函数,也接受 `{ name, factory }` 对象。 */
export type InlineExtension = VendorInlineExtension;

/** 外部插件工厂(plugin-loader 从磁盘加载的扩展)。 */
export type ExtensionFactory = VendorExtensionFactory;

/** 扩展 API 句柄(`pi` 参数);扩展内部用它注册命令 / 工具 / 钩子。 */
export type ExtensionAPI = VendorExtensionAPI;

/** 扩展运行上下文(命令回调收到的东西:TUI、会话、cwd 等)。 */
export type ExtensionContext = VendorExtensionContext;

/** 命令回调的上下文(比 `ExtensionContext` 多命令名/参数等)。 */
export type ExtensionCommandContext = VendorExtensionCommandContext;

/** 工具执行结果事件(`tool_result` 钩子收到的东西)。 */
export type ToolResultEvent = VendorToolResultEvent;

/** 会话事件(流式增量、消息结束、工具调用…);SessionHost 把它扇出给订阅者。 */
export type AgentSessionEvent = VendorAgentSessionEvent;

/** 会话运行时(含 `session` / `switchSession` / `dispose`)。 */
export type AgentSessionRuntime = VendorAgentSessionRuntime;

/** 会话运行时工厂:收到 `{ cwd, sessionManager, sessionStartEvent }` 返回 runtime 包装结果。 */
export type CreateAgentSessionRuntimeFactory = VendorCreateAgentSessionRuntimeFactory;

/** `--model` 模式串的解析结果(含 `model` / `error` / `warning`)。 */
export type ResolveCliModelResult = VendorResolveCliModelResult;

/** `/skill:<name>` 展开块的解析结果(`{ name, userMessage? }`)。 */
export type ParsedSkillBlock = VendorParsedSkillBlock;

/** 会话 entry(一条消息 / 一次压缩 / 一个自定义块);会话树的基本节点数据。 */
export type SessionEntry = VendorSessionEntry;

/** 会话树节点(`SessionEntry` + 子节点数组)。 */
export type SessionTreeNode = VendorSessionTreeNode;

// —— pi-agent-core ——

/** 思考档位(`"off"` … `"max"`);跨 TUI / Web / 舞台共用的会话设置。 */
export type ThinkingLevel = VendorThinkingLevel;

/** agent 消息(vendor 的 `Message` 联合);提示词注入钩子按 `AgentMessage[]` 传递。 */
export type AgentMessage = VendorAgentMessage;

// —— pi-ai ——

/** 交互式认证回调(web 端只用「输一次 API key」这一种形态)。 */
export type AuthInteraction = VendorAuthInteraction;

/** token 用量(输入/输出/缓存读/缓存写);工具执行结果里回填给会话统计。 */
export type Usage = VendorUsage;
