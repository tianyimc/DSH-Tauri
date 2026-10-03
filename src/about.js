/*
 * DSHTauri — 「关于」窗口
 *
 * 版本号来自 Rust：invoke("app_version") -> "v.0.3.2"（RC 构建则是 "v.0.3.2 RC"）。
 * 检查更新直接在这里 fetch GitHub Releases API：这是个本地页面，GitHub API 允许 CORS，
 * 所以不需要任何额外插件或 HTTP 依赖。
 *
 * 本轮（v0.3.2）要点：
 *   - 一次点击同时检查 **Release 与 RC 两个通道**（/releases?per_page=30）。
 *     不再用 /releases/latest —— 它只会返回 Release 通道。
 *   - 跨通道下载前必须先确认（**页内确认面板**，不是 window.confirm）。
 *
 * 文件结构（重要，测试依赖它）：
 *   1) 顶部是**纯逻辑**：无 document / 无 window 依赖，可在 Node 里直接单测。
 *      通过 `globalThis.__aboutInternals` 暴露给 scripts/test-about.mjs。
 *   2) 底部 boot() 只在真实 WebView（有 document/window）里执行，负责 DOM 与事件。
 *   往纯逻辑区里加东西时不要碰 DOM，否则 Node 导入会挂。
 */

/* ==================================================================== 常量 */

const REPO = "tianyimc/DSH-Tauri";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const CHANNEL_RELEASE = "release";
const CHANNEL_RC = "rc";
const CHANNEL_ORDER = [CHANNEL_RELEASE, CHANNEL_RC];

const CHANNEL_LABEL = {
  [CHANNEL_RELEASE]: "Release 版",
  [CHANNEL_RC]: "RC 版（预发布）",
};

/* ============================================== 纯逻辑：版本 / 通道 / 资产 */

/**
 * 把任意通道写法收敛成 "rc" / "release"。
 * Rust 的 app_channel 只应给 "rc" / "release"，但宁可宽松。
 * 未知值一律当 Release（与「app_channel 调用失败则退回 release」的约定一致）。
 */
function normalizeChannel(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "rc" || s === "prerelease" || s === "pre-release" || s === "beta" || s === "alpha") {
    return CHANNEL_RC;
  }
  return CHANNEL_RELEASE;
}

/**
 * 从版本文本里推断通道：`v.0.3.2 RC`、`v.0.3.2-rc`、`v.0.3.2-rc1` ⇒ rc。
 * 仅作为文案/标签的兜底识别，**分区仍以 GitHub 的 prerelease 标志为准**。
 */
function channelOfText(text) {
  return /[\s\-_.]rc\d*$/i.test(String(text ?? "").trim()) ? CHANNEL_RC : CHANNEL_RELEASE;
}

/**
 * "v.0.3.2 RC" / "v.0.3.2-rc" / "v0.3.2" / "1.2.10" ⇒ [0,3,2]。
 * 只取主版本段做数字比较，后缀（RC/-rc/+build）不参与。
 */
function parseVersion(text) {
  const core = String(text ?? "")
    .trim()
    .replace(/^v\.?/i, "")
    .split(/[\s\-+]/)[0];
  return core.split(".").map((n) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) ? v : 0;
  });
}

/** a > b 返回正数，相等返回 0。 */
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Release 对象里最像版本号的字段：tag_name 优先，其次 name。 */
function releaseVersion(release) {
  const raw = release?.tag_name || release?.name || "";
  return String(raw).trim();
}

/** 分区依据：严格按 GitHub 的 prerelease 布尔值。 */
function releaseChannel(release) {
  return release?.prerelease === true ? CHANNEL_RC : CHANNEL_RELEASE;
}

/** 把 releases 列表按通道分区；非法输入返回两个空数组。 */
function partitionReleases(list) {
  const out = { [CHANNEL_RELEASE]: [], [CHANNEL_RC]: [] };
  if (!Array.isArray(list)) return out;
  for (const release of list) {
    if (!release || typeof release !== "object") continue;
    out[releaseChannel(release)].push(release);
  }
  return out;
}

