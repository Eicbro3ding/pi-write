/**
 * pi-adapter 的**运行时值接入点**(T7 批 2,2026-10-04)。
 *
 * ## 与其它三个文件的分工
 *
 * | 文件 | 内容 | 依赖 vendor |
 * |---|---|---|
 * | `domain.ts` | 自研自定义接口 + 不透明句柄类型 | **零** |
 * | `types.ts` | vendor 类型别名 | 仅 `import type` |
 * | `guard.ts` | 工具路径守卫 | 唯一深层 import |
 * | `usage.ts` | 成本拆分投影 | 唯一深层 import |
 * | **`runtime.ts`(本文件)** | **会话装配 / 打开的运行时函数** | **包的 `index.ts`** |
 *
 * ## 为什么值级函数也要收进来
 *
 * `SessionManager.open(...)` 是个**值**(静态方法),不是类型 —— 类型别名救不了它。
 * 自研侧(如 `web/writer-host.ts`)有 5 处 `SessionManager.open(...)`,那 5 处
 * 就是在直接调用 vendor 的 API。
 *
 * 本文件把它们换成语义来自写作领域的函数名:
 * - `openSession(file, dir, cwd)` —— 「打开一份写作会话」
 * - `assembleSessionServices(...)` —— 「装配一次会话的服务」
 *
 * ## 铁律三(单向依赖)的体现
 *
 * 本文件**只 import vendor**,不 import 任何 `src/` 业务模块。自研侧 import
 * 本文件,本文件 import vendor —— 方向单一,不会成环。
 */

import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	type CreateAgentSessionFromServicesOptions,
	createAgentSessionServices,
	type CreateAgentSessionServicesOptions,
	type CreateAgentSessionRuntimeFactory,
	InteractiveMode as VendorInteractiveMode,
	parseSkillBlock as vendorParseSkillBlock,
	type ParsedSkillBlock,
	type PrintModeOptions as VendorPrintModeOptions,
	resolveCliModel,
	runPrintMode as vendorRunPrintMode,
	SessionManager,
} from "../../vendor/pi-coding-agent/src/index.ts";
import type { SessionManagerHandle } from "./domain.ts";
import { fromFactoryHandle, fromHandle, toHandle } from "./session.ts";

// ============================================================================
// 会话打开
// ============================================================================

/**
 * 打开一份会话文件(`SessionManager.open` 的写作领域别名)。
 *
 * 返回的是**句柄**而非 vendor 实体 —— 调用方拿到之后只能交回 adapter 的函数,
 * 不能顺着它去调 vendor 的内部方法。这与 T6 为 `SessionHostOptions.sessionManager`
 * 定的契约一致(见 domain.ts 的「不透明句柄」)。
 *
 * @param file 会话 jsonl 的绝对路径
 * @param sessionDir 会话目录(缺省用文件所在目录)
 * @param cwdOverride 工作目录覆盖(切书后要覆盖成新书目录)
 */
export function openSession(file: string, sessionDir?: string, cwdOverride?: string): SessionManagerHandle {
	return toHandle(SessionManager.open(file, sessionDir, cwdOverride));
}

/** 句柄 → 实体。**仅供 adapter 内部与过渡期使用**(见 index.ts 的升级对照表)。 */
export { fromHandle };

// ============================================================================
// 会话只读读取(句柄的消费端)
// ============================================================================

/**
 * 会话**只读视图** —— 自研侧能看到的全部会话内部形状。
 *
 * 为什么不让自研侧直接拿 `SessionManager` 实体:实体有几十个方法
 * (`append` / `delete` / `moveTo` …),自研侧一旦能拿到就会**越用越多** ——
 * 三个月后 vendor 升级时,你会发现在十个文件里散落着对内部方法的调用。
 * 这里只开三个**只读**入口,写入路径一律走 vendor 自己的 agent 循环。
 *
 * 方法名(`getLeafId` / `getBranch` / `getTree`)刻意**与 vendor 同名**:自研侧
 * 早已按这套名字写代码(`src/session-tree.ts` 的 `SessionTreeSource` 就在用),
 * 改名只会制造无谓的适配层。隔离的是**能不能拿到实体**,不是名字。
 *
 * **返回值用 `unknown[]` 而不是自研的 entry 形状**:adapter 的职责是「挡住实体」,
 * 不是「定义 entry 长什么样」。具体的 entry 类型由消费方(如 `session-tree.ts`)
 * 用 vendor 的 `SessionEntry` 别名去收窄 —— adapter 在这里假装知道形状,
 * 只会在上游改 entry 结构时多一处要同步的地方。
 */
export interface SessionReader {
	/** 当前 leaf(会话头)entry id;空会话为 null。 */
	getLeafId(): string | null;
	/** 沿 parentId 回溯的当前分支;`fromId` 缺省从 leaf 起。 */
	getBranch(fromId?: string): unknown[];
	/** 完整会话树(全部节点,含已切走的旧分支)。 */
	getTree(): unknown[];
}

/** 把句柄包成只读读取器。 */
export function readerOf(h: SessionManagerHandle): SessionReader {
	const sm = fromHandle(h);
	return {
		getLeafId: () => sm.getLeafId(),
		getBranch: (fromId?: string) => sm.getBranch(fromId),
		getTree: () => sm.getTree(),
	};
}

/**
 * 读取一份会话文件(只读,不启动 agent 运行时);解析失败返回 null。
 *
 * 这是「按路径读会话」的**唯一入口** —— 原先 `writer-host.ts` 有三处
 * `SessionManager.open(...)`,现在都收在这里。收口的好处是「文件不存在怎么办」
 * 「解析失败怎么办」这类判断只有一份实现,不会各写各的。
 */
