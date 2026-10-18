/**
 * 样式入口(唯二之一:`main.tsx` 与组件预览页 `preview-entry.tsx`)。
 *
 * **顺序即优先级**——下面这些 `import` 的排列是行为,不是风格:
 * 1. `styles.css` 打底(令牌 + 通用组件);
 * 2. 各页样式按页覆盖(`world` / `stage` / `settings` / `wizard` / `dialog`);
 * 3. `mobile.css` 必须排在所有页样式之后 —— 它要压过 `.stage-head`、`.w-bar` 这些
 *    在页样式里已经写死的宽度/布局;
 * 4. `uiroom.css` 自带 `uiroom-` 前缀,不与任何页抢选择器,顺序无关但仍放在页之后;
 * 5. `presence.css`(退场层 `.is-closing`)必须最后 —— 它要压过各页的入场 animation。
 *
 * 加新样式文件:在对应档位插入,别一律追加到末尾。预览页要「和真实界面同一套皮肤」,
 * 它只引这一份,所以任何漏在这里的文件在预览页里都是隐形缺失。
 */
import "./styles.css";
import "./styles/world.css";
import "./styles/stage.css";
import "./styles/settings.css";
import "./styles/wizard.css";
import "./styles/dialog.css";
import "./styles/mobile.css";
import "./styles/uiroom.css";
import "./styles/presence.css";