/** 候选是否比在位者更新（版本相同则比发布时间，便于「同版本重发」取新的）。 */
function isNewerRelease(candidate, incumbent) {
  const cmp = compareVersion(releaseVersion(candidate), releaseVersion(incumbent));
  if (cmp !== 0) return cmp > 0;
  return String(candidate?.published_at || "") > String(incumbent?.published_at || "");
}

/** 每个通道取最高版本；没有该通道的发布则为 null。 */
function highestPerChannel(list) {
  const parts = partitionReleases(list);
  const pick = (arr) => {
    let best = null;
    for (const release of arr) {
      if (!releaseVersion(release)) continue;
      if (best === null || isNewerRelease(release, best)) best = release;
    }
    return best;
  };
  return { [CHANNEL_RELEASE]: pick(parts[CHANNEL_RELEASE]), [CHANNEL_RC]: pick(parts[CHANNEL_RC]) };
}

/**
 * 从 assets 里挑安装包：优先 setup/installer，其次任意 .exe，再其次 .msi。
 * 没有任何安装包时返回 null（调用方退回 Release 页面链接）。
 */
function pickInstallerAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const score = (asset) => {
    const name = String(asset?.name || "").toLowerCase();
    if (!/\.(exe|msi)$/.test(name)) return -1;
    let s = 1;
    if (/setup|installer|install/.test(name)) s += 4;
    if (name.endsWith(".exe")) s += 2;
    return s;
  };
  let best = null;
  let bestScore = 0;
  for (const asset of assets) {
    if (!asset?.browser_download_url) continue;
    const s = score(asset);
    if (s > bestScore) {
      best = asset;
      bestScore = s;
    }
  }
  return best;
}

/** 目标通道与当前运行通道不同 ⇒ 需要跨通道确认。 */
function needsCrossChannelConfirm(currentChannel, targetChannel) {
  return normalizeChannel(currentChannel) !== normalizeChannel(targetChannel);
}

/** 跨通道确认文案（两个通道都要点名）。 */
function crossChannelPrompt(currentChannel, targetChannel) {
  const from = CHANNEL_LABEL[normalizeChannel(currentChannel)];
  const to = CHANNEL_LABEL[normalizeChannel(targetChannel)];
  return `当前是 ${from}，即将下载 ${to}，是否继续？`;
}

/** 某通道还没有发布时的友好文案（RC 通道没预发布是正常状态，不是错误）。 */
function emptyChannelText(channel) {
  return normalizeChannel(channel) === CHANNEL_RC
    ? "暂无 RC 预发布版本。"
    : "暂无已发布的 Release 版本。";
}

/** ISO 时间 ⇒ YYYY-MM-DD；解析不了就原样返回。 */
function formatDate(iso) {
  const s = String(iso ?? "").trim();
  if (!s) return "未知日期";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 10);
}

/** innerHTML 拼接用；Release 标题/资产名都来自外部，必须转义。 */
function escapeHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

/* Node 单测出口：浏览器里挂着也无害。 */
globalThis.__aboutInternals = {
  RELEASES_API,
  RELEASES_PAGE,
  CHANNEL_RELEASE,
  CHANNEL_RC,
  CHANNEL_ORDER,
  CHANNEL_LABEL,
  normalizeChannel,
  channelOfText,
  parseVersion,
  compareVersion,
  releaseVersion,
  releaseChannel,
  partitionReleases,
  isNewerRelease,
  highestPerChannel,
  pickInstallerAsset,
  needsCrossChannelConfirm,
  crossChannelPrompt,
  emptyChannelText,
  formatDate,
  escapeHtml,
};

/* ============================================================ DOM / 接线 */

