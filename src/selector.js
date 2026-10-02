/*
 * DSHTauri — 启动选择界面逻辑（Tauri 2，无框架 / 无构建步骤）
 *
 * 与 Rust 后端约定五个命令（见 src-tauri/src/lib.rs）：
 *   load_config()                 -> AppConfig
 *   save_config({ config })       -> null
 *   start_local_service({ command }) -> null   // 后台拉起本地 DSH 服务
 *   probe_url({ url })            -> boolean   // 单次 TCP 探测，前端轮询用
 *   open_main_window({ request }) -> null      // request = { url }
 *
 * 说明：Tauri 2 会把 JS 的 camelCase 参数名转换成 Rust 的 snake_case。
 * 为避免歧义，这里所有参数都用「单个单词」的参数名（config / command / url / request），
 * 结构体内部字段由 Rust 侧 serde(rename_all = "camelCase") 负责映射。
 *
 * 配置语义（与需求方确认）：
 *   - 「每次启动都要选本地 / 远程」——选择本身不持久化；
 *   - 「地址只设置一次」——首次填写后写入 config.json，之后点一下就直接连；
 *   - **本地和远程允许只配一个**，另一个留空即可；两个都留空不允许。
 */

import {
  DEFAULT_CONFIG,
  MODE_LABEL,
  buildConfig,
  normalizeUrl,
  urlOf,
  validateConfig,
} from "./config-rules.js";

const { invoke } = window.__TAURI__.core;

const el = (id) => document.getElementById(id);

const ui = {
  picker: el("picker"),
  setup: el("setup"),
  setupHint: el("setup-hint"),
  labelLocal: el("label-local"),
  labelRemote: el("label-remote"),
  badgeLocal: el("badge-local"),
  badgeRemote: el("badge-remote"),
  inputLocal: el("input-local"),
  inputRemote: el("input-remote"),
  inputAutostart: el("input-autostart"),
  inputCommand: el("input-command"),
  fieldCommand: el("field-command"),
  status: el("status"),
  footConfig: el("foot-config"),
  footVersion: el("foot-version"),
  toggleSettings: el("toggle-settings"),
  saveSetup: el("save-setup"),
  cancelSetup: el("cancel-setup"),
  pickLocal: el("pick-local"),
  pickRemote: el("pick-remote"),
};

let config = { ...DEFAULT_CONFIG };
/** "first-run" | "edit" | null —— 决定「保存」按钮的行为 */
let setupMode = null;
/** 首次配置 / 补配置时，保存完成后要连接的模式 */
let pendingMode = null;
/** 连接进行中，禁用两个卡片 */
let busy = false;

/* ------------------------------------------------------------------ utils */

function setStatus(message, kind = "") {
  ui.status.textContent = message || "";
  ui.status.className = "status" + (kind ? " " + kind : "");
}

function setBusy(value) {
  busy = value;
  render();
}

/* ----------------------------------------------------------------- render */

function render() {
  const hasLocal = Boolean(config.localUrl);
  const hasRemote = Boolean(config.remoteUrl);

  // 未配置的一侧仍然可点——点了会打开设置面板去补，而不是死按钮。
  ui.pickLocal.disabled = busy;
  ui.pickRemote.disabled = busy;
  ui.pickLocal.classList.toggle("is-off", !hasLocal);
  ui.pickRemote.classList.toggle("is-off", !hasRemote);

  ui.labelLocal.textContent = hasLocal ? config.localUrl : "未配置（点击填写）";
  ui.labelRemote.textContent = hasRemote ? config.remoteUrl : "未配置（点击填写）";

  ui.badgeLocal.textContent = !hasLocal
    ? "未配置"
    : config.autoStartLocal && config.localStartCommand.trim()
      ? "自动启动本地服务"
      : "需手动启动服务";
  ui.badgeRemote.textContent = hasRemote ? "直接加载远程页面" : "未配置";

  if (!hasLocal && !hasRemote) {
    ui.footConfig.textContent = "还没配置地址：点「设置」填写本地或远程地址（至少填一个）";
  } else {
    ui.footConfig.textContent = `已记住地址：本地 ${hasLocal ? config.localUrl : "（未配置）"} ｜ 远程 ${
      hasRemote ? config.remoteUrl : "（未配置）"
    }`;
  }
}

/* ------------------------------------------------------------- setup panel */

function openSetup(mode, hint) {
  setupMode = mode;
  ui.inputLocal.value = config.localUrl;
  ui.inputRemote.value = config.remoteUrl;
  ui.inputAutostart.checked = config.autoStartLocal;
  ui.inputCommand.value = config.localStartCommand;
  ui.setupHint.textContent =
    hint ||
    "本地和远程**至少填一个**，另一个留空即可。保存后写入配置文件，下次启动仍然生效。";
  ui.setup.hidden = false;
  ui.picker.hidden = mode === "first-run";
  syncCommandVisibility();
  ui.inputLocal.focus();
}

function closeSetup() {
  setupMode = null;
  pendingMode = null;
  ui.setup.hidden = true;
  ui.picker.hidden = false;
  setStatus("");
}

function syncCommandVisibility() {
  // 没填本地地址时，「自动启动本地服务」没有意义。
  const hasLocal = Boolean(normalizeUrl(ui.inputLocal.value));
  const on = ui.inputAutostart.checked && hasLocal;
  ui.inputAutostart.disabled = !hasLocal;
  ui.fieldCommand.style.opacity = on ? "1" : "0.45";
  ui.inputCommand.disabled = !on;
}

