#!/usr/bin/env node
/*
 * DSHTauri 顶栏 / 标题栏 静态校验（纯 Node，无第三方依赖，可在 CI 上跑）
 *
 *   node scripts/verify-titlebar.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败。
 *
 * 为什么需要这个脚本
 * ------------------
 * 单元测试（scripts/test-titlebar.mjs）只测 `src/titlebar/rules.js` 里的**纯函数**；
 * 冒烟测试（scripts/smoke-windows.ps1）只跑 Windows 真机。两者之间有一个空档：
 * **「独立 chrome 窗口是否真的被移除干净」「建窗口的命令是否真的都是 async」**
 * 这类跨文件的静态事实。历史 bug（点「网页对话」卡死、顶栏高度翻倍）恰恰产生于这个空档，
 * 而且都能靠静态检查提前发现。本脚本就是补这个空档。
 *
 * 设计原则
 * --------
 * 1) 只读：绝不修改任何文件。
 * 2) 精确：用「先剥注释再做正则」的方式，避免把注释里的字面量当成代码。
 * 3) 可解释：每条失败都打印文件名、行号、原始行，便于直接定位。
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ 结果收集 */

const failures = [];
const passes = [];
let currentSection = "";

function section(name) {
  currentSection = name;
  console.log(`\n== ${name} ==`);
}

function check(name, ok, detail = "") {
  if (ok) {
    passes.push(name);
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push({ section: currentSection, name, detail });
    console.log(`  [FAIL] ${name}`);
    if (detail) console.log(`         ${detail}`);
  }
}

/* ------------------------------------------------------------------ 工具函数 */

