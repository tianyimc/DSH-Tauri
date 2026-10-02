/*
 * 顶栏规则单元测试：node --test scripts/test-titlebar.mjs
 *
 * 被测逻辑是 src/titlebar/rules.js —— 顶栏运行时（src/titlebar/titlebar.js）用的同一份代码。
 * 这里只测**纯函数**，不碰 DOM / Tauri；真正的可见效果要在 Windows 真机上确认（见 README）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS_MENU_ACTIONS,
  APP_MENU_ACTIONS,
  DIRECT_ACTIONS,
  TITLEBAR_COMMANDS,
  TITLEBAR_HEIGHT,
  canDragWindow,
  canToggleMaximize,
  chromeActionRequest,
  isTitlebarChromeHit,
  maximizeButtonAriaLabel,
  maximizeButtonGlyph,
  maximizeButtonTitle,
  menuRequest,
  normalizeWindowState,
  shouldReserveContentTop,
  titlebarRadius,
  windowControlRequest,
} from "../src/titlebar/rules.js";

/* --------------------------------------------------- 官方 P3 的关键尺寸 */

test("顶栏高度是 40px（与 Rust TITLEBAR_HEIGHT 一致）", () => {
  assert.equal(TITLEBAR_HEIGHT, 40);
});

/* ------------------------------------------------------------ 命中判定 */

test("左键点在空白处 = 可拖拽", () => {
  assert.equal(isTitlebarChromeHit(null, 0), true);
  assert.equal(isTitlebarChromeHit(undefined, 0), true);
});

test("点在按钮上不算拖拽（否则点菜单会把窗口拖走）", () => {
  assert.equal(isTitlebarChromeHit("BUTTON", 0), false);
  assert.equal(isTitlebarChromeHit("button.ctl.close", 0), false);
});

test("非左键不触发拖动/双击", () => {
  assert.equal(isTitlebarChromeHit(null, 1), false); // 中键
  assert.equal(isTitlebarChromeHit(null, 2), false); // 右键
});

/* -------------------------------------------------------- 窗口状态规则 */

test("普通窗口可以拖动", () => {
  assert.equal(canDragWindow({ maximized: false }), true);
  assert.equal(canDragWindow({}), true);
});

test("最大化 / 全屏时不能拖动", () => {
  assert.equal(canDragWindow({ maximized: true }), false);
  assert.equal(canDragWindow({ fullscreen: true }), false);
  assert.equal(canDragWindow({ maximized: true, fullscreen: true }), false);
});

test("最大化时双击不再切换（此时应点按钮还原）", () => {
  assert.equal(canToggleMaximize({ maximized: false }), true);
  assert.equal(canToggleMaximize({ maximized: true }), false);
  assert.equal(canToggleMaximize({ fullscreen: true }), false);
});

test("normalizeWindowState 补全默认值：无边框是常态", () => {
  assert.deepEqual(normalizeWindowState(), {
    maximized: false,
    fullscreen: false,
    minimized: false,
    focused: false,
    borderless: true,
  });
  assert.equal(normalizeWindowState({ maximized: 1 }).maximized, true);
  assert.equal(normalizeWindowState({ borderless: false }).borderless, false);
});

/* -------------------------------------------------- 最大化按钮的呈现 */

test("最大化按钮的 tooltip 反映「点下去会发生什么」", () => {
  assert.equal(maximizeButtonTitle({ maximized: false }), "最大化");
  assert.equal(maximizeButtonTitle({ maximized: true }), "向下还原");
});

test("最大化按钮的图标在 E922 / E923 之间切换", () => {
  assert.equal(maximizeButtonGlyph({ maximized: false }), "\uE922");
  assert.equal(maximizeButtonGlyph({ maximized: true }), "\uE923");
});

test("无障碍标签与 tooltip 一致", () => {
  assert.equal(maximizeButtonAriaLabel({ maximized: true }), "向下还原");
  assert.equal(maximizeButtonAriaLabel({ maximized: false }), "最大化");
});

test("最大化/全屏时不留圆角（否则四角露出一道黑边）", () => {
  assert.equal(titlebarRadius({ maximized: false }), 6);
  assert.equal(titlebarRadius({ maximized: true }), 0);
  assert.equal(titlebarRadius({ fullscreen: true }), 0);
});

test("全屏时不再给页面预留顶部 40px", () => {
  assert.equal(shouldReserveContentTop({}), true);
  assert.equal(shouldReserveContentTop({ fullscreen: true }), false);
});

/* ----------------------------------------------------- 命令参数构造 */

test("popup_menu 参数是 {menu, x}，x 是相对主窗口左边的 CSS 像素", () => {
  assert.deepEqual(menuRequest("app", 14), { menu: "app", x: 14 });
  assert.deepEqual(menuRequest("actions", 96.5), { menu: "actions", x: 96.5 });
});

test("popup_menu 的 x 被夹到 >= 0，非法值退化为 0", () => {
  assert.equal(menuRequest("app", -5).x, 0);
  assert.equal(menuRequest("app", NaN).x, 0);
  assert.equal(menuRequest("app", undefined).x, 0);
});

test("未知菜单名要抛出，而不是发一个空菜单过去", () => {
  assert.throws(() => menuRequest("nope", 0), /未知菜单/);
});

test("window_control 只接受三个动作", () => {
  assert.deepEqual(windowControlRequest("minimize"), { action: "minimize" });
  assert.deepEqual(windowControlRequest("toggle-maximize"), { action: "toggle-maximize" });
  assert.deepEqual(windowControlRequest("close"), { action: "close" });
  assert.throws(() => windowControlRequest("maximize"), /未知的窗口操作/);
});

test("chrome_action 覆盖两个菜单的全部条目 + 直接动作", () => {
  for (const action of [...APP_MENU_ACTIONS, ...ACTIONS_MENU_ACTIONS, ...Object.values(DIRECT_ACTIONS)]) {
    assert.deepEqual(chromeActionRequest(action), { action });
  }
  assert.throws(() => chromeActionRequest("nope"), /未知的菜单操作/);
});

/* -------------------------------------------------------- 契约对账表 */

test("菜单条目与 Rust popup_menu 的分支一一对应", () => {
  // 见 src-tauri/src/lib.rs 的 popup_menu：app 分支 3 项，actions 分支 3 项
  assert.deepEqual(APP_MENU_ACTIONS, ["about", "check-update", "reconnect"]);
  assert.deepEqual(ACTIONS_MENU_ACTIONS, ["refresh", "undo", "redo"]);
  assert.deepEqual(DIRECT_ACTIONS, { chat: "chat" });
});

test("顶栏只使用已冻结的四个命令", () => {
  assert.deepEqual([...TITLEBAR_COMMANDS].sort(), [
    "chrome_action",
    "popup_menu",
    "start_drag",
    "window_control",
  ]);
});
