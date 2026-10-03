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

/**
 * 切出 CSS 里**所有** `@media (prefers-color-scheme: dark)` 块的块内容。
 *
 * 为什么需要：只 grep `prefers-color-scheme` 这个 token 的话，注释里留一句就够
 * 满足断言 —— 而「整个 @media 块被删掉」这种真实回归会**静默通过**
 * （独立验证的 M11 变异）。所以必须切出块内容再断言块内真的做了切换。
 *
 * ⚠️ 必须返回**所有**块，不能只返回第一个：`about.css` 里有两个深色媒体查询
 * （第一个是主题变量，第二个才是 logo 切换）。初版只取第一个 ⇒ 断言永远失败。
 */
function extractCssAtMediaDarkBlocks(code) {
  const blocks = [];
  const re = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    const braceStart = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = braceStart; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(code.slice(braceStart, i + 1));
          // 从块尾继续找下一个媒体查询。
          re.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return blocks;
}

/**
 * 把 Rust 源码里所有 `&[u16] = &['A' as u16, 'p' as u16, …, 0]` 形式的
 * UTF-16 字面量**解码回字符串**。
 *
 * 为什么必须这样做：`win_icon.rs` 里的注册表值名是用 UTF-16 字符数组写的
 * （`RegGetValueW` 要 `PCWSTR`），**代码里根本没有 `AppsUseLightTheme` 这个字符串**
 * —— 它只出现在注释里。于是「扫含注释的原文」会得到一个**永远为真**的断言
 * （注释里留着名字就行），而「把真正使用的值名换掉」这种回归**抓不住**
 * （独立验证的 M7 变异）。解码字符数组才能断言**代码实际使用的**值名。
 */
function decodeRustU16CharArrays(code) {
  const decoded = [];
  const re = /&\s*\[u16\]\s*=\s*&\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const chars = [...m[1].matchAll(/'((?:\\.|[^'\\])*)'\s*as\s*u16/g)].map((x) =>
      x[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\"),
    );
    // 去掉结尾的 NUL 终止符（字面量末尾的 `0`）。
    decoded.push(chars.filter((c) => c !== "\0").join(""));
  }
  return decoded;
}

/**
 * 去掉 Rust 源码里的注释，只留代码 —— 供「某 token 是否出现在**代码**里」这类断言使用。
 *
 * 为什么需要：直接扫含注释的原文时，「在注释里写一句关键词」就能满足断言（假绿）。
 * 独立验证用这种方式抓出过多条假绿（例如把注册表值名换掉、但注释里还留着旧名字）。
 *
 * 处理 `//`（含 `///`、`//!`）与块注释（含文档块注释）两种形式。
 * ⚠️ 不处理字符串字面量里的 `//`：Rust 代码里出现 `"http://…"` 很常见，
 * 简单按行剔除会把它截断。所以这里对**字符串感知**地扫描：
 * 遇到 `"` 就跳到配对的 `"`（跳过转义），遇到注释起始才进入注释状态。
 */
function stripRustComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    // 块注释
    if (c2 === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    // 行注释
    if (c2 === "//") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    // 字符串字面量：整段原样保留（含其中的 //）
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 从 Rust 源码里切出某个函数的**函数体**（大括号配对），用于把断言限定在函数内部。
 *
 * 为什么需要：用固定长度的 `[\s\S]{0,600}` 窗口会**越过函数边界**，落进后面的
 * 其它函数（甚至测试函数），于是「删掉目标函数里的某段代码」仍能被别处的代码满足
 * —— 独立验证的 M5 变异就是这么骗过断言的（测试自身的源码满足了产品断言）。
 *
 * 返回 `null` 表示找不到该函数。
 */
function extractRustFnBody(code, fnName) {
  const re = new RegExp(`\\bfn\\s+${fnName}\\s*[<(]`);
  const m = re.exec(code);
  if (!m) return null;
  const braceStart = code.indexOf("{", m.index);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(braceStart, i + 1);
    }
  }
  return null;
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
  // ⚠️ **必须是剔除注释后的代码**，不能直接用原文。
  //
  // 这里原本写的是 `findCodeMatches(animRaw, /./).length > 0 ? animRaw : animRaw`
  // —— 两个分支都是 `animRaw`，整个表达式**恒等于原文**，等于完全没用上
  // `findCodeMatches`。后果：下面的断言扫的是**含注释的源码**，
  // 于是「在注释里写一句 `ANIM_GENERATION` 防抢占」就能让断言通过（假绿）。
  // 实测过：把真代码全删、只在注释里留关键词，旧写法仍然 PASS。
  //
  // 现在按行剔注释（`//` 与 `///` 整行 + 行尾），得到 `animCode` 供断言使用。
  // 注意：只用于「某 token 是否出现在**代码**里」这类判断；
  // `SLIDE_MS` 的取值仍从原文提取（正则本身就要求是代码形态的 `const`）。
  const animCode = animRaw
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

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

  // ⚠️ **末帧的 on_done 必须复检代次**（v0.3.2 修的竞态）。
  //
  // 为什么这条必须是**静态**检查：动画跑在 `std::thread::spawn` 出来的线程里，
  // 单测只能覆盖抽出来的纯函数 `should_run_on_done`，**覆盖不到循环有没有真的调它**。
  // 实测过：把循环里的这行删掉（退回 v0.3.1 的行为），`cargo test` **依然 48 全绿**
  // —— 纯函数测试对「调用点被删除」完全无感。所以这里补一条结构断言。
  //
  // 竞态本身：代次检查只在每帧开头做，而 `last` 是之后算的；用户若在
  // 「判定末帧 → 调用 on_done」之间点开关，旧收尾（关闭分支是 `chat.hide()`）
  // 会把用户刚打开的侧栏藏掉 ⇒ `CHAT_VISIBLE=true` 但不可见 =「点了没反应」。
  // ⚠️ 断言写法刻意**宽松**：只要求「在 `if` 条件里引用了
  // `should_run_on_done(my_generation)`」，不绑定具体的语句形态。
  //
  // 为什么不用更严格的 `if !f() { return; }`：那样会把**语义等价**的改写
  // （例如 `if f() { } else { return; }`）误报成失败 —— 独立验证专门指出过这点。
  // 假阴性（噪音）比假阳性（漏掉真回归）危害小，但仍应避免。
  //
  // 「调用点被删除」由下一条**顺序断言**兜住：函数**定义**里是
  // `should_run_on_done(generation)`（形参名不同），所以一旦调用点被删，
  // `guardIdx` 就是 -1，顺序断言必然失败。两条合起来既宽松又不漏。
  check(
    "末帧调用 on_done 前会复检代次（should_run_on_done）",
    /if\s*!?\s*should_run_on_done\s*\(\s*my_generation\s*\)/.test(animCode),
    "on_done 前没有在 `if` 条件里复检代次 —— " +
      "被抢占的旧动画仍会执行收尾（关闭分支的 hide() 会把刚打开的侧栏藏掉）",
  );

  // 反向断言：`on_done(&app)` 必须出现在那次复检**之后**。
  //
  // 注意 `should_run_on_done(generation)` 的函数**定义**不匹配
  // `my_generation`，所以这里找到的一定是**调用点**，不会自我满足。
  const onDoneIdx = animCode.indexOf("on_done(&app)");
  const guardIdx = animCode.indexOf("should_run_on_done(my_generation)");
  check(
    "on_done 的调用点位于代次复检之后",
    guardIdx !== -1 && onDoneIdx !== -1 && guardIdx < onDoneIdx,
    guardIdx === -1
      ? "代码里找不到 `should_run_on_done(my_generation)` 调用 —— 守卫被删了"
      : "on_done 在代次复检之前就被调用了 —— 复检形同虚设",
  );
}

