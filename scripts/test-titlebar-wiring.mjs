/*
 * 顶栏接线测试：node --test scripts/test-titlebar-wiring.mjs
 *
 * 和 scripts/test-titlebar.mjs 的分工：
 *   - test-titlebar.mjs 测**纯函数**（rules.js 算出什么）；
 *   - 这里测**接线**（titlebar.js 有没有把事件接到正确的命令上、参数对不对）。
 *
 * 做法：用最小 DOM / Tauri stub 真跑一遍 src/titlebar/titlebar.js，手动触发事件，
 * 断言捕获到的 invoke 调用序列。每个用例用带 query 的 URL 重新 import 一次，
 * 保证模块状态（warned 标志等）互不干扰。
 *
 * 这**不是**渲染测试 —— 颜色/字体/悬停这些视觉必须在 Windows 真机上确认，
 * 见 src/titlebar/README.md「只能在 Windows 上确认的部分」。
 */
import test from "node:test";
import assert from "node:assert/strict";

const IDS = ["bar", "btn-app", "btn-actions", "btn-chat", "btn-min", "btn-max", "btn-close"];
let seq = 0;
/** freshBoot 期间被替换掉的原始 console.warn，由用例或 afterEach 恢复。 */
let lastRestore = null;

test.afterEach(() => {
  if (lastRestore) {
    console.warn = lastRestore;
    lastRestore = null;
  }
});

/**
 * 搭一个最小浏览器环境并加载 titlebar.js。
 * @param {{tauri?: "core"|"internals"|"none"}} [opts] 模拟哪种 Tauri 注入方式
 */
