import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { initTheme } from "./theme.ts";
import { DEBUG_LOCK_COMMAND, DEBUG_UNLOCK_COMMAND, disableDebugMode, enableDebugMode } from "./settings.ts";
// 样式统一从 styles.ts 进(那是唯一的样式入口):顺序与取舍写在那个文件里,
// 组件预览页也按同一份闭包取 CSS,少一处「main.tsx 里有、预览页里没有」的分叉。
import "./styles.ts";

initTheme(); // 首帧应用持久化主题,避免闪烁

/**
 * 调试模式的**控制台入口**(2026-09-19)。
 *
 * 平时设置界面里没有「调试模式」这一项 —— 它是开发者的排障开关(把每个工具块退回
 * 原始工具名 + 完整参数 + 完整结果),对普通使用只有噪音。需要时在本页 F12 控制台:
 *
 *   piWriterDebug()     // 解锁并打开(顶栏同时多出「UI 房」——全部组件的陈列室)
 *   piWriterDebugOff()  // 关闭并重新藏回界面
 *
 * ⚠️ 这不是权限门:任何人打开控制台都能开,它防的是误触,不是恶意。
 */
declare global {
	interface Window {
		piWriterDebug: () => void;
		piWriterDebugOff: () => void;
	}
}
window.piWriterDebug = () => {
	enableDebugMode();
	console.info(`[pi-writer] 调试模式已开启(顶栏多出「UI 房」:全部 UI 组件的陈列室)。关闭并重新隐藏:${DEBUG_LOCK_COMMAND}`);
};
window.piWriterDebugOff = () => {
	disableDebugMode();
	console.info(`[pi-writer] 调试模式已关闭并重新隐藏。再次开启:${DEBUG_UNLOCK_COMMAND}`);
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 应用级错误边界:任一处运行时错误不白屏 */}
    <ErrorBoundary>
      {/* 系统开启「减少动态效果」时,全部 framer 动画自动降级为即时切换 */}
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </ErrorBoundary>
  </StrictMode>,
);