/* ================================================================== 9. 外部链接交给系统浏览器 */

section("9. 下载链接交给系统浏览器（不让「关于」窗口自己导航走）");

{
  // 「关于」窗口点「下载」若直接 `location.href = url`，窗口本身会被导航到
  // GitHub 的下载页 ⇒ 用户回不到界面。所以必须有 Rust 侧命令用系统外壳打开。
  const openCmd = findCodeMatches(libRaw, /async\s+fn\s+open_external\s*\(/);
  check(
    "lib.rs 定义了 open_external 命令（用系统默认浏览器打开链接）",
    openCmd.length > 0,
    "没有 open_external —— 「关于」窗口点下载会把自己导航走",
  );

  // 必须校验协议，避免把危险 scheme 交给系统外壳执行。
  check(
    "open_external 只允许 http / https",
    /fn\s+open_external[\s\S]{0,600}?"http"\s*\|\s*"https"/.test(libRaw),
    "open_external 没有做协议白名单 —— 前端若被注入 file:/javascript: 会被系统执行",
  );

  // Windows 上用 ShellExecuteW（不经过 cmd，避免引号/注入问题）。
  check(
    "Windows 分支用 ShellExecuteW 打开链接",
    /ShellExecuteW\s*\(/.test(libRaw),
    "没有用 ShellExecuteW —— 用 cmd start 之类会引入引号转义与注入风险",
  );

  // 命令必须真的注册进 invoke_handler，否则前端调用会失败。
  check(
    "open_external 已注册进 invoke_handler",
    /open_external\s*,/.test(libRaw),
    "open_external 没注册 —— 前端 invoke 会直接报「命令不存在」",
  );

  const aboutJs = readIfExists("src/about.js");
  if (aboutJs !== null) {
    // 前端必须调这个命令，而不是直接改 location。
    check(
      'about.js 用 invoke("open_external") 打开下载',
      /invoke\(\s*"open_external"\s*,\s*\{\s*url\s*\}\s*\)/.test(aboutJs),
      "about.js 没有调用 open_external —— 下载会让「关于」窗口自己被导航走",
    );
    // location.href 只允许作为降级路径出现一次。
    const hrefUses = findCodeMatches(aboutJs, /window\.location\.href/);
    check(
      "about.js 里 location.href 仅作为降级路径（最多 1 处）",
      hrefUses.length <= 1,
      `location.href 出现了 ${hrefUses.length} 处 —— 它只应作为 open_external 失败后的兜底`,
    );
  }
}

/* ================================================================== 10. NSIS 开始菜单图标修复钩子 */

section("10. NSIS 开始菜单图标修复钩子");

{
  const hooks = readIfExists("src-tauri/nsis-hooks.nsh");
  check("找到 src-tauri/nsis-hooks.nsh", hooks !== null, "找不到 nsis-hooks.nsh");

  if (hooks !== null) {
    // 只留代码行（丢掉整行 `;` 注释），避免注释里的字眼骗过断言
    // —— 这正是第 8 节那个假绿的同类问题，这里一开始就避开。
    const hookCode = hooks
      .split("\n")
      .filter((l) => !/^\s*;/.test(l))
      .join("\n");

    check(
      "定义了 NSIS_HOOK_POSTINSTALL（覆盖安装也要跑）",
      /!macro\s+NSIS_HOOK_POSTINSTALL\b/.test(hookCode),
      "没有 NSIS_HOOK_POSTINSTALL —— 模板自带的函数在 $UpdateMode=1 时直接 Return，旧图标永远修不好",
    );
    // ⚠️ 钩子**不能**被 $UpdateMode 守卫，否则就失去「修好旧安装」的意义。
    check(
      "钩子体内没有 $UpdateMode 守卫（否则更新时不会修复）",
      !/\$UpdateMode/.test(hookCode),
      "钩子里出现了 $UpdateMode —— 更新模式下会跳过，旧安装的开始菜单图标修不好",
    );
    check(
      "钩子重建快捷方式时显式指定了 startmenu.ico",
      /CreateShortcut[^\n]*startmenu\.ico/.test(hookCode),
      "CreateShortcut 没指定 startmenu.ico —— 图标仍会继承 exe 资源（就是本次缺陷的成因）",
    );
    check(
      "钩子调用 SHChangeNotify 刷新 shell 图标缓存",
      /SHChangeNotify/.test(hookCode),
      "没有 SHChangeNotify —— .lnk 已改对但资源管理器仍显示缓存里的旧图标",
    );
    // 启用了 startMenuFolder 时，必须从注册表读回文件夹名（不能假设变量还有值：
    // 静默/被动安装会 Skip 掉 MUI_PAGE_STARTMENU）。
    //
    // ⚠️ 正则要匹配模板里的**完整**写法 `!if "${STARTMENUFOLDER}" != ""`。
    // 初版漏掉了 `}` 与 `"` 之间的那部分，写成 `STARTMENUFOLDER\}\s*!=`，
    // 于是永远为 false ⇒ 这条断言**从未执行**，把 GETFOLDER 删掉也照样全绿
    // （变异测试发现的第二个假绿）。
    const usesFolder = /STARTMENUFOLDER\}\s*"\s*!=\s*""/.test(hookCode);
    if (usesFolder) {
      check(
        "启用 startMenuFolder 时用 MUI_STARTMENU_GETFOLDER 读回路径",
        /MUI_STARTMENU_GETFOLDER/.test(hookCode),
        "直接用 $AppStartMenuFolder 而不 GETFOLDER —— 静默安装（/S）下该变量可能为空，会算出错路径",
      );
    }
    // 结构平衡：宏与预处理条件必须配对。
    const count = (re) => (hookCode.match(re) ?? []).length;
    check(
      "NSIS 宏与预处理条件结构平衡（!macro/!if/${If} 配对）",
      count(/^\s*!macro\s/gm) === count(/^\s*!macroend/gm) &&
        count(/^\s*!if\b/gm) === count(/^\s*!endif\b/gm) &&
        count(/\$\{If\}/g) === count(/\$\{EndIf\}/g),
      `!macro=${count(/^\s*!macro\s/gm)} !macroend=${count(/^\s*!macroend/gm)} ` +
        `!if=${count(/^\s*!if\b/gm)} !endif=${count(/^\s*!endif\b/gm)} ` +
        `If=${count(/\$\{If\}/g)} EndIf=${count(/\$\{EndIf\}/g)}`,
    );
    // 桌面快捷方式的既有行为不能被破坏。
    check(
      "保留了 MUI_FINISHPAGE_SHOWREADME_NOTCHECKED（桌面快捷方式默认不勾选）",
      /MUI_FINISHPAGE_SHOWREADME_NOTCHECKED/.test(hookCode),
      "丢了 MUI_FINISHPAGE_SHOWREADME_NOTCHECKED —— 完成页的「创建桌面快捷方式」会恢复默认勾选",
    );
  }
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

  // v0.3.2：两种模式共用同一条滑动路径，差别只在「内容页什么时候收窄」。
  //
  // 关键不变量（这是 v0.3.1 docked「白闪」的根治点）：
  //   · 关闭分支：先起动画（slide_x_with）→ 再 layout，layout 负责把内容页宽度还回去；
  //   · 打开分支：docked 必须用 slide_x_with + on_done 里 layout，**不能**在动画开始前
  //     就 layout（那会让内容页先收窄、右侧露出一条没有页面覆盖的空带 = 白闪）。
  //
  // ⚠️ 断言必须**限定在打开分支的代码区间内**。
  // 第一版写成对全文匹配 `if chat_docked() { ... slide_x_with`，
  // 结果把「关闭分支」和「首次创建分支」的 slide_x_with 也匹配上了 ——
  // 故意把打开分支改回 v0.3.1 的错误写法，校验**依然全绿**（假绿）。
  // 现在先按注释锚点切出「打开」区间，再在区间内断言。
  const openRegion = (libRaw.split("---------------- 打开 ----------------")[1] ?? "").split(
    "首次打开",
  )[0];

  check(
    "toggle_chat_webview 按模式分流，且 docked 的收窄发生在动画之后",
    /if\s+chat_docked\s*\(\s*\)/.test(libRaw),
    "没看到按 chat_docked() 分流的逻辑 —— docked 模式的内容页收窄时机必须与 overlay 不同",
  );

  // docked 打开分支必须**紧接** slide_x_with（带 on_done），在回调里才 layout。
  // 若有人改回「先 layout 再动画」或退回裸 slide_x，这里会失败。
  check(
    "docked 打开分支用 anim::slide_x_with（on_done 里才收窄内容页）",
    openRegion !== "" && /if\s+chat_docked\s*\(\s*\)\s*\{\s*anim::slide_x_with/.test(openRegion),
    openRegion === ""
      ? "没能在 lib.rs 里定位「打开」分支区间（注释锚点被改动？）"
      : "docked 打开分支没有紧跟 anim::slide_x_with —— 内容页会在侧栏滑入前就收窄，右侧露出一条无内容带（用户看到的是白闪）",
  );

  // 打开分支的 on_done 里必须真的调 layout_main_webviews，否则内容页永远不让出宽度。
  check(
    "docked 打开分支的 on_done 回调里会调 layout_main_webviews",
    openRegion !== "" &&
      /slide_x_with[\s\S]{0,300}?layout_main_webviews/.test(openRegion),
    openRegion === ""
      ? "没能在 lib.rs 里定位「打开」分支区间"
      : "on_done 里没有 layout_main_webviews —— docked 模式下内容页不会让出宽度，侧栏会盖在内容页上",
  );

  // 首次创建分支也必须让 docked 走 on_done 收窄（否则第一次点「网页对话」会露出空带）。
  const createRegion = (libRaw.split("首次打开")[1] ?? "").split("对话侧栏 webview 已创建")[0];
  check(
    "首次创建侧栏时 docked 同样走 on_done 收窄（第一次打开也不露空带）",
    createRegion !== "" &&
      /if\s+chat_docked\s*\(\s*\)\s*\{\s*anim::slide_x_with/.test(createRegion),
    createRegion === ""
      ? "没能在 lib.rs 里定位「首次打开」分支区间（注释锚点被改动？）"
      : "首次创建分支里 docked 没有用 slide_x_with —— 第一次点「网页对话」时右侧会先露出一条无内容带",
  );

  // 任务栏图标：Tauri 的 set_icon 只设 ICON_SMALL，必须额外补 ICON_BIG，
  // 否则任务栏按钮一直用 exe 里那个静态图标（v0.3.1 用户实测的缺陷）。
  check(
    "win_icon 模块存在（任务栏大图标槽）",
    /^\s*mod\s+win_icon\s*;/m.test(libRaw),
    "lib.rs 里没有 `mod win_icon;` —— 任务栏图标不会跟随主题",
  );
  check(
    "apply_theme_icons 会设置任务栏大图标（ICON_BIG）",
    /set_taskbar_icon\s*\(/.test(libRaw),
    "没有调用 win_icon::set_taskbar_icon —— Tauri 的 set_icon() 只设 ICON_SMALL，任务栏不会变",
  );

  // 任务栏跟随的是**外壳**主题（SystemUsesLightTheme），不是应用主题。
  const winIcon = readIfExists("src-tauri/src/win_icon.rs");
  if (winIcon !== null) {
    check(
      "win_icon.rs 读 SystemUsesLightTheme（任务栏跟外壳主题，不是应用主题）",
      /SystemUsesLightTheme/.test(winIcon),
      "win_icon.rs 没有读 SystemUsesLightTheme —— 「应用浅色 + 系统深色」时任务栏图标会选错配色",
    );
    check(
      "win_icon.rs 用 CreateIcon 从 RGBA 现场造 HICON",
      /CreateIcon\s*\(/.test(winIcon),
      "win_icon.rs 没有用 CreateIcon —— 图标是编译期内嵌的 PNG，没有文件路径可给 LoadImageW",
    );
    // ⚠️ 必须断言**调用点**用的是 ICON_BIG，不能只 grep 文件里有没有 `ICON_BIG`
    // 这个字符串 —— 文件顶部 `use ...::{CreateIcon, SendMessageW, ICON_BIG, WM_SETICON}`
    // 里就有它，于是「把调用点改成 ICON_SMALL/0」这种真实回归会被判成通过（假绿）。
    // 实测过：只查字符串时该变异存活；改成查 `SendMessageW(...WM_SETICON, ICON_BIG...)
    // 的调用点后才抓得住。
    check(
      "win_icon.rs 的 SendMessageW 调用点用 ICON_BIG（不是只 import 了它）",
      /SendMessageW\s*\([^;]*WM_SETICON\s*,\s*ICON_BIG/s.test(winIcon),
      "win_icon.rs 的 SendMessageW 调用没有传 ICON_BIG —— 设成 ICON_SMALL 等于重复 Tauri 已有的行为，任务栏仍不变",
    );
    // 反向断言：调用点不能出现字面量 0（= ICON_SMALL）。
    check(
      "win_icon.rs 的 SendMessageW 调用点没有用字面量 0（ICON_SMALL）",
      !/SendMessageW\s*\([^;]*WM_SETICON\s*,\s*0\b/s.test(winIcon),
      "win_icon.rs 把 ICON_SMALL（0）传给了 WM_SETICON —— 那是 Tauri 已经在做的，任务栏不会变",
    );
  }
}

/* ============================================== 11. v0.3.3：窗口图标 + 页内 logo + 许可证 */

section("11. v0.3.3：窗口图标、页内 logo、许可证");

{
  // ---- 窗口图标：按需创建的窗口必须在创建后立刻设图标 ----
  //
  // 「关于」/「设置」窗口是点菜单时才创建的，远晚于 `apply_theme_icons` 的最后一次调用，
  // 所以必须在自己的创建路径里设一次，否则会一直用 bundle 里那个静态深藏青 icon.ico。
  //
  // ⚠️ 本节所有断言都建立在**去注释后的 Rust 源码**上（`libCode`）。
  // 独立验证指出：初版直接用 `libRaw`（含注释），于是「注释里留一句关键词」
  // 就能满足断言（假绿）。
  const libCode = stripRustComments(libRaw);
  const winIcon2Raw = readIfExists("src-tauri/src/win_icon.rs");
  const winIconCode = winIcon2Raw !== null ? stripRustComments(winIcon2Raw) : null;

  // ⚠️ 正则必须用词边界：`set_creation_icon` **包含** `creation_icon` 子串，
  // 初版 `/fn\s+set_creation_icon/` 在把 `creation_icon` 整体改名后**仍能命中**
  // （残留的 `set_creation_icon` 让它通过）—— 独立验证的 M4 变异证明了这个假绿。
  check(
    "lib.rs 定义了 set_creation_icon（创建后立刻设主题图标）",
    /\bfn\s+set_creation_icon\s*[<(]/.test(libCode),
    "没有 set_creation_icon —— 按需创建的窗口会退回静态图标",
  );
  check(
    "lib.rs 定义了 creation_icon（创建期主题解析）",
    /\bfn\s+creation_icon\s*[<(]/.test(libCode),
    "没有 creation_icon —— 创建第一个窗口时拿不到主题",
  );
  for (const varName of ["selector", "about", "settings"]) {
    check(
      `lib.rs 里 ${varName} 窗口创建后调用了 set_creation_icon`,
      new RegExp(`set_creation_icon\\(&${varName}\\);`).test(libCode),
      `${varName} 窗口缺少 set_creation_icon 调用 —— 它的标题栏图标不会跟随主题`,
    );
  }

  // ⚠️ 必须**先切出 `creation_icon` 的函数体**再断言，不能用一个固定长度的
  // `[\s\S]{0,600}` 窗口：初版那个窗口会**越过函数边界**，落进下面的测试函数
  // `creation_icon_is_available_without_any_window`（它里面就有 `apps_prefers_light()`），
  // 于是把 `creation_icon` 里的注册表分支删掉后**断言依然通过**
  // —— 独立验证的 M5 变异证明了它（用测试自身的源码满足了产品断言）。
  const creationBody = extractRustFnBody(libCode, "creation_icon");
  check(
    "creation_icon 函数体存在且优先读注册表（不依赖已有窗口）",
    creationBody !== null && /apps_prefers_light\s*\(/.test(creationBody),
    creationBody === null
      ? "找不到 creation_icon 的函数体（签名或大括号被改动？）"
      : "creation_icon 函数体里没有 apps_prefers_light —— 创建第一个窗口时拿不到主题，浅色系统上会错用白色鲸鱼",
  );

  if (winIconCode !== null) {
    // ⚠️ 注册表值名在**代码**里是 UTF-16 字符数组（`RegGetValueW` 要 `PCWSTR`），
    // 字符串形式只出现在注释里。所以必须解码字符数组来断言**实际使用的**值名
    // —— 否则「注释里留着名字」就能满足断言（独立验证的 M7 假绿）。
    const u16Names = decodeRustU16CharArrays(winIconCode);
    check(
      "win_icon.rs 提供 apps_prefers_light（应用主题）",
      /\bfn\s+apps_prefers_light\s*[<(]/.test(winIconCode),
      "win_icon.rs 没有 apps_prefers_light",
    );
    // 两个值名必须都**真实出现在代码的 UTF-16 字面量里**（不是只在注释里）。
    for (const [label, name] of [
      ["应用主题", "AppsUseLightTheme"],
      ["外壳主题", "SystemUsesLightTheme"],
    ]) {
      check(
        `win_icon.rs 代码里真的读取 ${name}（${label}）`,
        u16Names.includes(name),
        `代码的 UTF-16 字面量里没有 ${name} —— 只有注释提到它（断言会变成永远为真）`,
      );
    }
    // 两者必须是**不同的**值：应用主题与外壳主题是两个独立开关，混用会让配色错。
    check(
      "win_icon.rs 里应用主题与外壳主题是两个不同的注册表值",
      u16Names.includes("AppsUseLightTheme") && u16Names.includes("SystemUsesLightTheme"),
      "缺少其中一个主题值 —— 应用主题与外壳主题被混用了",
    );
  }

  // ---- 页内 logo：不能再是 emoji ----
  for (const page of ["src/about.html", "src/settings.html"]) {
    const html = readIfExists(page);
    if (html === null) continue;
    check(
      `${page} 不再用 emoji 当 logo`,
      !/🐋/.test(html) && !/⚙️/.test(html),
      `${page} 仍有 emoji logo —— 与统一鲸鱼不一致`,
    );
    check(
      `${page} 引用了统一 logo 图片`,
      /logo-on-dark\.png/.test(html) && /logo-on-light\.png/.test(html),
      `${page} 没有引用 logo-on-dark.png / logo-on-light.png`,
    );
  }
  // ⚠️ 这段断言必须检查 **`@media (prefers-color-scheme: dark)` 块内部**真的有
  // 显隐切换，不能只 grep 三个 token。
  //
  // 为什么（独立验证的 M11 变异，最严重的一处假绿）：只 grep token 时，
  // **整个删掉 @media 块**仍能通过 —— 因为
  //   · `prefers-color-scheme` 还残留在上方注释里；
  //   · `.logo-on-dark` 还残留在基础规则 `.logo-on-dark { display: none; }` 里；
  //   · `.logo-on-light` 还残留在 HTML/其它规则里。
  // 而删掉 @media 的**实际后果**是：`.logo-on-dark { display: none }` 在两种主题下
  // 都生效、`.logo-on-light` 无规则恒可见 ⇒ **深色系统上显示深色鲸鱼、落在深色背景
  // 上看不见** —— 正是本轮要修的缺陷静默复发，而当时 89 条检查全绿。
  //
  // 所以这里改成：先把 CSS 注释去掉，再**切出 @media 块**，断言块内同时含
  // `.logo-on-dark { display: block }` 与 `.logo-on-light { display: none }`。
  for (const css of ["src/about.css", "src/settings.css"]) {
    const text = readIfExists(css);
    if (text === null) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ""); // 去 CSS 注释
    const darkBlocks = extractCssAtMediaDarkBlocks(code);
    check(
      `${css} 存在 @media (prefers-color-scheme: dark) 块`,
      darkBlocks.length > 0,
      `${css} 没有深色主题媒体查询 —— 深色系统下会显示深色鲸鱼，落在深色背景上看不见`,
    );
    // 至少要有一个深色块真的完成了 logo 显隐切换。
    const switchBlock = darkBlocks.find(
      (b) =>
        /\.logo-on-dark\s*\{[^}]*display\s*:\s*block/.test(b) &&
        /\.logo-on-light\s*\{[^}]*display\s*:\s*none/.test(b),
    );
    check(
      `${css} 的某个深色块内切换到 logo-on-dark / 隐藏 logo-on-light`,
      switchBlock !== undefined,
      `${css} 的 @media 块里没有完成 logo 显隐切换 —— 深色主题下 logo 会不可见`,
    );
    // 基础（浅色）规则也必须在：浅色下显示深藏青、隐藏白色。
    check(
      `${css} 基础规则默认隐藏 logo-on-dark（浅色下显示深藏青版）`,
      /\.logo-on-dark\s*\{[^}]*display\s*:\s*none/.test(code),
      `${css} 基础规则没有隐藏 logo-on-dark —— 浅色主题下会同时显示两个 logo`,
    );
  }
  // 两个 logo 资源必须真的存在（否则页面会显示裂图）。
  for (const png of ["src/logo-on-dark.png", "src/logo-on-light.png"]) {
    check(`${png} 存在`, existsSync(join(ROOT, png)), `找不到 ${png} —— 页面会显示裂图`);
  }

  // ---- 关于页的作者信息与免责声明 ----
  const aboutHtml = readIfExists("src/about.html");
  if (aboutHtml !== null) {
    check(
      "关于页显示作者信息 tianyimc.com",
      /tianyimc\.com/.test(aboutHtml),
      "关于页没有作者信息",
    );
    check(
      "关于页声明与 DeepSeek 官方无关",
      /与\s*DeepSeek\s*官方无关|与\s*DeepSeek\s*官方无任何关联/.test(aboutHtml),
      "关于页缺少「与 DeepSeek 官方无关」的声明",
    );
  }

  // ---- 许可证文件 ----
  check("LICENSE 文件存在", existsSync(join(ROOT, "LICENSE")), "找不到 LICENSE");
  const license = readIfExists("LICENSE");
  if (license !== null) {
    check(
      "LICENSE 是 Apache-2.0 全文",
      /Apache License/.test(license) && /Version 2\.0/.test(license),
      "LICENSE 不是 Apache-2.0",
    );
    check(
      "LICENSE 含版权行（作者信息）",
      /Copyright\s+20\d\d\s+tianyimc/.test(license),
      "LICENSE 里没有 `Copyright <年> tianyimc` 版权行 —— 用户要求必须保留原作者信息",
    );
  }
  check("NOTICE 文件存在", existsSync(join(ROOT, "NOTICE")), "找不到 NOTICE");
  const notice = readIfExists("NOTICE");
  if (notice !== null) {
    check(
      "NOTICE 含原作者归属声明",
      /tianyimc/.test(notice),
      "NOTICE 里没有原作者信息",
    );
  }

  // ---- README 的第三方定位声明 ----
  const readme = readIfExists("README.md");
  if (readme !== null) {
    check(
      "README 声明与官方无关（第三方客户端）",
      /第三方[\s\S]{0,40}官方无关|与\s*DeepSeek\s*官方无关/.test(readme),
      "README 没有「第三方 / 与官方无关」声明",
    );
    check(
      "README 声明不包含 DSH 主程序",
      /不包含[\s\S]{0,20}DSH|不含[\s\S]{0,20}DSH|不捆绑/.test(readme),
      "README 没有说明本程序不含 DSH 主程序",
    );
    check(
      "README 给出 DSH 官方仓库链接",
      /deepseek-ai\/deepseek-harness/.test(readme),
      "README 没有 DSH 官方链接",
    );
    check(
      "README 许可证章节已更新为 Apache-2.0（不再写 All rights reserved）",
      /Apache-2\.0/.test(readme) && !/All rights reserved/.test(readme),
      "README 仍写着「未附带许可证 / All rights reserved」—— 已过期",
    );
  }
}

/* ============================ 12. v0.3.4：WebView2 挂起（省内存） ============ */

section("12. v0.3.4：WebView2 挂起、销毁 about/settings");

{
  const suspendRaw = readIfExists("src-tauri/src/wv_suspend.rs");
  check(
    "src-tauri/src/wv_suspend.rs 存在（挂起模块）",
    suspendRaw !== null,
    "找不到挂起模块 —— 关闭后的 webview 会一直占着完整 JS 堆",
  );

  if (suspendRaw !== null) {
    // ⚠️ 一律用**去注释**的代码：注释里留一句关键词就能满足断言（本轮已多次踩到）。
    const suspendCode = stripRustComments(suspendRaw);
    const libCode12 = stripRustComments(libRaw);

    check(
      "wv_suspend.rs 真的调用 TrySuspend（不是只在注释里提）",
      /\bTrySuspend\s*\(/.test(suspendCode),
      "代码里没有 TrySuspend 调用 —— 挂起是空实现",
    );
    check(
      "wv_suspend.rs 真的调用 Resume",
      /\bResume\s*\(\s*\)/.test(suspendCode),
      "代码里没有 Resume() 调用 —— 挂起后无法恢复",
    );
    check(
      "wv_suspend.rs 用 IsSuspended 做实时判断（避免重复挂起/无谓 Resume）",
      /\bIsSuspended\s*\(/.test(suspendCode),
      "没有 IsSuspended —— 会重复请求挂起或做无谓恢复",
    );
    check(
      "wv_suspend.rs 声明了非 Windows 的空实现（Linux 上 cargo test 才能过）",
      /cfg\(not\(windows\)\)/.test(suspendCode),
      "缺少非 Windows 分支 —— Linux 上编译不过",
    );
    check(
      "wv_suspend.rs 用代次（generation）防止「挂起追着恢复跑」",
      /generation/.test(suspendCode) && /confirm_suspend/.test(suspendCode),
      "没有代次校验 —— 迟到的挂起回调会把刚打开的侧栏又标记成挂起",
    );

    // ---- chat 关闭路径：必须在 hide() **之后**才挂起 ----
    //
    // 为什么断言顺序：`TrySuspend` 要求 controller 的 IsVisible 为 false，
    // 而子 webview 的 `hide()` 才会设它。顺序反了会拿到 ERROR_INVALID_STATE，
    // 挂起**静默失效**（不报错、也没省到内存）。
    const closeFn = extractRustFnBody(libCode12, "toggle_chat_webview");
    check(
      "能在 toggle_chat_webview 里切出侧栏关闭分支",
      closeFn !== null,
      "找不到 toggle_chat_webview —— 断言无法定位",
    );
    if (closeFn !== null) {
      // 只看「关闭分支」那段：从 slide_x_with 到 layout_main_webviews。
      const slideIdx = closeFn.indexOf("slide_x_with");
      const layoutIdx = closeFn.indexOf("layout_main_webviews", slideIdx + 1);
      const closeBlock =
        slideIdx !== -1 && layoutIdx !== -1 ? closeFn.slice(slideIdx, layoutIdx) : "";
      check(
        "侧栏关闭分支里能定位到 hide() + 挂起",
        closeBlock.length > 0,
        "切不出关闭分支（slide_x_with / layout_main_webviews 结构变了？）",
      );
      const hideIdx = closeBlock.indexOf("chat.hide()");
      const suspendIdx = closeBlock.indexOf("wv_suspend::suspend");
      check(
        "侧栏关闭时调用了 wv_suspend::suspend",
        suspendIdx !== -1,
        "关闭侧栏没有挂起 —— 重 renderer 会一直留着",
      );
      check(
        "侧栏挂起发生在 hide() **之后**（否则 ERROR_INVALID_STATE 静默失效）",
        hideIdx !== -1 && suspendIdx !== -1 && hideIdx < suspendIdx,
        `顺序错误：hide 在第 ${hideIdx} 字符、suspend 在第 ${suspendIdx} 字符 —— suspend 必须在后`,
      );
    }

    // ---- chat 打开路径：必须先 resume() 再 show() ----
    const openIdx = libCode12.indexOf("wv_suspend::resume");
    check(
      "侧栏打开路径调用了 wv_suspend::resume",
      openIdx !== -1,
      "打开侧栏没有恢复 —— 挂起后打开会是一张死页",
    );
    if (openIdx !== -1) {
      // 在 resume 之后找**同一次打开**里的 show()。
      const showIdx = libCode12.indexOf("chat.show()", openIdx);
      check(
        "侧栏恢复发生在 chat.show() **之前**（先递增代次，让在飞的挂起回调失效）",
        showIdx !== -1 && openIdx < showIdx,
        "resume 在 show() 之后 —— 迟到的挂起回调可能把刚打开的侧栏又挂起",
      );
    }

    // ---- cookie 保活必须跳过挂起的 webview ----
    check(
      "cookie 保活会跳过已挂起的 webview（否则每 20 秒唤醒一次、挂起白做）",
      /should_skip_cookie_persist/.test(libCode12),
      "cookie 保活没有挂起判断 —— GetCookies 会把 webview 唤醒，省内存失效",
    );
  }
}

{
  // ---- 冒烟脚本里的内存采样：格式串必须合法 ----
  //
  // ⚠️ 这条守卫是被一次真实 CI 失败逼出来的：
  // 我写了 `"{1,>10}" -f ...` —— `>` 是 PowerShell 习惯，**.NET 的 `-f` 不认**，
  // 运行时抛 "Error formatting a string: Input string was not in a correct format"，
  // 直接把整个冒烟脚本搞挂（前面所有断言都过了，却因为最后打汇总表而失败）。
  //
  // **语法检查抓不住它**（`ParseFile` 通过），所以必须在这里静态拦：
  // .NET 复合格式串的对齐只能是可选的**正负号 + 数字**，`>` 一律非法。
  const smoke = readIfExists("scripts/smoke-windows.ps1");
  if (smoke !== null) {
    check(
      "冒烟脚本存在内存采样（阶段 0）",
      /Write-MemSample/.test(smoke) && /Write-MemSummary/.test(smoke),
      "冒烟脚本没有内存采样 —— 无法用真机数字验证优化效果",
    );
    check(
      "冒烟脚本的内存汇总在杀进程之前打印",
      (() => {
        const fin = smoke.indexOf("finally {");
        const summ = smoke.indexOf("Write-MemSummary", fin);
        const cleanup = smoke.indexOf("== 清理 ==", fin);
        return fin !== -1 && summ !== -1 && cleanup !== -1 && summ < cleanup;
      })(),
      "汇总表在 Stop-App 之后才打印 —— 进程已杀，拿不到数据",
    );
    // 抓 `{n,>...}` 这类非法对齐。
    const badAlign = smoke.match(/\{\d+,\s*[^}]*[<>][^}]*\}/g);
    check(
      "冒烟脚本没有非法的 .NET 格式串对齐（`{n,>10}` 会运行时抛异常）",
      badAlign === null,
      `发现非法格式串：${badAlign ? badAlign.join(", ") : ""} —— .NET 的 -f 只接受「符号+数字」对齐`,
    );
  }
}

{
  // ---- 关于 / 设置：关闭即**销毁**（v0.3.4 阶段 2）----
  //
  // 这两个窗口是本地小页面，重建很快；而隐藏会让它的 renderer 一直占内存。
  // 断言分三层：①纯函数分类正确 ②`window_control` 真的调 destroy() ③
  // 原生 × 路径不再 prevent_close。
  const libCode2 = stripRustComments(libRaw);

  const closeFn = extractRustFnBody(libCode2, "close_disposition");
  check(
    "lib.rs 定义了 close_disposition（可单测的关闭策略）",
    closeFn !== null,
    "没有 close_disposition —— 关闭策略散在事件处理器里，无法单测",
  );
  if (closeFn !== null) {
    check(
      "close_disposition 把 about / settings 归为 Destroy",
      /ABOUT_LABEL\s*\|\s*SETTINGS_LABEL\s*=>\s*CloseAction::Destroy/.test(closeFn),
      "about/settings 没被归为 Destroy —— 关闭后 renderer 仍占内存",
    );
    // v0.3.4：selector 是**条件**销毁 —— 有主窗口才销毁（省 renderer），
    // 没有主窗口时必须只隐藏（销毁最后一个窗口会让程序直接退出）。
    check(
      "close_disposition 对 selector 做条件判断（有主窗口才销毁）",
      /SELECTOR_LABEL\s*=>\s*\{[^}]*has_main_window[^}]*CloseAction::Destroy/.test(closeFn),
      "selector 不是条件销毁 —— 要么没省到内存，要么会在唯一窗口时让程序退出",
    );
    check(
      "close_disposition 对 selector 有「无主窗口则隐藏」的分支",
      /SELECTOR_LABEL[\s\S]{0,220}CloseAction::Hide/.test(closeFn),
      "缺少「没有主窗口时只隐藏」的分支 —— 销毁唯一窗口会让程序直接退出",
    );
    // ⚠️ 签名不在 `closeFn`（它只含函数体），要在整份去注释源码里找。
    check(
      "close_disposition 的签名接收 has_main_window（可测的前提）",
      /fn\s+close_disposition\s*\([^)]*has_main_window\s*:\s*bool/.test(libCode2),
      "close_disposition 没有 has_main_window 参数 —— 无法区分唯一窗口的情形",
    );
    check(
      "close_disposition 把 main 归为 HideToTray（关闭≠退出）",
      /MAIN_LABEL\s*=>\s*CloseAction::HideToTray/.test(closeFn),
      "main 不再收托盘 —— 关闭窗口会直接退出程序",
    );
  }

  const wcFn = extractRustFnBody(libCode2, "window_control");
  check(
    "window_control 里 about/settings 走 destroy() 而不是 hide()",
    wcFn !== null && /about\.destroy\(\)/.test(wcFn) && /settings\.destroy\(\)/.test(wcFn),
    "window_control 没有销毁这两个窗口 —— 省内存目标落空",
  );
  check(
    "销毁失败时有 hide() 兜底（不能让「关闭」看起来没反应）",
    wcFn !== null && (wcFn.match(/\.hide\(\)/g) || []).length >= 2,
    "destroy 失败没有兜底 —— 用户点了关闭窗口却还在",
  );

  // 原生 × 路径：CloseRequested 必须按 close_disposition 分派，
  // 且 Destroy 分支**不能**调 api.prevent_close()。
  const evIdx = libCode2.indexOf("CloseRequested { api, .. }");
  check(
    "CloseRequested 处理器存在",
    evIdx !== -1,
    "找不到 CloseRequested 处理 —— 原生 × 按钮行为无法断言",
  );
  if (evIdx !== -1) {
    // 取该 match 分支的一小段。
    const branch = libCode2.slice(evIdx, evIdx + 1200);
    check(
      "CloseRequested 按 close_disposition 分派（而不是硬编码 label 判断）",
      /close_disposition\s*\(/.test(branch),
      "CloseRequested 没用 close_disposition —— 关闭策略与单测脱节",
    );
    check(
      "Destroy 分支不调用 prevent_close（否则窗口不会被销毁）",
      /CloseAction::Destroy\s*=>\s*\{\s*\}/.test(branch),
      "Destroy 分支不是空实现 —— 可能仍在 prevent_close，窗口销毁不掉",
    );
  }

  // 动作名必须如实反映语义：既然是销毁，就不该再叫 hide-about。
  const aboutJs = readIfExists("src/about.js");
  const settingsJs = readIfExists("src/settings.js");
  if (aboutJs !== null && settingsJs !== null) {
    check(
      "前端动作名已改为 close-about / close-settings（不再是误导性的 hide-*）",
      /"close-about"/.test(aboutJs) &&
        /"close-settings"/.test(settingsJs) &&
        !/hide-about/.test(aboutJs) &&
        !/hide-settings/.test(settingsJs),
      "动作名仍叫 hide-* 但实际行为是销毁 —— 名实不符，后续维护会被误导",
    );
    check(
      "lib.rs 的命令分支用的是新动作名",
      /action == "close-about"/.test(libCode2) && /action == "close-settings"/.test(libCode2),
      "Rust 侧仍匹配 hide-* —— 前端点了关闭会没有任何反应",
    );
  }

  // 重建必须有重试：destroy() 是异步的，build() 可能赶在旧 WebView2 释放前执行。
  check(
    "按需窗口的重建有重试（destroy 是异步的，build 可能撞上旧实例未释放）",
    /fn build_with_retry/.test(libCode2) &&
      /build_with_retry\("打开关于窗口失败"/.test(libCode2) &&
      /build_with_retry\("打开设置窗口失败"/.test(libCode2),
    "重建没有重试 —— 「关闭关于窗口后立刻再打开」可能失败",
  );

  // ---- 收托盘：挂起 content / chat（v0.3.4 阶段 3）----
  //
  // 关键点：`Window::hide()` **只隐藏 HWND**，子 webview 的 controller 仍认为可见
  // ⇒ `TrySuspend` 会因 ERROR_INVALID_STATE 失败。所以必须先显式 SetIsVisible(false)。
  const hideFn = extractRustFnBody(libCode2, "hide_main_windows");
  check(
    "hide_main_windows 会挂起子 webview（收托盘是最该省内存的时刻）",
    hideFn !== null && /suspend_main_webviews\s*\(/.test(hideFn),
    "收托盘只隐藏窗口、没挂起 —— DSH 页面仍在满速跑（CI 采样点 5≈2 就是这个原因）",
  );

  const suspFn = extractRustFnBody(libCode2, "suspend_main_webviews");
  check(
    "suspend_main_webviews 同时处理 content 与 chat",
    suspFn !== null && /CONTENT_LABEL/.test(suspFn) && /CHAT_LABEL/.test(suspFn),
    "只挂起了其中一个 —— 另一个的 renderer 仍在占内存",
  );
  if (suspFn !== null) {
    // 顺序：必须先 set_controller_visible(false)，再 suspend。
    const visIdx = suspFn.indexOf("set_controller_visible");
    const susIdx = suspFn.indexOf("wv_suspend::suspend");
    check(
      "先 SetIsVisible(false) 再 TrySuspend（顺序反了会 ERROR_INVALID_STATE 静默失效）",
      visIdx !== -1 && susIdx !== -1 && visIdx < susIdx,
      `顺序错误：set_controller_visible 在第 ${visIdx} 字符、suspend 在第 ${susIdx} 字符`,
    );
  }

  const resFn = extractRustFnBody(libCode2, "resume_main_webviews");
  check(
    "resume_main_webviews 会唤醒子 webview",
    resFn !== null && /wv_suspend::resume/.test(resFn),
    "没有恢复逻辑 —— 从托盘回来会是一片空白",
  );
  if (resFn !== null) {
    // 恢复顺序与挂起相反：先 Resume，再置可见。
    const resIdx = resFn.indexOf("wv_suspend::resume");
    const visIdx2 = resFn.indexOf("set_controller_visible");
    check(
      "先 Resume() 再 SetIsVisible(true)（与微软官方示例顺序一致）",
      resIdx !== -1 && visIdx2 !== -1 && resIdx < visIdx2,
      `顺序错误：resume 在第 ${resIdx} 字符、set_controller_visible 在第 ${visIdx2} 字符`,
    );
    // 侧栏不该被「恢复」成可见 —— 否则内容页右侧会露出一块本应隐藏的侧栏。
    check(
      "恢复时按 CHAT_VISIBLE 决定侧栏是否置可见（不强行显示隐藏的侧栏）",
      /CHAT_VISIBLE/.test(resFn),
      "恢复时无条件把侧栏置可见 —— 会在内容页右侧露出一块本应隐藏的侧栏",
    );
  }

  const showFn = extractRustFnBody(libCode2, "show_main_windows");
  if (showFn !== null) {
    const resumeIdx = showFn.indexOf("resume_main_webviews");
    const showIdx2 = showFn.indexOf("main.show()");
    check(
      "show_main_windows 在 show() 之前先恢复子 webview",
      resumeIdx !== -1 && showIdx2 !== -1 && resumeIdx < showIdx2,
      "先 show() 再恢复 —— 用户会先看到一帧空白窗口",
    );
  }

  // 「重新选择连接方式」那条路径也会 show 主窗口，同样必须先恢复。
  const omwFn = extractRustFnBody(libCode2, "open_main_window_inner");
  check(
    "「重新选择连接方式」路径也会先恢复子 webview（否则切地址后页面是挂起的）",
    omwFn !== null && /resume_main_webviews\s*\(/.test(omwFn),
    "该路径直接 show() 主窗口 —— 从挂起状态切地址会留下挂起的内容页",
  );
  if (omwFn !== null) {
    // 恢复必须在 navigate 之前：navigate 会隐式自动恢复，但那样我们的记账
    // （CONTENT_SUSPEND）不会同步，cookie 保活会一直误判为「挂起」而全部跳过。
    const rIdx = omwFn.indexOf("resume_main_webviews");
    const nIdx = omwFn.indexOf("navigate_content");
    check(
      "先恢复、再导航（避免依赖 Navigate 的隐式自动恢复导致记账不同步）",
      rIdx !== -1 && nIdx !== -1 && rIdx < nIdx,
      "navigate 在 resume 之前 —— 状态记账会不同步，cookie 保活会被错误跳过",
    );
  }

  // 冒烟里必须有「挂起真的生效」的行为断言（不靠内存数字）。
  const smoke2 = readIfExists("scripts/smoke-windows.ps1");
  if (smoke2 !== null) {
    // ⚠️ 首次 CI 后修正的推理：**不能**用「隐藏后页面心跳停止」证明挂起生效 ——
    // Chromium 自己就会对隐藏页节流定时器，两者行为上无法区分。
    // 真正的证据是 `TrySuspend` 回调里打的日志（见 wv_suspend.rs）。
    check(
      "wv_suspend 在挂起成功时打日志（区分「我们挂起成功」与「Chromium 自己节流」）",
      /已挂起 webview/.test(
        readIfExists("src-tauri/src/wv_suspend.rs") || "",
      ),
      "挂起成功没有日志 —— 「心跳停止」无法区分我们的挂起与 Chromium 自身的节流",
    );
    check(
      "冒烟断言挂起成功的日志（而不是用不可靠的心跳停止）",
      /已挂起 webview/.test(smoke2),
      "冒烟没有断言挂起日志 —— 挂起是否生效无法确认",
    );
    check(
      "冒烟验证恢复后内容页在跑（兜住「窗口回来但空白」的最坏情况）",
      /从托盘恢复后内容页仍在跑/.test(smoke2),
      "没有恢复断言 —— 恢复失败会导致内容页永久空白却测不出来",
    );
    // v0.3.4：选择窗口销毁后，冒烟必须断言「销毁后主界面仍健康」
    // —— 这正是历史上「销毁正在执行 IPC 的 webview」那个坏状态的检测点。
    check(
      "冒烟断言销毁选择窗口后主界面仍健康（防历史坏状态复发）",
      /销毁选择窗口后主窗口没有卡死/.test(smoke2) &&
        /销毁选择窗口后内容页仍在运行/.test(smoke2),
      "没有「销毁后仍健康」的断言 —— 历史坏状态（点 × 没反应）可能静默复发",
    );
    check(
      "冒烟断言连接后选择窗口确实被销毁",
      /首次连接后选择窗口已销毁/.test(smoke2),
      "没有断言选择窗口真的被销毁 —— 省内存目标可能没达成",
    );
    check(
      "verify 断言 reveal_selector 有重建分支且带重试",
      /fn\s+reveal_selector/.test(libCode2) &&
        /create_selector_window\(app\)/.test(libCode2),
      "reveal_selector 没有重建分支 —— 选择窗口销毁后用户再也无法切换连接方式",
    );
  }
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
