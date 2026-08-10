import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "打开设置" },
	{ name: "model", description: "选择模型(打开选择器)", argumentHint: "<服务商/模型>" },
	{ name: "login", description: "登录服务商(API key 或 OAuth)", argumentHint: "<服务商>" },
	{ name: "logout", description: "退出登录,清除已保存的凭据" },
	{ name: "new", description: "新建对话" },
	{ name: "compact", description: "压缩当前对话上下文" },
	{ name: "reload", description: "重新加载配置与扩展" },
	{ name: "quit", description: "退出 pi-writer" },
	{ name: "hotkeys", description: "查看全部快捷键" },
];
