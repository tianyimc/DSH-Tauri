# 更新日志

版本号规则见 [README §0.5](README.md#05-版本规则vabc-genx)：**`v.A.B.C GenX`**。

- `A` 文集网页核心版本 · `B` 重要功能版本 · `C` 普通更新 · `GenX` 同一个 `C` 内的补丁快照
- **`C` 提升时 `Gen` 立即重置为 1**；`Gen1` 不显示后缀
- 只记录**面向用户的变化**；纯内部调整放到「内部」小节
- 每次改版本号时，在下面**顶部**加一条新记录

发版三步：`node scripts/version.mjs --set X.Y.Z`（或 `--bump-gen`）→ 在本文件顶部加记录 → 提交推送。

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