export function readSessionFile(
	file: string,
	sessionDir?: string,
	cwdOverride?: string,
): SessionReader | null {
	try {
		return readerOf(openSession(file, sessionDir, cwdOverride));
	} catch {
		return null;
	}
}

// ============================================================================
// 会话装配(给 session-factory.ts 用)
// ============================================================================

/**
 * 装配一次会话的**服务**(auth / models / settings / resourceLoader)。
 * 原样转发 `createAgentSessionServices`;返回类型由调用方从 vendor 收窄。
 *
 * 保留 `options` 的完整 vendor 形状:这是**装配参数**,自研侧本来就要按 vendor
 * 的配置面填写(auth 目录、resourceLoaderOptions、skill 路径…),包装成别的形状
 * 只会多一层翻译且容易漏字段。
 */
export const assembleSessionServices = createAgentSessionServices;

/** 从已装配的服务**创建会话**;原样转发。 */
export const createSessionFromServices = createAgentSessionFromServices;

/** `--model` 模式串解析;原样转发。 */
export const resolveModelSpec = resolveCliModel;

/** 把「运行时包装器」和初始会话目标组合成 `AgentSessionRuntime`;原样转发。 */
export const createRuntime = createAgentSessionRuntime;

// ============================================================================
// 运行模式（TUI / 打印）
// ============================================================================

/**
 * 交互式 TUI 模式。
 *
 * 这两项(`InteractiveMode` / `runPrintMode`)是 cli.ts 与 vendor 之间**最后一层**
 * 直接耦合 —— 它们是「怎么把 runtime 跑起来」的两种方式,语义上属于 adapter。
 */
export const InteractiveMode: typeof VendorInteractiveMode = VendorInteractiveMode;

/** 打印模式(非交互,把结果打到 stdout);`--print` 走的路径。 */
export const runPrintMode: typeof vendorRunPrintMode = vendorRunPrintMode;

/** 打印模式选项(`{ mode, initialMessage, … }`)。 */
export type PrintModeOptions = VendorPrintModeOptions;

// ============================================================================
// 技能消息解析
// ============================================================================

/**
 * 解析 `/skill:<name>` 展开块。
 *
 * vendor 在发送时会把技能调用展开成整份 `SKILL.md` 写进用户消息(`<skill name="..">`
 * 开头)。自研侧需要把它拆回「技能名 + 用户自己说的话」—— 否则对话标题会取到
 * `<skill name="critique" loc` 这种前缀垃圾(见 `conversationTitleText`)。
 *
 * 返回 `null` 表示这不是一次技能调用(普通消息)。
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	return vendorParseSkillBlock(text);
}

// —— 上面这些转发的类型别名(供调用方标注) ——
// 注意:`ResolveCliModelResult` 已在 types.ts 定义,此处**不重复导出**
// (`export *` 会让两个模块的同名导出冲突)。
export type { CreateAgentSessionFromServicesOptions, CreateAgentSessionServicesOptions };

/**
 * 造型:`SessionManagerHandle` → vendor 实体。
 *
 * 与 `session.ts` 的 `fromHandle` 同义,这里再导一次是为了让
 * 「装配路径」的调用方不必同时 import 两个模块。
 */
export function entityOf(h: SessionManagerHandle): ReturnType<typeof fromHandle> {
	return fromHandle(h);
}

/**
 * 造型:工厂句柄 → vendor 实体。
 *
 * `session-factory.ts` 返回的工厂是句柄(`RuntimeFactoryHandle`),而
 * `createAgentSessionRuntime` 要的是实体 —— 这个转换就是那道桥。
 */
export function entityOfFactory(
	h: Parameters<typeof fromFactoryHandle>[0],
): CreateAgentSessionRuntimeFactory {
	return fromFactoryHandle(h);
}

// ============================================================================
// 组合式入口：一次装配
// ============================================================================

/** `assembleRuntime` 的入参。 */
export interface AssembleRuntimeArgs {
	/** 会话运行时工厂句柄(由 `session-factory.ts` 产出)。 */
	createRuntime: Parameters<typeof fromFactoryHandle>[0];
	cwd: string;
	agentDir: string;
	/** 要打开的会话(句柄,见 `openSession`)。 */
	sessionManager: SessionManagerHandle;
}

/**
 * 组合 `createAgentSessionRuntime`,把句柄层与实体层的转换收在一处。
 *
 * 调用方(如 `SessionHost.start()`)原先要写:
 * ```ts
 * createAgentSessionRuntime(fromFactoryHandle(options.createRuntime), {
 *   cwd: this.options.cwd,
 *   agentDir: this.options.agentDir,
 *   sessionManager: fromHandle(options.sessionManager),
 * })
 * ```
 * 现在写:
 * ```ts
 * assembleRuntime({ createRuntime, cwd, agentDir, sessionManager })
 * ```
 *
 * 收益不只是短 —— 是**调用点不再需要 import `fromHandle` / `fromFactoryHandle`**,
 * 于是自研侧彻底看不见「句柄↔实体」这回事。
 */
export function assembleRuntime(args: AssembleRuntimeArgs): Promise<AgentSessionRuntime> {
	return createAgentSessionRuntime(fromFactoryHandle(args.createRuntime), {
		cwd: args.cwd,
		agentDir: args.agentDir,
		sessionManager: fromHandle(args.sessionManager),
	});
}
