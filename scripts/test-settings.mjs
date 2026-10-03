/*
 * 「设置」窗口接线测试：node --test scripts/test-settings.mjs
 *
 * 和 scripts/test-titlebar-wiring.mjs 同一套路：用最小 DOM / Tauri stub 真跑一遍
 * src/settings.js，手动触发事件，断言捕获到的 invoke 调用序列与参数。
 *
 * 为什么需要这个文件（单测/静态校验都覆盖不到的一段）：
 *
 *   Rust 侧 `save_config` 是**补丁语义**（只覆盖载荷里出现过的字段），
 *   而这条契约成立的前提是**前端只发要改的字段**。
 *   如果 settings.js 图省事把整份 config 发过去，`chatDocked` 之外的字段
 *   就会以「当前值」被写回 —— 表面看没问题，但一旦前端持有的 config 副本过期
 *   （用户在别处改过地址），就会把旧值覆盖回去。
 *   所以这里**断言载荷里只有 chatDocked 一个键**，把契约钉死。
 *
 * 这**不是**渲染测试 —— 颜色/间距必须在真机上确认。
 */
import test from "node:test";
import assert from "node:assert/strict";

const IDS = ["version", "conn-summary", "btn-reconnect", "modes", "status", "btn-close"];
let seq = 0;

/**
 * 搭一个最小浏览器环境并加载 src/settings.js。
 * @param {{tauri?: "core"|"internals"|"none", config?: object|null, failSave?: boolean}} [opts]
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
  win.window = win;
  globalThis.window = win;

  const invokeImpl = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "load_config") {
      if (opts.config === null) return Promise.reject(new Error("boom"));
      return Promise.resolve(opts.config ?? {});
    }
    if (cmd === "save_config" && opts.failSave) {
      return Promise.reject(new Error("磁盘只读"));
    }
    return Promise.resolve(null);
  };

  if (mode === "core") {
    win.__TAURI__ = { core: { invoke: invokeImpl } };
  } else if (mode === "internals") {
    win.__TAURI_INTERNALS__ = { invoke: invokeImpl };
  }

  const makeEl = (id) => ({
    id,
    textContent: "",
    className: "",
    disabled: false,
    checked: false,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) {
      const key = `${id}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(fn);
    },
    // 真浏览器里 HTMLElement.click() 会派发 click 事件；
    // settings.js 的 Esc 处理就是调 `ui.close.click()`，所以这里必须实现。
    click() {
      for (const fn of listeners.get(`${id}:click`) ?? []) fn({ preventDefault() {} });
    },
    closest: () => null,
  });

  const els = Object.fromEntries(IDS.map((id) => [id, makeEl(id)]));

  // 两个模式单选按钮 + 它们的 .mode 容器（renderMode 会 toggle .is-active）
  const makeRadio = (value) => {
    const el = makeEl(`mode-${value}`);
    el.value = value;
    el.modeEl = { classes: new Set(), classList: { toggle(_c, on) { on ? this._s.add(1) : 0; } } };
    const box = {
      active: false,
      classList: {
        toggle(cls, on) { box.active = Boolean(on); },
        add() {}, remove() {},
      },
    };
    el.closest = (sel) => (sel === ".mode" ? box : null);
    el._box = box;
    return el;
  };
  const radios = [makeRadio("overlay"), makeRadio("docked")];

  win.document = {
    documentElement: { classList: { toggle() {} } },
    getElementById: (id) => els[id] ?? null,
    querySelectorAll: (sel) => (sel === 'input[name="chat-mode"]' ? radios : []),
  };
  globalThis.document = win.document;

  win.addEventListener = (type, fn) => {
    if (!rootListeners.has(type)) rootListeners.set(type, []);
    rootListeners.get(type).push(fn);
  };
  win.close = () => { win.closed = true; };
  globalThis.addEventListener = win.addEventListener;

  const url = `../src/settings.js?case=${seq}`;
  await import(url);
  // boot() 是异步 IIFE：多让几个微/宏任务跑完，等 load_config / app_version 落地。
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

  const fire = async (key, event) => {
    for (const fn of listeners.get(key) ?? []) await fn(event);
  };

  return {
    calls,
    els,
    radios,
    warns,
    done() { console.warn = origWarn; },
    click: (id) => fire(`${id}:click`, { preventDefault() {} }),
    change: async (radio) => {
      radio.checked = true;
      await fire(`${radio.id}:change`, { target: radio, preventDefault() {} });
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    },
    keydown: async (key) => {
      for (const fn of rootListeners.get("keydown") ?? []) {
        await fn({ key, preventDefault() {} });
      }
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    },
    callsOf: (cmd) => calls.filter(([c]) => c === cmd),
  };
}

/** 收尾：恢复 console.warn。 */
const finish = (app) => app.done();

