/**
 * models.json 自定义 provider / 模型条目的读写与增删改(纯函数,可单测)。
 *
 * 背景(2026-09):设置页「自定义供应商 / 添加模型」把配置写进
 * `~/.pi/writer/agent/models.json`。此前只有「加」,既没有编辑/删除模型,
 * 也没有真正移除自定义供应商 —— 模型定义里的 apiKey 不在凭据库(auth.json),
 * vendor 的 logout 动不到它,于是「移除凭据」点了等于没点(后端 200,状态不变)。
 *
 * 本模块只负责**配置对象的内存变换**,落盘(原子写)由调用方负责,便于单测。
 */

/** 一个自定义模型条目(只列我们读写的字段,其余字段原样保留)。 */
export interface CustomModelEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	[key: string]: unknown;
}

/** 一个自定义 provider 条目(vendor models.json 的 provider 形状子集)。 */
export interface CustomProviderEntry {
	api?: string;
	baseUrl?: string;
	apiKey?: unknown;
	models?: CustomModelEntry[];
	[key: string]: unknown;
}

/** models.json 顶层形状(未知字段原样保留:imports 等)。 */
export interface ModelsConfig {
	providers?: Record<string, CustomProviderEntry>;
	[key: string]: unknown;
}

/** 更新自定义模型时可以改的字段;`newId` 用于改模型 id(重命名)。 */
export interface CustomModelPatch {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: Array<"text" | "image">;
	/** 是否声明该模型支持思考深度(reasoning)。 */
	reasoning?: boolean;
	newId?: string;
}

/** 解析 models.json 文本;损坏 / 非对象一律当空配置(与 server 原有的容错一致)。 */
export function parseModelsConfig(text: string): ModelsConfig {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ModelsConfig) : {};
	} catch {
		return {};
	}
}

/** 序列化为 models.json 文本(2 空格缩进 + 末尾换行,与原写入格式一致)。 */
export function serializeModelsConfig(cfg: ModelsConfig): string {
	return `${JSON.stringify(cfg, null, 2)}\n`;
}

/**
 * 某 provider 在 models.json 里定义的自定义模型 id 集合。
 * 用于 `GET /api/providers/:id` 给模型条目标 `custom: true`(前端据此给编辑/删除入口)。
 */
export function customModelIds(cfg: ModelsConfig, providerId: string): Set<string> {
	const list = cfg.providers?.[providerId]?.models;
	const out = new Set<string>();
	if (Array.isArray(list)) {
		for (const m of list) {
			if (m && typeof m.id === "string") out.add(m.id);
		}
	}
	return out;
}

/** 模型 id 在某个 provider 下是否已存在。 */
export function hasModel(cfg: ModelsConfig, providerId: string, modelId: string): boolean {
	return customModelIds(cfg, providerId).has(modelId);
}

/**
 * 更新一个自定义模型条目(按 id 定位;`patch.newId` 非空且不同时改 id)。
 * @returns 是否命中并修改。
 */
export function updateCustomModel(cfg: ModelsConfig, providerId: string, modelId: string, patch: CustomModelPatch): boolean {
	const list = cfg.providers?.[providerId]?.models;
	if (!Array.isArray(list)) return false;
	const index = list.findIndex((m) => m && m.id === modelId);
	if (index < 0) return false;
	const prev = list[index]!;
	const next: CustomModelEntry = { ...prev };
	if (typeof patch.name === "string") {
		if (patch.name.trim().length > 0) next.name = patch.name.trim();
		else delete next.name; // 清空显示名 = 回退到用模型 id
	}
	if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
	if (patch.input !== undefined) next.input = patch.input;
	if (patch.reasoning !== undefined) next.reasoning = patch.reasoning;
	if (typeof patch.newId === "string" && patch.newId.length > 0 && patch.newId !== modelId) next.id = patch.newId;
	list[index] = next;
	return true;
}

/** 删除一个自定义模型条目。
 * @returns 是否删除(未命中返回 false,由调用方映射 404)。 */
export function deleteCustomModel(cfg: ModelsConfig, providerId: string, modelId: string): boolean {
	const list = cfg.providers?.[providerId]?.models;
	if (!Array.isArray(list)) return false;
	const index = list.findIndex((m) => m && m.id === modelId);
	if (index < 0) return false;
	list.splice(index, 1);
	return true;
}

/**
 * 写入一个自定义 provider 条目(**只管 provider 级字段**,models 里已有的条目原样保留)。
 *
 * 2026-09 拆开「加供应商」与「加模型」:此前只有一个「自定义供应商」表单,它顺手要求
 * 填第一个模型,于是「加一个供应商」变成了「加一个模型」。现在供应商先独立建出来
 * (`models: []`),模型再由用户在它的详情里逐条添加。
 *
 * @param patch.baseUrl 服务地址(必填)
 * @param patch.apiKey  凭据;缺省沿用已有值,仍无则用占位值(vendor 会跳过无 key 的 provider)
 * @param patch.name    显示名;空串 = 清掉,回退到 provider id
 * @param patch.api     协议;缺省沿用已有值,仍无则 openai-completions
 */
export function upsertCustomProvider(
	cfg: ModelsConfig,
	providerId: string,
	patch: { baseUrl: string; apiKey?: string; name?: string; api?: string },
): void {
	const existing = cfg.providers?.[providerId];
	const prev = typeof existing === "object" && existing !== null ? (existing as CustomProviderEntry) : {};
	const next: CustomProviderEntry = { ...prev };
	if (patch.name !== undefined) {
		if (patch.name.trim().length > 0) next.name = patch.name.trim();
		else delete next.name;
	}
	next.baseUrl = patch.baseUrl;
	next.api = patch.api ?? (typeof prev.api === "string" && prev.api.length > 0 ? prev.api : "openai-completions");
	next.apiKey = patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : (prev.apiKey ?? "sk-custom");
	if (!Array.isArray(next.models)) next.models = [];
	cfg.providers = { ...(cfg.providers ?? {}), [providerId]: next };
}

/** models.json 里是否已有这个 provider 条目。 */
export function hasCustomProvider(cfg: ModelsConfig, providerId: string): boolean {
	return cfg.providers !== undefined && Object.prototype.hasOwnProperty.call(cfg.providers, providerId);
}

/** 删除整个 provider 条目(移除自定义供应商 / 其凭据定义)。
 * @returns 是否删除。 */
export function deleteCustomProvider(cfg: ModelsConfig, providerId: string): boolean {
	if (!cfg.providers || !Object.prototype.hasOwnProperty.call(cfg.providers, providerId)) return false;
	delete cfg.providers[providerId];
	return true;
}