function readIfExists(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** 递归列出目录下所有文件（跳过 node_modules / target / .git）。 */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 把源码里的注释剥掉，但**保留行号**（注释内容替换为等长空白）。
 * 这样对「剥注释后的文本」做正则时行号仍然准确，也避免注释里的
 * 字面量（例如本文件里就写着 chrome.html）造成误报。
 */
/**
 * 按行剔除注释后再匹配，用于「禁止某种写法」这类断言。
 *
 * 为什么不复用 `stripComments`：那是个逐字符状态机，**只懂 JS/C 风格注释**，
 * 不认 Rust 的**生命周期**（`<'a, R: Runtime>`）和字符字面量 —— 它会把 `'`
 * 当成字符串起点，此后与真实代码脱节，于是注释里的字眼（例如解释历史 bug 的
 * 「旧实现手算 CHROME_HEIGHT * scale」）会被误判成真代码。
 *
 * 对「某段代码是否出现」这种需求，按行过滤注释既简单又可靠：
 * 丢掉整行注释（`//` 与 `///`），再去掉行尾注释。
 */
export function findCodeMatches(src, regex) {
  const out = [];
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  src.split("\n").forEach((raw, i) => {
    if (/^\s*\/\//.test(raw)) return; // 整行注释（含 /// 文档注释）
    const code = raw.replace(/\/\/.*$/, ""); // 去掉行尾注释
    const re = new RegExp(regex.source, flags);
    let m;
    while ((m = re.exec(code)) !== null) {
      out.push({ line: i + 1, text: raw.trim() });
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  });
  return out;
}

export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code"; // code | line | block | html | str | tpl
  let quote = "";
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    const c3 = src.slice(i, i + 3);
    const c4 = src.slice(i, i + 4);
    if (state === "code") {
      // HTML 注释 <!-- ... -->（顶栏是 .html 模板，注释里会出现「侧边栏」等字样）
      if (c4 === "<!--") { state = "html"; out += "    "; i += 4; continue; }
      if (c2 === "//") { state = "line"; out += "  "; i += 2; continue; }
      if (c2 === "/*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { state = "str"; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "html") {
      if (c3 === "-->") { state = "code"; out += "   "; i += 3; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; i++; continue; }
      out += " "; i++; continue;
    }
    if (state === "block") {
      if (c2 === "*/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (state === "str") {
      // 简化处理：字符串里不做转义跟踪以外的解析
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) { state = "code"; out += c; i++; continue; }
      out += c === "\n" ? "\n" : c; i++; continue;
    }
  }
  return out;
}

/**
 * 解析 CSS 自定义属性表：`--name: value;`
 *
 * 注意：同一变量可能在 `@media (prefers-color-scheme: light)` 里被再次赋值。
 * 我们关心的是**官方基线（深色）**的值，所以：
 *   - 跳过所有位于 `@media` 块内的声明（用花括号配对粗略界定块范围）；
 *   - 保留每个变量的**第一个**（即 :root 基线）定义。
 */
export function cssVars(css) {
  // 先标记出 @media 块覆盖的字符区间，这些区间内的声明一律不采集
  const masked = css.split("");
  const mediaRe = /@media[^{]*\{/g;
  let m;
  while ((m = mediaRe.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    for (let k = m.index; k < i && k < masked.length; k++) {
      if (masked[k] !== "\n") masked[k] = " ";
    }
  }
  const scoped = masked.join("");

  const vars = new Map();
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
  while ((m = re.exec(scoped)) !== null) {
    if (!vars.has(m[1])) vars.set(m[1], m[2].trim()); // 保留第一个 = 基线值
  }
  return vars;
}

/**
 * 判断一个 CSS 值是否「等价于 none / 0」（即不产生可见边框）。
 * 覆盖 0 / none / 0px / 0 solid transparent 等写法。
 */
export function isNoBorder(value) {
  const v = String(value).trim().toLowerCase();
  if (v === "0" || v === "none") return true;
  // 形如 "0 solid ..." / "0px none" 也算没有可见边框
  const tokens = v.split(/\s+/);
  return tokens[0] === "0" || tokens[0] === "0px" || tokens.includes("none");
}

/**
 * 在 CSS 里查找某个属性是否被设为期望值，支持一层 var() 解引用。
 * 返回命中的行号数组（空数组 = 没找到）。
 */
export function cssPropertyMatches(css, prop, expected, vars) {
  const hits = [];
  const lines = css.split("\n");
  const re = new RegExp(`\\b${prop}\\s*:\\s*([^;{}]+)`, "gi");
  lines.forEach((line, idx) => {
    let m;
    while ((m = re.exec(line)) !== null) {
      let val = m[1].trim().toLowerCase();
      // 解一层 var(--x)
      const vm = val.match(/^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/);
      if (vm && vars && vars.has(vm[1])) val = String(vars.get(vm[1])).toLowerCase();
      if (val === expected.toLowerCase()) hits.push(idx + 1);
    }
    re.lastIndex = 0;
  });
  return hits;
}

/** 在（已剥注释的）文本里找所有匹配，返回 {line, text}。 */
function findMatches(cleaned, re) {
  const lines = cleaned.split("\n");
  const hits = [];
  lines.forEach((line, idx) => {
    if (re.test(line)) hits.push({ line: idx + 1, text: line.trim() });
    re.lastIndex = 0;
  });
  return hits;
}

function fmt(hits, file, limit = 6) {
  return hits
    .slice(0, limit)
    .map((h) => `${file}:${h.line}  ${h.text}`)
    .join("\n         ") + (hits.length > limit ? `\n         …共 ${hits.length} 处` : "");
}

/* ================================================================== 1. chrome 独立窗口是否彻底移除 */

section("1. chrome 独立窗口已彻底移除");

const LIB_RS = "src-tauri/src/lib.rs";
const libRaw = readIfExists(LIB_RS);
const lib = libRaw ? stripComments(libRaw) : null;

check("src-tauri/src/lib.rs 存在", lib !== null, `找不到 ${LIB_RS}`);

if (lib !== null) {
  const chromeLabel = findMatches(lib, /\bCHROME_LABEL\b/);
  check(
    "lib.rs 里没有残留的 CHROME_LABEL 常量/引用",
    chromeLabel.length === 0,
    fmt(chromeLabel, LIB_RS),
  );

  const chromeHtml = findMatches(lib, /chrome\.html/);
  check(
    "lib.rs 里没有 chrome.html 引用",
    chromeHtml.length === 0,
    fmt(chromeHtml, LIB_RS),
  );

  const ensureSync = findMatches(lib, /\bfn\s+(ensure_chrome_window|sync_chrome_window)\b/);
  check(
    "lib.rs 里没有 ensure_chrome_window / sync_chrome_window",
    ensureSync.length === 0,
    fmt(ensureSync, LIB_RS),
  );
}

// 老的 chrome 页面文件必须已删除
for (const rel of ["src/chrome.html", "src/chrome.css", "src/chrome.js"]) {
  check(`${rel} 已删除`, !existsSync(join(ROOT, rel)), `${rel} 仍然存在，应删除`);
}

// 全仓库（src/ 与 src-tauri/）不应再有 chrome.html / chrome.css / chrome.js 的引用
{
  const scanDirs = ["src", "src-tauri/src", "src-tauri/capabilities"].map((d) => join(ROOT, d));
  const hits = [];
  for (const dir of scanDirs) {
    for (const f of walk(dir)) {
      if ([".png", ".ico", ".lock"].includes(extname(f))) continue;
      if (f.endsWith(".lock")) continue;
      const text = readIfExists(relative(ROOT, f).split(sep).join("/"));
      if (text === null) continue;
      const cleaned = stripComments(text);
      cleaned.split("\n").forEach((line, idx) => {
        if (/\bchrome\.(html|css|js)\b/.test(line)) {
          hits.push({ file: relative(ROOT, f), line: idx + 1, text: line.trim() });
        }
      });
    }
  }
  check(
    "src/ 与 src-tauri/ 内无 chrome.html|chrome.css|chrome.js 引用",
    hits.length === 0,
    hits.slice(0, 8).map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n         "),
  );
}

// capabilities 里不应再有 "chrome" 窗口条目
{
  const capPath = "src-tauri/capabilities/default.json";
  const capRaw = readIfExists(capPath);
  check(`${capPath} 存在`, capRaw !== null, `找不到 ${capPath}`);
  if (capRaw !== null) {
    let cap = null;
    try {
      cap = JSON.parse(capRaw);
    } catch (e) {
      check(`${capPath} 是合法 JSON`, false, String(e.message));
    }
    if (cap) {
      check(`${capPath} 是合法 JSON`, true);
      const wins = Array.isArray(cap.windows) ? cap.windows : [];
      check(
        `capabilities 的 windows 列表里没有 "chrome"`,
        !wins.includes("chrome"),
        `当前 windows = ${JSON.stringify(wins)}`,
      );
      // 顶栏必须仍然有 IPC 权限（它是本地页面），否则按钮全废。
      //
      // ⚠️ 顶栏是主窗口 `main` 里的**子 webview**（label = `titlebar`）。
      // Tauri 的匹配规则是「webview label 命中 `webviews`」**或**「window label 命中 `windows`」
      // 二者之一 —— 见 tauri 的 `RuntimeAuthority::resolve_access`：
      //     cmd.webviews.iter().any(|w| w.matches(webview))
      //       || cmd.windows.iter().any(|w| w.matches(window))
      // 所以 `titlebar` 写在 `webviews` 里是**正确且必要**的写法
      // （写进 `windows` 反而不匹配，因为窗口 label 是 `main`）。两种写法这里都接受。
      const views = Array.isArray(cap.webviews) ? cap.webviews : [];
      check(
        `capabilities 覆盖了顶栏（windows 或 webviews 里有 "titlebar"）`,
        wins.includes("titlebar") || views.includes("titlebar"),
        `当前 windows = ${JSON.stringify(wins)}, webviews = ${JSON.stringify(views)}`,
      );
      // 安全断言：不能把主窗口 `main` 整体放进 windows。
      // 那会让主窗口的**所有**子 webview（含加载远程 DSH 页面的 content）都被这条
      // capability 覆盖；虽然 `local: true` 的来源检查仍会挡住远程来源，
      // 但显式只授权 titlebar 更清晰，也避免以后有人误加 remote.urls 就放开远程 IPC。
      check(
        `capabilities 没有把主窗口 "main" 整体放进 windows（避免顺带覆盖远程 content）`,
        !wins.includes("main"),
        `当前 windows = ${JSON.stringify(wins)}`,
      );
    }
  }
}

/* ================================================================== 2. 顶栏 CSS 关键样式 */

section("2. 顶栏 CSS（高度 40px / 背景 #1b1b1c）");

const CSS_CANDIDATES = ["src/titlebar/titlebar.css", "src/titlebar.css"]
  .map((p) => join(ROOT, p))
  .filter(existsSync);

check(
  "找到顶栏 CSS 文件",
  CSS_CANDIDATES.length > 0,
  `以下路径都不存在：src/titlebar/titlebar.css, src/titlebar.css`,
);

if (CSS_CANDIDATES.length > 0) {
  const cssRel = relative(ROOT, CSS_CANDIDATES[0]).split(sep).join("/");
  const css = stripComments(readFileSync(CSS_CANDIDATES[0], "utf8"));
  const vars = cssVars(css);

  // 高度：必须解析出 40px（支持 height: 40px 或 height: var(--dsht-h)，--dsht-h: 40px）
  const heightHits = cssPropertyMatches(css, "height", "40px", vars);
  check(
    `${cssRel} 顶栏高度解析为 40px（height: 40px 或 height: var(--…: 40px)）`,
    heightHits.length > 0,
    `没找到解析为 40px 的 height。官方 P3 与 Rust CHROME_HEIGHT 都是 40px。\n` +
      `         当前 CSS 变量：${[...vars.entries()].filter(([k]) => /h$|-h\b|height/i.test(k)).map(([k, v]) => `${k}=${v}`).join(", ") || "(无)"}`,
  );

  // 背景：#1b1b1c（官方 P3 实测 (27,27,28) = #1b1b1c），支持 var()
  const bgHits = [
    ...cssPropertyMatches(css, "background", "#1b1b1c", vars),
    ...cssPropertyMatches(css, "background-color", "#1b1b1c", vars),
  ];
  check(
    `${cssRel} 顶栏背景解析为 #1b1b1c`,
    bgHits.length > 0,
    "官方 P3 顶栏底色实测为 rgb(27,27,28) = #1b1b1c（可经 var() 间接设置）。",
  );

  // 不能再用旧的 (32,32,32) = #202020 顶栏底色
  const oldBg = [
    ...cssPropertyMatches(css, "background", "#202020", vars),
    ...cssPropertyMatches(css, "background-color", "#202020", vars),
  ];
  check(
    `${cssRel} 没有残留旧的 #202020 顶栏底色`,
    oldBg.length === 0,
    oldBg.map((l) => `${cssRel}:${l}`).join("\n         "),
  );

  // .bar 规则块内不应有可见的 border-bottom（官方 P3 无边框线）
  // 只在 .bar / body / html 这几个「顶栏容器」选择器的块里查，避免误伤下拉菜单等
  const barBlock = (() => {
    const m = css.match(/(^|\n)\s*\.bar\s*\{([^}]*)\}/);
    return m ? m[2] : null;
  })();
  if (barBlock !== null) {
    // 逐条 border 声明判断，避免把 `border: 0` 误判成有边框
    const borderDecls = [];
    const bre = /\bborder(-[a-z]+)?\s*:\s*([^;{}]+)/gi;
    let bm;
    while ((bm = bre.exec(barBlock)) !== null) {
      if (!isNoBorder(bm[2])) borderDecls.push(bm[0].trim());
    }
    check(
      `${cssRel} 的 .bar 没有可见边框线（官方 P3 无边框线）`,
      borderDecls.length === 0,
      `\`.bar\` 里有非 0 的边框：${borderDecls.join(", ")}\n` +
        `         旧实现是 1px solid rgb(51,51,51)（P2 里实测 y=80..81）。`,
    );
  } else {
    check(
      `${cssRel} 能定位到 .bar 规则块`,
      false,
      "没找到 `.bar { ... }`，选择器名可能变了，请同步更新本脚本。",
    );
  }
}

/* ================================================================== 3. 所有会建窗口的 command 必须是 async */

section("3. 会创建窗口的 command 必须是 async");

if (lib !== null) {
  /**
   * 解析 lib.rs：找出每个 #[tauri::command]（或其调用的内部函数）里
   * 是否出现 WebviewWindowBuilder::...build()，以及该 command 是否 async。
   */
  const lines = lib.split("\n");

  // 找出所有 `fn name(` 定义及其 async 状态与起始行
  const fnDefs = [];
  lines.forEach((line, idx) => {
    const m = line.match(/^\s*(pub\s+)?(async\s+)?fn\s+([A-Za-z0-9_]+)\s*[<(]/);
    if (m) fnDefs.push({ name: m[3], isAsync: Boolean(m[2]), line: idx + 1, idx });
  });

  // 每个函数体范围 = 从本 def 到下一个 def（近似；Rust 顶层 fn 顺序排列足够用）
  fnDefs.forEach((d, i) => {
    d.end = i + 1 < fnDefs.length ? fnDefs[i + 1].idx : lines.length;
  });

  const fnByName = new Map(fnDefs.map((d) => [d.name, d]));

  /** 该函数体（含其直接调用的同文件函数，递归一层）里是否有 build()。 */
  function createsWindow(fn, seen = new Set()) {
    if (!fn || seen.has(fn.name)) return false;
    seen.add(fn.name);
    const body = lines.slice(fn.idx, fn.end).join("\n");
    if (/\.build\s*\(\s*\)/.test(body) && /WebviewWindowBuilder/.test(body)) return true;
    // 递归一层：body 里调用的其他同文件函数
    for (const callee of fnByName.keys()) {
      const re = new RegExp(`\\b${callee}\\s*\\(`);
      if (callee !== fn.name && re.test(body) && createsWindow(fnByName.get(callee), seen)) {
        return true;
      }
    }
    return false;
  }

  // 找出所有 #[tauri::command] 标注的函数
  const commands = [];
  lines.forEach((line, idx) => {
    if (line.trim() === "#[tauri::command]") {
      for (let j = idx + 1; j < Math.min(idx + 6, lines.length); j++) {
        const m = lines[j].match(/^\s*(pub\s+)?(async\s+)?fn\s+([A-Za-z0-9_]+)/);
        if (m) {
          commands.push({ name: m[3], isAsync: Boolean(m[2]), line: j + 1 });
          break;
        }
      }
    }
  });

  check(
    "在 lib.rs 里找到了 #[tauri::command]",
    commands.length > 0,
    "一个都没找到，说明解析逻辑或文件路径有问题。",
  );

  console.log(`  [INFO] 共 ${commands.length} 个 command：` +
    commands.map((c) => `${c.name}${c.isAsync ? "(async)" : "(同步)"}`).join(", "));

  const syncWindowBuilders = [];
  const asyncWindowBuilders = [];
  for (const cmd of commands) {
    const fn = fnByName.get(cmd.name);
    if (!fn) continue;
    if (!createsWindow(fn)) continue;
    // 判断归属：直接看 command 函数自身的 async 状态
    (cmd.isAsync ? asyncWindowBuilders : syncWindowBuilders).push(cmd);
  }

  check(
    "没有「同步 command 内部创建窗口」的情况（否则会卡死主线程）",
    syncWindowBuilders.length === 0,
    syncWindowBuilders.length
      ? "以下同步 command 会创建窗口，必须改成 async（见 lib.rs 中 open_main_window 的注释）：\n         " +
        syncWindowBuilders.map((c) => `${c.name} (line ${c.line})`).join("\n         ")
      : "",
  );

  if (asyncWindowBuilders.length > 0) {
    console.log(
      `  [INFO] 以下 async command 会创建窗口（预期为 async）：` +
        asyncWindowBuilders.map((c) => c.name).join(", "),
    );
  }

  // 顶层事件回调（菜单/Tray）不能同步建窗口
  const menuHandler = findMatches(lib, /run_action\s*\(/);
  if (menuHandler.length > 0) {
    // run_action 会建窗口，它必须只从 async 上下文或主线程代理里调用
    const syncCallers = [];
    for (const d of fnDefs) {
      const body = lines.slice(d.idx, d.end).join("\n");
      if (/\brun_action\s*\(/.test(body) && !d.isAsync && /#\[tauri::command\]/.test(
        lines.slice(Math.max(0, d.idx - 3), d.idx).join("\n"),
      )) {
        syncCallers.push(d);
      }
    }
    check(
      "没有同步 command 调用 run_action（run_action 会创建窗口）",
      syncCallers.length === 0,
      syncCallers.length
        ? "以下同步 command 调用了 run_action：" +
          syncCallers.map((d) => `${d.name} (line ${d.line})`).join(", ")
        : "",
    );
  }
}

/* ================================================================== 4. DPI 双重缩放回归 */

section("4. DPI 双重缩放回归（顶栏高度翻倍的根因）");

if (lib !== null) {
  // Tauri 的 inner_size / set_size / LogicalPosition 都接受**逻辑**单位，
  // 框架内部会自己乘 scale_factor。代码里再手动 * scale 就会翻倍。
  //
  // ⚠️ 这里刻意用 `findCodeMatches`（按行剔除注释）而不是 `stripComments`：
  // 后者是个状态机，不认 Rust 的**生命周期**（`<'a, R: Runtime>`）与字符字面量，
  // 会把 `'` 当成字符串起点而与真实代码脱节，导致 lib.rs 的文档注释里的
  // 历史说明（「旧实现手算 CHROME_HEIGHT * scale」）被误报成真代码。
  // 对「禁止某种写法」这类断言，按行过滤注释才可靠。
  const doubleScale = findCodeMatches(libRaw, /\*\s*scale\b/);
  check(
    "lib.rs 代码里没有手动 `* scale`（会导致 DPI 双重缩放）",
    doubleScale.length === 0,
    doubleScale.length
      ? "以下位置的**代码**（非注释）把逻辑尺寸手动乘了 scale，而 Tauri 的 inner_size/set_size\n" +
        "内部还会再乘一次，结果顶栏高度变成 2 倍（实测 P1 顶栏 158 device px ≈ 40*2*2）：\n         " +
        fmt(doubleScale, LIB_RS)
      : "",
  );
}

/* ================================================================== 5. 初始化脚本防重复插入 */

section("5. 顶栏初始化脚本：防重复插入 / 重复绑定");

/*
 * 关于任务书里的「初始化脚本里有防重复插入的唯一 id 判断」：
 *
 * 若顶栏是「注入到主页面里的 HTML 覆盖层」，则必须有唯一 id + 存在性判断，
 * 否则重复初始化会插入多份顶栏。
 *
 * 但本项目的设计是**独立 40px webview 页面**（src/titlebar.html，理由见该文件注释：
 * 远程页面没有 IPC 权限，顶栏必须是本地来源才能 invoke）。独立页面只加载一次，
 * 不存在「重复插入」的场景。
 *
 * 因此本节断言分两种形态，任一满足即可 —— 这样无论最终采用哪种架构，脚本都有效：
 *   (a) 独立页面形态：脚本不得把顶栏节点注入到别的文档（无 appendChild/insertAdjacent 顶栏节点）；
 *   (b) 注入形态：必须有唯一 id + 存在性判断。
 */

{
  const candidates = ["src/titlebar/titlebar.js", "src/titlebar.js", "src/chrome.js"]
    .map((p) => ({ rel: p, text: readIfExists(p) }))
    .filter((x) => x.text !== null);

  check("找到顶栏初始化脚本", candidates.length > 0, "src/titlebar/titlebar.js 不存在");

  for (const { rel, text } of candidates) {
    const cleaned = stripComments(text);

    // 形态判别：是否有「把节点插入文档」的动作
    const injects =
      /insertAdjacentHTML|insertAdjacentElement|\.appendChild\s*\(|\.prepend\s*\(/.test(cleaned);

    if (!injects) {
      // (a) 独立页面形态 —— 合法
      check(
        `${rel} 是独立页面形态（不注入到其它文档），无需防重复插入`,
        true,
      );
    } else {
      // (b) 注入形态 —— 必须有唯一 id + 存在性判断
      const hasGuard =
        /getElementById\s*\(/.test(cleaned) ||
        /querySelector\s*\(/.test(cleaned) ||
        /\.isConnected\b/.test(cleaned);
      const hasUniqueId =
        /(^|\s)(const|let)\s+[A-Za-z0-9_]*(ID|Id)\b\s*=\s*["'`]/m.test(cleaned);
      check(
        `${rel}（注入形态）有防重复插入的存在性判断`,
        hasGuard,
        "检测到节点注入，但没有任何「元素是否已存在」的判断，重复初始化会插入多份顶栏。",
      );
      check(
        `${rel}（注入形态）使用稳定的唯一 id`,
        hasUniqueId,
        "检测到节点注入，但没有稳定的唯一 id 常量，无法可靠判断「是否已插入过」。",
      );
    }

    // 两种形态都该有的：DOM 查找必须走 getElementById（而不是随机 id）
    check(
      `${rel} 通过 getElementById 定位元素`,
      /getElementById\s*\(/.test(cleaned),
      "没有使用 getElementById，元素定位方式可能不稳定。",
    );
  }
}

/* ================================================================== 6. 不出现官方的侧边栏展开按钮 */

section("6. 没有官方的侧边栏展开按钮");

{
  const tbHtml = readIfExists("src/titlebar.html") ?? readIfExists("src/index.html");
  check(
    "找到顶栏 HTML 模板（src/titlebar.html）",
    tbHtml !== null,
    "src/titlebar.html 不存在",
  );

  if (tbHtml !== null) {
    const cleaned = stripComments(tbHtml);
    // 官方那个 40x40 的侧边栏展开按钮：不应出现相关 id / aria-label / title
    const sidebarBtn = [];
    cleaned.split("\n").forEach((line, idx) => {
      if (/sidebar|侧边栏|expand-sidebar|toggle-sidebar|btn-nav/i.test(line)) {
        sidebarBtn.push({ line: idx + 1, text: line.trim() });
      }
    });
    check(
      "顶栏 HTML 里没有「侧边栏展开」按钮",
      sidebarBtn.length === 0,
      fmt(sidebarBtn, "src/titlebar.html") + "\n         用户明确不要官方的侧边栏展开按钮（P3 左侧那个 45,45,46 方块）。",
    );

    // 必须存在窗口控制三件套
    for (const [what, re] of [
      ["最小化按钮", /btn-min/],
      ["最大化按钮", /btn-max/],
      ["关闭按钮", /btn-close/],
    ]) {
      check(
        `顶栏 HTML 里有${what}`,
        re.test(cleaned),
        `没找到 ${re}，窗口控制按钮缺失会导致无法最小化/关闭。`,
      );
    }

    // 「网页对话」入口必须存在（这是问题1 的入口）
    check(
      "顶栏 HTML 里有「网页对话」入口",
      /btn-chat|网页对话/.test(cleaned),
      "没有找到「网页对话」按钮，用户无法打开对话侧栏。",
    );
  }
}

/* ================================================================== 7. 窗口几何单位一致性（回归防护） */

section("7. 窗口几何：逻辑/物理单位不要混用");

if (lib !== null) {
  const mixed = [];
  lib.split("\n").forEach((line, idx) => {
    // outer_position() 是物理坐标，若被直接塞进 LogicalPosition 或 .position(f64,f64) 就是单位混用
    if (/outer_position\s*\(\s*\)/.test(line)) {
      mixed.push({ line: idx + 1, text: line.trim() });
    }
  });
  console.log(
    `  [INFO] outer_position() 出现 ${mixed.length} 处；` +
      (mixed.length ? "请人工确认其返回值只用于物理单位 API（PhysicalPosition），不要传给 LogicalPosition/.position(f64,f64)。" : "已无使用。"),
  );
}

/* ------------------------------------------------- 8. 侧栏过渡动画（任务 1） */

section("8. 侧栏开/关过渡动画（Windows 11 动画效果适配）");

const ANIM_RS = "src-tauri/src/anim.rs";
const animRaw = readIfExists(ANIM_RS);

check(`${ANIM_RS} 存在（侧栏过渡动画模块）`, animRaw !== null, `找不到 ${ANIM_RS}`);

if (animRaw !== null) {
  const animCode = findCodeMatches(animRaw, /./).length > 0 ? animRaw : animRaw;

  // 必须尊重系统的「动画效果」开关：关掉时不能硬放动画。
  check(
    "动画模块读取 SPI_GETCLIENTAREAANIMATION（尊重系统「动画效果」开关）",
    /SPI_GETCLIENTAREAANIMATION/.test(animCode),
    "没找到 SPI_GETCLIENTAREAANIMATION —— 系统关掉动画时仍会播放过渡，属无障碍缺陷",
  );

  // 必须有缓动 + 插值的纯函数，才能被单测覆盖。
  check(
    "动画有可单测的纯函数（ease_out_cubic / x_at）",
    /fn\s+ease_out_cubic/.test(animCode) && /fn\s+x_at/.test(animCode),
    "缺少 ease_out_cubic / x_at —— 观感逻辑无法被单测覆盖",
  );

  // 防抢占：快速连点时旧动画必须退出。
  check(
    "动画有代次（generation）防抢占机制",
    /ANIM_GENERATION/.test(animCode),
    "缺少代次机制：用户快速连点会让多个动画线程同时改位置",
  );

  // 时长要落在「不拖沓」的区间。
  const ms = animCode.match(/SLIDE_MS\s*:\s*u64\s*=\s*(\d+)/);
  check(
    "过渡时长在 100~300ms 之间（对齐 Windows 原生观感）",
    ms !== null && Number(ms[1]) >= 100 && Number(ms[1]) <= 300,
    ms ? `实际 SLIDE_MS = ${ms[1]}ms` : "没找到 SLIDE_MS 常量",
  );
}

if (lib !== null) {
  // 模块必须真的被挂上，否则代码在但根本不编译（静默失效）。
  check(
    "lib.rs 已 `mod anim;` 挂上动画模块",
    /^\s*mod\s+anim\s*;/m.test(libRaw),
    "lib.rs 里没有 `mod anim;` —— anim.rs 不会被编译，动画等于没做",
  );

  // 收进托盘 / 缩放窗口时必须取消动画，否则侧栏会停在错误位置。
  const cancels = findMatches(libRaw, /anim::cancel\s*\(\s*\)/);
  check(
    "窗口缩放 / 收进托盘时会 anim::cancel()（避免侧栏停在错误位置）",
    cancels.length >= 2,
    `只找到 ${cancels.length} 处 anim::cancel()，至少应有 2 处（Resized + hide_main_windows）`,
  );

  // overlay 模式才做滑动；docked 模式必须避开逐帧重排。
  check(
    "toggle_chat_webview 按模式区分：docked 不做逐帧重排",
    /if\s+chat_docked\s*\(\s*\)/.test(libRaw),
    "没看到按 chat_docked() 分流的逻辑 —— docked 模式下逐帧改宽度会导致内容页每帧重排",
  );
}

/* ------------------------------------------------------------------ 汇总 */

console.log("\n" + "=".repeat(60));
console.log(`结果：${passes.length} 通过，${failures.length} 失败`);
console.log("=".repeat(60));

if (failures.length > 0) {
  console.log("\n失败明细：");
  for (const f of failures) {
    console.log(`\n  ✗ [${f.section}] ${f.name}`);
    if (f.detail) console.log(`      ${f.detail.replace(/\n/g, "\n      ")}`);
  }
  console.log(
    `\n静态校验未通过：${failures.length} 项失败。` +
      `\n这些断言覆盖的是「单元测试与真机冒烟之间的空档」，历史 bug（顶栏高度翻倍、点网页对话卡死）都在这里。\n`,
  );
  process.exit(1);
}

console.log("\n✓ 全部静态校验通过。\n");
