/*
 * DSHTauri 顶栏 —— 交互逻辑。
 *
 * 这个页面（src/titlebar.html）是一个**本地页面**，由 Rust 作为主窗口上方那条 40px 高的
 * webview 加载。它是本地来源，所以命中 capabilities/default.json，
 * `window.__TAURI__.core.invoke` 可用（withGlobalTauri: true）。
 *
 * 下拉菜单用**原生菜单**（Rust 的 popup_menu 命令）而不是 HTML：
 * 这个 webview 只有 40px 高，HTML 下拉会被窗口边界裁掉；原生菜单能正常溢出到窗口外，
 * 外观也跟随系统 —— 与改造前的 chrome.js 保持一致。
 *
 * 纯逻辑（状态 -> 视觉、请求参数构造）在 src/titlebar/rules.js 里，那份是可测的
 * ES module；这里只做 DOM 接线。
 */

import {
  DIRECT_ACTIONS,
  canDragWindow,
  canToggleMaximize,
  chromeActionRequest,
  isTitlebarChromeHit,
  maximizeButtonAriaLabel,
  maximizeButtonGlyph,
  maximizeButtonTitle,
  menuRequest,
  normalizeWindowState,
  windowControlRequest,
} from "./rules.js";

/* ----------------------------------------------------------- invoke 包装 */

/**
 * 把 Tauri 调用收敛到一个函数里。
 *
 * 本地页面里 `__TAURI__.core.invoke` 应当可用，但这里是「注入/内嵌」场景，
 * 宁可退化也不要让整条顶栏崩掉：依次尝试几种已知位置，都拿不到就
 * console.warn 一次并让按钮**静默失效**（返回 rejected promise，调用方吞掉）。
 */
function createInvoker() {
  let warned = false;

  return function invoke(cmd, args) {
    const candidates = [
      () => window.__TAURI__?.core?.invoke,
      () => window.__TAURI__?.invoke,
      () => window.__TAURI_INTERNALS__?.invoke,
      () => window.__TAURI_INTERNALS__?.ipc,
    ];

    let fn = null;
    for (const pick of candidates) {
      try {
        const found = pick();
        if (typeof found === "function") {
          fn = found;
          break;
        }
      } catch {
        /* 某些构建里访问 __TAURI__ 会抛，忽略这一路候选 */
      }
    }

    if (!fn) {
      if (!warned) {
        warned = true;
        console.warn(
          "[DSHTauri] 顶栏：找不到 Tauri invoke，窗口按钮/菜单将静默失效。" +
            "（本地页面应当命中 capabilities/default.json，检查窗口 label 是否在权限列表里）",
        );
      }
      return Promise.reject(new Error("Tauri invoke unavailable"));
    }

    let result;
    try {
      result = fn.call(window, cmd, args);
    } catch (err) {
      console.warn(`[DSHTauri] 顶栏调用失败：${cmd}`, err);
      return Promise.reject(err);
    }
    return Promise.resolve(result).catch((err) => {
      console.warn(`[DSHTauri] 顶栏调用失败：${cmd}`, err);
      throw err;
    });
  };
}

export const invoke = createInvoker();

/** 发起调用并吞掉 rejection（invoke 内部已经 warn 过，这里防止 unhandled rejection）。 */
function fire(promise) {
  if (promise && typeof promise.catch === "function") {
    promise.catch(() => {});
  }
}

/* ------------------------------------------------------------------ 元素 */

const el = (id) => document.getElementById(id);

const bar = el("bar");
const menuApp = el("btn-app");
const menuActions = el("btn-actions");
const btnChat = el("btn-chat");
const btnMin = el("btn-min");
const btnMax = el("btn-max");
const btnClose = el("btn-close");

/* ---------------------------------------------------------- 窗口状态同步 */

/*
 * 顶栏是主窗口里的一个**子 webview**：它看不到主窗口是否最大化，
 * 浏览器侧的 `screen.availHeight` 在 DPI 缩放 / 多显示器 / 任务栏自动隐藏下都会误判。
 * 所以以 **Rust 推送的状态**为准：Rust 用
 * `emit_to("titlebar", "dsht:window-state", { maximized, fullscreen })` 推送。
 *
 * ⚠️ **Tauri 事件不是 DOM 事件。** 必须用 `window.__TAURI__.event.listen(...)` 订阅；
 * 只挂 `window.addEventListener("dsht:window-state", ...)` 是**永远不会触发**的，
 * 表现为「窗口最大化后，最大化按钮的图标不切成『还原』」。
 *
 * 收不到事件时顶栏仍然完全可用：最大化/还原由 Rust 自己判断当前状态，
 * 双击在非最大化时也照常生效（拖动是否允许同样由 Rust 的 `start_drag` 兜底）。
 */
