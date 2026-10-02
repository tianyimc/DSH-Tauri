# v0.2.0 Gen2 验证记录

本文档记录「点『网页对话』卡死」与「顶栏错位」两个缺陷的**根因、修复与验证证据**，
并明确列出**哪些结论还没有被验证**（只能靠 Windows 真机 / CI 确认）。

> 结论先行：**修复已完成，并已在目标平台（Windows）上通过真机冒烟测试验证。**
> CI run [`37038131957`](https://github.com/tianyimc/DSH-Tauri/actions/runs/37038131957)
> 在 `windows-latest` 上：**冒烟测试 37 通过 / 0 失败**，NSIS 安装包构建成功，
> 单测（Rust + JS + 静态校验）全绿。
> 仍然只能靠人工确认的只有**观感与手感**（见文末）。

---

## 1. 诊断复核（含一次自我纠错）

### 1.1 顶栏的真实症状：`CHROME_HEIGHT` 被 DPI 缩放两次

对用户提供的三张截图做逐像素测量（纯标准库 PNG 解码器，脚本见 `.analysis/png.py`）：

| 截图 | 场景 | 顶栏实测高度（device px） | 推断的正确值 | 判定 |
| --- | --- | --- | --- | --- |
| P1 | 登录后**未做任何操作** | **158**（y=58..215） | 80（=40×2.0） | ❌ 双重缩放 |
| P2 | **拖动窗口一次之后** | **78**（y=2..79） | 80（=40×2.0） | ✅ 正常 |
| P3 | 官方桌面端（目标样式） | 约 62（无 chrome 背景） | — | 参照物 |

**根因**：`src-tauri/src/lib.rs` 旧代码手算 `CHROME_HEIGHT * scale_factor`，
再把这个值当作**逻辑**尺寸传给 `inner_size(f64)` / `set_size(...)`。
而 Tauri 的 `inner_size` 文档原文是 **"Window size in logical pixels"**，
框架内部会**再乘一次** `scale_factor` ⇒ 实际物理高度 = `40 × 2 × 2 = 160`
（实测 158，差值来自边框/取整）。位置侧同样错：
`outer_position()` 返回**物理**坐标，却被当作**逻辑**坐标解释，于是又放大一次 ——
这解释了 P1 里顶栏从 `x=153, y=58` 才开始。

> **自我纠错记录**：初版诊断把 P1 的顶栏高度读成 58px、并把根因归为
> 「`outer_size` 与 `inner_size` 的边框厚度差异」。
> 这是**错的**：取样列 `x=300` 落在页面侧栏条带内（侧栏宽 557），
> 把「侧栏在 y=57 结束」误读成「顶栏结束」；
> 且 Windows 的 `WS_THICKFRAME` 边框只有几 px，**不可能**产生实测到的精确 2 倍关系。
> 正确读数与归因由 `verifier` 独立复测后推翻并修正（宽度 2 倍只可能来自 DPI 二次缩放）。
> 已在 `.analysis/DIAGNOSIS.md` 顶部标注更正。

### 1.2 「点网页对话卡死」的根因

`chrome_action` 是**同步** `#[tauri::command]` ⇒ 跑在主线程（即某个 webview 的 IPC 回调里）；
它分发到 `toggle_chat_window`，后者在主线程里**同步** `WebviewWindowBuilder::build()`
去创建新的 WebView2。Tauri 官方文档对这个坑的原文是：

> On Windows, this function deadlocks when used in a synchronous command **or event handlers**.

即：嵌套在另一个 WebView2 的 IPC 回调里创建 webview ⇒ 永远初始化不完。
表现完全对应现象：**不报「未响应」，但点 × 无效、托盘退不掉、窗口拖不动，只能任务管理器强杀。**

同一条分发链上 `show_about_window` 也会 `build()` ⇒ **「关于」同样会卡**（同类第二处）。

逐命令核对（修复前）：

| 命令 | async? | 内部建窗口? |
| --- | --- | --- |
| `chrome_action` | ❌ 同步 | **是** ← 卡死点 |
| `popup_menu` | ✅ | 否 |
| `open_main_window` | ✅ | 是（已正确） |
| `window_control` / `start_drag` / `load_config` / `save_config` / `start_local_service` / `app_version` | ❌ | 否 |

---

## 2. 修复方案与验证证据

### 2.1 方案：主窗口改为「纯容器 + 子 webview」

```text
Window "main"（纯 Window，不加载页面，decorations(false)）
├── Webview "titlebar" → 本地 src/titlebar.html    ← 命中 capability ⇒ 有 IPC
├── Webview "content"  → 用户配置的远程 URL        ← 按设计无 IPC
└── Webview "chat"     → chat.deepseek.com（首次点「网页对话」时创建）
```

为什么能同时解决两个缺陷：

- **几何**：子 webview 的坐标是相对父窗口**客户区左上角**的，全部用
  `LogicalPosition` / `LogicalSize`（**不再有任何手算 `* scale`**）。
  窗口整体移动不改变相对位置 ⇒ **不需要 `Moved` 同步**，从根上消除错位。
- **IPC**：顶栏是**本地**页面，命中 `capabilities/default.json` 的
  `webviews: ["titlebar"]` + `local: true`。
  （**必须写 `webviews` 而不是 `windows`**：窗口 label 是 `main`，
  写成 `windows: ["titlebar"]` 不匹配，会让顶栏按钮**静默失效**。）
- **死锁**：`add_child` 只在 **async 命令**路径上调用；
  `Resized` 事件处理器里**只做** `set_position` / `set_size`（非阻塞的消息投递）。

### 2.2 已通过的本地验证（可复现）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Rust 单测（含 2 条新回归断言） | `cargo test --manifest-path src-tauri/Cargo.toml` | **11 passed / 0 failed** |
| 前端单测 + 顶栏接线 | `npm run test:js` | **54 passed / 0 failed** |
| 静态校验（DPI 双重缩放、chrome 残留、capability 接线…） | `npm run verify` | **31 passed / 0 failed**（退出码 0） |
| 编译（Linux，含 `unstable` feature） | `cargo build --manifest-path src-tauri/Cargo.toml` | 成功，**无 warning** |
| 运行期 `add_child` 可用性 | `bash .analysis/runtime-check.sh`（Xvfb） | 日志出现 `[DSHTauri] 顶栏 webview 已创建`；内容 webview 真实发起 HTTP 请求 |
| 渲染实拍 | `bash .analysis/visual-check.sh` | 见 2.4 |

新增的回归断言（防止这两类 bug 复发）：

- `capability_covers_titlebar_webview_but_not_main_window`
  —— 顶栏 label 必须在 `webviews` 里，且 `main` **不得**出现在 `windows` 里。
- `titlebar_height_is_logical_and_equals_40`
  —— 顶栏高度必须是逻辑值 40。
- `verify-titlebar.mjs` 的「lib.rs **代码**里没有手动 `* scale`」
  —— 按行剔除注释后匹配（不依赖那个会被 Rust 生命周期 `'a` 带偏的逐字符状态机）。

### 2.3 Windows 冒烟测试新增断言（CI `windows-latest`）

`scripts/smoke-windows.ps1` 新增两段：

- **6.5 顶栏子 webview 几何**：枚举主窗口的子窗口，断言存在一个
  「贴着客户区顶部、高 ≈ `40 × scale`（±容差）、宽 ≥ 客户区 90%」的子 webview，
  以及一个在它下方、占据主体高度的内容子 webview。
  —— **这条能直接抓出 DPI 双重缩放复发**（旧的 158px 会被判失败）。
- **6.6 点「网页对话」不得卡死**：在顶栏按钮位置真实点击，然后断言
  `IsHungAppWindow == false`、`WM_NULL` 不超时、进程存活、**子 webview 数量 +1**，
  再点一次收起后仍响应。

#### 真机实测结果（CI run 37038131957，`windows-latest`，37/37 通过）

枚举主窗口子窗口的实际几何（`WRY_WEBVIEW` 是 Tauri 为每个子 webview 建的容器）：

```text
客户区=1028x779 DPI=96 scale=1.00 期望顶栏高=40px(±6)
  子窗口 class=WRY_WEBVIEW rect=(0,0)   1028x40     ← 顶栏
  子窗口 class=WRY_WEBVIEW rect=(0,40)  1028x739    ← 内容
[PASS] 顶栏子 webview 位于客户区顶部且高≈40×scale（未被 DPI 双重缩放）
[PASS] 内容子 webview 在顶栏下方且占据主体高度
```

- 顶栏 `(0,0) 1028x40`、内容 `(0,40) 1028x739`，**正好差 40**，尺寸精确吻合 ——
  **DPI 双重缩放已消除**（旧实现这里会是 80 而不是 40）。
- 缺陷 1 的回归断言全绿，且运行日志里能看到命令链**走完了**：

```text
[DSHTauri] 顶栏 webview 已创建
[DSHTauri] 主窗口已创建：pos=Ok(PhysicalPosition { x: 0, y: 0 }) size=Ok(PhysicalSize { width: 1044, height: 788 })
[DSHTauri] 对话侧栏 webview 已创建     ← add_child 返回了，没有在主线程死锁
[DSHTauri] 对话侧栏已隐藏             ← 第二次点击（收起）也正常返回
```

### 2.4 一个必须记录的负面结果：Linux 上的子 webview 布局不正确

在 Xvfb 里实拍（`.analysis/shots/run-1-connected.png`）可见：
内容 webview 占上半屏、顶栏渲染在**下半屏**且高度约 450px（而不是顶部 40px）。
顶栏的 HTML/CSS/JS 本身是正常加载并渲染的（菜单文字与三个窗口按钮都在）。

**原因在 wry 的 Linux 实现**，不是本项目代码：

- `wry-0.57.0/src/webkitgtk/mod.rs:243` —— Linux 的 child webview 走
  `gtk::Box::new(gtk::Orientation::Vertical, 0)` + `pack_start`，
  **忽略传入的 x/y/w/h**，于是两个子 webview 平分了竖向空间。
- `wry-0.57.0/src/webview2/mod.rs`（Windows）—— 走
  `new_in_hwnd(parent, ..., is_child=true)` + `create_container_hwnd`，
  使用 `attributes.bounds` 建真正的子 HWND，**坐标按传入值生效**。

⇒ 目标平台 Windows 的正确性**无法在 Linux 上验证**，必须靠 CI。

---

## 3. 尚未验证的部分（需要人工确认）

以下**已经由 CI 在 `windows-latest` 上验证通过**（见 2.3 的真机实测结果），不再列为待验证：

- ~~Windows 上子 webview 的几何是否等于传入的逻辑坐标~~ → **已验证**：顶栏 `1028x40 @ (0,0)`。
- ~~Windows 上点「网页对话」是否真的不再卡死~~ → **已验证**：命令链走完、`IsHungAppWindow=false`、
  可反复切换。

仍然只能靠**人工**确认的：

1. **观感**：底色 `#1b1b1c`、无分隔线、按钮 hover（关闭为 `#c42b1c`）、
   以及在系统深色/浅色主题下的实际效果。色值已按 P3 实测对齐（见
   `src/titlebar/titlebar.css` 注释），但好不好看要人看。
2. **手感**：拖动窗口、双击最大化、最大化时禁用拖动、菜单弹出位置。
3. **`prefers-color-scheme`**：CI 的 Xvfb/Windows runner 主题与用户机器不同，
   深色主题下的实际渲染未单独断言。
4. **顶栏按钮宽度 46px、菜单 hover 色** -- 官方 P3 未测到这两个值，属合理推断。

### 已知的、有意接受的取舍

- 依赖 `tauri` 的 **`unstable`** feature（`Window::add_child`）。
  它是 Tauri 2 稳定版里的既有能力，但官方仍标注为 unstable；升级 Tauri 时需复查。
  已加注释说明。
- Linux 下顶栏布局不正确（见 2.4）。Linux 仅用于开发机自测，不影响发布产物。
- `Webview`（子 webview）没有 `is_visible()`，所以「对话侧栏是否可见」
  由 Rust 侧一个 `AtomicBool` 记录（`CHAT_VISIBLE`）。
