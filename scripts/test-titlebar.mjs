/*
 * 顶栏规则单元测试：node --test scripts/test-titlebar.mjs
 *
 * 被测逻辑是 src/titlebar/rules.js —— 顶栏运行时（src/titlebar/titlebar.js）用的同一份代码。
 * 这里只测**纯函数**，不碰 DOM / Tauri；真正的可见效果要在 Windows 真机上确认（见 README）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `src-tauri/src/lib.rs` 的绝对路径（契约对账要真读它）。 */
const LIB_RS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "src", "lib.rs");

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

/**
 * 从 `src-tauri/src/lib.rs` 里解析出 `popup_menu` 两个分支的菜单项 id。
 *
 * 为什么不写硬编码快照：这里以前是
 *   `assert.deepEqual(APP_MENU_ACTIONS, ["about","check-update","reconnect"])`
 * —— 一个**不读 Rust 源码**的快照。结果菜单加了 `settings` 之后，
 * 前端白名单、Rust 菜单、这条断言三方已经不一致，而测试**照样全绿**（假绿）。
 * 现在改成真解析，任何一方漂移都会当场测挂。
 */
function parsePopupMenuIds(libSrc) {
  // popup_menu 函数体：从 `async fn popup_menu` 开始。
  const start = libSrc.indexOf("async fn popup_menu");
  assert.notEqual(start, -1, "在 lib.rs 里找不到 `async fn popup_menu`（函数被改名了？）");
  const body = libSrc.slice(start);

  // 按分支切：每个分支从 `"<name>" => {` 到**下一个**分支标记（或兜底 `other =>`）为止。
  // 注意不能只找 `other =>`：那是**最后一个**分支的兜底，
  // 用它当上界会把后面的分支内容一起吞进第一个分支里。
  const branchNames = ["app", "actions"];
  const markers = branchNames.map((n) => ({ n, m: `"${n}" => {` }));
  const otherAt = body.indexOf("other =>");

  const grab = (name) => {
    const marker = `"${name}" => {`;
    const i = body.indexOf(marker);
    assert.notEqual(i, -1, `在 popup_menu 里找不到分支 ${marker}`);
    const from = i + marker.length;

    // 上界 = 下一个分支标记 / 兜底行 / 函数结束，取最近的那个。
    let to = body.length;
    for (const { m } of markers) {
      const j = body.indexOf(m, from);
      if (j !== -1 && j < to) to = j;
    }
    if (otherAt !== -1 && otherAt > from && otherAt < to) to = otherAt;

    return [...body.slice(from, to).matchAll(/item\("([^"]+)"/g)].map((mm) => mm[1]);
  };

  return { app: grab("app"), actions: grab("actions") };
}

/** 从 lib.rs 的 `run_action` 里解析出所有 action 分支名。 */
function parseRunActionIds(libSrc) {
  const start = libSrc.indexOf("fn run_action");
  assert.notEqual(start, -1, "在 lib.rs 里找不到 `fn run_action`（函数被改名了？）");
  const body = libSrc.slice(start);
  const end = body.indexOf("\n}");
  const scoped = end === -1 ? body : body.slice(0, end);
  return [...scoped.matchAll(/^\s*"([a-z-]+)"\s*=>/gm)].map((m) => m[1]);
}

test("菜单条目与 Rust popup_menu 的分支一一对应（真读 lib.rs，不是快照）", () => {
  const libSrc = readFileSync(LIB_RS, "utf8");
  const ids = parsePopupMenuIds(libSrc);

  assert.deepEqual(
    APP_MENU_ACTIONS,
    ids.app,
    "顶栏的 APP_MENU_ACTIONS 与 Rust `popup_menu` 的 app 分支不一致",
  );
  assert.deepEqual(
    ACTIONS_MENU_ACTIONS,
    ids.actions,
    "顶栏的 ACTIONS_MENU_ACTIONS 与 Rust `popup_menu` 的 actions 分支不一致",
  );
  assert.deepEqual(DIRECT_ACTIONS, { chat: "chat" });

  // 每个菜单项都必须有对应的 run_action 分支，否则点了没反应。
  const branches = parseRunActionIds(libSrc);
  for (const id of [...ids.app, ...ids.actions]) {
    assert.ok(
      branches.includes(id),
      `菜单项 "${id}" 在 popup_menu 里有，但 run_action 里没有对应分支（点了会报「未知的菜单操作」）`,
    );
  }
});

test("顶栏只使用已冻结的四个命令", () => {
  assert.deepEqual([...TITLEBAR_COMMANDS].sort(), [
    "chrome_action",
    "popup_menu",
    "start_drag",
    "window_control",
  ]);
});