/* --------------------------------------------------------------- 启动读取 */

test("启动时读配置，并按 chatDocked 回显对应模式", async () => {
  const app = await freshBoot({ config: { chatDocked: true, localUrl: "http://x:1" } });
  assert.deepEqual(app.callsOf("load_config").length, 1);
  assert.equal(app.radios[0].checked, false, "overlay 不该被选中");
  assert.equal(app.radios[1].checked, true, "docked 应被选中");
  assert.equal(app.radios[1]._box.active, true, "docked 卡片应有 is-active 兜底类");
  finish(app);
});

test("老配置没有 chatDocked 时按 overlay（默认）回显", async () => {
  const app = await freshBoot({ config: { localUrl: "http://x:1" } });
  assert.equal(app.radios[0].checked, true);
  assert.equal(app.radios[1].checked, false);
  finish(app);
});

test("版本号来自 Rust 的 app_version", async () => {
  const app = await freshBoot({ config: {} });
  assert.ok(app.callsOf("app_version").length === 1);
  finish(app);
});

test("连接摘要显示已配置的地址", async () => {
  const app = await freshBoot({
    config: { localUrl: "http://127.0.0.1:3080", remoteUrl: "https://dsh.example.com" },
  });
  assert.match(app.els["conn-summary"].textContent, /127\.0\.0\.1:3080/);
  assert.match(app.els["conn-summary"].textContent, /dsh\.example\.com/);
  finish(app);
});

/* -------------------------------------------------- 切模式：补丁语义契约 */

test("切到 docked 只发 { chatDocked: true }（不带其它字段）", async () => {
  const app = await freshBoot({
    config: { chatDocked: false, localUrl: "http://x:1", remoteUrl: "https://y:2" },
  });
  await app.change(app.radios[1]);

  const saves = app.callsOf("save_config");
  assert.equal(saves.length, 1, "应当恰好保存一次");
  const payload = saves[0][1];
  // ⚠️ 核心契约：Rust 侧 save_config 是补丁语义，前端必须只发要改的字段。
  assert.deepEqual(
    Object.keys(payload.config),
    ["chatDocked"],
    "载荷只能含 chatDocked —— 多发字段会把前端可能过期的副本覆盖回磁盘",
  );
  assert.equal(payload.config.chatDocked, true);
  finish(app);
});

test("切回 overlay 只发 { chatDocked: false }", async () => {
  const app = await freshBoot({ config: { chatDocked: true } });
  await app.change(app.radios[0]);

  const payload = app.callsOf("save_config")[0][1];
  assert.deepEqual(Object.keys(payload.config), ["chatDocked"]);
  assert.equal(payload.config.chatDocked, false);
  finish(app);
});

test("保存成功后提示「布局立即生效」并保持选中态", async () => {
  const app = await freshBoot({ config: { chatDocked: false } });
  await app.change(app.radios[1]);
  assert.match(app.els.status.textContent, /并排/);
  assert.equal(app.els.status.className, "status ok");
  assert.equal(app.radios[1].checked, true);
  finish(app);
});

