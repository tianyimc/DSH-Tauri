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
 */

const { invoke } = window.__TAURI__.core;

/** 与 Rust `AppConfig` 一一对应的默认值（Rust 侧也会兜底）。 */
const DEFAULT_CONFIG = {
  configured: false,
  localUrl: "http://127.0.0.1:8080",
  remoteUrl: "https://dsh.example.com",
  autoStartLocal: false,
  localStartCommand: "",
};

const el = (id) => document.getElementById(id);

const ui = {
  picker: el("picker"),
  setup: el("setup"),
  setupHint: el("setup-hint"),
  labelLocal: el("label-local"),
  labelRemote: el("label-remote"),
  badgeLocal: el("badge-local"),
  inputLocal: el("input-local"),
  inputRemote: el("input-remote"),
  inputAutostart: el("input-autostart"),
  inputCommand: el("input-command"),
  fieldCommand: el("field-command"),
  status: el("status"),
  footConfig: el("foot-config"),
  toggleSettings: el("toggle-settings"),
  saveSetup: el("save-setup"),
  cancelSetup: el("cancel-setup"),
  pickLocal: el("pick-local"),
  pickRemote: el("pick-remote"),
};

let config = { ...DEFAULT_CONFIG };
/** "first-run" | "edit" | null —— 决定“保存”按钮的行为 */
let setupMode = null;
/** 首次配置时，保存完成后要连接的模式 */
let pendingMode = null;

/* ------------------------------------------------------------------ utils */

function setStatus(message, kind = "") {
  ui.status.textContent = message || "";
  ui.status.className = "status" + (kind ? " " + kind : "");
}

function setBusy(busy) {
  ui.pickLocal.disabled = busy;
  ui.pickRemote.disabled = busy;
}

function normalizeUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

function render() {
  ui.labelLocal.textContent = config.localUrl;
  ui.labelRemote.textContent = config.remoteUrl;
  ui.badgeLocal.textContent = config.autoStartLocal && config.localStartCommand.trim()
    ? "自动启动本地服务"
    : "需手动启动服务";
  ui.footConfig.textContent = config.configured
    ? `已记住地址：本地 ${config.localUrl} ｜ 远程 ${config.remoteUrl}`
    : "首次使用：点击任一方式以填写并保存地址（之后每次启动直接选择即可）";
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
    "修改地址后会写入配置文件（下次启动仍然生效）。";
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
  const on = ui.inputAutostart.checked;
  ui.fieldCommand.style.opacity = on ? "1" : "0.45";
  ui.inputCommand.disabled = !on;
}

function readForm() {
  return {
    configured: true,
    localUrl: normalizeUrl(ui.inputLocal.value),
    remoteUrl: normalizeUrl(ui.inputRemote.value),
    autoStartLocal: ui.inputAutostart.checked,
    localStartCommand: ui.inputCommand.value.trim(),
  };
}

function validate(candidate) {
  if (!isHttpUrl(candidate.localUrl)) return "本地 URL 无效，必须是 http:// 或 https:// 开头的地址。";
  if (!isHttpUrl(candidate.remoteUrl)) return "远程 URL 无效，必须是 http:// 或 https:// 开头的地址。";
  if (candidate.autoStartLocal && !candidate.localStartCommand) {
    return "勾选了自动启动本地服务，但启动命令为空。";
  }
  return null;
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
  const url = mode === "local" ? config.localUrl : config.remoteUrl;
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
  } catch (err) {
    setBusy(false);
    setStatus(String(err), "err");
  }
}

async function pick(mode) {
  // 首次使用（或配置被清空）时，先让用户提供地址并落盘，之后直接连接。
  if (!config.configured) {
    pendingMode = mode;
    openSetup(
      "first-run",
      `首次使用：请确认${mode === "local" ? "本地" : "远程"}地址，保存后立即连接，以后点击即可直接进入。`,
    );
    return;
  }
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

ui.inputAutostart.addEventListener("change", syncCommandVisibility);

ui.saveSetup.addEventListener("click", async () => {
  const candidate = readForm();
  const problem = validate(candidate);
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

  if (setupMode === "first-run" && pendingMode) {
    const mode = pendingMode;
    closeSetup();
    await connect(mode);
  } else {
    closeSetup();
    setStatus("配置已保存。", "ok");
  }
});

/* ------------------------------------------------------------------ start */

(async function boot() {
  try {
    const loaded = await invoke("load_config");
    config = { ...DEFAULT_CONFIG, ...loaded };
    render();
    // 语义：每次启动都要选「本地 / 远程」，但地址只需在首次设置一次。
    setStatus(
      config.configured
        ? "请选择连接方式（地址已记住，点右上角「设置」可修改）。"
        : "请选择连接方式。",
    );
  } catch (err) {
    render();
    setStatus(`读取配置失败，使用默认值：${err}`, "err");
  }
})();
