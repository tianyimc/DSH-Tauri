# DSHTauri 顶栏（Titlebar）

把主窗口顶部那条 40px 的横条做成**官方 DeepSeek Harness 桌面端**的样子（截图 P3），
但**不要**官方最左边那个「侧边栏展开」按钮，且**保留改造前的全部功能**。

---

## 1. 交付形态（重要）

**这是一个真实的本地 HTML 页面**，由 Rust 作为主窗口上方那条 40px 高的 webview 加载。
不是初始化脚本、不是注入到 DSH 页面里的 Shadow DOM 覆盖层。

```
src/titlebar.html            <- 页面（入口；src/ 就是 frontendDist）
src/titlebar/titlebar.css    <- 样式（官方 P3 对齐）
src/titlebar/titlebar.js     <- 接线：事件 -> invoke
src/titlebar/rules.js        <- 纯函数（可测，无 DOM / 无 Tauri）
```

页面内引用：

```html
<link rel="stylesheet" href="titlebar/titlebar.css" />
<script type="module" src="titlebar/titlebar.js"></script>
```

### 为什么必须是本地页面，而不是注入远程页面

按 `docs/TROUBLESHOOTING.md §5`：**远程页面默认没有任何 Tauri 权限**。
主窗口加载 `https://...` 时，即使 `withGlobalTauri: true` 注入了 `window.__TAURI__`，
任何 `invoke` 都会被拒绝。本项目用户地址是运行时可配置的，而 capability 的
`remote.urls` 要求 **scheme + host + port 完全匹配**，静态配置覆盖不了 —— 这是有意的安全设计
（`capabilities/remote-main.json.example` 靠 `.example` 后缀默认不生效）。

所以：**顶栏必须是一个本地来源的 webview**，这样它命中 `capabilities/default.json`，
IPC 正常。改造前它是一个独立窗口 `chrome`；现在它是**主窗口内的一个子 webview**
（label `titlebar`），由 Rust 用 `Window::add_child` 创建。

> ⚠️ **`capabilities/default.json` 必须用 `webviews: ["titlebar"]` 覆盖本页面。**
> 注意是 **`webviews`** 而不是 `windows`：顶栏是子 webview，它的 **window label 是 `main`**，
> 写进 `windows` 是**不匹配**的，`invoke` 会被拒绝、按钮全部静默失效
> （`TROUBLESHOOTING §5` 第 5 条里的那个坑）。
> `cargo test` 有一条 `capability_covers_titlebar_webview_but_not_main_window` 盯着这个接线。

### 尺寸与挂载方式

页面自身铺满 40px 视口 —— CSS 里 `html, body { height: 100% }`，`.bar { height: 40px }`，
**不用** `position: fixed` 去覆盖页面（它本来就是个独立 webview，没有别的页面可覆盖）。

Rust 侧把它定位到主窗口客户区顶部：`LogicalPosition(0, 0)` + `LogicalSize(宽, 40)`，
内容是 `(0, 40)` + `(宽, 高-40)`。窗口 `Resized` / DPI 变化时重排一次。

**关键点（也是旧实现的翻车点）**：

- 子 webview 的坐标是相对父窗口**客户区左上角**的，窗口整体**移动**不改变相对位置，
  所以**不需要监听 `Moved`**。
- 尺寸/位置全部用**逻辑**单位（`LogicalSize` / `LogicalPosition`）。
  **绝不要手算 `× scale_factor`** —— Tauri 内部会自己乘一次，手动再乘会让高度变成 2 倍
  （实测顶栏 158 device px ≈ 40×2×2，正确值应是 78 ≈ 40×2）。
  旧的 `sync_chrome_window` 正是栽在这里，它已被删除。

---

## 2. 与官方 P3 的逐项对照

参数全部来自 Lead 对 P3 的**逐像素测量**（`.analysis/DIAGNOSIS.md`「问题 3」），不是我猜的。