async function freshBoot(opts = {}) {
  seq += 1;
  const mode = opts.tauri ?? "core";
  const calls = [];
  const warns = [];
  const listeners = new Map();
  const rootListeners = new Map();

  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));

  const win = {};
  win.window = win; // titlebar.js 里用 window.xxx 访问
  globalThis.window = win;

  if (mode === "core") {
    win.__TAURI__ = {
      core: { invoke: (cmd, args) => (calls.push([cmd, args]), Promise.resolve()) },
    };
  } else if (mode === "internals") {
    win.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => (calls.push([cmd, args]), Promise.resolve()),
    };
  }

  const makeEl = (id) => ({
    id,
    textContent: "",
    title: "",
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    addEventListener(type, fn) {
      const key = `${id}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(fn);
    },
    getBoundingClientRect: () => ({ left: 100, top: 0, width: 46, height: 40 }),
    closest: () => null,
    classList: { toggle() {}, add() {}, remove() {} },
  });

  const els = Object.fromEntries(IDS.map((id) => [id, makeEl(id)]));
  win.document = {
    documentElement: { classList: { toggle() {} } },
    getElementById: (id) => els[id] ?? null,
  };
  globalThis.document = win.document;
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  // titlebar.js 用的是裸 `window.addEventListener` 与 `window.dispatchEvent`
  win.addEventListener = (type, fn) => {
    if (!rootListeners.has(type)) rootListeners.set(type, []);
    rootListeners.get(type).push(fn);
  };
  win.dispatchEvent = () => true;
  globalThis.addEventListener = win.addEventListener;
  globalThis.dispatchEvent = win.dispatchEvent;

  const url = `../src/titlebar/titlebar.js?case=${seq}`;
  try {
    await import(url);
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    // 注意：**不能**在这里就恢复 console.warn —— invoke 的降级警告是在
    // 用户点击时（异步）才发出的，提前恢复就捕获不到了。
    // 由用例显式调用 app.done() 收尾；下面的全局 afterEach 也会兜底。
    lastRestore = origWarn;
  }

  const evt = (target, button = 0) => ({ target, button, preventDefault() {} });
  const fire = async (key, event) => {
    for (const fn of listeners.get(key) ?? []) await fn(event);
  };

  return {
    calls,
    els,
    warns,
    done() {
      console.warn = origWarn;
    },
    click: (id) => fire(`${id}:click`, evt(els[id])),
    mousedown: (target, button = 0) => fire("bar:mousedown", evt(target, button)),
    dblclick: (target, button = 0) => fire("bar:dblclick", evt(target, button)),
    pushState: (detail) => {
      for (const fn of rootListeners.get("dsht:window-state") ?? []) fn({ detail });
    },
  };
}

const BLANK = { closest: () => null };
const ON_BUTTON = { closest: () => ({ tagName: "BUTTON" }) };

/* ------------------------------------------------------------------ 菜单 */

test("点「应用」发 popup_menu {menu:'app', x:按钮左边缘}", async () => {
  const app = await freshBoot();
  await app.click("btn-app");
  assert.deepEqual(app.calls, [["popup_menu", { menu: "app", x: 100 }]]);
});

test("点「操作」发 popup_menu {menu:'actions'}", async () => {
  const app = await freshBoot();
  await app.click("btn-actions");
  assert.deepEqual(app.calls, [["popup_menu", { menu: "actions", x: 100 }]]);
});

test("「网页对话」是直接动作，发 chrome_action chat", async () => {
  const app = await freshBoot();
  await app.click("btn-chat");
  assert.deepEqual(app.calls, [["chrome_action", { action: "chat" }]]);
});

/* -------------------------------------------------------------- 窗口按钮 */

test("三个窗口按钮分别发 minimize / toggle-maximize / close", async () => {
  const app = await freshBoot();
  await app.click("btn-min");
  await app.click("btn-max");
  await app.click("btn-close");
  assert.deepEqual(app.calls, [
    ["window_control", { action: "minimize" }],
    ["window_control", { action: "toggle-maximize" }],
    ["window_control", { action: "close" }],
  ]);
});

/* ------------------------------------------------------------------ 拖动 */

test("空白处按下 = start_drag", async () => {
  const app = await freshBoot();
  await app.mousedown(BLANK);
  assert.deepEqual(app.calls, [["start_drag", undefined]]);
});

test("按在按钮上不拖动（否则点菜单会把窗口拖走）", async () => {
  const app = await freshBoot();
  await app.mousedown(ON_BUTTON);
  assert.deepEqual(app.calls, []);
});

test("非左键不拖动", async () => {
  const app = await freshBoot();
  await app.mousedown(BLANK, 1); // 中键
  await app.mousedown(BLANK, 2); // 右键
  assert.deepEqual(app.calls, []);
});

test("双击空白处 = toggle-maximize", async () => {
  const app = await freshBoot();
  await app.dblclick(BLANK);
  assert.deepEqual(app.calls, [["window_control", { action: "toggle-maximize" }]]);
});

test("双击按钮上不触发最大化", async () => {
  const app = await freshBoot();
  await app.dblclick(ON_BUTTON);
  assert.deepEqual(app.calls, []);
});

/* -------------------------------------------------------- 窗口状态推送 */

test("收到 maximized 推送后，按钮变「向下还原」+ 图标 E923", async () => {
  const app = await freshBoot();
  app.pushState({ maximized: true });
  assert.equal(app.els["btn-max"].title, "向下还原");
  assert.equal(app.els["btn-max"].attrs["aria-label"], "向下还原");
  assert.equal(app.els["btn-max"].textContent, "\uE923");
});

test("未最大化时是「最大化」+ 图标 E922", async () => {
  const app = await freshBoot();
  app.pushState({ maximized: false });
  assert.equal(app.els["btn-max"].title, "最大化");
  assert.equal(app.els["btn-max"].textContent, "\uE922");
});

test("最大化后空白处不再拖动、不再双击切换", async () => {
  const app = await freshBoot();
  app.pushState({ maximized: true });
  await app.mousedown(BLANK);
  await app.dblclick(BLANK);
  assert.deepEqual(app.calls, []);
});

test("全屏后同样不拖动、不双击切换", async () => {
  const app = await freshBoot();
  app.pushState({ fullscreen: true });
  await app.mousedown(BLANK);
  await app.dblclick(BLANK);
  assert.deepEqual(app.calls, []);
});

test("还原之后又能拖动（状态推送可逆）", async () => {
  const app = await freshBoot();
  app.pushState({ maximized: true });
  await app.mousedown(BLANK);
  app.pushState({ maximized: false });
  await app.mousedown(BLANK);
  assert.deepEqual(app.calls, [["start_drag", undefined]]);
});

test("最大化状态下窗口按钮依然可用", async () => {
  const app = await freshBoot();
  app.pushState({ maximized: true });
  await app.click("btn-max");
  await app.click("btn-min");
  assert.deepEqual(app.calls, [
    ["window_control", { action: "toggle-maximize" }],
    ["window_control", { action: "minimize" }],
  ]);
});

/* ------------------------------------------------------------ invoke 降级 */

test("只有 __TAURI_INTERNALS__ 时也能调用（降级路径）", async () => {
  const app = await freshBoot({ tauri: "internals" });
  await app.click("btn-min");
  assert.deepEqual(app.calls, [["window_control", { action: "minimize" }]]);
});

test("完全没有 Tauri 时只警告一次，且不抛异常", async () => {
  const app = await freshBoot({ tauri: "none" });
  await app.click("btn-close");
  await app.click("btn-max");
  await app.click("btn-app");
  assert.equal(app.warns.length, 1);
  assert.match(app.warns[0], /找不到 Tauri invoke/);
  assert.deepEqual(app.calls, []);
  app.done();
});