test("保存失败时回退到磁盘状态并报错（不能显示与配置不一致的模式）", async () => {
  const app = await freshBoot({ config: { chatDocked: false }, failSave: true });
  await app.change(app.radios[1]);

  // 用户点了 docked，但保存失败 ⇒ 界面必须回到 overlay。
  assert.equal(app.radios[0].checked, true, "失败后应回退到 overlay");
  assert.equal(app.radios[1].checked, false);
  assert.match(app.els.status.textContent, /保存失败/);
  assert.equal(app.els.status.className, "status err");
  finish(app);
});

test("保存期间禁用单选按钮，避免连点造成乱序写入", async () => {
  const app = await freshBoot({ config: { chatDocked: false } });
  await app.change(app.radios[1]);
  // 保存已结束 ⇒ 恢复可用
  assert.equal(app.radios[0].disabled, false);
  assert.equal(app.radios[1].disabled, false);
  finish(app);
});

/* ------------------------------------------------------------ 重新选择连接 */

test("「重新选择连接方式」复用 chrome_action reconnect，然后收起设置窗口", async () => {
  const app = await freshBoot({ config: {} });
  await app.click("btn-reconnect");

  const actions = app.callsOf("chrome_action");
  assert.equal(actions.length, 1);
  // 与托盘「重新选择连接方式」/ 顶栏「应用 → 重新连接」是同一个 action。
  assert.deepEqual(actions[0][1], { action: "reconnect" });

  const wc = app.callsOf("window_control");
  assert.deepEqual(wc.map(([, a]) => a), [{ action: "close-settings" }]);
  finish(app);
});

test("打开选择窗口失败时报错，且不收起设置窗口", async () => {
  const app = await freshBoot({ config: {} });
  // 让 chrome_action 失败
  app.calls.length = 0;
  const orig = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = (cmd, args) =>
    cmd === "chrome_action" ? Promise.reject(new Error("nope")) : orig(cmd, args);
  await app.click("btn-reconnect");
  assert.match(app.els.status.textContent, /无法打开选择窗口/);
  assert.equal(app.callsOf("window_control").length, 0);
  window.__TAURI__.core.invoke = orig;
  finish(app);
});

/* ------------------------------------------------------------------ 关闭 */

test("关闭按钮发 window_control close-settings", async () => {
  const app = await freshBoot({ config: {} });
  await app.click("btn-close");
  assert.deepEqual(
    app.callsOf("window_control").map(([, a]) => a),
    [{ action: "close-settings" }],
  );
  finish(app);
});

test("Esc 等同于点关闭", async () => {
  const app = await freshBoot({ config: {} });
  await app.keydown("Escape");
  assert.deepEqual(
    app.callsOf("window_control").map(([, a]) => a),
    [{ action: "close-settings" }],
  );
  // 其它键不该关窗
  app.calls.length = 0;
  await app.keydown("a");
  assert.equal(app.callsOf("window_control").length, 0);
  finish(app);
});

test("拿不到 Tauri 时只警告一次，且不抛异常", async () => {
  const app = await freshBoot({ tauri: "none", config: {} });
  await app.click("btn-close");
  await app.click("btn-reconnect");
  assert.equal(app.warns.length, 1, `应只警告一次，实际 ${app.warns.length}`);
  assert.match(app.warns[0], /找不到 Tauri invoke/);
  assert.equal(app.calls.length, 0);
  finish(app);
});

test("只有 __TAURI_INTERNALS__ 时也能调用（降级路径）", async () => {
  const app = await freshBoot({ tauri: "internals", config: { chatDocked: true } });
  assert.equal(app.callsOf("load_config").length, 1);
  await app.click("btn-close");
  assert.equal(app.callsOf("window_control").length, 1);
  finish(app);
});

test("读配置失败时禁用模式单选（避免在未知状态下写入）", async () => {
  const app = await freshBoot({ config: null });
  assert.equal(app.radios[0].disabled, true);
  assert.equal(app.radios[1].disabled, true);
  assert.match(app.els.status.textContent, /读取配置失败/);
  finish(app);
});
