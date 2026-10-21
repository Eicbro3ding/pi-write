/**
 * 插件集合变化(安装 / 启停 / 信任 / 删除)的全局通知。
 *
 * 浮窗与斜杠命令各自有 30 秒对账兜底,但它们并不知道"刚刚装了一个插件" ——
 * 这段空白期很容易被读成「装了没反应,得去设置里点一下」。这里是立刻生效的快路。
 *
 * 用 CustomEvent 而不是共享 store:变化的发起方在设置页的插件列表里,
 * 消费方在 App 根(浮窗)和两个输入页(斜杠命令),彼此没有父子关系。
 */

export const PLUGINS_CHANGED_EVENT = "piw:plugins-changed";

/** 通知所有监听者:插件集合变了。非浏览器环境静默(SSR / 单测)。 */
export function notifyPluginsChanged(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT));
}

/**
 * 清掉某插件的浮窗本地状态(位置 / 关闭)。
 *
 * 只在**全新安装**时调用:重装或升级不该把用户拖好的位置、手动关掉的窗口重置。
 * 而全新安装的插件如果沿用了同 id 的历史状态,会出现「装上却看不见」——
 * 因为它记着上一次被关掉的位置。
 */
export function resetPluginWindows(pluginId: string): void {
	if (typeof localStorage === "undefined") return;
	const prefix = `piw-plugin-window:${pluginId}:`;
	try {
		const doomed: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key !== null && key.startsWith(prefix)) doomed.push(key);
		}
		for (const key of doomed) localStorage.removeItem(key);
	} catch {
		/* 隐私模式:清不掉就按旧状态显示,不影响安装本身 */
	}
}
