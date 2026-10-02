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
};

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

/** 把表单读出来的原始值整理成要落盘的配置。 */
export function buildConfig(form) {
  return {
    configured: true,
    localUrl: normalizeUrl(form.localUrl),
    remoteUrl: normalizeUrl(form.remoteUrl),
    autoStartLocal: Boolean(form.autoStartLocal),
    localStartCommand: String(form.localStartCommand ?? "").trim(),
  };
}