| 项目 | 官方 P3 实测（device px） | 本实现（逻辑 px / CSS） | 状态 |
|---|---|---|---|
| 顶栏背景 | `(27,27,28)` | `#1b1b1c` | ✅ 一致 |
| 菜单文字 | `(170,173,176)` | `#aaadb0` | ✅ 一致 |
| 顶栏高度 | y=0..61 ≈ 62 → 约 31~40 | **40px** | ✅ 取 40，与 `TITLEBAR_HEIGHT` 一致 |
| 底部边框线 | **无**（靠底色差区分） | **无** `border` / `box-shadow` | ✅ 已删掉旧的 `(51,51,51)` 线 |
| 菜单文字 hover | —（官方未测到） | 文字变 `#f0f1f2` + 淡背景 `rgba(255,255,255,.06)` | ⚠️ 合理推断，待真机确认 |
| 窗口按钮背景 | 透明 | `transparent`、`border: 0` | ✅ 一致 |
| 窗口按钮图标 | `(170,173,176)` | 继承 `#aaadb0` | ✅ 一致 |
| 窗口按钮宽度 | 未精确测 | 46px（沿用改造前尺寸） | ⚠️ 待真机确认是否偏宽 |
| 关闭按钮 hover | — | `#c42b1c`（Windows 标准红）+ 白色图标 | ⚠️ 行业标准，待真机确认 |
| 图标字体 | Segoe Fluent Icons / MDL2 | `"Segoe Fluent Icons", "Segoe MDL2 Assets", "Segoe UI Symbol"` | ✅ 兜底链完整 |
| 最小化 / 最大化 / 关闭 | — | `&#xE921;` / `&#xE922;` / `&#xE8BB;` | ✅ 与改造前一致 |
| 左侧栏展开按钮 | `(45,45,46)` 圆角方块 40×40 | **刻意不做** | ✅ 用户明确不要 |
| 内容区底色 | `(21,21,23)` | 页面自己的事，顶栏不掺和 | — |
| 浅色主题 | 官方是深色 UI | `prefers-color-scheme: light` 给了一套等价浅色值 | ➕ 新增，官方无对应项 |

### 功能对照（改造前 → 现在）

| 功能 | 交互 | 调用 |
|---|---|---|
| 应用菜单 | 点「应用」 | `popup_menu { menu: "app", x }` |
| 操作菜单 | 点「操作」 | `popup_menu { menu: "actions", x }` |
| 网页对话 | 点「网页对话」 | `chrome_action { action: "chat" }` |
| 最小化 | 点 `─` | `window_control { action: "minimize" }` |
| 最大化/还原 | 点 `□` | `window_control { action: "toggle-maximize" }` |
| 关闭到托盘 | 点 `✕` | `window_control { action: "close" }` |
| 拖动窗口 | 空白处按住左键 | `start_drag` |
| 最大化 | 双击空白处 | `window_control { action: "toggle-maximize" }` |

**全部保留**，命令契约与改造前逐字一致（`chrome_action` / `window_control` / `start_drag` / `popup_menu`）。
`popup_menu` 的 `x` 仍是**相对主窗口左上角的逻辑像素**（`TITLEBAR_HEIGHT` = 40 是它的 y 偏移）。

### 新增的边界处理

- **最大化 / 全屏时不拖动、不双击切换** —— 窗口已贴满屏幕边缘，拖动没有意义。
  还原后自动恢复可拖动（`rules.js` 的 `canDragWindow` / `canToggleMaximize`）。
- **最大化时按钮变「向下还原」+ 图标 `E923`（Restore）**，tooltip 反映「点下去会发生什么」。
- **最大化时不留圆角** —— 此时窗口与屏幕边缘齐平，多余圆角会在四角露出页面底色。
  注意：当前顶栏是**独立 webview**，圆角其实由主窗口（`decorations(false)`）决定，
  所以 CSS 里的 `--dsht-radius` 只在将来改成同窗口子 webview 时才会真正生效；
  现在这条逻辑由 `titlebarRadius()` 单测覆盖、留作接口。
- **高对比度模式**（`forced-colors: active`）下补回一条分隔线，否则顶栏会和内容糊在一起。

---

## 3. 窗口状态同步（需要 rust-core 配合的唯一接口）

**问题**：顶栏是独立 webview，它**看不到**主窗口是否最大化。
浏览器侧的 `screen.availHeight` 在 DPI 缩放、多显示器、任务栏自动隐藏下都会误判 —— 不可靠。

**约定**：Rust 在主窗口状态变化时 `emit` 一个事件，前端监听：

```js
// 前端（src/titlebar/titlebar.js）
window.addEventListener("dsht:window-state", (event) => {
  applyWindowState(event.detail); // { maximized, fullscreen }
});
```

```rust
// Rust：Moved / Resized / 最大化变化时推给顶栏 webview
main.emit_to("titlebar", "dsht:window-state", serde_json::json!({
    "maximized": main.is_maximized().unwrap_or(false),
    "fullscreen": main.is_fullscreen().unwrap_or(false),
}))?;
```

**事件名是可改的** —— 如果 `rust-core` 想用别的名字或别的通道，改 `titlebar.js` 里那一行字符串即可
（`dsht:window-state` 在文件里只出现 1 次）。

