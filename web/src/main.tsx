import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { initTheme } from "./theme.ts";
import "./styles.css";
// 分页样式(设计稿 v1 重做):按此顺序在 styles.css 之后加载,同名选择器后者胜
import "./styles/world.css";
import "./styles/stage.css";
import "./styles/settings.css";
import "./styles/wizard.css";
import "./styles/dialog.css";

initTheme(); // 首帧应用持久化主题,避免闪烁

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