function readForm() {
  return buildConfig({
    localUrl: ui.inputLocal.value,
    remoteUrl: ui.inputRemote.value,
    autoStartLocal: ui.inputAutostart.checked,
    localStartCommand: ui.inputCommand.value,
  });
}

async function persist(candidate) {
  await invoke("save_config", { config: candidate });
  config = candidate;
  render();
}

/* ---------------------------------------------------------------- connect */

/** 等待本地服务就绪的总时长（毫秒）。 */
const SERVICE_WAIT_MS = 20000;
const SERVICE_POLL_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询 `probe_url`，直到本地服务开始监听或超时。
 * 放在前端做（而不是 Rust 里 sleep）是因为 Tauri 的同步命令跑在主线程上，
 * 在 Rust 里等待会直接冻住界面。
 */
async function waitForService(url) {
  const deadline = Date.now() + SERVICE_WAIT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    let ready = false;
    try {
      ready = await invoke("probe_url", { url });
    } catch {
      ready = false;
    }
    if (ready) return true;
    setStatus(`已启动本地服务，正在等待它就绪…（第 ${attempt} 次探测）`);
    await sleep(SERVICE_POLL_MS);
  }
  return false;
}

async function connect(mode) {
  const url = urlOf(config, mode);
  if (!url) {
    openSetup("edit", `还没有配置${MODE_LABEL[mode]}地址，填写并保存后即可连接。`);
    return;
  }

  const startCommand =
    mode === "local" && config.autoStartLocal && config.localStartCommand.trim()
      ? config.localStartCommand.trim()
      : null;

  setBusy(true);

  try {
    if (startCommand) {
      setStatus("正在启动本地服务…");
      await invoke("start_local_service", { command: startCommand });
      const ready = await waitForService(url);
      if (!ready) {
        setStatus("本地服务在 20 秒内没有就绪，仍会尝试加载页面。", "err");
      }
    } else {
      setStatus("正在打开主窗口…");
    }

    await invoke("open_main_window", { request: { url } });
    // 成功也要复位：选择窗口只是被隐藏，用户随时可能从托盘把它叫回来切地址，
    // 那时按钮必须还能点（否则就是「点了没反应 + 一直转圈」）。
    setBusy(false);
  } catch (err) {
    setBusy(false);
    setStatus(String(err), "err");
  }
}

async function pick(mode) {
  if (busy) {
    setStatus("正在连接中，请稍候…");
    return;
  }

  // ① 首次使用：让用户填写 / 确认地址，保存后立即连接。
  if (!config.configured) {
    pendingMode = mode;
    openSetup(
      "first-run",
      `首次使用：请填写${MODE_LABEL[mode]}地址（本地和远程至少填一个，另一个可以留空），保存后立即连接。`,
    );
    return;
  }

  // ② 已配置过，但这一侧没填地址：引导去补。
  if (!urlOf(config, mode)) {
    pendingMode = mode;
    openSetup("edit", `还没有配置${MODE_LABEL[mode]}地址，填写并保存后即可连接。`);
    return;
  }

  // ③ 正常连接。
  await connect(mode);
}

/* ----------------------------------------------------------------- events */

ui.pickLocal.addEventListener("click", () => pick("local"));
ui.pickRemote.addEventListener("click", () => pick("remote"));

ui.toggleSettings.addEventListener("click", () => {
  if (ui.setup.hidden) openSetup("edit");
  else closeSetup();
});

ui.cancelSetup.addEventListener("click", closeSetup);

// 兜底：选择窗口被托盘重新叫出来（窗口重新获得焦点）时，确保按钮可点。
window.addEventListener("focus", () => {
  if (busy) setBusy(false);
});

ui.inputAutostart.addEventListener("change", syncCommandVisibility);
ui.inputLocal.addEventListener("input", syncCommandVisibility);

ui.saveSetup.addEventListener("click", async () => {
  const candidate = readForm();
  const problem = validateConfig(candidate);
  if (problem) {
    setStatus(problem, "err");
    return;
  }
  try {
    await persist(candidate);
  } catch (err) {
    setStatus(String(err), "err");
    return;
  }

  // 保存后如果明确知道用户想连哪一侧，就直接连。
  const target = pendingMode && urlOf(config, pendingMode) ? pendingMode : null;
  closeSetup();
  if (target) {
    await connect(target);
  } else {
    setStatus("配置已保存。", "ok");
  }
});

/* ------------------------------------------------------------------ start */

(async function boot() {
  try {
    const loaded = await invoke("load_config");
    config = { ...DEFAULT_CONFIG, ...loaded };
  } catch (err) {
    setStatus(`读取配置失败，使用默认值：${err}`, "err");
  }

  // 版本号（v.A.B.C GenX）由 Rust 侧编译进去，这里只负责显示。
  try {
    ui.footVersion.textContent = await invoke("app_version");
  } catch {
    ui.footVersion.textContent = "";
  }

  render();

  if (!config.localUrl && !config.remoteUrl) {
    setStatus("请选择连接方式；首次使用需要先填写地址（本地 / 远程至少填一个）。");
  } else if (!config.configured) {
    setStatus("请选择连接方式。");
  } else {
    // 语义：每次启动都要选「本地 / 远程」，但地址只需在首次设置一次。
    setStatus("请选择连接方式（地址已记住，点右上角「设置」可修改）。");
  }
})();