**收不到事件也不影响可用性**：`window_control` 的 `toggle-maximize` 由 Rust 自己判断当前状态，
所以按钮/双击在任何情况下都是对的；只是**图标不会从 `E922` 切成 `E923`**、tooltip 停留在「最大化」，
且最大化时仍然允许拖动（拖了没效果，因为窗口已经贴边）。属于**降级但不坏**。

---

## 4. `invoke` 包装

注入/内嵌场景下 `__TAURI__` 的位置不总是固定，所以把调用收敛到一个函数里，
依次尝试：

1. `window.__TAURI__.core.invoke`（本地页面的正常路径，`withGlobalTauri: true`）
2. `window.__TAURI__.invoke`
3. `window.__TAURI_INTERNALS__.invoke`
4. `window.__TAURI_INTERNALS__.ipc`

都拿不到时：**`console.warn` 一次**（不重复刷屏）并返回一个 rejected promise，
让按钮**静默失效** —— 绝不抛同步异常打断页面。调用点统一走内部的 `fire()` 吞掉 rejection，
避免 unhandled rejection。

降级路径有测试覆盖：`scripts/test-titlebar-wiring.mjs` 里
「只有 `__TAURI_INTERNALS__` 时也能调用」「完全没有 Tauri 时只警告一次，且不抛异常」。

---

## 5. 测试

```bash
node --test scripts/test-titlebar.mjs scripts/test-titlebar-wiring.mjs
# 或者挂进 package.json 的 test:js 后：npm run test:js
```

| 文件 | 测什么 | 用例数 |
|---|---|---|
| `scripts/test-titlebar.mjs` | **纯函数**：`rules.js` 算什么（命中判定、状态规则、按钮文案/图标、命令参数构造、契约对账） | 21 |
| `scripts/test-titlebar-wiring.mjs` | **接线**：`titlebar.js` 有没有把事件接到正确的命令上、参数对不对、降级路径对不对 | 17 |

`test-titlebar-wiring.mjs` 用最小 DOM / Tauri stub **真跑一遍** `titlebar.js` 的 import，
再手动触发事件断言捕获到的 `invoke` 调用序列（每个用例用带 query 的 URL 重新 import 以隔离状态）。
它**不是渲染测试**。

> `package.json` 的 `test:js` 目前是 `node --test scripts/test-rules.mjs`，
> 需要加上这两个文件（该文件不在前端 write scope 内，由 Lead 改）。

---

## 6. 只能在 Windows 真机上确认的部分

我**无法**在 Linux 上渲染这个页面（容器里没有任何浏览器，也没有 WebView2），
所以以下内容只有**结构性/逻辑性**验证（元素 id 与 CSS 类对齐、调用序列、降级路径），
**视觉效果一律没有真机验证过**：

1. **颜色是否与 P3 真的一致** —— `#1b1b1c` / `#aaadb0` 是从截图像素反推的，
   实际渲染还要经过 WebView2 的色彩管理（尤其非 sRGB 显示器、HDR、夜灯模式）。
   请用取色器对比官方截图同一位置。
2. **字体是否命中** —— `Segoe Fluent Icons` 在 Win11 有、Win10 只有 `Segoe MDL2 Assets`。
   兜底链写好了，但**图标字形在各版本的宽度/基线**要实看（可能偏左/偏右几个像素）。
3. **hover 视觉** —— 淡背景透明度 `rgba(255,255,255,.06)`、关闭红 `#c42b1c` 是否符合官方观感，
   以及 hover 过渡 90ms 是否跟手。
4. **窗口按钮宽度 46px 是否偏宽** —— 官方 P3 没测到精确值，这个是沿用改造前的尺寸。
   若明显比官方宽，调 `titlebar.css` 的 `--dsht-btn-w` 即可（单点）。
5. **DPI 缩放下的清晰度** —— 图标是字体字形，125% / 150% / 200% 下是否发虚、是否对齐。
6. **触摸 / 笔输入**下的拖动与双击。
7. **浅色主题**那一套值（官方没有浅色顶栏可对照，属自行设计）。
8. **拖动过程中顶栏是否跟手** —— 这取决于 Rust 的几何同步策略，属于 `rust-core` 的验证范围。

### 排查建议

如果在 Windows 上发现「按钮全部没反应」，**第一件事**是看 `tauri dev` 日志里有没有
`capability ... does not match any window` —— 那就是第 1 节说的 label 没进
`capabilities/default.json` 的 `windows`。第二件事是开发者工具 Console 里有没有
`[DSHTauri] 顶栏：找不到 Tauri invoke`。
