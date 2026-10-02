/*
 * DSHTauri — 「关于」窗口
 *
 * 版本号来自 Rust（编译期从 version.json 读的 Gen 号也包含在内）。
 * 检查更新直接在这里 fetch GitHub Releases API：
 * 这是个本地页面，GitHub API 允许 CORS，所以不需要任何额外插件或 HTTP 依赖。
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const REPO = "tianyimc/DSH-Tauri";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const updateBox = document.getElementById("update");
const versionBox = document.getElementById("version");

let currentVersion = "";

/** 把 "1.2.10" 拆成数字数组，方便比较。 */
function parseVersion(text) {
  return String(text || "")
    .replace(/^v/i, "")
    .split(" ")[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

/** a > b 返回正数。 */
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function checkUpdate() {
  updateBox.textContent = "正在检查…";
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });

    if (res.status === 404) {
      updateBox.textContent = `仓库还没有发布过 Release。\n${RELEASES_PAGE}`;
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const latest = data.tag_name || "";
    if (compareVersion(latest, currentVersion) > 0) {
      updateBox.textContent = `发现新版本 ${latest}（当前 ${currentVersion}）\n${data.html_url || RELEASES_PAGE}`;
    } else {
      updateBox.textContent = `已是最新版本（${currentVersion}）。`;
    }
  } catch (err) {
    updateBox.textContent = `检查失败：${err}\n（离线或被网络策略拦截时属正常）`;
  }
}

document.getElementById("btn-check").addEventListener("click", checkUpdate);
document.getElementById("btn-close").addEventListener("click", () => {
  invoke("window_control", { action: "hide-about" }).catch(() => {
    // 兜底：直接关掉本窗口
    window.close();
  });
});

// 标题栏菜单里的「检查更新」会打开本窗口并触发这个事件
listen("check-update", () => checkUpdate());

(async () => {
  try {
    currentVersion = await invoke("app_version");
  } catch {
    currentVersion = "未知";
  }
  versionBox.textContent = currentVersion;
})();