/** 收敛 Tauri 调用（与 src/settings.js 同一思路）：拿不到就静默退化。 */
function createInvoker() {
  let warned = false;
  return function invoke(cmd, args) {
    const candidates = [
      () => window.__TAURI__?.core?.invoke,
      () => window.__TAURI__?.invoke,
      () => window.__TAURI_INTERNALS__?.invoke,
      () => window.__TAURI_INTERNALS__?.ipc,
    ];
    for (const pick of candidates) {
      const fn = pick();
      if (typeof fn === "function") return Promise.resolve(fn(cmd, args));
    }
    if (!warned) {
      warned = true;
      console.warn("[about] 未找到 Tauri invoke，窗口功能将退化");
    }
    return Promise.reject(new Error("no tauri invoke"));
  };
}

function boot() {
  const invoke = createInvoker();

  const versionBox = document.getElementById("version");
  const badgeBox = document.getElementById("channel-badge");
  const updateBox = document.getElementById("update");
  const channelsBox = document.getElementById("channels");
  const confirmPanel = document.getElementById("confirm");
  const confirmText = document.getElementById("confirm-text");

  let currentVersion = "";
  let currentChannel = CHANNEL_RELEASE;
  let pendingUrl = "";

  /* ------------------------------------------------------------ 渲染 */

  function renderChannelBlock(channel, release) {
    const isCurrent = channel === currentChannel;
    const name = CHANNEL_LABEL[channel];
    const currentTag = isCurrent ? '<span class="badge current">当前运行</span>' : "";
    const head = `<div class="chan-head"><span class="chan-name">${escapeHtml(name)}</span>${currentTag}</div>`;

    if (!release) {
      return `<div class="chan${isCurrent ? " is-current" : ""}" data-channel="${channel}">${head}<p class="chan-meta">${escapeHtml(emptyChannelText(channel))}</p></div>`;
    }

    const version = releaseVersion(release);
    const asset = pickInstallerAsset(release);
    const url = asset ? asset.browser_download_url : release.html_url || RELEASES_PAGE;
    const label = asset ? `下载 ${asset.name}` : "打开发布页面";

    return (
      `<div class="chan${isCurrent ? " is-current" : ""}" data-channel="${channel}">` +
      head +
      `<p class="chan-ver mono">${escapeHtml(version)}</p>` +
      `<p class="chan-meta">发布于 ${escapeHtml(formatDate(release.published_at))}</p>` +
      `<a class="chan-link" href="${escapeHtml(url)}" data-download-url="${escapeHtml(url)}"` +
      ` data-channel="${channel}" rel="noreferrer noopener">${escapeHtml(label)}</a>` +
      `</div>`
    );
  }

  function renderChannels(best) {
    channelsBox.innerHTML = CHANNEL_ORDER.map((ch) => renderChannelBlock(ch, best[ch])).join("");
  }

  /* ------------------------------------------------- 确认面板 / 跳转 */

  function showConfirm(url, targetChannel) {
    pendingUrl = url;
    confirmText.textContent = crossChannelPrompt(currentChannel, targetChannel);
    confirmPanel.hidden = false;
  }

  function hideConfirm() {
    pendingUrl = "";
    confirmPanel.hidden = true;
  }

  /**
   * 真正打开下载地址。
   *
   * 用 Rust 侧新增的 `open_external` 命令交给**系统默认浏览器**。
   * 为什么不能直接 `location.href = url`：那会让**「关于」窗口自己导航走**
   * —— 用户点一次「下载」，关于窗口就变成浏览器的下载页，界面回不来。
   *
   * 若该命令不可用（旧版本 / 调用失败），退回 `location.href` 作为**最后手段**，
   * 并明确这是降级路径（会离开本页）。
   */
  function openDownload(url) {
    if (!url) return;
    invoke("open_external", { url }).catch((err) => {
      console.warn("[about] open_external 不可用，退回 location.href：", err);
      window.location.href = url;
    });
  }

  /* ------------------------------------------------------- 检查更新 */

  async function checkUpdates() {
    updateBox.textContent = "正在同时检查 Release 与 RC 两个通道…";
    channelsBox.innerHTML = "";
    hideConfirm();

    try {
      const res = await fetch(RELEASES_API, {
        // 只发 Accept：这是 CORS 简单请求，不触发预检（本容器无法联网验证预检行为）。
        headers: { Accept: "application/vnd.github+json" },
      });

      if (res.status === 404) {
        updateBox.textContent = `仓库不存在或尚未发布过版本。\n${RELEASES_PAGE}`;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        updateBox.textContent = `仓库还没有发布过任何版本。\n${RELEASES_PAGE}`;
        return;
      }

      renderChannels(highestPerChannel(data));
      updateBox.textContent = `已检查 ${data.length} 个 Release：Release 与 RC 两个通道均已列出。`;
    } catch (err) {
      updateBox.textContent = `检查失败：${err}\n（离线或被网络策略拦截时属正常）\n${RELEASES_PAGE}`;
    }
  }

  /* ------------------------------------------------------------ 事件 */

  // 下载链接是 innerHTML 拼出来的，用事件委托统一处理跨通道守卫。
  channelsBox.addEventListener("click", (event) => {
    const target = event?.target;
    const link = target && typeof target.closest === "function" ? target.closest("[data-download-url]") : null;
    if (!link) return;
    if (typeof event.preventDefault === "function") event.preventDefault();

    const url = link.getAttribute("data-download-url") || "";
    const channel = normalizeChannel(link.getAttribute("data-channel"));
    if (!url) return;

    if (needsCrossChannelConfirm(currentChannel, channel)) {
      showConfirm(url, channel);
      return;
    }
    openDownload(url);
  });

  document.getElementById("confirm-ok").addEventListener("click", () => {
    const url = pendingUrl;
    hideConfirm();
    openDownload(url);
  });

  document.getElementById("confirm-cancel").addEventListener("click", hideConfirm);

  document.getElementById("btn-check").addEventListener("click", checkUpdates);

  document.getElementById("btn-close").addEventListener("click", () => {
    invoke("window_control", { action: "hide-about" }).catch(() => {
      // 兜底：直接关掉本窗口
      window.close();
    });
  });

  // 标题栏菜单里的「检查更新」会打开本窗口并触发这个事件
  window.__TAURI__?.event?.listen?.("check-update", () => checkUpdates());

  /*
   * 外链一律交给**系统默认浏览器**，不在本窗口内导航。
   *
   * 为什么需要：这是 WebView2 里的本地页面，`<a href="https://…" target="_blank">`
   * 在 Tauri 里**不保证**会开新窗口 —— 某些情况下会把**「关于」窗口自己**导航走，
   * 用户点一下作者链接，界面就变成网页、再也回不来了。
   * 所以这里统一拦截所有 http/https 外链，复用 Rust 侧的 `open_external`
   * （与「检查更新」的下载按钮走同一条路径，它也只允许 http/https）。
   */
  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return; // 页内锚点等放行
    event.preventDefault();
    invoke("open_external", { url: href }).catch(() => {
      // 命令不可用（旧版本）时退回默认行为，至少别让点击完全没反应。
      window.open(href, "_blank", "noopener");
    });
  });

  /* ------------------------------------------------------------ 启动 */

  (async function init() {
    try {
      currentVersion = String((await invoke("app_version")) ?? "").trim() || "未知";
    } catch {
      currentVersion = "未知";
    }

    // app_channel 是 Lead 本轮新加的命令；调用失败一律退回 release（版本规格约定）。
    try {
      currentChannel = normalizeChannel(await invoke("app_channel"));
    } catch {
      currentChannel = CHANNEL_RELEASE;
    }

    versionBox.textContent = currentVersion;
    badgeBox.textContent = CHANNEL_LABEL[currentChannel];
    badgeBox.className = `badge ${currentChannel}`;
  })();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  boot();
}
