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

---

# v0.3.0 验证记录

CI run [`37047216127`](https://github.com/tianyimc/DSH-Tauri/actions/runs/37047216127)
在 `windows-latest` 上：**冒烟 38 通过 / 0 失败**，NSIS 构建 + 单测（Rust/JS/静态校验）全绿。

## 1. 侧栏过渡动画（任务 1）

**框架确实没有动画能力**（证据见 [`ANIMATION-FEASIBILITY.md`](ANIMATION-FEASIBILITY.md)）：
wry 用 `SetWindowPos` 摆放子 webview，无动画参数；`set_position` 也走 `set_bounds`
（同时设位置和尺寸），没有「只移动」的低开销通道。⇒ 自己逐帧插值（`src-tauri/src/anim.rs`）。

真机断言（CI，overlay 模式）：

```text
[PASS] 动画结束后侧栏停在客户区右侧（overlay 目标位置）
       客户区宽 1028、侧栏宽 420 ⇒ 期望左边缘 ≈ 608；实际 (608,40) 420x739 ✅
[PASS] 点「网页对话」后多出侧栏子 webview
[PASS] 再次点击收起侧栏后仍响应（可反复切换）
```

设计取舍：
- **只对 overlay 模式滑动**（网页整宽不变 ⇒ 动画期间尺寸不变、只改 x ⇒ 网页零重排）。
- **docked 模式不做滑动**：必须改网页宽度，逐帧改会每帧重排、必然掉帧。
- 跟随系统 `SPI_GETCLIENTAREAANIMATION`，关掉「动画效果」时直接切换。

## 2. 「设置」窗口（任务 2）

- 命令面**零新增**（复用 `load_config` / `save_config` / `chrome_action` / `window_control` / `popup_menu`）。
- 配置字段 `chatDocked`（默认 `false`），老配置缺字段天然兼容
  （`.analysis/settings-check.sh` 用**真的缺字段的老配置**启动验证过）。
- `save_config` 改**补丁语义**，避免「设置里选了 docked → 改一次地址 → 静默退回 overlay」。
- 布局几何是纯函数（`main_webview_rects` / `chat_target_bounds`），由 cargo test 直接覆盖；
  `Resized` 只读 `static CHAT_DOCKED`，不读盘。

## 3. 安装包图标（任务 4）

- 生成脚本 `scripts/make-ico.mjs` 从**托盘 logo**（`icons/tray-light.png`）派生
  7 档 ICO（256/128/64/48/32/24/16），挂在 `posticon` 钩子上。
- 素材同源已核验：`deepseek.ico` 与 `tray-light.png` 的 artwork **逐像素一致**
  （`compare -metric AE` = 0）。
- 生成结果与托盘 logo 的差异仅来自重采样抗锯齿（`compare` 602/4096 像素，边缘）。
- CI 无 ImageMagick 时安全跳过（仓库已提交生成结果），不会让打包失败。

## 4. 安装时默认不勾选桌面快捷方式（任务 3）

Tauri 的 NSIS 模板把「创建桌面快捷方式」做成完成页复选框，复用的是 MUI2 的
`MUI_FINISHPAGE_SHOWREADME`（**默认勾选**）。官方开关是
`MUI_FINISHPAGE_SHOWREADME_NOTCHECKED`。

**已核验插入顺序成立**（这是关键 —— `!define` 必须在插入完成页之前执行）：

```text
$ grep -n "installer_hooks\|MUI_PAGE_FINISH" installer.nsi
36:!include "{{installer_hooks}}"     ← 我们的 nsis-hooks.nsh 在这里被 include
418:!insertmacro MUI_PAGE_FINISH        ← 完成页在这里才插入
```

⇒ `!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED` 在 line 36 生效，line 418 的完成页
复选框因此**默认不勾选**。CI 的 NSIS 构建成功也证明 `installerHooks` 路径解析正确
（Tauri 对配置里的相对路径会 `set_current_dir` 到 `src-tauri/`）。

## 5. 仍未验证 / 只能人工确认

- **动画流畅度**（180ms 是否合适、有没有掉帧）：CI 只能断言终点位置正确，
  看不出流畅度 —— 需要人眼在 Windows 真机上看。
- **「应用 → 设置」这条原生菜单链路**：菜单是系统级弹出窗口，CI 无法可靠点击；
  改由「真解析 lib.rs 的契约对账」+「capability 覆盖 settings」两条断言覆盖。
- **安装器完成页复选框的实际显示状态**：已用「模板插入顺序」在静态层面证明，
  但没在真机跑一遍安装向导看那一页。

---

# v0.3.1 验证记录

CI run [`37056298132`](https://github.com/tianyimc/DSH-Tauri/actions/runs/37056298132)
在 `windows-latest` 上：**冒烟 38 通过 / 0 失败**；NSIS 构建成功；
新增的「统一 logo 接线」校验步骤通过；单测全绿（Rust 44、JS 76、静态校验 39）。

## 1. 统一 logo（任务 3）

| 检查 | 证据 |
| --- | --- |
| 素材同源 | `tray-light.png` 与 `deepseek.ico` 的 artwork `compare -metric AE` = **0**（逐像素一致） |
| 配色正确 | `tray-dark` 仅含 `(255,0)`/`(255,255)`（白+透明）；`tray-light` 主色 `(2,14,54,255)` = `#020E36` |
| icon.ico 合法 | ICO 头 `reserved=0 type=1 count=7`（256/128/64/48/32/24/16） |
| 安装包/卸载器图标 | `nsis.installerIcon` / `uninstallerIcon` 已显式设置（**此前从未设置** ⇒ 一直是 Tauri 默认图标） |
| CI 校验 | 新增步骤 `Verify unified logo is wired into the bundle` **PASS** |
| 运行时主题切换 | `apply_theme_icons()` 在启动、主窗口创建、`ThemeChanged` 三处调用 |

> **Windows 的固有限制**：资源管理器/桌面上的文件图标**不会**随系统主题换色
> （一个 `.ico` 只能存一份图像）。所以文件图标固定用深藏青版；
> **运行时**的窗口/任务栏/托盘图标才按主题自动切换。

## 2. 侧栏动画：白闪与卡顿（任务 4）

改动与**可验证的**证据：

| 改动 | 怎么证明的 |
| --- | --- |
| 子 webview 预绘制底色（深 `#1b1b1c` / 浅 `#f3f3f3`） | 与 `titlebar.css` 的 `--dsht-bg` 逐位一致；`ThemeChanged` 时刷新 |
| 中间帧不再投递 `set_size` | 单测 `animation_never_resizes_between_first_and_last_frame`：中间帧 `set_size` 次数 == **0** |
| 投递次数下降 | 单测 `per_frame_call_count_drops_versus_v0_3_0`：**26 → 15** 被锁死，防回退 |
| 几何独占（动画中 layout 不碰侧栏） | 消除「先摆到终点」的跳变；`anim::is_animating()` |
| 时间戳驱动抗抖动 | 单测 `timestamp_driven_does_not_drift_under_jitter_but_accumulating_does`：31ms 抖动下累加驱动被拉到 ≥2× 时长，时间戳驱动不受影响 |
| 末帧精确落点 | 单测 `final_frame_lands_exactly_on_target` |
| 代次 CAS 防竞态 | 单测 `stale_animation_cannot_release_newer_ownership` |
| 真机终点位置 | CI 冒烟 `[PASS] 动画结束后侧栏停在客户区右侧（overlay 目标位置）` |

### 已核实的**边界**（不粉饰）

`SetPosition` 与 `SetSize` 最终**都**走到 `webview.set_bounds()` →
`controller.SetBounds()`，而该 RECT 的 `left/top` **硬编码为 0**
（`wry-0.57.0/src/webview2/mod.rs:1532`），位置实际由 `SetWindowPos` 施加。

⇒ 本次优化省掉的是**每帧重复的那一次**尺寸投递，**并未**把网页重排从动画路径中
彻底移除。真正「零重排」需要绕过 Tauri 直接操作子 webview 的 HWND，
而公开 API 拿不到（`Window::hwnd()` 只给主窗口），本版不做。

### 仍未验证（只能人工）

- **动画观感**（是否「丝滑」）：Linux 上 wry 忽略子 webview 坐标，无法验证；
  CI 只能断言终点位置与不卡死，看不出流畅度。
- **白闪是否完全消除**：底色已按「与页面底色接近」取值（`#1b1b1c`），
  但 `chat.deepseek.com` 的真实背景色无法在本容器读取（访问超时）。
- **安装向导完成页复选框**：仍只做了静态层面的插入顺序证明。

---

# v0.3.2 验证记录

本版修四件事：**并排（docked）模式的过渡动画**、**版本规则改为 RC / Release 双通道**、
**开始菜单图标**、**任务栏图标**。

本轮**没有**可引用的 CI run —— 代码改动完成后尚未推送（见文末「待办」）。
下面区分三类证据：**本地已实测**、**静态/单测锁死**、**只能真机确认**。

## 1. 并排（docked）模式的过渡动画（任务 1）

### 根因

v0.3.1 的 docked 分支**刻意不做滑动**，直接切到位，理由是「逐帧缩放会让内容页每帧重排」
（`lib.rs` 旧注释原话）。用户实测「还是之前那个问题」。

真正的白闪来源是**顺序**而不是「有没有动画」：

1. 点关闭 → 先 `layout_main_webviews()` 把内容页宽度**立刻**还回去，
   紧接着 `chat.hide()`；
2. 中间没有任何过渡，`[target_x, width]` 那块区域在「内容页还没画好」时先露一帧
   —— 深色主题下就是白闪（该区域此刻没有页面覆盖）。

### 修法（两种模式共用一条滑动路径）

| 模式 | 滑动期间内容页 | 内容页何时收窄/还原 | 重排次数 |
| --- | --- | --- | --- |
| `overlay` | 整宽不变 | 不变（本来就整宽） | **0** |
| `docked`（打开） | **整宽不变** | 侧栏滑到位后（`slide_x_with` 的 `on_done`） | **1** |
| `docked`（关闭） | 立即还原 | 起动画后由 `layout` 还原 | **1** |

关键点：docked 的**那一次**必然重排被挪到「侧栏已经盖住右侧之后」，
所以**滑动过程本身零重排**（与 overlay 同质），空带不再露出。

### 证据

| 检查 | 证据 |
| --- | --- |
| 打开分支用 `slide_x_with` + `on_done` 收窄 | 静态校验 `docked 打开分支用 anim::slide_x_with（on_done 里才收窄内容页）` |
| `on_done` 里真的调 `layout_main_webviews` | 静态校验 `docked 打开分支的 on_done 回调里会调 layout_main_webviews` |
| **首次**创建侧栏也走同一路径 | 静态校验 `首次创建侧栏时 docked 同样走 on_done 收窄（第一次打开也不露空带）` |
| 两种模式几何前提一致 | 单测 `slide_endpoints_are_mode_independent` |
| docked 精确平铺、不重叠 | 单测 `docked_mode_shrinks_content_and_tiles_with_chat`（内容 780 + 侧栏 420 = 1200，窗口尺寸不变） |
| 真机几何（新增） | 冒烟 `docked：内容页让出侧栏宽度` / `docked：侧栏左边缘与内容页右边缘对齐` |

### ✅ 真机证据（CI `windows-latest`，run `37103819235`）

新增的两条 docked 断言在**真实 Windows** 上**已通过**（从 `ci-logs` 分支的
`smoke-windows.txt` 读出）：

```
[PASS] docked：内容页让出侧栏宽度（与侧栏并排、不重叠）
[PASS] docked：侧栏左边缘与内容页右边缘对齐（精确平铺）
[PASS] docked：打开侧栏后进程仍存活（未死锁）
```

这证明「docked 模式下侧栏滑到位后 `on_done` 里的 `layout_main_webviews`
确实把内容页收窄、并与侧栏精确平铺」在真机上成立 —— 这是本版并排模式改动的
**核心后果**，不是只靠单测推断的。

> 同一次 run 里第 7/8 节失败，但那是**冒烟脚本自身**的缺陷（新加的 docked 检查
> 杀掉了后续断言依赖的进程），不是产品缺陷 —— 已在下一个提交修复。
> 详见第 9 节。

> ⚠️ 上一版「overlay 分支先起动画再 layout」的不变量被保留；docked 与 overlay
> **唯一**差别变成「内容页什么时候收窄」，布局策略仍只由纯函数 `main_webview_rects` 决定。

## 2. 版本规则：取消 GenX，改为 RC / Release（任务 2）

| 项 | 值 |
| --- | --- |
| 格式 | `v.A.B.C`；RC 版附 ` RC`（`v.0.3.2 RC`），Release 无后缀（`v.0.3.2`） |
| 状态文件 | `version.json` = `{"channel":"release"}` |
| 本版 | `0.3.2` + `release` ⇒ 显示 **`v.0.3.2`**（用户明确要求不带 RC/Release 后缀） |
| 切渠道 | `node scripts/version.mjs --set-channel release\|rc`（`--bump-gen` **已移除**） |
| GitHub | RC ⇒ `prerelease: true`、tag `v.0.3.2-rc`；Release ⇒ `false`、tag `v.0.3.2` |

实测 `node scripts/version.mjs --json`（release 渠道）：

```json
{"version":"0.3.2","channel":"release","display":"v.0.3.2",
 "release_name":"DSHTauri v.0.3.2","asset_name":"DSHTauri-v.0.3.2-setup.exe",
 "tag":"v.0.3.2","title":"DSHTauri v.0.3.2","prerelease":false}
```

- 三处版本号一致（`tauri.conf.json` / `package.json` / `Cargo.toml`）由单测
  `app_version_matches_tauri_config` 锁死。
- 显示规则由单测 `display_version_marks_rc_only` 锁死，并**显式断言显示串里不得出现 `Gen`**
  —— 这条就是「GenX 已取消」的守卫。
- workflow 的 `release` 作业已从硬编码 `prerelease: false` 改为
  `prerelease: ${{ needs.build-windows.outputs.prerelease }}`。

## 3. 「关于 → 检查更新」双通道（任务 2）

- 一次点击查询 `GET /repos/tianyimc/DSH-Tauri/releases?per_page=30`（**不再用 `/releases/latest`**
  —— 它只会返回 Release 通道），按 `prerelease === true` 分成 RC / Release 两组，
  各组取最高版本，**并列显示**并标出「当前运行」。
- **跨通道下载**（Release 用户下 RC，或反之）先弹页内确认面板，确认后才跳转；同通道直接下载。
- 单测：`scripts/test-about.mjs` **32 项**，直接 import 真实的 `src/about.js`
  （纯逻辑经 `globalThis.__aboutInternals` 暴露），覆盖分组、取最高版本、
  `v.0.3.2` / `v.0.3.2 RC` / `v.0.3.2-rc` 三种写法、空列表、跨通道判定。

## 4. 开始菜单图标（任务 3）

### 根因（两层，缺一不可）

1. Tauri 的 NSIS 模板创建快捷方式时**不传 `IconFile`**：
   `CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"`
   ⇒ 图标继承 **exe 内嵌资源**，无法单独指定。
2. 模板的 `CreateOrUpdateStartMenuShortcut` 在 `$UpdateMode = 1` 时**直接 `Return`**
   ⇒ **覆盖安装永远不会修好已存在的旧快捷方式**。这正是「仓库里图标早就统一了、
   用户看到的却还是旧图」的原因。

### 修法

- 新增 `src-tauri/icons/startmenu.ico` = **白鲸鱼 + 细描边**（用户选定）。
  `.lnk` 的图标是静态的、**不跟随系统主题**，所以用深浅背景都可读的配色；
  每一档尺寸用**该尺寸自己的描边宽度**单独合成（不是先做 256 再缩，否则小尺寸描边被稀释）。
- 新增 `NSIS_HOOK_POSTINSTALL`（**不受 `$UpdateMode` 影响**）：重建快捷方式并显式指定
  `$INSTDIR\icons\startmenu.ico`，再调 `SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH)`
  刷新 shell 图标缓存。
- 路径按模板自己的 `!if "${STARTMENUFOLDER}" != ""` 两分支计算，避免将来启用分组后改错位置。
- `bundle.resources` 加入 `icons/startmenu.ico` ⇒ 落在 `$INSTDIR\icons\startmenu.ico`
  （`tauri-utils` 的 `resource_relpath` 保留相对路径）。

### 证据

| 检查 | 证据 |
| --- | --- |
| ICO 合法 | 7 帧 256/128/64/48/32/24/16，`reserved=0 type=1`，全部内嵌 PNG |
| 每帧都有描边 | 独立验证：边框暗像素占比 256px 45.8% / 128 44.4% / 64 46.7% / 48 48.3% / 32 43.5% / 24 50.0% / 16 63.6%，**无全白帧** |
| 双背景可读 | 本机渲染 256px 合成图（浅底 / 深底）肉眼确认 |
| 钩子确实在更新模式运行 | 从 CLI 二进制取出模板原文：钩子在 `Section Install` 末尾，**无 `$UpdateMode` 守卫** |
| `$R8`/`$R9` 安全 | 全模板 `$R9` 出现 **0** 次、`$R8` **0** 次（`$R0` 45 次） |
| CI 接线 | workflow 新增断言：`bundle.resources` 含 startmenu.ico、ICO 多档、钩子含 `POSTINSTALL`/`startmenu.ico`/`SHChangeNotify` |

## 5. 任务栏图标（任务 3）

### 根因（同样是两层）

1. **槽位错**：`Window::set_icon()` → `tao::set_window_icon()` **只设置 `ICON_SMALL`**；
   任务栏按钮渲染的是 **`ICON_BIG`**。tao 有 `set_taskbar_icon()`（用 `ICON_BIG`），
   但 **Tauri 从未暴露它**（`taskbar_icon` 在 tauri / tauri-runtime / tauri-runtime-wry
   里零命中），创建时也没有对应 builder 选项 ⇒ 任务栏一直用 exe 里的静态图标。
2. **主题源错**：任务栏跟的是**外壳**主题（注册表 `SystemUsesLightTheme`），
   而 tao 的 `Theme` 读的是**应用**主题（`AppsUseLightTheme`）。
   用户在「个性化 → 颜色」选「自定义」时两者不一致 ⇒ 深色任务栏上摆了深藏青图标。

### 修法

新增 `src-tauri/src/win_icon.rs`：

- `set_taskbar_icon()`：把内嵌 PNG 解成 BGRA + 1bpp 掩码，`CreateIcon` 造 `HICON`，
  再 `SendMessageW(WM_SETICON, ICON_BIG)` 塞进**大图标槽**。
- `taskbar_prefers_light()`：读 `HKCU\...\Themes\Personalize\SystemUsesLightTheme`
  决定托盘与任务栏的配色；读不到时退回 tao 给的主题。

| 检查 | 证据 |
| --- | --- |
| 只设 `ICON_SMALL` | `tao-0.37.1/.../windows/window.rs:850`（Small）vs `:862`（Big，`set_taskbar_icon`） |
| Tauri 不暴露 taskbar icon | `grep taskbar_icon` 在 tauri-2*/src 与 tauri-runtime*/src **零命中** |
| tao 读的是应用主题 | `tao-0.37.1/.../windows/dark_mode.rs:241` 读 `AppsUseLightTheme` |
| 静态守卫 | `win_icon` 模块挂载、`set_taskbar_icon` 调用点、调用点用 `ICON_BIG`（且断言**不是**字面量 0）、读 `SystemUsesLightTheme`、用 `CreateIcon` |

### 掩码实现的一处纠错（自我记录）

1bpp 掩码的行距按 DIB 规范是 **WORD（2 字节）对齐**：`((width + 15) / 16) * 2`。
初版误写成 DWORD 对齐（`div_ceil(32) * 4`），且注释自相矛盾地写着「2 字节」。
当前实际传入的是 **64×64**，该尺寸下 WORD 与 DWORD 恰好都等于 8 ⇒ **发布版行为正确**，
但 16/33/48 等宽度下会从第 2 行起整体错位。已按规范改正（这是独立验证发现的，非自查）。

## 6. 本轮发现的自身缺陷（独立验证的产出）

独立验证者（`verifier`）在两个版本里抓出并已修复：

| 缺陷 | 性质 | 修法 |
| --- | --- | --- |
| `anim.rs` 末帧 `on_done` 不受代次保护 | **真实竞态**：用户在「判定末帧 → 执行收尾」之间点开关，旧收尾（关闭分支是 `chat.hide()`）会把刚打开的侧栏藏掉 ⇒ `CHAT_VISIBLE=true` 但不可见 =「点了没反应」。且与循环顶部注释声明的意图不符 | 新增 `should_run_on_done()`，`on_done` 前复检代次 |
| `verify-titlebar.mjs` 恒真三元式 | **假绿**：`findCodeMatches(...).length > 0 ? animRaw : animRaw` 两分支相同 ⇒ 断言扫的是含注释原文，**在注释里写关键词就能骗过** | 改为真正按行剔注释得到 `animCode`；实测「只留注释、删光代码」现在报 6 项失败 |
| 纯函数单测覆盖不到调用点 | **测试盲区**：删掉循环里的守卫，`cargo test` 仍 48/48 全绿 | 补 2 条**静态**守卫（守卫正则 + `on_done` 必须在其之后） |
| HICON 泄漏量级注释不准 | 文档说 32×32/4KB，实际 64×64/约 16KB | 更正，并写明「若挂到高频路径必须改为销毁旧句柄」 |

> 这三条正是「独立验证」的价值所在：其中「恒真三元式」和「单测覆盖不到调用点」
> 都是**我自己写的守卫本身失效**，只跑自己写的测试永远发现不了。

## 7. 仍未验证（必须真机 / 只能人工）

- **动画观感**：180ms 是否真的顺滑、白闪是否完全消失 —— Linux 上 wry 忽略子 webview
  坐标（`webkitgtk/mod.rs:243` 用 `gtk::Box` + `pack_start`），**无法验证**。
  CI 只能断言终点几何与不卡死。
- **NSIS 安装器实际行为**：本机无 Windows/NSIS，未生成 `installer.nsi`、未安装。
  `.lnk` 是否真的显示新图标、`SHChangeNotify` 是否真的刷新缓存、
  **覆盖安装**（装 v0.3.1 → 覆盖装 v0.3.2）后旧图标是否被修好 —— 全部待真机。
- **`CreateIcon` 真实返回**：64×64 掩码是否被接受、任务栏是否真的变色。
  本机 `#[cfg(windows)]` 走不到，`cargo test` 覆盖不了。
- **`SystemUsesLightTheme` 在「自定义」模式下的实际表现**。
- **`cargo check --target x86_64-pc-windows-msvc` 只做类型检查**：本机无 `link.exe`，
  **无法链接、无法产出 exe**（`error: linker 'link.exe' not found`）。
- **`tauri-bundler` 未 vendored**：`resources_dirs` 的生成端源码读不到，
  `$INSTDIR\icons\startmenu.ico` 是从模板**消费端**反推的。

## 8. 本轮本地实测汇总

| 套件 | 结果 |
| --- | --- |
| `npm run test:js` | **109 通过 / 0 失败**（新增 `test-about.mjs` 33 项） |
| `npm run verify` | **64 通过 / 0 失败**（v0.3.1 为 39；新增 25 项） |
| `cargo test` | **48 通过 / 0 失败**（v0.3.1 为 44） |
| `cargo check --target x86_64-pc-windows-msvc` | 类型检查通过（**未链接**） |
| 新增静态守卫的变异测试 | 逐条故意改坏代码确认会失败；本轮因此发现并修掉 **4 处假绿 / 假阴性** |
| `scripts/smoke-windows.ps1` 语法 | pwsh 7.4.6 `ParseFile` **PARSE OK**（未运行） |
| Markdown 锚点 | README / CONTRIBUTER_README / CHANGELOG / docs 全部 **0 死链**（含修掉 1 处历史死链） |

## 9. 独立验证（第 2 轮）发现并已修复的问题

独立验证者对本轮的**修复本身**又做了一轮对抗性复验，抓出 4 个问题（全部已修）：

| 问题 | 性质 | 修法 |
| --- | --- | --- |
| `smoke-windows.ps1` 里「网页对话」按钮写了**两个不同坐标**（overlay 用 148、新增 docked 用 68） | **会让 CI 变红**：68 落在「操作」上，会弹出原生菜单 ⇒ 侧栏不开 ⇒ 新增的两条 docked 断言必然失败 | 抽出唯一常量 `$CHAT_BTN_X = 148`，两处共用 |
| docked 分支用 `TopLevelWindows \| Select-Object -First 1` 找主窗口 | **会让 CI 变红**：`.setup()` **无条件**创建选择窗口（不看 `configured`），第一个可见窗口是 560×460 的选择窗口；主窗口要点「本地」才建 | 改成与 A 段同构：`Wait-AppWindow $SELECTOR_TITLE` → 点「本地」→ `Wait-AppWindow $MAIN_TITLE` |
| 静态守卫的 `on_done` 正则**过严**：语义等价的 `if f(){}else{return}` 会被误报失败 | 假阴性噪音（不影响正确性，但会误导后来者） | 放宽为「`if` 条件里引用了 `should_run_on_done(my_generation)`」，同时保留顺序断言 —— 实测放宽后仍能抓住「删掉调用点」 |
| NSIS 钩子里直接用 `$AppStartMenuFolder` | **真实但当前不触发**：钩子跑在 `MUI_STARTMENU_WRITE_END` 之后，而**静默/被动安装**（`/S`、`/P`，正是 CI 与发布流程的方式）会 `Skip` 掉 `MUI_PAGE_STARTMENU` ⇒ 变量可能为空 ⇒ 算出错路径 | 改用模板自己的 `MUI_STARTMENU_GETFOLDER`（从注册表读回），与模板**同源** |

> 另外，**我自己**在做变异测试时又发现 2 处守卫假绿并修掉：
> `win_icon.rs` 的 `ICON_BIG` 断言只查字符串（`use` 语句里就有它，把调用点改成字面量 `0` 也能通过），
> 以及 NSIS 的 `STARTMENUFOLDER` 正则漏了 `}` 导致那条断言**从未执行**。
> 两次都是「守卫本身失效」—— 只跑自己写的测试永远发现不了，这是独立验证的核心价值。

---

# v0.3.3 验证记录

发布前收尾：修复「关于 / 设置」窗口图标不跟随主题、统一页内 logo、补齐许可证与官方免责声明。

## 1. 「关于 / 设置」窗口图标不跟随主题（任务 3）

### 根因（创建时机，不是「没做适配」）

`apply_theme_icons()` 只在**三个时刻**执行：`setup()` 末尾、主窗口创建后、
`WindowEvent::ThemeChanged`。而「关于」/「设置」窗口是用户在菜单里点击时
**按需创建**的（`show_about_window` / `show_settings_window`），远晚于这些时刻。

于是它们拿到的是 Tauri 的**默认窗口图标** —— bundle 里那个静态 `icon.ico`
（固定深藏青），之后**再没有任何机会被纠正**：`apply_theme_icons` 里那句
`for label in [...] { set_icon }` 只对**当时已存在**的窗口生效。

### 修法

1. 新增 `set_creation_icon()`：每个窗口 `.build()` 成功后立刻设一次图标。
   三个创建点全部接上（选择窗口 / 关于 / 设置）。
2. 新增 `creation_icon()`：**优先读注册表**（`AppsUseLightTheme`），
   读不到才退回 `current_theme()`。
   - 为什么必须这样：创建**第一个**窗口（选择窗口）时**一个窗口都还没有**，
     `Window::theme()` 无从询问 ⇒ 只能返回 `None` ⇒ 按「深色」给**白色**鲸鱼
     ⇒ 浅色系统的白色标题栏上几乎看不见。
3. 用 `set_icon(&self)` 而**不是** `builder.icon(self)`：后者**按值消耗** builder
   并返回 `Result`，一旦失败原 builder 已被移走、**无法回退**，窗口就建不出来。
   图标是锦上添花，不该有能力阻止窗口打开。

### 证据

| 检查 | 证据 |
| --- | --- |
| 三个创建点都设图标 | 单测 `creation_icon_is_wired_into_all_window_builders`（逐变量名断言） |
| 无窗口时也能拿到图标 | 单测 `creation_icon_is_available_without_any_window` |
| 静态守卫 | `verify-titlebar.mjs` 第 11 节：`set_creation_icon` 定义 + 三个调用点 + `creation_icon` 读注册表 |

## 2. 页内 logo 仍是 emoji（任务 4）

**现象**：`src/about.html` 用 `🐋`、`src/settings.html` 用 `⚙️` 作为 logo 占位，
与托盘 / 任务栏 / 标题栏的统一鲸鱼**不是同一只**。

**修法**：新增前端图片资源并按主题切换（与其余各处同一只鲸鱼）：

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `src/logo-on-light.png` | 深藏青 `#020E36` 鲸鱼，透明底 | 浅色背景显示 |
| `src/logo-on-dark.png` | 白色鲸鱼，透明底 | 深色背景显示 |

- 由 `convert ... PNG32:` 强制 RGBA 生成 —— 源 `tray-dark.png` 是 **ch=2**（灰度+alpha），
  不强制会保留灰度形式。
- 实测：两者均为 **64×64 / ch=4**，不透明像素数**完全相同**（1375），
  中心像素分别是 `(255,255,255,255)` 与 `(2,14,54,255)` ⇒ **同一只鲸鱼的两个配色**。
- CSS 用 `@media (prefers-color-scheme: dark)` 切换显隐（`about.css` / `settings.css` 都改）。

## 3. 页内外部链接会把「关于」窗口顶掉（自查发现的连带问题）

WebView2 里的本地页面，`<a target="_blank">` 在 Tauri 中**不保证**会开新窗口 ——
可能把「关于」窗口自己导航走，用户点一下链接界面就回不来了。

**修法**：`about.js` 统一拦截页内 `http`/`https` 外链，`preventDefault()` 后交给
Rust 的 `open_external`（与「检查更新」的下载按钮同一条路径，同样只允许 http/https）。

## 4. 许可证与作者信息（任务 2）

用户要求「必须永远保留原作者信息」，选用 **Apache-2.0**：

| 文件 | 作用 |
| --- | --- |
| [`LICENSE`](../LICENSE) | Apache-2.0 全文（202 行），含版权行 `Copyright 2026 tianyimc` |
| [`NOTICE`](../NOTICE) | 归属声明。**Apache-2.0 第 4(d) 条要求分发者必须保留它** —— 这正是「永远保留原作者信息」的强制机制 |

README §6.2 由「未附带许可证 / All rights reserved」整段重写为 Apache-2.0 的准确描述
（允许商用与修改，但必须保留版权与 NOTICE）。

> ⚠️ 诚实说明：LICENSE 全文本身是标准模板（不含具体作者名），
> **作者信息落在 `LICENSE` 末尾的 APPENDIX 版权行与 `NOTICE` 里**。
> Apache-2.0 的「保留归属」义务正是通过这两处生效。

## 5. README 第三方定位声明（任务 5）

- 顶部醒目 ⚠️ 声明 + 新增 §1.1「第三方客户端声明：与 DeepSeek 官方无关」：
  ① 非官方出品、未获背书授权；② 只把**你自己**跑起来的 DSH WebUI 装进窗口，
  **不包含、不捆绑、也不代替** DSH 本体；③ 官方仓库链接 + 「需自行获取并运行 DSH」。
- 新增 §1.2「相关链接」（本项目 / DSH 官方 / 作者主页），两个小节都挂进目录。
- **DSH 官方链接的来源**：本机 `@deepseek-ai/dsh` 包的 `package.json` 里
  `repository.url` = `git+https://github.com/deepseek-ai/deepseek-harness.git`
  （`directory: apps/cli`）⇒ 链接取自官方包元数据，不是推测。

## 6. 本轮本地实测汇总

| 套件 | 结果 |
| --- | --- |
| `npm run test:js` | **111 通过 / 0 失败**（新增外链拦截与作者链接断言） |
| `npm run verify` | **89 通过 / 0 失败**（v0.3.2 为 64；新增 25 项） |
| `cargo test` | **50 通过 / 0 失败**（v0.3.2 为 48） |
| `cargo check --target x86_64-pc-windows-msvc` | 类型检查通过（**未链接**，本机无 `link.exe`） |
| Markdown 锚点 | README / CONTRIBUTER_README / CHANGELOG / docs 全部 **0 死链** |
| 版本一致性 | `version.json`=`{"channel":"release"}`；三处版本号均为 `0.3.3`；显示 `v.0.3.3` |

### 变异测试（本轮发现并修掉的假绿）

新增断言逐条做了「故意改坏代码，确认会失败」的验证，过程中修掉 **2 处假绿**：

| 假绿 | 为什么原来抓不住 | 修法 |
| --- | --- | --- |
| `creation_icon_is_wired_into_all_window_builders` 只数总次数（`>= 3`） | 测试自身源码里含 `"set_creation_icon(&"` 字面量，删掉一个真实调用后计数仍是 4 ⇒ 依然通过 | 改为逐**变量名**断言 `set_creation_icon(&about);` 等，删任何一个都失败 |
| `about.js` 外链拦截的 `preventDefault` 断言全文件搜 | 文件里另有一处「通道卡片点击」的 `preventDefault`，删掉外链拦截里那处仍能匹配 | 先切出 `a[href]` 监听器作用域再断言 |

### 仍未验证（必须真机 / 只能人工）

- **图标与 logo 的真实显示效果**：本容器无 Windows/WebView2，无法渲染确认
  （图片格式与像素已实测，但「看起来对不对」需人眼）。
- **`prefers-color-scheme` 是否真的命中**：取决于 WebView2 / 系统主题设置，静态无法验证。
- **`set_creation_icon` 在真机上的效果**：`CreateIcon`/`set_icon` 的实际返回与渲染待 CI 冒烟 + 人工验收。
- **DPI 缩放下的清晰度**（125%/150%/200%）：未验证。
- **NSIS 安装器行为**：同前几版，需真机安装确认。

## 7. 独立验证（v0.3.3 复审）发现并已修复的问题

独立验证者对本轮改动做了对抗性复验，抓出 **4 个真实缺陷**（全部已修）：

| 问题 | 性质 | 修法 |
| --- | --- | --- |
| `about.js` 外链拦截**旁路跨通道确认** | **真实功能缺陷**：下载链接本身就是 `<a href>`，于是同时命中两个 click 监听器。外链拦截无条件打开链接 ⇒ 同通道**重复打开**、跨通道**用户还没点「继续下载」就已经开始下载**（破坏了「跨渠道下载需确认」这条需求） | 拦截器开头加 `if (event.defaultPrevented) return;`（`channelsBox` 的处理器已先调 `preventDefault`） |
| `NOTICE` 只引 §4(d)，漏了 §4(c) | **法律表述不全**：§4(a) 实际只要求「附带许可证副本」，把「保留版权声明」归给 §4(a) 不准确；§4(c) 才是保留归属声明的直接依据 | NOTICE 与 README §6.2 都改为同时引 §4(c)/§4(d)，并注明三条边界（§4(c) 限源码形式、§4(d) 不得改许可证部分、§6 不授予商标权） |
| `lib.rs` 的 `current_theme` 注释与事实相反 | **文档缺陷**：注释称「`setup` 跑之前选择窗口就已创建」，实际是在 `setup()` **内部**创建 —— 与本轮 `creation_icon` 的文档直接矛盾 | 改写为准确描述，并指向 `creation_icon` |
| 静态校验 5 处**假绿** | 见下表 | 见下表 |

### 5 处假绿的根因与修法（全部经变异测试确认已修好）

| 假绿 | 为什么原来抓不住 | 修法 |
| --- | --- | --- |
| M4：`creation_icon` 整体改名仍通过 | `/fn\s+set_creation_icon/` —— `set_creation_icon` **包含** `creation_icon` 子串 | 加词边界 `\b`，并单独断言 `creation_icon` 存在 |
| M5：删掉 `creation_icon` 里的注册表分支仍通过 | 用固定长度 `[\s\S]{0,600}` 窗口，**越过函数边界**落进测试函数（测试自身源码里就有 `apps_prefers_light()`） | 新增 `extractRustFnBody()` 按大括号配对切出函数体再断言 |
| M7：把注册表值名换成另一个仍通过 | 扫**含注释**原文；且该值名在代码里是 **UTF-16 字符数组**（`RegGetValueW` 要 `PCWSTR`），字符串只在注释里 | 新增 `decodeRustU16CharArrays()` 解码后断言**代码实际使用的**值名 |
| M11 / M11b：删掉整个 logo `@media` 块仍通过 | 三个 token 分别残留在注释与基础规则里 | 新增 `extractCssAtMediaDarkBlocks()`，切出深色块后断言块内真的做了显隐切换 |

> ⚠️ **M11 是最严重的一处**：删掉 `@media` 块后，`.logo-on-dark { display: none }`
> 在两种主题下都生效、`.logo-on-light` 无规则恒可见 ⇒ **深色系统上显示深色鲸鱼、
> 落在深色背景上看不见** —— 正是本轮要修的缺陷**静默复发**，而当时 89 条检查全绿。
>
> 这四处假绿的共同教训：**断言不能只 grep 关键词**。
> 必须（a）用去注释后的代码、（b）把范围限定在目标函数/块内、
> （c）对「代码里实际使用的值」而非「注释里提到的名字」下断言。

### 本轮本地实测汇总（复审后）

| 套件 | 结果 |
| --- | --- |
| `npm run test:js` | **112 通过 / 0 失败** |
| `npm run verify` | **97 通过 / 0 失败**（修复假绿后由 89 增至 97） |
| `cargo test` | **50 通过 / 0 失败** |
| `cargo check --target x86_64-pc-windows-msvc` | 类型检查通过（**未链接**） |
| Markdown 锚点 | 全部 **0 死链** |

# v0.3.4 验证记录

内存优化：让不可见 webview 进入「挂起」，让「关于 / 设置」关闭即销毁，
并新增**可复现的内存测量**。

## 1. 做了什么

| 阶段 | 改动 | 状态 |
| --- | --- | --- |
| 0 | 冒烟脚本新增内存采样（6 个阶段 + 汇总表 + 系统可用内存） | 完成 |
| 1 | 关闭「网页对话」侧栏时挂起 `chat`（`TrySuspend`） | 完成 |
| 2 | 「关于 / 设置」关闭即**销毁**（此前只隐藏） | 完成 |
| 3 | 收进托盘时挂起内容页与侧栏 | 完成 |
| 4 | 连接成功后**销毁选择窗口**（有主窗口才销毁；无主窗口只隐藏） | 完成 |

## 2. ❗ 核心实测结论（诚实说明）

**`TrySuspend` 确实调用成功，但任务管理器口径的内存没有下降。**

CI run `37115724192`（windows-latest）的原始数字：

| 采样点 | 工作集 MB | 私有 MB | WV2 进程 | 系统可用 MB |
| --- | --- | --- | --- | --- |
| 1-选择窗口 | 320.2 | 105.6 | 6 | 12981.6 |
| 2-连接后（未开侧栏） | 465.4 | 170.8 | 8 | 13099.8 |
| 3-侧栏已打开 | 667.8 | 281.4 | 10 | 12965.1 |
| 4-侧栏已关闭 | 669.3 | 280.2 | 10 | 12955.5 |
| 5-已收进托盘 | 666.0 | 280.2 | 10 | 12957.3 |
| 6-从托盘恢复 | 528.6 | 260.9 | 10 | 12979.9 |

同一运行里 `app.log.err` 有 **4 行** `[DSHTauri] 已挂起 webview（TrySuspend 成功）`
⇒ 挂起 API 层面**确实成功**。但：

- `4 - 3`（关侧栏）：工作集 `+1.5`、私有 `-1.2` —— **没有下降**
- `5 - 3`（收托盘）：工作集 `-1.8`、私有 `-1.2` —— **没有下降**

原因与微软文档一致：`TrySuspend` 的语义是

> *"Suspending ... **allows the operating system to reuse** the memory that was
> used by the renderer process"*

即把内存标记为**可回收**，而**不是立刻释放**。测试机系统可用内存约 **13GB**，
内核没有任何回收压力，所以工作集不动。

### 交叉验证：测量方法本身能测出「真实释放」

一个合理的质疑是：会不会是**测量口径太粗**、测不出下降？
答案是否定的 —— 同一次运行里有一个**真实释放**的对照：

| 采样点 | 私有 MB | 变化 |
| --- | --- | --- |
| 5-已收进托盘（挂起） | 281.6 | — |
| 6-从托盘恢复（**导航到新地址**） | 257.2 | **-24.4** |

第 6 步会把内容页 `navigate` 到另一个地址，这**销毁了旧 document** ⇒
私有内存立刻降了 24.4MB。**同一套测量能测出这次真实释放**，
所以第 4/5 步的「纹丝不动」是真实结论，不是测量粗糙。

另一条佐证：WebView2 进程数全程 `6 → 8 → 10 → 10 → 10 → 10`，
挂起**不会**销毁 renderer 进程，与「内存只是被标记为可回收」的解释一致。

### 因此本版对「任务管理器数字」几乎没有改善

实际收益是：

1. **不可见页面不再消耗 CPU** —— 挂起会暂停脚本定时器、动画、轮询；
2. **内存变成可回收** —— 在内存紧张的机器上可被系统回收以缓解压力；
3. **「关于 / 设置」关闭后 renderer 真正释放**（这部分是实打实的下降，
   但 CI 里不打开这两个窗口，所以未在采样表中体现）。

### 下一步要真正降常驻内存，只能「销毁」

挂起达不到用户的期望值。真正有效的手段是**销毁 webview**：

| 对象 | 可省 | 代价 | 现状 |
| --- | --- | --- | --- |
| `selector`（选择窗口） | 一个**本地小页面** renderer 的量级（数十 MB；现有采样无法单独分离出它） | 每次「重新选择连接方式」重建（本地小页面，很快） | ✅ **已做（阶段 4）** |
| `chat`（侧栏） | 一个**重型远程页面**的量级（实测增量约 100MB 私有） | 每次开侧栏重新加载 chat.deepseek.com（明显变慢、可能丢未发送草稿） | 用户此前选择「只挂起、永不销毁」 |

> ⚠️ **上表的数字口径修正过一次**：最初我把「只有选择窗口时整个应用的私有内存（109MB）」
> 误当成「选择窗口那一个 renderer 的占用」。那是**整个应用**的量（含主程序 +
> WebView2 browser/GPU/utility + 该页 renderer，共 6 个 WV2 进程），不是单个窗口的。
> 现有采样只能给出**增量**：
> - 加两个**轻量**页面（顶栏 + 测试内容页）：私有 +63MB、WV2 进程 +2
> - 再加一个**重型**页面（chat）：私有 +109MB、WV2 进程 +2
> 所以「重型远程页面 ≈ 100MB 增量」有数据支撑；
> 「选择窗口单独占多少」**无法从现有采样分离**，只能说是轻量页面的量级（数十 MB）。
| `content`（内容页） | 不能销毁 | 它是主视图 | — |

> ⚠️ 用户此前选择「侧栏只挂起、永不销毁」，那个决定建立在「挂起能省内存」的
> 假设上。该假设已被本次实测**证伪**，因此该选择需要重新评估。

## 2.5 阶段 4：连接后销毁选择窗口

选择窗口是一次性的「选连接方式」界面，主窗口起来后就没用了。
连接成功后销毁它，释放它的 renderer；用户仍可从托盘「重新选择连接方式」重建。

### 三个必须处理的点（都不是想当然，都有具体依据）

1. **销毁必须延后到 IPC 回调之外。**
   这条链路（`open_main_window`）正是**选择窗口自己发起**的 IPC。
   CHANGELOG v0.1.x 记录过一个真实 bug：在「正在执行该 IPC 的 webview 的回调里」
   销毁它自己，会让 Windows 消息处理进入坏状态（后续 `hide()` 被丢弃 ⇒ 点 × 没反应）。
   当年正因此把 `destroy()` 改成了 `hide()`。
   ⇒ 现在用 `spawn_blocking` 延后 250ms 再销毁，等本次 IPC 返回、消息循环回到正常状态。

2. **没有主窗口时绝不能销毁。**
   此时选择窗口是**唯一**的窗口；销毁最后一个窗口会让 tao 触发 `ExitRequested`
   ⇒ 整个程序退出（托盘也一起消失）。而用户点「×」通常只是想把它收起来。
   ⇒ `close_disposition(label, has_main_window)` 做成**纯函数**并单测两条分支。

3. **重建路径变成常规路径，必须带重试。**
   `destroy()` 走 `send_event`（异步），底层 WebView2 释放可能滞后，
   同 label 的 `build()` 会失败（代码原有注释记着这个坑）。
   ⇒ `reveal_selector` 的重建分支加一次重试（间隔 150ms）。

### 顺带核实并**修正**的一个错误判断

我一度在注释里写「重建在主线程上会死锁」，因为 `create_window` 内部是
`send_user_message` + `rx.recv()`，而 `send_user_message` 在主线程上会**内联执行**。
**核实后并非如此**：`handle_user_message` 的 `Message::CreateWindow` 分支会**同步**
执行创建并 `sender.send(...)`，所以主线程内联执行时 `recv()` 立刻就能拿到结果，
**不会死锁**。注释已按事实改写，没有把错误结论留在代码里。

### 覆盖方式（诚实说明）

CI 冒烟**不能**点托盘的原生菜单（系统级弹出窗口，坐标点不中），
所以「重建」这条链路不由冒烟覆盖，改由：

- `cargo test`：`close_disposition` 的两条分支语义
  （有主窗口 → Destroy；无主窗口 → Hide）；
- `npm run verify`：断言 `reveal_selector` 真的有重建分支与重试；
- 冒烟改为断言**本版最大的回归风险**：选择窗口销毁后，
  主窗口仍存在、不卡死、仍可见，内容页心跳仍在累积
  （正是历史坏状态的检测点）。

## 3. 修复过的一个**推理错误**（值得记录）

阶段 3 我最初用「收托盘后页面心跳停止」作为「我们的挂起生效」的证据。
首次 CI 后意识到这个推理**不成立**：

> Chromium 自己就会对**隐藏 / 被遮挡**的页面节流定时器。所以「心跳停了」
> 既可能是我们挂起成功，也可能是「我们什么都没做、Chromium 自己停了」——
> 两者在行为上无法区分。

改为在 `TrySuspend` 回调里**显式打日志**，冒烟断言该日志。
这正是后来能确认「挂起成功但不降内存」的关键。

## 4. 静态守卫与变异测试

`npm run verify` 新增 section 12（共 12 条 v0.3.4 守卫），每条都做了变异测试：

| 变异 | 是否被抓 |
| --- | --- |
| 把 `suspend` 挪到 `hide()` 之前 | ✅ |
| 删掉 `suspend` 调用 | ✅ |
| 删掉 cookie 保活的挂起跳过判断 | ✅ |
| 把 `TrySuspend` 改成注释 | ✅ |
| 把 `resume` 挪到 `show()` 之后 | ✅ |
| `about/settings` 归为 `Hide` | ✅ |
| `selector` 改成 `Destroy` | ✅ |
| `destroy()` 改回 `hide()` | ✅ |
| 删掉重建重试 | ✅ |
| 去掉托盘挂起 | ✅ |
| 调换 `SetIsVisible` / `TrySuspend` 顺序 | ✅ |
| 去掉切地址路径的恢复 | ✅ |
| `selector` 无条件销毁（会让程序在唯一窗口时退出） | ✅（verify + cargo test 双双抓住） |
| `selector` 退回永远隐藏（不省内存） | ✅ |

另有一条守卫是**被真实 CI 失败逼出来的**：`"{1,>10}" -f ...` 这种 .NET 非法对齐
会让整个冒烟脚本运行时崩掉（`pwsh ParseFile` **语法检查抓不住**），
已用正则静态拦下。

## 5. 本地验证

| 套件 | 结果 |
| --- | --- |
| `npm run test:js` | 112 通过 / 0 失败 |
| `npm run verify` | 142 通过 / 0 失败 |
| `cargo test` | 62 通过 / 0 失败 |
| `cargo check --target x86_64-pc-windows-msvc` | 通过（**未链接**） |
| CI 冒烟（windows-latest） | 45 通过 / 0 失败 |

## 6. 无法验证的

- **真机观感**：侧栏重开是否有一瞬卡顿、草稿是否原样（CI 的测试页是极简页面）。
- **内存紧张时的实际收益**：本次实测环境有 13GB 空闲，无法制造压力验证
  「可回收内存真的会被回收」。需要用户在有内存压力的场景下观察。
- **`about` / `settings` 销毁后的重建时序**：CI 不打开这两个窗口（原生菜单点不到），
  只在 `cargo test` 层面覆盖了「关闭策略」分类。
- 安装包行为、真机图标表现（与 v0.3.3 相同）。
