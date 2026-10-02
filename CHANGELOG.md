# 更新日志

版本号规则见 [README §0.5](README.md#05-版本规则vabc-genx)：**`v.A.B.C GenX`**。

- `A` 文集网页核心版本 · `B` 重要功能版本 · `C` 普通更新 · `GenX` 同一个 `C` 内的补丁快照
- **`C` 提升时 `Gen` 立即重置为 1**；`Gen1` 不显示后缀
- 只记录**面向用户的变化**；纯内部调整放到「内部」小节
- 每次改版本号时，在下面**顶部**加一条新记录

发版三步：`node scripts/version.mjs --set X.Y.Z`（或 `--bump-gen`）→ 在本文件顶部加记录 → 提交推送。

---

## v0.3.1

统一程序 logo；修复侧栏过渡动画的白色闪烁与卡顿；文档重构。

### 变更

- **统一程序 logo 为托盘那只小鲸鱼**，并跟随系统深浅色**自动换色**
  - 深色主题/深色任务栏 → **白色**小鲸鱼；浅色主题/浅色任务栏 → **深藏青**（`#020E36`）小鲸鱼。
  - 覆盖：主程序 exe、**安装包**、**卸载程序**、系统托盘、主窗口/任务栏/标题栏，
    以及选择窗口 / 关于窗口 / 设置窗口。
  - 之前安装包与卸载器用的是 **Tauri 默认图标**（`nsis.installerIcon` / `uninstallerIcon`
    从未设置），现已显式指向统一 logo。
  - 仓库里原先同时存在「鲸鱼+白色圆角方块」与「透明鲸鱼」两种风格，现已全部统一。
  - 生成逻辑见 `scripts/make-logo.mjs`（挂在 `npm run icon` 的钩子上，避免被覆盖）。
  - **说明**：Windows 资源管理器/桌面上的文件图标**不会**随系统主题换色
    （一个 `.ico` 只能存一份图像），所以文件图标固定用深藏青版；
    **运行时**的窗口/任务栏/托盘图标才按主题自动切换。

### 修复

- **侧栏过渡动画：深色模式下的白色闪烁**
  - 根因：子 webview 在页面首次绘制之前会先显示 WebView2 的**默认白底**，
    深色界面里滑动时就露出白块。现在给所有子 webview 设了与页面底色一致的
    **预绘制底色**（深色 `#1b1b1c` / 浅色 `#f3f3f3`），并在系统主题切换时刷新。
- **侧栏过渡动画：卡顿 / 跳变**
  - 动画期间不再重复设置尺寸（尺寸本来就不变），每帧投递次数由 26 降到 15。
  - 新增「几何独占」：动画进行中，窗口重排逻辑**不再同时摆弄侧栏** ——
    之前打开时重排会把尚未滑入的侧栏先摆到终点、关闭时先拽回终点，
    表现为「闪一下 / 弹一下」，这是跳变的主因。
  - 帧驱动改为**时间戳驱动**（不再累加固定间隔），并在 Windows 上用
    `timeBeginPeriod(1)` 提高定时器精度，避免 `sleep(15ms)` 实际睡 15~31ms 造成的抖动。
  - 首次打开「网页对话」现在也有滑入动画（此前第一次是直接出现，与后续观感不一致）。
  - 修掉两处自身引入的竞态：动画独占标志的「清标志」竞态（改为代次 CAS）；
    打开时未取消在飞的滑出动画，导致其 `hide()` 回调会把刚显示的侧栏藏掉。

### 文档

- **`README.md` 重写为面向使用者的文档**（上手 / 使用 / 排错 / 声明）。
- **新增 `CONTRIBUTER_README.md`**：构建、测试、CI、代码结构、架构决策等
  面向贡献者与 AI Agent 的内容（从原 README 整体搬迁，保留中文原文）。
- 新增 `docs/RELEASE-NOTES-v0.3.1.md`（发布说明草稿，**尚未发布**）。

### 说明

- 动画的**实际观感**仍只能在 Windows 真机上确认：开发容器（Linux）上 wry 会忽略
  子 webview 的坐标，无法验证动画。本次改动能证明的是「调用序列、投递次数、
  终点精度、无编译警告」，**不能**证明「看起来丝滑」。
- 已核实的边界：`SetPosition` 与 `SetSize` 最终都会走到 `set_bounds`
  → `controller.SetBounds`（其 `left/top` 硬编码为 0），所以本次优化省掉的是
  **每帧重复的那一次**尺寸投递，而不是把重排从动画路径中彻底移除。

---

## v0.3.0

新增「设置」窗口与网页对话的两种加载模式；适配 Windows 11 动画效果；修正安装包图标与快捷方式默认值。

### 新增

- **「设置」窗口**（顶栏「应用 → 设置」打开）
  - **重新选择连接方式**：与托盘菜单 / 顶栏「应用 → 重新连接」**完全同一分支**，行为一致。
  - **网页对话的加载方式**：可选两种模式（见下）。
  - 设置项立即生效并落盘；关闭设置窗口不影响主窗口。
- **网页对话两种加载模式**（设置里切换）
  - `overlay`（**默认**，与旧版一致）：侧栏**覆盖**在网页右侧之上，网页显示面积不变。
  - `docked`：**不改变程序窗口大小**，把网页宽度缩小、右侧让出固定宽度给聊天，
    像原生侧边栏一样**并排**显示 —— 适合一边看网页一边聊天。
    宽度严格守恒（网页宽 + 侧栏宽 = 窗口宽），两者不重叠。
- **侧栏开/关的过渡动画**（Windows 11「动画效果」适配）
  - `overlay` 模式下侧栏从右侧**滑入 / 滑出**（180ms、ease-out 缓动）。
  - 动画期间**只改位置、不改尺寸**，所以网页不需要重新布局，滑动很顺。
  - 跟随系统设置：Windows 11「设置 → 辅助功能 → 视觉效果 → 动画效果」关闭时
    **直接切换、不播放动画**（也是无障碍的正确行为）。
  - `docked` 模式**刻意不做滑动**：那种模式必须改变网页宽度，逐帧改会让网页每帧重排、
    必然掉帧，所以直接切到位。

### 修复 / 变更

- **安装包与 exe 图标改成正确的 DSHTauri logo**：之前用的是「鲸鱼画在白色圆角方块上」的
  应用图标风格，现在换成**托盘那个 logo**（透明背景的深蓝鲸鱼），
  重新生成 7 档多尺寸 ICO（256/128/64/48/32/24/16）。生成逻辑见 `scripts/make-ico.mjs`，
  挂在 `npm run icon` 的钩子上，避免被 `tauri icon` 覆盖回去。
- **安装时默认不勾选「创建桌面快捷方式」**：通过 NSIS 钩子
  （`src-tauri/nsis-hooks.nsh` + `installerHooks`）定义 `MUI_FINISHPAGE_SHOWREADME_NOTCHECKED`。
  用户仍可在安装完成页自己勾选创建。

### 内部

- **`save_config` 改为补丁语义**（只覆盖载荷里出现过的字段）。
  否则选择窗口保存地址时（它的载荷不含 `chatDocked`）会把设置里选的模式
  **静默重置**回默认值。
- 契约对账测试从**硬编码快照**改成**真解析 `lib.rs`**：之前菜单加了项而测试照旧全绿（假绿），
  现在任何一方漂移都会当场测挂。
- 新增 `docs/ANIMATION-FEASIBILITY.md`，记录「为什么框架做不了动画、我们怎么做的、
  以及为什么 docked 模式不做」。

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
