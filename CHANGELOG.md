# 更新日志

版本号规则见 [README §0.5](README.md#05-版本规则vabc-genx)：**`v.A.B.C GenX`**。

- `A` 文集网页核心版本 · `B` 重要功能版本 · `C` 普通更新 · `GenX` 同一个 `C` 内的补丁快照
- **`C` 提升时 `Gen` 立即重置为 1**；`Gen1` 不显示后缀
- 只记录**面向用户的变化**；纯内部调整放到「内部」小节
- 每次改版本号时，在下面**顶部**加一条新记录

发版三步：`node scripts/version.mjs --set X.Y.Z`（或 `--bump-gen`）→ 在本文件顶部加记录 → 提交推送。

---

## v0.2.0 Gen2

修掉 v0.2.0 实机反馈的两个问题：**点「网页对话」程序卡死**、**顶栏位置/高度错乱**；
并把顶栏样式对齐官方 DeepSeek Harness 桌面端。

### 修复

- **点「网页对话」后整个程序卡死**（不报「未响应」，但无法关窗、无法拖动、
  托盘也退不掉，只能任务管理器强杀）
  - 根因：`chrome_action` 是**同步命令**，跑在主线程上；它调到的
    `toggle_chat_window` 又在主线程里**同步** `WebviewWindowBuilder::build()`
    去建新的 WebView2。Tauri 官方文档对这个坑写得很明确：
    「On Windows, this function deadlocks when used in a synchronous command **or event handlers**」
    —— 嵌套在另一个 WebView2 的 IPC 回调里建 webview 会永远初始化不完。
    这正是「不报未响应、但点 × 没反应、只能强杀」的成因。
  - 现在：所有会创建 webview 的命令一律 `async`（`chrome_action` 等），
    并且**创建子 webview 只在异步路径上做**。
  - 「关于」窗口走的是同一条分发链（`show_about_window`），**同样会卡**，一并修掉。

- **顶栏位置与高度错乱**（仅在登录后 / 拖动窗口后尤其明显）
  - 根因：`CHROME_HEIGHT` 被 DPI **缩放两次**。Tauri 的 `inner_size(f64)` / `set_size`
    收的是**逻辑**像素，框架内部会自己乘 `scale_factor`；而旧代码先手算了
    `CHROME_HEIGHT * scale` 再当逻辑值传进去 ⇒ 实际物理高度 = `40 × 2 × 2`。
    实测截图里顶栏是 **158 device px**（≈40×2×2），而正确值应是 **78**（≈40×2）。
    另外位置用了 `outer_position()` 的**物理**坐标却按**逻辑**坐标解释，又放大一次。
  - 现在：顶栏不再是独立窗口，改为**主窗口内的一个子 webview**，
    位置用**客户区逻辑坐标**（`LogicalPosition(0, 0)` + `LogicalSize(宽, 40)`），
    **全文件不再有任何手算 `* scale`**；窗口缩放时在 `Resized` 里重排（只做非阻塞的
    `set_position`/`set_size`）。子 webview 用客户区坐标 ⇒ **窗口整体移动不影响它**，
    从根上消除了「拖动后错位」。

### 变更

- **顶栏样式对齐官方桌面端**：底色 `#1b1b1c`、文字色 `#aaadb0`、高 40px、
  **去掉**原来的分隔线；窗口按钮透明无边框，关闭按钮 hover 用 Windows 标准红 `#c42b1c`。
  保留「应用 / 操作 / 网页对话」与最小化 / 最大化 / 关闭、空白处拖动、双击最大化。
  **不包含**官方最左边那个侧边栏展开按钮（按需求刻意去掉）。
- **主窗口改为「纯容器窗口 + 子 webview」**：`titlebar` 加载本地 `titlebar.html`
  （因此命中 capability，**有 IPC**），`content` 加载用户配置的远程 DSH 页面
  （按设计**不授予**任何 capability）。右侧「网页对话」也改成主窗口内的子 webview。
- 顶栏页面从 `src/chrome.*` 迁移到 `src/titlebar.html` + `src/titlebar/`；
  `chrome` 独立窗口与 `CHROME_LABEL` 已彻底删除。
- Windows 冒烟测试新增两段：**顶栏子 webview 几何**（顶部、高≈40×scale，
  可直接抓出 DPI 双重缩放复发）与**点「网页对话」不得卡死**（`IsHungAppWindow` + 反复切换）。

### 说明

- 主窗口子 webview 依赖 Tauri 的 multiwebview API（`Window::add_child`），
  需要 `tauri` 的 **`unstable`** feature。它已是 Tauri 2 稳定版里的既有能力，
  但官方仍标注为 unstable，升级 Tauri 时需复查。
- **已知平台差异**：该 API 在 Linux（WebKitGTK）上把子 webview 塞进一个竖向
  `GtkBox`，**会忽略我们指定的坐标与尺寸**，因此 Linux 下顶栏不会正确地贴在顶部 40px。
  目标平台 Windows（WebView2）走的是真正的子 HWND，坐标按传入值生效。
  Linux 仅用于开发机自测，不影响发布产物。

---

## v0.2.0

自定义标题栏 + 右侧对话侧栏；彻底解决「每次启动都要重新登录」。

### 新增

- **自定义标题栏**：主窗口不再显示系统标题栏，顶部改为 40px 的自绘菜单栏
  - **应用**：关于 / 检查更新 / 重新连接（与托盘「重新选择连接方式」相同）
  - **操作**：刷新 / 撤销 / 重做（撤销重做发送真实的 Ctrl+Z / Ctrl+Y）
  - **网页对话**：点击后在**右侧打开应用级侧栏**，加载 <https://chat.deepseek.com/>
  - 右侧还有最小化 / 最大化 / 关闭按钮；标题栏空白处可拖动窗口，双击最大化
  - 下拉菜单用**系统原生菜单**（标题栏只有 40px，HTML 下拉会被窗口裁掉）
  - 「关闭」= 隐藏到托盘，与系统标题栏行为一致
  - 万一标题栏窗口建不出来，会自动退回系统标题栏，不会留下一个无法操作的无边框窗口
- **「关于」窗口**：显示版本号，并可在窗口内检查更新（直接查 GitHub Releases）

### 修复

- **每次启动都要重新登录（Cloudflare Access 等）**
  - 原因有两层，实测确认：
    1. 之前没有显式指定 WebView2 用户数据目录（`data_directory` 为 `None`，wry 会把空字符串
       传给 `CreateCoreWebView2EnvironmentWithOptions`），数据目录落到默认位置，且不保证
       各窗口共用同一份 profile。→ 现在统一固定到 `%LOCALAPPDATA%\<identifier>\webview2`。
    2. 更关键的是：**Chromium 默认不持久化「会话 cookie」**（没有 `Expires` 的那种），
       而 Cloudflare Access 的 `CF_Authorization` 正是会话 cookie —— 进程一退就没了。
       → 现在有一个 cookie keeper，定期把会话 cookie 的 `Expires` 设成正数并写回，
       让它变成持久 cookie（保留 30 天）。
  - 验证：Windows 冒烟测试新增一段，页面先上报已有 cookie 再写入，重启后断言
    **持久 cookie 与会话 cookie 都还在**。

### 说明

- 会话 cookie 转持久意味着**关闭程序后登录态仍然保留**（这正是本应用想要的）；
  如果要「关掉就退出登录」，目前需要手动清理 `%LOCALAPPDATA%\com.dsh.dshtauri\webview2`。
- 撤销 / 重做目前只在 Windows 上实现（用 Win32 `SendInput`）。

---

## v0.1.2

修掉 v0.1.1 实机测试发现的两个问题。

### 修复

- **已连接后，从托盘「重新选择连接方式」回来点按钮没有任何反应**
  （只看到按钮变成加载指针，主窗口也不切换）
  - 原因有两层，**两层都得修**：
    1. **前端**：`connect()` 只在 `catch` 里复位 `busy`，第一次连接成功后 `busy` 一直是 `true`。
       选择窗口再被托盘叫出来时两个卡片全是 `disabled`（CSS 还给它们 `cursor: progress`，
       就是那个转圈指针），而 `pick()` 开头是 `if (busy) return` —— 所以点了完全没反馈。
       修复：成功路径也复位 `busy`；窗口重新获得焦点时兜底复位；`busy` 时给出状态提示而不是静默返回。
    2. **后端**：`open_main_window` 在「已有主窗口」时走 `destroy()` + 用同一个 label 重建。
       WebView2 的销毁是异步的，旧窗口还没从 Tauri 的注册表里摘掉就去建同名窗口，很容易卡住或失败。
       修复：已有主窗口时**直接 `navigate()` 过去**并 `show()` / `set_focus()`，不再销毁重建。
  - 验证：Windows 冒烟测试新增「切换连接」一段 —— 重新显示选择窗口 → 点「远程」→
    断言主窗口仍然存在（复用而非重建）、未卡死、新地址收到 WebView2 的请求。

- **勾选「自动启动本地服务」后，本地服务不会随主程序退出，一直在后台吃资源**
  - 原因：`Command::spawn()` 出来的是**分离进程**，主程序退出后它照跑不误。
  - 修复：Windows 上用**作业对象（Job Object）** + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
    作业句柄由本进程持有且永不关闭，进程一退出句柄就被系统关闭，作业内所有进程
    （含子进程自己再拉起的孙进程）会被一起终止。正常退出、`app.exit()`、任务管理器强杀都生效。
    未能加入作业对象时会在日志里给出警告。
  - 验证：Windows 冒烟测试新增「进程生命周期」一段 —— 自动启动一个假服务 →
    断言端口在监听 → 强杀主程序 → 断言端口已关闭。

### 说明

- 作业对象是 Windows 机制；Linux 开发机上的 `sh` 分支**没有**这个保证（目标平台是 Windows）。
- 如果你反而希望本地服务在关掉 GUI 后继续跑，就别勾「自动启动本地服务」，
  改用计划任务 / NSSM 之类的外部守护（见 [README §6](README.md#6-src-taurisrclibrs--mainrs)）。

---

## v0.1.1

首个版本。把 DSH 终端的 WebUI 封装成 Windows 原生桌面应用。

### 新增

- **启动选择界面**「选择 DSH 连接方式」，两个入口：本地 / 远程
  - 两个地址**允许只配一个**，另一个留空即可；两个都留空不允许
  - 首次使用时点击任一侧会引导填写地址，保存进 `config.json`，之后每次启动点一下即可连接
  - 未配置的那一侧卡片会弱化显示「未配置」，点击可跳到设置去补
- **主窗口**：加载所选 URL，标题 `DSHTauri`，默认 1200×800，可缩放 / 最大化 / 最小化
- **系统托盘**（Tauri 2 官方 `tauri::tray` API）
  - 菜单：显示主窗口 / 退出
  - 点击窗口关闭按钮 = **隐藏到托盘**，不退出程序；托盘「退出」才真正结束
  - 左键单击托盘图标直接唤出窗口
- **可选自动启动本地 DSH 服务**：勾选后填写命令（示例 `dsh web`），
  应用会用 PowerShell 后台执行（`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden`），
  再由前端轮询端口，就绪后才加载页面
- **图标**
  - 安装包 / exe / 应用图标：官方白底 `deepseek_harness.ico`（7 档 16/24/32/48/64/128/256）
  - 托盘图标**随系统主题自动切换**：深色任务栏用反白版（原深色 → 白色，透明底不变），浅色用原版
- **打包与发布**：NSIS 安装包（`currentUser`，不需要管理员），GitHub Actions 在 `windows-latest`
  原生编译并上传 artifact；可选手动触发创建 GitHub Release
- **版本号体系** `v.A.B.C GenX` + [`scripts/version.mjs`](scripts/version.mjs) 工具，
  发布包名 / tag 由 CI 自动推导，同一 `C` 的多代包不会互相覆盖

### 修复

- **主窗口白屏，且点右上角 × 无反应，只能任务管理器强杀**（Windows 上必现，Linux 正常）
  - **症状**（由 `windows-latest` 上的 GUI 冒烟测试复现）：
    WebView2 从未发起任何网络请求（白屏），且收到 `WM_CLOSE` 后窗口仍然 `IsWindowVisible=True`（× 点不动）。
  - **根因**：`open_main_window` 是**同步命令**，而 Tauri 的同步命令跑在主线程（事件循环）上；
    这条命令又正是选择窗口通过 IPC 调进来的 —— 主线程此刻处在 **WebView2 的 IPC 回调里**。
    在这个位置同步创建「窗口 + WebView2」会同时踩两个坑：
    1. 新 WebView2 控制器的创建是异步的，嵌套在另一个 WebView2 的回调里**永远初始化不完** ——
       窗口出来了，但页面从不导航 ⇒ **白屏**；
    2. 紧接着销毁「正在执行这条 IPC 的那个 webview」会让消息处理进入坏状态 ——
       后续 `hide()` 被丢弃 ⇒ **点 × 没反应**。
  - **修复**：把 `open_main_window` / `probe_url` 改成 `async fn`。异步命令由 Tauri 丢到
    异步运行时的**独立线程**执行，创建窗口时走 `proxy.send_event` 交给此时空闲的主线程处理，
    不再嵌套在 IPC 回调里。选择窗口也从 `destroy()` 改为 `hide()`，避免销毁正在执行 IPC 的 webview。
  - **验证**：同一套冒烟测试在修复前 `12 通过 / 2 失败`，修复后 **`14 通过 / 0 失败`**。

### 新增（补充）

- 托盘菜单新增「**重新选择连接方式**」：把隐藏的选择窗口重新叫出来（选择窗口不再被销毁）

### 内部

- 配置校验抽成 [`src/config-rules.js`](src/config-rules.js) 纯函数，浏览器与 Node 共用（前端因此使用 ES module）
- 测试覆盖
  - 17 条 JS 单测（[`scripts/test-rules.mjs`](scripts/test-rules.mjs)）：地址校验的合法/非法组合、示例值、默认值、camelCase 契约
  - 9 条 Rust 单测：托盘 PNG 解码、反色 alpha 一致性、配置序列化、版本号与 `tauri.conf.json` 一致
  - Linux 无头冒烟 21 项（[`scripts/smoke-linux.sh`](scripts/smoke-linux.sh)）
  - **Windows 真实 GUI 冒烟**（[`scripts/smoke-windows.ps1`](scripts/smoke-windows.ps1)）：在 `windows-latest` 上真正启动 exe，
    检查窗口尺寸、**界面是否卡死**（`IsHungAppWindow` / `SendMessageTimeout`）、
    WebView2 是否真的发起了请求、关闭后是否隐藏到托盘
- 环境自检 [`scripts/check-env.mjs`](scripts/check-env.mjs) 与工具链接入 [`scripts/env.sh`](scripts/env.sh)

---

## 版本号变更说明

本项目的版本号曾短暂写作 `1.1.1`，随后按「文集网页核心尚未定版 → `A = 0`」重新编号为 **`0.1.1`**。
`1.1.x` 从未发布过安装包，因此不单独保留记录。
