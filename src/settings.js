/*
 * DSHTauri — 「设置」窗口逻辑。
 *
 * 这个页面是**本地页面**（tauri://localhost），由 Rust 作为独立窗口 `settings` 加载，
 * 命中 capabilities/default.json 的 windows 列表，所以可以直接 invoke 自定义命令。
 *
 * 用到的命令（全部是既有契约，没有新增命令面）：
 *   load_config()                     -> AppConfig
 *   save_config({ config })           -> null   // Rust 侧是**补丁语义**
 *   chrome_action({ action })         -> null   // action: "reconnect"
 *   window_control({ action })        -> null   // action: "hide-settings"
 *   app_version()                     -> "v.0.3.2"（RC 版是 "v.0.3.2 RC"）
 *   app_channel()                     -> "release" | "rc"
 *
 * ⚠️ `save_config` 的补丁语义很关键：这里切模式时**只发 `{ chatDocked }`**，
 * 其余字段（地址、启动命令）由 Rust 保留磁盘上的旧值。
 * 反过来说，选择窗口保存地址时也不会把这里的模式重置掉 —— 见 lib.rs 的 merge_config。
 */

import { CHAT_MODES, chatDockedOf, chatModeOf } from "./config-rules.js";

/* ----------------------------------------------------------- invoke 包装 */

/**
 * 收敛 Tauri 调用。
 *
 * 本地页面里 `window.__TAURI__.core.invoke` 应当可用；但宁可退化也不要整页崩掉：
 * 依次尝试几种已知位置，都拿不到就 console.warn 一次并让按钮静默失效。
 * （与 src/titlebar/titlebar.js 的 createInvoker 同一思路。）
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
          "[DSHTauri] 设置窗口：找不到 Tauri invoke，设置项将不可用。" +
            "（本地页面应当命中 capabilities/default.json，检查 windows 里是否有 settings）",
        );
      }
      return Promise.reject(new Error("Tauri invoke unavailable"));
    }

    let result;
    try {
      result = fn.call(window, cmd, args);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(result);
  };
}

const invoke = createInvoker();

/* ------------------------------------------------------------------ 元素 */

const el = (id) => document.getElementById(id);

const ui = {
  version: el("version"),
  summary: el("conn-summary"),
  reconnect: el("btn-reconnect"),
  modes: el("modes"),
  radios: Array.from(document.querySelectorAll('input[name="chat-mode"]')),
  status: el("status"),
  close: el("btn-close"),
};

/** 已加载的配置（只在 boot 与保存成功后更新）。 */
let config = null;
/** 保存进行中：避免连点造成乱序写入。 */
let saving = false;

/* ------------------------------------------------------------------ 渲染 */

function setStatus(message, kind = "") {
  ui.status.textContent = message || "";
  ui.status.className = "status" + (kind ? " " + kind : "");
}

function renderSummary() {
  if (!config) {
    ui.summary.textContent = "正在读取配置…";
    return;
  }
  const local = config.localUrl ? config.localUrl : "（未配置）";
  const remote = config.remoteUrl ? config.remoteUrl : "（未配置）";
  ui.summary.textContent = `本地：${local}　｜　远程：${remote}`;
}

/** 把当前模式同步到单选按钮，并维护 `.is-active`（`:has()` 不支持时的兜底）。 */
function renderMode() {
  const mode = chatModeOf(config);
  for (const radio of ui.radios) {
    radio.checked = radio.value === mode;
    // 兜底样式：即使浏览器不支持 :has()，选中卡片也看得出高亮。
    radio.closest(".mode")?.classList.toggle("is-active", radio.checked);
  }
}

function render() {
  renderSummary();
  renderMode();
}

/* ------------------------------------------------------------- 保存模式 */

/**
 * 只把 `chatDocked` 作为补丁发过去（见文件头注释）。
 * Rust 侧落盘后会刷新缓存并**立即重排**主窗口的子 webview。
 */
async function saveMode(modeId) {
  if (saving) return;
  saving = true;
  ui.radios.forEach((r) => (r.disabled = true));
  setStatus("正在保存…");

  const docked = chatDockedOf(modeId);
  try {
    await invoke("save_config", { config: { chatDocked: docked } });
    config = { ...config, chatDocked: docked };
    renderMode();
    setStatus(
      docked
        ? "已切换为「并排」：主页面已让出右侧，布局立即生效。"
        : "已切换为「覆盖」：主页面恢复整宽，布局立即生效。",
      "ok",
    );
  } catch (err) {
    // 保存失败：把界面退回到磁盘上的真实状态，避免显示与配置不一致。
    renderMode();
    setStatus(`保存失败：${err}`, "err");
  } finally {
    saving = false;
    ui.radios.forEach((r) => (r.disabled = false));
  }
}

/* ---------------------------------------------------------------- 事件 */

for (const radio of ui.radios) {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    saveMode(radio.value);
  });
}

ui.reconnect.addEventListener("click", async () => {
  ui.reconnect.disabled = true;
  try {
    // 与托盘「重新选择连接方式」/ 顶栏「应用 → 重新连接」走的是**同一个**分支
    // （Rust 的 run_action("reconnect") → reveal_selector）。
    await invoke("chrome_action", { action: "reconnect" });
    setStatus("已打开「选择 DSH 连接方式」窗口。", "ok");
    // 选择窗口会居中弹出；把设置窗口收起来，免得盖在它上面。
    await invoke("window_control", { action: "hide-settings" }).catch(() => {});
  } catch (err) {
    setStatus(`无法打开选择窗口：${err}`, "err");
  } finally {
    ui.reconnect.disabled = false;
  }
});

ui.close.addEventListener("click", () => {
  invoke("window_control", { action: "hide-settings" }).catch(() => {
    // 兜底：直接关掉本窗口
    window.close();
  });
});

/* 键盘：Esc 关闭（设置窗口没有系统标题栏之外的关闭途径，加一个更顺手）。 */
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") ui.close.click();
});

/* ------------------------------------------------------------------ 启动 */

(async function boot() {
  try {
    const loaded = await invoke("load_config");
    config = { ...loaded };
  } catch (err) {
    config = null;
    setStatus(`读取配置失败：${err}`, "err");
  }
  render();

  try {
    ui.version.textContent = await invoke("app_version");
  } catch {
    ui.version.textContent = "";
  }

  if (!config) {
    ui.radios.forEach((r) => (r.disabled = true));
  }
})();

// 供将来可能的单元测试/调试使用（当前没有 DOM 测试环境，仅作调试出口）。
export { chatModeOf, CHAT_MODES };
