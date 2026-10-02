/*
 * DSHTauri 顶栏（titlebar）的纯函数规则 —— 无 DOM、无 Tauri、无副作用。
 *
 * 为什么单独一个文件：`src/titlebar/titlebar.js` 是**内联模板**（会被抄进 Rust 的
 * `initialization_script` 字符串里），没法用 `import` 引用外部模块；但它引用的这块
 * 逻辑本身是纯的，放在这里可以被 `scripts/test-titlebar.mjs` 用 node --test 直接测。
 * 两边靠 `scripts/titlebar-build.mjs` 与 `test-titlebar.mjs` 的一致性检查保证不跑偏。
 *
 * 约束：本文件必须保持 **ES module**（浏览器 `import` 与 node `import` 都能用）。
 * 内联模板里对应的是 `createTitlebarRules()` 工厂 + 同名常量，写法不同、语义必须一致。
 */

/** 顶栏高度（逻辑像素）。与 Rust 的 `CHROME_HEIGHT` / `popup_menu` 的 y 偏移一致。 */
export const CHROME_HEIGHT = 40;

/** 顶栏里出现过的所有 Tauri 命令。命令契约由 Lead 冻结，这里只是白名单。 */
export const TITLEBAR_COMMANDS = ["chrome_action", "window_control", "start_drag", "popup_menu"];

/** 「应用」原生菜单支持的条目（Rust 侧 `popup_menu` 的 "app" 分支）。 */
export const APP_MENU_ACTIONS = ["about", "check-update", "reconnect"];

/** 「操作」原生菜单支持的条目（Rust 侧 `popup_menu` 的 "actions" 分支）。 */
export const ACTIONS_MENU_ACTIONS = ["refresh", "undo", "redo"];

/** 直接动作按钮 id —— 这些不是菜单，点了立刻发 `chrome_action`。 */
export const DIRECT_ACTIONS = { chat: "chat" };

/**
 * 拖拽/双击的命中判定。
 *
 * 顶栏空白处用来拖窗口、双击最大化；但**落在按钮或菜单文字上时不能拖**，
 * 否则用户点菜单会顺手把窗口拖走（这也是现有 chrome.js 的行为）。
 *
 * @param {string|null|undefined} closestButton 从事件目标开始向上找最近的可交互元素所得的值
 *        （`event.target.closest("button, .menu, .ctl")` 的 tagName / 类名，没有则为空）。
 * @param {number} button 鼠标键（0 = 左键）。
 * @returns {boolean} true 表示这次按下/双击应该被当作「拖窗口 / 最大化」
 */
export function isTitlebarChromeHit(closestButton, button) {
  if (button !== 0) return false;
  return !closestButton;
}

/**
 * 窗口状态归一化。
 *
 * 主窗口的四种状态：普通 / 最大化 / 全屏 / 最小化（+ 无边框）。Windows 上「无边框」是
 * 常态（这个应用就是自绘标题栏），所以 `borderless` 单独一项，供视觉层判断是否画圆角。
 *
 * @param {{maximized?:boolean, fullscreen?:boolean, minimized?:boolean, focused?:boolean, borderless?:boolean}} [state]
 */
export function normalizeWindowState(state) {
  const s = state || {};
  return {
    maximized: Boolean(s.maximized),
    fullscreen: Boolean(s.fullscreen),
    minimized: Boolean(s.minimized),
    focused: Boolean(s.focused),
    borderless: s.borderless !== false, // 默认就是无边框
  };
}

/** 最大化或全屏时，窗口已经贴满屏幕边缘，不该再让用户拖动。 */
export function canDragWindow(state) {
  const s = normalizeWindowState(state);
  return !(s.maximized || s.fullscreen);
}

/** 最大化或全屏时，也不该双击切最大化（双击语义是「在 最大化/还原 之间切」）。 */
export function canToggleMaximize(state) {
  return canDragWindow(state);
}

/**
 * 最大化/还原按钮的 tooltip：反映「点下去会发生什么」。
 * 最大化状态下显示「向下还原」，否则「最大化」。
 */
export function maximizeButtonTitle(state) {
  return normalizeWindowState(state).maximized ? "向下还原" : "最大化";
}

/** 最大化按钮的图标字形：还原用 MDL2/Fluent 的 E923（Restore），否则 E922（Maximize）。 */
export function maximizeButtonGlyph(state) {
  return normalizeWindowState(state).maximized ? "\uE923" : "\uE922";
}

/** 无障碍标签：把状态也念出来，和 tooltip 保持一致。 */
export function maximizeButtonAriaLabel(state) {
  return maximizeButtonTitle(state);
}

/**
 * 窗口**最大化**时不应再画圆角/留边框：此时窗口与屏幕边缘齐平，
 * 多余的圆角会在四角露出页面底色（一道黑边）。
 */
export function titlebarRadius(state) {
  const s = normalizeWindowState(state);
  return s.maximized || s.fullscreen ? 0 : 6;
}

/**
 * 是否保留「页面内容顶部预留 40px」的内边距。
 * 全屏（真 F11 / 视频全屏）时官方会隐藏标题栏，这里也跟着收起。
 */
export function shouldReserveContentTop(state) {
  return !normalizeWindowState(state).fullscreen;
}

/**
 * 构造 `popup_menu` 的参数。
 *
 * 契约冻结：`{ menu: "app" | "actions", x: number }`，其中 `x` 是**相对主窗口左上角的逻辑像素**。
 * 用按钮的 `getBoundingClientRect().left`（CSS 像素，对文档缩放免疫），并夹到 >= 0。
 *
 * @param {"app"|"actions"} menu
 * @param {number} buttonLeft 按钮左边缘的 CSS 像素坐标
 */
export function menuRequest(menu, buttonLeft) {
  if (menu !== "app" && menu !== "actions") {
    throw new Error(`未知菜单：${menu}`);
  }
  const x = Number.isFinite(buttonLeft) ? Math.max(0, buttonLeft) : 0;
  return { menu, x };
}

/** 构造 `window_control` 的参数。只有三个合法动作，写错要当场炸出来而不是静默失效。 */
export function windowControlRequest(action) {
  const allowed = ["minimize", "toggle-maximize", "close"];
  if (!allowed.includes(action)) {
    throw new Error(`未知的窗口操作：${action}`);
  }
  return { action };
}

/** 构造 `chrome_action` 的参数。合法动作 = 两个菜单的条目 + 直接动作。 */
export function chromeActionRequest(action) {
  const allowed = [...APP_MENU_ACTIONS, ...ACTIONS_MENU_ACTIONS, ...Object.values(DIRECT_ACTIONS)];
  if (!allowed.includes(action)) {
    throw new Error(`未知的菜单操作：${action}`);
  }
  return { action };
}