let winState = normalizeWindowState({ maximized: false, focused: true });

function applyWindowState(next) {
  if (!next || typeof next !== "object") return;
  winState = normalizeWindowState(next);

  document.documentElement.classList.toggle("dsht-maximized", winState.maximized);
  document.documentElement.classList.toggle("dsht-fullscreen", winState.fullscreen);

  if (btnMax) {
    btnMax.textContent = maximizeButtonGlyph(winState);
    btnMax.title = maximizeButtonTitle(winState);
    btnMax.setAttribute("aria-label", maximizeButtonAriaLabel(winState));
  }
}

/**
 * 订阅一个由 Rust 侧发出的 Tauri 事件。
 *
 * 拿不到 Tauri 事件 API 时退化为监听同名 DOM 事件（便于单测/将来换实现），
 * 两条路都收不到也不影响顶栏其余功能。
 */
function listenWindowState(event, handler) {
  const api = window.__TAURI__?.event;
  if (api && typeof api.listen === "function") {
    try {
      const pending = api.listen(event, (e) => handler(e?.payload));
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
      return;
    } catch (err) {
      console.warn(`[DSHTauri] 顶栏：订阅 ${event} 失败（窗口状态图标不会联动）`, err);
    }
  }
  window.addEventListener(event, (e) => handler(e?.detail));
}

listenWindowState("dsht:window-state", applyWindowState);

/* -------------------------------------------------------------- 原生菜单 */

function openMenu(menu, button) {
  if (!button) return;
  const rect = button.getBoundingClientRect();
  button.setAttribute("aria-expanded", "true");
  fire(
    invoke("popup_menu", menuRequest(menu, rect.left)).finally(() => {
      button.removeAttribute("aria-expanded");
    }),
  );
}

menuApp?.addEventListener("click", () => openMenu("app", menuApp));
menuActions?.addEventListener("click", () => openMenu("actions", menuActions));

// 「网页对话」：切换右侧侧栏（与托盘菜单里的同名动作等价）
btnChat?.addEventListener("click", () => {
  fire(invoke("chrome_action", chromeActionRequest(DIRECT_ACTIONS.chat)));
});

/* -------------------------------------------------------------- 窗口按钮 */

btnMin?.addEventListener("click", () => {
  fire(invoke("window_control", windowControlRequest("minimize")));
});

btnMax?.addEventListener("click", () => {
  fire(invoke("window_control", windowControlRequest("toggle-maximize")));
});

btnClose?.addEventListener("click", () => {
  // 走正常关闭流程：隐藏到托盘，不退出程序
  fire(invoke("window_control", windowControlRequest("close")));
});

/* ------------------------------------------------------ 拖动 / 双击最大化 */

// 命中判定：落在按钮上的按下不算拖窗口（否则点菜单会顺手把窗口拖走）
const interactiveFrom = (event) => event.target?.closest?.("button") ?? null;

bar?.addEventListener("mousedown", (event) => {
  if (!isTitlebarChromeHit(interactiveFrom(event), event.button)) return;
  if (!canDragWindow(winState)) return; // 最大化/全屏时不拖
  event.preventDefault();
  fire(invoke("start_drag"));
});

// 双击顶栏空白处 = 最大化 / 还原；最大化时不再处理（此时该用按钮还原）
bar?.addEventListener("dblclick", (event) => {
  if (!isTitlebarChromeHit(interactiveFrom(event), event.button)) return;
  if (!canToggleMaximize(winState)) return;
  fire(invoke("window_control", windowControlRequest("toggle-maximize")));
});

/* ------------------------------------------------------------------ 启动 */

// 让 Rust 有机会推一次初始状态；收不到也没关系（见上面的说明）。
applyWindowState(winState);
window.dispatchEvent(new CustomEvent("dsht:titlebar-ready"));
