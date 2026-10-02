/*
 * DSHTauri — 自定义标题栏
 *
 * 这个页面跑在一个独立的、贴在主窗口顶部的 40px 高窗口里（见 lib.rs 的 ensure_chrome_window）。
 * 下拉菜单用**原生菜单**（Rust 的 popup_menu 命令）而不是 HTML：
 * 窗口只有 40px 高，HTML 下拉会被裁掉；原生菜单能正常溢出到窗口外，外观也跟随系统。
 */

const { invoke } = window.__TAURI__.core;

const el = (id) => document.getElementById(id);

function fail(err) {
  console.error("[chrome]", err);
}

/* --------------------------------------------------------------- 下拉菜单 */

function openMenu(menu, button) {
  const rect = button.getBoundingClientRect();
  button.setAttribute("aria-expanded", "true");
  invoke("popup_menu", { menu, x: rect.left })
    .catch(fail)
    .finally(() => button.removeAttribute("aria-expanded"));
}

el("btn-app").addEventListener("click", (e) => openMenu("app", e.currentTarget));
el("btn-actions").addEventListener("click", (e) => openMenu("actions", e.currentTarget));

// 「网页对话」是直接动作，没有下拉：切换右侧侧栏
el("btn-chat").addEventListener("click", () => {
  invoke("chrome_action", { action: "chat" }).catch(fail);
});

/* ------------------------------------------------------------- 窗口按钮 */

el("btn-min").addEventListener("click", () => {
  invoke("window_control", { action: "minimize" }).catch(fail);
});

el("btn-max").addEventListener("click", () => {
  invoke("window_control", { action: "toggle-maximize" }).catch(fail);
});

el("btn-close").addEventListener("click", () => {
  // 走正常关闭流程：隐藏到托盘，不退出程序
  invoke("window_control", { action: "close" }).catch(fail);
});

/* ----------------------------------------------------------------- 拖动 */

// 标题栏窗口自己不能拖（那只会移动它自己），所以交给 Rust 去拖主窗口。
el("bar").addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  if (event.target.closest("button")) return;
  invoke("start_drag").catch(fail);
});

// 双击标题栏空白处 = 最大化 / 还原
el("bar").addEventListener("dblclick", (event) => {
  if (event.target.closest("button")) return;
  invoke("window_control", { action: "toggle-maximize" }).catch(fail);
});
