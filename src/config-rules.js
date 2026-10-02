/*
 * DSHTauri 配置规则（纯函数，无 DOM 依赖）。
 *
 * 浏览器里由 selector.js 以 ES module 方式 import；
 * Node 里由 scripts/test-rules.mjs 直接 import 做单元测试 —— 同一份逻辑，不会跑偏。
 */

/** 与 Rust `AppConfig` 一一对应。URL 默认留空，由用户按需填写。 */
export const DEFAULT_CONFIG = {
  configured: false,
  localUrl: "",
  remoteUrl: "",
  autoStartLocal: false,
  localStartCommand: "",
  // 网页对话的加载模式：false = overlay（默认，覆盖在内容页之上），true = docked（并排）。
  // 与 Rust 的 `chat_docked` 对应（serde camelCase）。老配置没有这个字段时按 false 处理。
  chatDocked: false,
};

/**
 * 网页对话的两种加载模式。
 *
 * `overlay`：侧栏**覆盖**在内容页右侧之上，内容页面积不变（默认，保持升级前的行为）。
 * `docked`：内容页让出右侧 `CHAT_WIDTH`（Rust 侧 420 逻辑 px），两者**并排**；
 *           **不改变程序窗口本身的大小**。
 */
export const CHAT_MODES = {
  overlay: { id: "overlay", docked: false, label: "覆盖（overlay）", hint: "侧栏浮在页面之上，页面宽度不变。" },
  docked: { id: "docked", docked: true, label: "并排（docked）", hint: "页面让出右侧 420px，与侧栏并排。" },
};

/** 由 `chatDocked` 布尔值得到模式 id（`"overlay"` | `"docked"`）。 */
export function chatModeOf(config) {
  return config && config.chatDocked ? CHAT_MODES.docked.id : CHAT_MODES.overlay.id;
}

/** 由模式 id 得到要写进配置的 `chatDocked` 值。未知 id 一律按 overlay（false）。 */
export function chatDockedOf(modeId) {
  return modeId === CHAT_MODES.docked.id;
}

/** 界面上的示例值（只用于 placeholder，不会写进默认配置）。 */
export const EXAMPLES = {
  localUrl: "http://127.0.0.1:3080",
  remoteUrl: "https://dsh.example.com",
  localCommand: "dsh web",
};

export const MODE_LABEL = { local: "本地", remote: "远程" };

/** 去掉首尾空白和结尾的 `/`。 */
export function normalizeUrl(raw) {
  return String(raw ?? "").trim().replace(/\/+$/, "");
}

export function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

/** 取某个模式对应的地址。 */
export function urlOf(config, mode) {
  return mode === "local" ? config.localUrl : config.remoteUrl;
}

/**
 * 校验一份待保存的配置。
 *
 * 核心规则：**本地和远程允许只配一个**，另一个留空即可；两个都空不允许。
 *
 * @returns {string|null} 错误提示；`null` 表示通过。
 */
export function validateConfig(candidate) {
  const localUrl = normalizeUrl(candidate.localUrl);
  const remoteUrl = normalizeUrl(candidate.remoteUrl);

  if (!localUrl && !remoteUrl) {
    return "本地和远程地址至少要填一个（可以只配其中一个）。";
  }
  if (localUrl && !isHttpUrl(localUrl)) {
    return "本地 URL 无效：必须是 http:// 或 https:// 开头；不想要本地就把它留空。";
  }
  if (remoteUrl && !isHttpUrl(remoteUrl)) {
    return "远程 URL 无效：必须是 http:// 或 https:// 开头；不想要远程就把它留空。";
  }
  if (candidate.autoStartLocal && !localUrl) {
    return "没有配置本地地址，无法自动启动本地服务。";
  }
  if (localUrl && candidate.autoStartLocal && !String(candidate.localStartCommand ?? "").trim()) {
    return "勾选了自动启动本地服务，但启动命令为空。";
  }
  return null;
}

/**
 * 把表单读出来的原始值整理成要落盘的配置。
 *
 * ⚠️ **这里刻意不产出 `chatDocked`** —— 本函数只服务于选择窗口的地址表单。
 * Rust 侧 `save_config` 是**补丁语义**（没提到的字段保持磁盘旧值），
 * 所以省略它不会把用户在设置窗口选的模式重置掉。
 * 若将来这里要带上它，必须先从已加载的配置里透传，而不是写死 false。
 */
export function buildConfig(form) {
  return {
    configured: true,
    localUrl: normalizeUrl(form.localUrl),
    remoteUrl: normalizeUrl(form.remoteUrl),
    autoStartLocal: Boolean(form.autoStartLocal),
    localStartCommand: String(form.localStartCommand ?? "").trim(),
  };
}
