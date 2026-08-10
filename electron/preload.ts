/**
 * 预加载脚本(阶段 1 占位)。
 *
 * 阶段 1 无需 IPC:渲染进程只通过 http://127.0.0.1:<port> 访问本地服务,
 * 主进程不向其暴露任何 API(contextIsolation 开启、nodeIntegration 关闭)。
 * 后续阶段如需桌面能力(托盘、快捷键、原生菜单、窗口控制等)再在此通过
 * contextBridge.exposeInMainWorld 暴露。
 */
export {};
