# 更新日志

版本号规则见 [README §0.5](README.md#05-版本规则vabc-genx)：**`v.A.B.C GenX`**。

- `A` 文集网页核心版本 · `B` 重要功能版本 · `C` 普通更新 · `GenX` 同一个 `C` 内的补丁快照
- **`C` 提升时 `Gen` 立即重置为 1**；`Gen1` 不显示后缀
- 只记录**面向用户的变化**；纯内部调整放到「内部」小节
- 每次改版本号时，在下面**顶部**加一条新记录

发版三步：`node scripts/version.mjs --set X.Y.Z`（或 `--bump-gen`）→ 在本文件顶部加记录 → 提交推送。

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

- **主窗口白屏且点右上角 × 无反应，只能任务管理器强杀**（Windows 上必现）
  - 原因：`open_main_window` 是**同步命令**，Tauri 的同步命令跑在主线程（事件循环）里，
    而 `WebviewWindowBuilder::build()` 会向事件循环投递消息后 `rx.recv()` **阻塞等待**它被处理——
    事件循环正卡在这条命令里，于是永久死锁：窗口画不出来（白屏），也不再响应任何消息（× 点不动）。
    Tauri 源码里对此有明确注释：*"must be called from a separate thread, otherwise the channel will introduce a deadlock"*。
  - 修复：把 `open_main_window` 改成 `async fn`，命令改为跑在异步运行时（独立线程），
    死锁消失；`probe_url` 一并改成 async，避免 DNS 查询卡住界面。

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
