This file is intended for project contributors and AI Agents. It contains various build- and debug-related content and conventions.

## TODO LIST

## 关于本文档

> 本文档由 [README.md](README.md) 的**构建 / 开发类章节整体搬迁**而来，保留中文原文；面向用户的内容（安装、使用、排错、声明）留在 README。
> 文中的代码片段是成文时的快照，实际以仓库文件为准。

---

## 目录

- [0. 模板变量对照](#0-模板变量对照)
- [0.5 版本号工具与发版流程](#05-版本号工具与发版流程)
- [1. 项目文件树](#1-项目文件树)
- [2. `package.json`](#2-packagejson)
- [3. `src-tauri/tauri.conf.json`](#3-src-tauritauriconfjson)
- [4. 选择界面前端](#4-选择界面前端)
- [5. `src-tauri/Cargo.toml`](#5-src-tauricargotoml)
- [6. `src-tauri/src/lib.rs` + `main.rs`](#6-src-taurisrclibrs--mainrs)
- [6.5 自定义标题栏 / 右侧对话侧栏 / 关于窗口](#65-自定义标题栏--右侧对话侧栏--关于窗口)
- [6.6 内存与挂起策略（v0.3.4）](#66-内存与挂起策略v034)
- [7. `src-tauri/capabilities/` 权限配置](#7-src-tauricapabilities-权限配置)
- [8. `.github/workflows/release-windows.yml`](#8-githubworkflowsrelease-windowsyml)
- [9. 在 Debian 上从零到推送的完整命令](#9-在-debian-上从零到推送的完整命令)
- [10. 构建成功后：看 Actions、下载 `.exe`](#10-构建成功后看-actions下载-exe)
- [11. 排错用的环境自检与日志命令](#11-排错用的环境自检与日志命令)
- [验收标准对照](#验收标准对照)
- [设计决策速查](#设计决策速查)
- [验证记录（本仓库实际跑过的检查）](#验证记录本仓库实际跑过的检查)
- [12. 许可证与项目定位](#12-许可证与项目定位)

---

## 0. 模板变量对照

需求里的占位符在本项目中的取值（**改这些地方即可**）：

| 占位符 | 取值 | 改哪里 |
| --- | --- | --- |
| `{{APP_NAME}}` | `DSHTauri` | `src-tauri/tauri.conf.json` → `productName`、`src-tauri/src/lib.rs` → `MAIN_TITLE` |
| `{{NODE_VERSION}}` | `22` | `.github/workflows/release-windows.yml` → `node-version` |
| `{{LOCAL_URL}}` | 示例 `http://127.0.0.1:3080`（**默认留空**） | 界面 placeholder 在 `src/index.html`；示例常量在 `src/config-rules.js` 的 `EXAMPLES`；用户填写后存进 `config.json` |
| `{{REMOTE_URL}}` | 示例 `https://dsh.example.com`（**默认留空**） | 同上 |
| 本地服务启动命令示例 | `dsh web` | `src/index.html` 的 textarea placeholder |
| `{{WINDOW_SIZE}}` | `1200x800` | `src-tauri/src/lib.rs` → `MAIN_WIDTH` / `MAIN_HEIGHT` |
| 远程页面是否需要本地 Rust 命令 | **否**（默认不开放） | 需要时见 [§7](#7-src-tauricapabilities-权限配置) |

> 开发机：Debian x86_64，只跑 `tauri dev` 验证界面；**Windows 产物全部由 GitHub Actions 在 `windows-latest` 上原生编译**。
> 本文档里的所有代码都在仓库里，文件即最终产物；下面按文件逐项说明，每个文件都给出路径和要点。

**每次启动都要选，地址只设置一次**（需求里「首次点击要求用户提供并记录在配置文件」和「选择不需要持久化」看起来冲突，本项目按下面这条语义实现，已与需求方确认）：

- **每次启动都显示选择界面**，必须点「本地」或「远程」——**「选择」本身不持久化**；
- **首次**点击时弹出表单让用户确认地址，保存进 `config.json`——**「地址」持久化**；
- 之后每次启动读同一份配置，点一下就直接连接，**不需要再设置地址**；
- 地址随时可在「设置」里改。

对应代码：`src/selector.js` 的 `pick()` 判断 `config.configured`——未配置过才弹表单，已配置直接 `connect(mode)`。

**本地和远程允许只配一个**：两个地址默认都是空的，用户按需填其中一个即可，另一个留空。
校验规则在 [src/config-rules.js](src/config-rules.js) 的 `validateConfig()`，由 [scripts/test-rules.mjs](scripts/test-rules.mjs) 单测覆盖。

---

## 0.5 版本号工具与发版流程

> 面向用户的版本规则说明留在 [README.md](README.md#63-版本规则)；本节只讲工具用法与发版流程。

**怎么用**

```bash
npm run ver                                  # 打印当前版本 / 渠道 / 发布包名 / tag
node scripts/version.mjs --json              # 同上，JSON 格式
node scripts/version.mjs --set 0.3.3         # 改 A.B.C（三处一起写），渠道保持不变
node scripts/version.mjs --set-channel rc    # 切到 RC 预发布渠道
node scripts/version.mjs --set-channel release   # 切回正式渠道
```

`--set` 会一次性同步三处版本号：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`，
并校验它们没有跑偏（不一致会直接报错并给出修复命令）。

**数据来源（各自唯一，不重复维护）**

- `A.B.C` → `src-tauri/tauri.conf.json` 的 `version`（`--set` 同时写入另外两处）
- `channel` → 仓库根目录 `version.json` 的 `channel`，取值 `"release"` 或 `"rc"`

**渠道决定显示名与产物名**（`scripts/version.mjs` 的 `describe()`）：

| 渠道 | 显示 | 安装包文件名 | Git tag | Release 标题 | prerelease |
| --- | --- | --- | --- | --- | --- |
| `release` | `v.0.3.3` | `DSHTauri-v.0.3.3-setup.exe` | `v.0.3.3` | `DSHTauri v.0.3.3` | `false` |
| `rc` | `v.0.4.0 RC` | `DSHTauri-v.0.4.0-RC-setup.exe` | `v.0.4.0-rc` | `DSHTauri v.0.4.0 RC` | `true` |

> 后缀写法三处不同，别混：**显示**用空格（` RC`）、**文件名**用 `-RC`、**tag** 用小写 `-rc`。
> 这样同一组 `A.B.C` 的 RC 与正式版能各自占一个 tag，不会互相覆盖。

CI 用 `node scripts/version.mjs --github` 推导 artifact 名、Release tag、标题和安装包文件名，
所以**发布包名和 tag 永远跟着版本规则走**，不用手工改 workflow。

**在程序里也看得到**：选择窗口右下角显示当前版本；托盘悬浮提示是 `DSHTauri <当前版本>`。
显示名由 `src-tauri/build.rs` 在编译期读 `version.json` 的 `channel` 塞进二进制
（`release` → `v.0.3.3`，`rc` → `v.0.3.3 RC`）。

**每次发版要做的四件事**（详见 [CHANGELOG.md](CHANGELOG.md)）：

1. 改版本号：`node scripts/version.mjs --set 0.3.3`
2. 选渠道：`node scripts/version.mjs --set-channel rc`（发预发布）或
   `--set-channel release`（发正式版）
3. 在 [CHANGELOG.md](CHANGELOG.md) 顶部加一条对应版本的记录
4. 提交推送；CI 会自动用新版本号出包（RC 会发布为 GitHub **prerelease**）

---

## 1. 项目文件树

```text
DSHTauri/
├── .github/
│   └── workflows/
│       └── release-windows.yml     # 第 8 项：windows-latest + NSIS 出包 + Windows 真机冒烟测试
├── docs/
│   ├── TROUBLESHOOTING.md          # 第 11 项：常见错误与排查
│   ├── ANIMATION-FEASIBILITY.md    # 侧栏动画的可行性论证（为什么框架做不了、我们怎么做）
│   └── VERIFICATION.md             # 各项验证的证据记录
├── scripts/
│   ├── check-env.mjs               # 环境自检：cargo 不在 PATH 等问题直接给修复命令
│   ├── env.sh                      # `source scripts/env.sh` 接入项目自带 Rust 工具链
│   ├── make-logo.mjs               # 从 tray-light.png 派生全部 logo 资源（纯 Node + ImageMagick）
│   ├── post-icon.mjs               # 图标生成后处理：清理移动端图标 + 跑 make-logo.mjs 统一 logo
│   ├── test-rules.mjs              # 配置规则单测（node --test，23 条）
│   ├── test-titlebar.mjs           # 顶栏纯函数单测
│   ├── test-titlebar-wiring.mjs    # 顶栏与 Rust 命令的接线对账
│   ├── test-settings.mjs           # 设置窗口纯函数单测
│   ├── verify-titlebar.mjs         # 静态校验脚本（npm run verify）
│   ├── version.mjs                 # 版本号 / 渠道工具（v.A.B.C，release | rc）
│   ├── smoke-linux.sh              # Xvfb 下的无头冒烟测试（21 项断言）
│   └── smoke-windows.ps1           # windows-latest 上的真实 GUI 冒烟测试（39 项断言）
├── src/                            # 前端（无框架、无构建步骤，直接嵌入二进制）
│   ├── index.html / selector.css / selector.js   # 启动选择界面
│   ├── config-rules.js             # 配置校验纯函数（浏览器与 Node 共用，可单测）
│   ├── titlebar.html               # 主窗口顶部的自定义标题栏（本地页面 = 有 IPC）
│   ├── titlebar/                   #   顶栏的 CSS / JS / 纯函数规则 + 说明
│   ├── logo-on-dark.png            # 「关于」/「设置」窗口内的 logo（深色底：白鲸鱼）
│   ├── logo-on-light.png           # 同上（浅色底：深藏青鲸鱼），CSS 按主题显隐
│   └── about.html / about.css / about.js         # 「关于 / 检查更新」窗口
│   └── settings.html / settings.css / settings.js # 「设置」窗口（连接方式 / 网页对话加载模式）
├── src-tauri/
│   ├── nsis-hooks.nsh              # NSIS 安装钩子（默认不勾桌面快捷方式等）
│   ├── capabilities/
│   │   ├── default.json            # 第 7 项：选择窗口 / 关于窗口 / 顶栏子 webview 的权限
│   │   └── remote-main.json.example# 第 7 项：远程页面 IPC 权限（可选，默认不生效）
│   ├── icons/                      # logo 资源（icon.ico / tray-*.png / app-*.png …），见 §3「图标」
│   ├── src/
│   │   ├── lib.rs                  # 第 6 项：托盘 / 关闭隐藏 / 命令
│   │   ├── anim.rs                 # 侧栏开/关的逐帧过渡动画
│   │   └── main.rs                 # 薄壳入口
│   ├── build.rs                    # tauri-build + 把版本号与渠道编译进二进制
│   ├── Cargo.toml                  # 第 5 项
│   ├── Cargo.lock                  # 提交它，保证 CI 可复现
│   └── tauri.conf.json             # 第 3 项
├── version.json                    # 版本渠道（"release" | "rc"）；A.B.C 在 tauri.conf.json
├── LICENSE                         # Apache License 2.0 全文
├── CHANGELOG.md                    # 按版本号记录的更新日志
├── package.json                    # 第 2 项
├── package-lock.json               # `npm ci` 依赖它
├── .gitignore
├── README.md                       # 用户向文档：安装 / 使用 / 排错 / 声明
└── CONTRIBUTER_README.md           # 本文档：环境 / 构建 / 测试 / CI / 内部实现
```

> `src-tauri/gen/schemas/` 是 `tauri-build` 在构建时生成的权限 schema，已在 `.gitignore` 中忽略，不要提交。

---

## 2. `package.json`

路径：[package.json](package.json)

```json
{
  "name": "dshtauri",
  "private": true,
  "version": "0.3.3",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build",
    "build:nsis": "tauri build --bundles nsis",
    "posticon": "node scripts/post-icon.mjs",
    "check": "node scripts/check-env.mjs",
    "ver": "node scripts/version.mjs",
    "test": "npm run test:js && npm run verify && npm run test:rust",
    "test:js": "node --test scripts/test-rules.mjs scripts/test-titlebar.mjs scripts/test-titlebar-wiring.mjs scripts/test-settings.mjs",
    "verify": "node scripts/verify-titlebar.mjs",
    "test:rust": "cargo test --manifest-path src-tauri/Cargo.toml",
    "smoke": "bash scripts/smoke-linux.sh"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.12.1"
  }
}
```

要点：
- **只有一个依赖**：Tauri CLI。前端是纯静态 HTML/CSS/JS，**没有 Vite / 没有框架**，所以不需要 `beforeDevCommand`，也不需要 `beforeBuildCommand`，打包体积和启动开销都最小。
- `npm run tauri build -- --bundles nsis` 里的 `--` 是把参数透传给 `tauri` 子命令，必须写。
- **图标不再走 `tauri icon`**：该脚本已退休（它依赖的旧源图已删除）。
  现在直接跑 `node scripts/post-icon.mjs`（内部调用 `scripts/make-logo.mjs`），见 §3「图标」。

---

## 3. `src-tauri/tauri.conf.json`

路径：[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "DSHTauri",
  "version": "0.3.3",
  "identifier": "com.dsh.dshtauri",
  "build": {
    "frontendDist": "../src"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": [
      "nsis"
    ],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ],
    "publisher": "DSH",
    "category": "Utility",
    "shortDescription": "DSHTauri - DSH WebUI 轻量桌面壳",
    "longDescription": "基于 Tauri 2 + Windows 原生 WebView2 的 DSH WebUI 桌面壳：启动时选择本地或远程地址，关闭窗口最小化到系统托盘。",
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper",
        "silent": true
      },
      "nsis": {
        "installMode": "currentUser",
        "languages": [
          "SimpChinese",
          "English"
        ],
        "displayLanguageSelector": false,
        "compression": "lzma",
        "installerHooks": "nsis-hooks.nsh",
        "installerIcon": "icons/icon.ico",
        "uninstallerIcon": "icons/icon.ico"
      }
    }
  }
}
```

对应你的要求逐条说明：

| 要求 | 实现方式 |
| --- | --- |
| 主窗口不直接加载 URL，先加载本地选择页面 | `app.windows` 为**空数组** —— 选择窗口与主窗口**都由 Rust 动态创建**（见 §6），选择窗口加载 `index.html`（来自 `frontendDist: "../src"`） |
| 两个窗口 or 单窗口路由切换 | 采用**两个窗口**：`selector`（`WebviewWindowBuilder` 运行时创建）+ `main`（同样运行时创建）。选择完成后 `selector.destroy()` |
| `bundle.targets` 含 `nsis` | `"targets": ["nsis"]` |
| `bundle.icon` 含 `.ico` | `"icons/icon.ico"`（路径相对 `src-tauri/`） |
| 安装包 / 卸载器图标 | `nsis.installerIcon` / `nsis.uninstallerIcon` 都指向 `icons/icon.ico`（此前从未设置 ⇒ 一直是 Tauri 默认图标） |
| 安装钩子 | `nsis.installerHooks: "nsis-hooks.nsh"`（见 §3「安装包行为」） |
| 窗口标题为 `{{APP_NAME}}` | 主窗口标题在 `lib.rs` 的 `MAIN_TITLE = "DSHTauri"`；选择窗口标题是「选择 DSH 连接方式」 |
| 无构建步骤 | 不写 `devUrl` / `beforeDevCommand`。Tauri CLI 官方说明：*"If you don't have a dev server or don't want to use one, ignore this option and use `frontendDist` … Tauri CLI will run its built-in dev server and provide a simple hot-reload experience."* |
| `withGlobalTauri` | 必须为 `true`，否则静态页面拿不到 `window.__TAURI__`，选择界面无法调用 Rust 命令 |
| CSP | 设为 `null` = 不注入 CSP。远程 WebUI 往往有自己的 CSP/内联脚本，由 Tauri 再注入一份容易白屏。见 [§4 安全说明](#4-选择界面前端) |

### 图标

**统一 logo：只有一只鲸鱼。** 全项目（安装包、exe、卸载器、任务栏、托盘）都用同一只鲸鱼，
由 [scripts/make-logo.mjs](scripts/make-logo.mjs) 从 `src-tauri/icons/tray-light.png`
（深藏青 `#020E36` 鲸鱼 + 透明底）派生。

**生成流程**：

```bash
node scripts/post-icon.mjs    # = 清理移动端图标 + 调用 scripts/make-logo.mjs
```

`post-icon.mjs` 做两件事：删掉 `src-tauri/icons/android/` 与 `ios/`（本项目只做 Windows 桌面端），
然后调用 `make-logo.mjs` 生成全部 logo 资源。**旧的 `tauri icon` 流程已退休**
（`package.json` 的 `"icon"` 脚本连同它依赖的源图一起下线）——不要再走那条老路。

**产出**（都在 `src-tauri/icons/`）：

| 产出 | 用途 | 说明 |
| --- | --- | --- |
| `icon.ico` | **安装包 / exe / 卸载器 / 资源管理器** | 统一 logo（深藏青，透明底），**7 档**多尺寸：16/24/32/48/64/128/256 |
| `app-dark.png` / `app-light.png` | **运行时窗口 / 任务栏图标** | 64px 两套配色，由 Rust 按系统主题 `Window::set_icon()` 动态切换 |
| `src/logo-on-dark.png` / `src/logo-on-light.png` | **「关于」/「设置」窗口内的 logo** | 前端资源：深色底用白鲸鱼、浅色底用深藏青鲸鱼，由 CSS 按主题显示其中一个（见下） |
| `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.png` / `StoreLogo.png` … | `bundle.icon` 引用的各尺寸 PNG | 同一只鲸鱼，避免仓库里出现两种风格 |

> **「关于」/「设置」窗口的 logo**：`src/about.html` 与 `src/settings.html` 各放
> `<img class="logo-on-dark" src="logo-on-dark.png">` 与 `<img class="logo-on-light" src="logo-on-light.png">`，
> 由 `src/about.css` / `src/settings.css` 按 `prefers-color-scheme` 只显示匹配主题的那一只
> （与托盘/任务栏是同一只鲸鱼，配色规则一致）。这两个 PNG 是**前端资源**，
> 随 `frontendDist: "../src"` 一起嵌进二进制，不是 `bundle.icon` 用的那套。
> 早前版本这里是 emoji（🐋 / ⚙️）占位，现已替换为统一鲸鱼。

> **为什么 ico 固定用深藏青版**：Windows 资源管理器/桌面**不会**按深浅色主题切换 exe/ico 的颜色
> （它只认 ico 里那一个图像）。所以 ico 用深藏青（浅色背景下清晰）；
> 深色主题下任务栏/标题栏的**运行时**图标由 `app-dark` / `app-light` 在代码里切换。

`bundle.icon` 里写的是 `icons/icon.ico` 等文件；`installerIcon` / `uninstallerIcon`
（见 §3 的 `tauri.conf.json`）也指向 `icons/icon.ico`，所以安装包与卸载器图标同源。

> 依赖 ImageMagick（`convert`）。CI 的 `windows-latest` 没有它，所以 `make-logo.mjs`
> 找不到时会**安全跳过**（仓库里已提交生成结果），不让打包失败。

**图标随系统主题自动切换**（[src-tauri/src/lib.rs](src-tauri/src/lib.rs)）：

```rust
const ICON_ON_DARK:  &[u8] = include_bytes!("../icons/tray-dark.png");   // 白色版
const ICON_ON_LIGHT: &[u8] = include_bytes!("../icons/tray-light.png");  // 深色原版

fn themed_icon(theme: Option<Theme>) -> Option<Image<'static>> {
    let bytes = match theme {
        Some(Theme::Light) => ICON_ON_LIGHT,
        _ => ICON_ON_DARK,   // 探测不到也按深色处理：深色底上白 logo 才看得见
    };
    Image::from_bytes(bytes).ok()
}
```

- **同一个函数同时服务托盘与窗口/任务栏图标**：`apply_theme_icons()` 把主题对应的 logo
  同时 `set_icon()` 给托盘与主窗口，保证两处配色一致。
- 启动时读一次窗口主题（`setup` 之前配置里的选择窗口已创建，所以拿得到）。
- 用户中途切换浅色/深色时，`WindowEvent::ThemeChanged` 会实时换图标。
- PNG 解码需要 `tauri` 的 `image-png` feature。实测代价：剥离符号 + LTO 的 release 二进制**增加约 137 KB**（约 1.5%）。介意的话可以改成构建期解码成裸 RGBA + `Image::new_owned()`，省掉这个依赖。

**换 logo**：

```bash
# 1. 把新的鲸鱼 PNG（透明底、方形）放到 src-tauri/icons/tray-light.png
# 2. 重新派生全部资源（icon.ico + app-dark/app-light + 各尺寸 PNG）
node scripts/post-icon.mjs
```

托盘两版配色由 `tray-light.png`（深藏青）与 `tray-dark.png`（白色）提供，二者 artwork 必须一致、只有填色不同。

> ⚠️ 反色**必须用「alpha 掩码 + CopyOpacity」写法**，不要用 `-colorize`：
> 后者会让抗锯齿边缘的 alpha 偏移 1（实测 340 个像素），破坏「透明背景不变」的要求。
> 单元测试 `tray_icons_are_inverted_versions_of_each_other` 会断言两版 alpha 完全一致，
> 写错了 `cargo test` 会直接失败。

不要直接把 `.png` 改名成 `.ico` —— 文件头不对，`makensis` 会拒绝（见 [TROUBLESHOOTING §4](docs/TROUBLESHOOTING.md#4-图标格式错误)）。

### 安装包行为：这是**安装版**，不是绿色版

产物是 NSIS 安装程序，会写注册表、建快捷方式、带卸载器。**不是**可自由移动的绿色版。

**安装向导页面顺序**（Tauri 2.12.1 官方 NSIS 模板，实测自 CLI 内嵌模板）：

```text
1. Welcome                      欢迎
2. License                      （未配置则跳过）
3. Install mode                 （仅当 installMode = "both"）
4. 已安装时询问 重装/卸载
5. Choose install directory     ★ 安装目录选择页 —— 默认就有，用户可以改
6. Start menu shortcut          开始菜单文件夹
7. Installing
8. Finish
```

**安装目录**：

| 项 | 值 |
| --- | --- |
| 默认目录 | `%LOCALAPPDATA%\DSHTauri`（即 `C:\Users\<你>\AppData\Local\DSHTauri`） |
| 用户能否改 | ✅ 能。第 5 步就是 `!insertmacro MUI_PAGE_DIRECTORY`，**默认插入、无需额外配置** |
| 什么时候看不到 | 只有静默/被动安装（`/S`）才会跳过该页，这是 NSIS 的正常行为 |
| 是否需要管理员 | 不需要。`installMode: "currentUser"` 装到用户目录，不弹 UAC |

**会写的注册表**（`currentUser` 下 `SHCTX` = `HKCU`）：

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<DSHTauri>` —— `DisplayName` / `UninstallString` / `HelpLink` / `URLInfoAbout` / `URLUpdateInfo` / `EstimatedSize` / `NoModify` / `NoRepair`
- `HKCU\Software\<publisher>\<productName>`
- 开始菜单快捷方式 `%AppData%\Microsoft\Windows\Start Menu\Programs\DSHTauri.lnk`
- 卸载时会 `DeleteRegKey` 清掉以上项；**仅当用户在卸载确认页勾选了「删除应用数据」且不是更新模式时**，
  才会 `RmDir /r "$APPDATA\<BUNDLEID>"` 与 `RmDir /r "$LOCALAPPDATA\<BUNDLEID>"` 清理配置与 WebView2 数据
  （模板里条件为 `$DeleteAppDataCheckboxState = 1` **且** `$UpdateMode <> 1`）。

### 覆盖安装 / 无损更新的机制

Tauri 的 NSIS 模板对「已装过再装一次」有原生支持，本项目的配置正好走这条路径：

| 机制 | 模板实现 | 效果 |
| --- | --- | --- |
| 装到哪 | `installMode: "currentUser"` ⇒ `StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"` | 默认 `%LOCALAPPDATA%\DSHTauri` |
| 复用上次目录 | `RestorePreviousInstallLocation` 从 `SHCTX "${MANUPRODUCTKEY}"` 读回 `$INSTDIR` | 更新时装回你上次选的目录 |
| 程序在运行 | `Section Install` 里 `CheckIfAppIsRunning`（RestartManager） | 会提示并询问是否关掉它 |
| 不删数据 | 卸载段 `RmDir /r` 被 `$UpdateMode <> 1` 挡住 | 配置与登录态保留 |
| 不重复建快捷方式 | `CreateOrUpdateStartMenuShortcut` / `CreateOrUpdateDesktopShortcut` 在 `$UpdateMode = 1` 时 `Return` | 不重复创建 |

**关键点：数据不在安装目录里**，所以覆盖安装天然是无损的：

- 配置：`app.path().app_config_dir()` ⇒ `%APPDATA%\com.dsh.dshtauri\config.json`（[src-tauri/src/lib.rs](src-tauri/src/lib.rs) 的 `config_path`）
- 登录态：`app_local_data_dir()/webview2` ⇒ `%LOCALAPPDATA%\com.dsh.dshtauri\webview2`（同文件的 `webview_data_dir`）

两者都在 `%LOCALAPPDATA%\DSHTauri`（安装目录）之外，安装器只覆盖安装目录内的文件。
RC 与 Release 共用同一个 `identifier`，所以**跨渠道覆盖安装同样保留数据**。

> 面向用户的操作步骤见 [README.md 如何无损更新](README.md#如何无损更新升级)。

**想改成别的安装模式**（`src-tauri/tauri.conf.json` → `bundle.windows.nsis.installMode`）：

| 取值 | 行为 |
| --- | --- |
| `currentUser`（当前） | 装到 `%LOCALAPPDATA%`，无需管理员 |
| `perMachine` | 装到 `%PROGRAMFILES%`，需要管理员，卸载项写 `HKLM` |
| `both` | **多一页**让用户选"仅为我安装 / 为所有用户安装"，再选目录 |

> 如果你其实想要**绿色版**：`src-tauri/target/release/DSHTauri.exe` 本身就是单文件可执行程序，
> 拷到哪都能跑（前提是目标机已装 WebView2，Win11 自带）。代价是没有开始菜单快捷方式、没有卸载项、
> 也不会自动装 WebView2。需要的话我可以在 CI 里额外产出一个 `dshtauri-portable.zip`。

---

## 4. 选择界面前端

路径：[src/index.html](src/index.html) · [src/selector.css](src/selector.css) · [src/config-rules.js](src/config-rules.js) · [src/selector.js](src/selector.js)

界面结构（首次启动、两个地址都还没配的样子）：

```text
┌──────────────────────────────────────────────┐
│ ● 选择 DSH 连接方式                    [设置] │
├──────────────────────────────────────────────┤
│ ⌂  本地                                      │
│    未配置（点击填写）              [未配置]   │   ← 虚线框、半透明
├──────────────────────────────────────────────┤
│ ☁  远程                                      │
│    未配置（点击填写）              [未配置]   │   ← 虚线框、半透明
├──────────────────────────────────────────────┤
│ 状态：请选择连接方式；首次使用需要先填写地址。│
│ 还没配置地址：点「设置」填写…       v.0.3.3 │
└──────────────────────────────────────────────┘
```

配好之后，卡片显示实际地址和状态徽章：

```text
│ ⌂  本地                                      │
│    http://127.0.0.1:3080      [自动启动服务] │
│ ☁  远程                                      │
│    未配置（点击填写）              [未配置]   │
```

**本地和远程允许只配一个**（需求明确要求）：

- 两个地址默认都是空的，用户按需填一个即可，另一个留空；
- 两个都留空不允许（保存时会提示「至少要填一个」）；
- 未配置的那一侧卡片仍是**可点**的（不是死按钮）——点了会直接打开设置面板去补；
- 校验逻辑抽到 [src/config-rules.js](src/config-rules.js) 的 `validateConfig()`，
  浏览器和 Node 共用同一份代码，由 [scripts/test-rules.mjs](scripts/test-rules.mjs) 单测覆盖。

「设置」/首次点击时展开的表单：本地 URL、远程 URL（各带「可留空」标注和示例 placeholder）、
**勾选「选择本地时自动执行下面的命令」**、以及 PowerShell 启动命令（placeholder 示例 `dsh web`）。

前端用 ES module（`<script type="module">`），`selector.js` 从 `config-rules.js` 引入校验逻辑。

`selector.js` 的核心逻辑（完整代码见文件）：

```js
import { urlOf, validateConfig, buildConfig } from "./config-rules.js";

const { invoke } = window.__TAURI__.core;

// 1) 启动时读配置
config = { ...DEFAULT_CONFIG, ...(await invoke("load_config")) };

// 2) 点击「本地 / 远程」
//    - 未配置过     -> 弹出表单，保存后再连接
//    - 这一侧是空的 -> 打开设置去补
//    - 已配置       -> 直接连接
async function connect(mode) {
  const url = urlOf(config, mode);
  const startCommand = mode === "local" && config.autoStartLocal
    ? config.localStartCommand.trim() : null;

  if (startCommand) {
    await invoke("start_local_service", { command: startCommand });
    // 轮询探测端口，避免服务没起来就加载出白屏
    if (!(await waitForService(url))) {
      setStatus("本地服务在 20 秒内没有就绪，仍会尝试加载页面。", "err");
    }
  }
  await invoke("open_main_window", { request: { url } });
}
```

**为什么「等端口」放在 JS 而不是 Rust**：Tauri 的**同步命令跑在主线程**上，在 Rust 里 `sleep` 等待会直接冻住界面。所以拆成 `start_local_service` + 前端轮询 `probe_url`（每次只做一次 300ms 超时的 TCP 连接），状态行还能实时显示「第 N 次探测」。

### 关于 Cookie 持久化 / CSP / WebView2 兼容性 / 登录态（实现细节）

> 面向用户的说明见 [README.md 登录态与 Cookie](README.md#46-登录态与-cookie) 与
> [常见问题与排查](README.md#5-常见问题与排查)；下面是实现层面的原因与取舍。

- **Cookie 与登录态**：Tauri 2 把 WebView2 的用户数据目录放在应用数据目录下，由 `identifier` 决定（本项目 `com.dsh.dshtauri`）。Cookie、localStorage、IndexedDB、缓存**默认跨重启保留**，登录一次即可。注意：**改 `identifier` 等于换 profile**，登录态会「丢失」。
- **不要开隐身模式**：窗口配置里 `incognito: true` 会导致不落盘。
- **CSP**：`csp: null` 表示 Tauri 不注入 CSP，远程页面的安全策略完全由它自己（HTTP 响应头）决定。这是加载第三方 WebUI 最稳的做法。如果你要自己加 CSP，必须同时放行远程页面的 `script-src` / `connect-src` / `img-src`，否则白屏。
- **WebView2 兼容性**：目标机 Win11 自带；Win10 通过 `webviewInstallMode` 自动引导安装。远程页面若用了很新的 JS/CSS 特性，取决于目标机 WebView2 版本，可用 `minimumWebview2Version` 卡最低版本。
- **混合内容**：`https://` 页面里请求 `http://127.0.0.1:3080` 会被 WebView2 拦截。本地服务请用 `http://` 直接打开，或给本地服务配可信证书。
- **会话 Cookie → 持久 Cookie**：应用启动时会把会话 Cookie 转成持久 Cookie，否则「关掉再开又要重新登录」。

---

## 5. `src-tauri/Cargo.toml`

路径：[src-tauri/Cargo.toml](src-tauri/Cargo.toml)

```toml
[package]
name = "dshtauri"
version = "0.3.3"
description = "DSHTauri - lightweight Tauri 2 desktop shell for the DSH WebUI"
authors = ["DSHTauri"]
edition = "2021"
rust-version = "1.77.2"

[lib]
name = "dshtauri_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }
serde_json = "1"

[dependencies]
# tray-icon = Tauri 2 官方托盘 API，不需要额外插件
# image-png = 让图标能从内嵌 PNG 字节解码（Image::from_bytes）
# unstable  = multiwebview API（Window::add_child），顶栏是主窗口内的子 webview
tauri = { version = "2", features = ["tray-icon", "image-png", "unstable"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
panic = "abort"
strip = true
incremental = false
```

要点：
- **托盘依赖就是 `tauri` 的 `tray-icon` feature**，用的是官方 `tauri::tray` API，没有第三方插件。
- `image-png` 用于从内嵌 PNG 解码图标（`Image::from_bytes`）；`unstable` 用于 `Window::add_child`（子 webview 顶栏）。
- `[profile.release]` 这一段是为「体积尽量小」服务的：`lto` + `opt-level = "s"` + `strip` + `panic = "abort"`。代价是 release 编译慢一些（CI 上有 Rust 缓存，问题不大）。
- `Cargo.lock` **要提交**，CI 才能复现完全相同的依赖树。

---

## 6. `src-tauri/src/lib.rs` + `main.rs`

路径：[src-tauri/src/lib.rs](src-tauri/src/lib.rs) · [src-tauri/src/main.rs](src-tauri/src/main.rs)

`main.rs` 只是薄壳：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dshtauri_lib::run()
}
```

`windows_subsystem = "windows"` 让 release 构建不弹黑色控制台窗口。

`lib.rs` 的骨架与关键点：

**① 托盘创建（官方 `tauri::tray` + `tauri::menu`）**

```rust
fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let select_item = MenuItem::with_id(app, MENU_SELECT, "重新选择连接方式", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &select_item, &separator, &separator2, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(MAIN_TITLE)
        .menu(&menu)
        .show_menu_on_left_click(false)          // 左键单击=唤出窗口，右键=菜单
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => reveal_window(app),
            MENU_SELECT => reveal_selector(app), // 把隐藏的选择窗口叫回来
            MENU_QUIT => app.exit(0),            // 真退出
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up, ..
            } = event { reveal_window(tray.app_handle()); }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());    // 复用 bundle.icon，不额外打包资源
    }
    builder.build(app)?;
    Ok(())
}
```

**② 关闭窗口 = 隐藏到托盘**

```rust
.on_window_event(|window, event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if TRAY_READY.load(Ordering::Relaxed) {
            api.prevent_close();     // 不真正关闭
            let _ = window.hide();   // 隐藏到托盘
        }
    }
})
```

注意两个容易踩的坑（详见 [TROUBLESHOOTING §2](docs/TROUBLESHOOTING.md)）：
- 关闭**选择窗口**必须用 `destroy()` 而不是 `close()`，否则会被上面的逻辑拦住，选择窗口永远关不掉。
- 托盘「退出」必须用 `app.exit(0)`，`app.exit` 不触发 `CloseRequested`，所以是真正的退出。

**③ 托盘创建失败时的降级**（工程健壮性）

```rust
static TRAY_READY: AtomicBool = AtomicBool::new(false);

.setup(|app| {
    match setup_tray(app.handle()) {
        Ok(()) => TRAY_READY.store(true, Ordering::Relaxed),
        Err(err) => eprintln!("[DSHTauri] 系统托盘创建失败：{err}\n\
            [DSHTauri] 已降级运行：关闭窗口将直接退出程序（不会隐藏到托盘）。"),
    }
    Ok(())
})
```

如果托盘没建起来还继续「关闭即隐藏」，用户就会得到一个**藏起来又没有任何入口**的窗口。所以托盘不可用时关闭按钮走正常关闭流程。Windows 上托盘一定可用，这段只在 Linux 开发机（没有 StatusNotifier 宿主）才会触发。

**④ 接收前端选择结果并打开主窗口**

```rust
#[tauri::command]
fn open_main_window(app: AppHandle, request: OpenRequest) -> Result<(), String> {
    let url = tauri::Url::parse(request.url.trim()).map_err(|e| format!("URL 无效：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("不支持的协议 `{other}`，只允许 http / https。")),
    }

    if let Some(existing) = app.get_webview_window(MAIN_LABEL) {
        let _ = existing.destroy();     // 重新选择时按新地址重建
    }

    let window = WebviewWindowBuilder::new(&app, MAIN_LABEL, WebviewUrl::External(url))
        .title(MAIN_TITLE)              // "DSHTauri"
        .inner_size(1200.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true).maximizable(true).minimizable(true).closable(true)
        .center().visible(true)
        .build()
        .map_err(|e| format!("创建主窗口失败：{e}"))?;

    let _ = window.set_focus();
    if let Some(selector) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = selector.destroy();     // 选择窗口使命完成
    }
    Ok(())
}
```

**⑤ 五个命令**（`load_config` / `save_config` / `start_local_service` / `probe_url` / `open_main_window`）

配置持久化用 `serde_json` 手写到 `<app config dir>/config.json`（Windows：`%APPDATA%\com.dsh.dshtauri\config.json`），**不引入额外插件**：

```rust
fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("无法定位配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    Ok(dir.join("config.json"))
}
```

**⑥ 自动启动本地服务（PowerShell，后台无窗口）**

```rust
#[cfg(windows)]
fn spawn_local_service(command: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
               "-WindowStyle", "Hidden", "-Command", command])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn().map(|_| ())
        .map_err(|e| format!("启动本地服务失败：{e}"))
}
```

非 Windows 上退化为 `sh -lc`，所以同一份代码在 Debian 上跑 `tauri dev` 也能验证。

> 「本地 URL 需要先启动本地服务时怎么办」的三种方式（手动启动 / 应用自动启动 / 外部守护）
> 是用户向内容，见 [README.md §4.5 本地服务怎么启动](README.md#45-本地服务怎么启动)；
> 上面的 `spawn_local_service` 就是「应用自动启动」那条路径的实现。

---

## 6.5 自定义标题栏 / 右侧对话侧栏 / 关于窗口

> 用户向说明（顶栏菜单、两种加载模式、设置窗口）见 [README.md 使用说明](README.md#4-使用说明)；本节只讲实现要点。

### 顶栏与子 webview 实现要点

主窗口**没有系统标题栏**（`decorations(false)`），顶部 40px 换成自绘的菜单栏。
主窗口本身是一个**纯 `Window` 容器（不加载页面）**，页面由它的**子 webview**承载：

```text
主窗口 main（纯 Window，1200x800，decorations(false)）
┌──────────────────────────────────────────────────────────────────────┐
│ 应用 ▾   操作 ▾   网页对话              （拖动区域）      ─   □   ✕   │  ← 子 webview「titlebar」40px
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│              子 webview「content」（远程 DSH WebUI，无 IPC）           │
│                                                                      │
│                                          ┌────────────────────────┐  │
│                                          │ 子 webview「chat」      │  │
│                                          │ chat.deepseek.com       │  │
│                                          └────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

| 菜单 | 展开项 | 行为 |
| --- | --- | --- |
| **应用** | 关于 / 检查更新 / 重新连接 | 关于 → 打开「关于」窗口；检查更新 → 打开并自动检查；重新连接 → 与托盘「重新选择连接方式」**完全相同** |
| **操作** | 刷新 / 撤销 / 重做 | 刷新 = 内容 webview `.reload()`（等同 F5）；撤销 / 重做 = 发真实的 **Ctrl+Z / Ctrl+Y** |
| **网页对话** | （无下拉，直接动作） | 切换右侧侧栏子 webview，加载 <https://chat.deepseek.com/> |

**右侧对话侧栏**：主窗口内的第三个子 webview（首次点击时创建），贴在右侧、顶部让开顶栏；
「网页对话」再次点击即隐藏。

- 顶栏是主窗口内的一个**子 webview**（label `titlebar`），由 Rust 在 `add_child` 时
  用**客户区逻辑坐标**摆放到 `(0, 0)`、尺寸 `(宽, 40)`；内容 webview（label `content`）
  摆在 `(0, 40)`、尺寸 `(宽, 高-40)`。窗口 `Resized` / DPI 变化时重排一次。
  - **为什么用客户区坐标**：子 webview 的坐标是相对父窗口**客户区左上角**的，
    窗口整体移动不改变相对位置 ⇒ **不需要**任何 `Moved` 同步，从根上消除了
    「拖动窗口后顶栏错位」。
  - **绝不要手算 `× scale_factor`**：`LogicalSize` / `LogicalPosition` 收的就是逻辑单位，
    Tauri 内部会自己乘一次。手动再乘一次会让高度变成 2 倍（实测顶栏 158 device px ≈ 40×2×2）。
    静态校验脚本 `npm run verify` 里有专门的断言盯着这条。
  - `Window::add_child` 是 Tauri 的 multiwebview API，需要 `tauri` 的 **`unstable`** feature。
- **顶栏必须是本地页面**（`src/titlebar.html`）：只有本地来源才命中 `capabilities/default.json`，
  才有 IPC 权限去调 `chrome_action` / `window_control` 等命令。
  远程的 `content` 子 webview 按设计**不授予**任何 capability（见第 7 项）。
- **所有会创建 webview 的命令都必须是 `async`**：`add_child` 内部会阻塞等主线程，
  在同步命令（跑在主线程）或事件处理器里调用会**死锁** —— 表现为「点网页对话整个程序卡住、
  不报未响应、只能任务管理器强杀」。这是 Tauri 官方文档写明的坑。
- 主窗口虽然无边框，但 tao 只去掉 `WS_CAPTION`、保留 `WS_THICKFRAME`，所以**仍然可以拖边缘缩放**。
- 下拉菜单用**系统原生菜单**（`Menu::popup_at`），不是 HTML：外观跟随系统、不受裁剪。
- 拖动窗口由顶栏发起、拖的却是**主窗口**（`start_drag` 命令）；主窗口最大化时 Rust 侧直接忽略拖动。
- 撤销/重做**不能**用 `eval` 合成键盘事件 —— 合成事件不受信任，浏览器不会拿它触发 undo/redo。
  这里用 Win32 `SendInput` 发真实按键（先把焦点切回内容 webview）。
- 顶栏 webview 万一创建失败，会自动把主窗口退回**系统标题栏**，并把内容铺满客户区，
  不会留下一个既没标题栏又没按钮的无边框窗口。

### 6.5.1（实现）网页对话的两种加载模式

配置字段 `chatDocked`（默认 `false`）：`overlay`（默认，聊天覆盖在网页之上、网页整宽不变）
与 `docked`（网页让出 `CHAT_WIDTH`、与聊天并排）。

实现要点：几何全部由纯函数 `main_webview_rects(width, height, docked)` 算出，
`layout_main_webviews` 只负责把结果写进子 webview；`docked` 状态用
`static CHAT_DOCKED: AtomicBool` 缓存（**`Resized` 里不读盘**，只在启动与保存设置时刷新）。

### 6.5.2 侧栏开/关的过渡动画（v0.3.0）

Windows 11 的「动画效果」适配，实现在 `src-tauri/src/anim.rs`：

- 框架**没有**动画能力 —— wry 最终用 `SetWindowPos` 摆放子 webview，没有动画参数
  （证据见 [`docs/ANIMATION-FEASIBILITY.md`](docs/ANIMATION-FEASIBILITY.md)），
  所以是自己**逐帧插值**（180ms、约 60fps、ease-out cubic）。
- **只对 `overlay` 模式做滑动**：那种模式网页整宽不变，动画期间**尺寸不变、只改 x**，
  网页不需要重新布局，滑动很顺。
- **`docked` 模式不做滑动**：它必须改变网页宽度，逐帧改会让网页每帧重排、必然掉帧，
  所以直接切到位。
- 跟随系统设置：读 `SPI_GETCLIENTAREAANIMATION`，系统关掉「动画效果」时**直接切换**。
- 窗口缩放 / 收进托盘时 `anim::cancel()`，避免侧栏停在错误位置。

### 6.5.3（实现）「设置」窗口

> **`save_config` 是补丁语义**（只覆盖载荷里出现过的字段）。
> 这是必要的：选择窗口保存地址时的载荷**不含** `chatDocked`，
> 若按整对象反序列化，`#[serde(default)]` 会把它补成 `false`，
> 于是「设置里选了 docked → 之后改一次地址」会**静默退回 overlay**。

> **平台差异**：Linux（WebKitGTK）把子 webview 塞进一个竖向 `GtkBox`，会**忽略**指定的坐标与尺寸，
> 所以 Linux 下顶栏不会正确贴在顶部 40px。目标平台 Windows 走真正的子 HWND，坐标按传入值生效。
> Linux 只用于开发机自测。

---

## 7. `src-tauri/capabilities/` 权限配置

**默认假设：远程页面不需要调用本地 Rust 命令 → 默认不开放远程 IPC。**

### `capabilities/default.json`（生效）

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "本地窗口 / 本地 webview 的权限：调用应用自定义命令 + Tauri 核心 API。",
  "windows": ["selector", "about", "settings"],
  "webviews": ["titlebar"],
  "permissions": ["core:default"]
}
```

**这里为什么用 `webviews` 而不是 `windows`（很容易搞错，后果是静默失效）**

顶栏是主窗口 `main` 里的一个**子 webview**，label 是 `titlebar`。capability 的匹配规则是
「**webview label** 命中 `webviews`」**或**「**window label** 命中 `windows`」二者之一
（见 tauri 的 `RuntimeAuthority::resolve_access`）：

```rust
cmd.webviews.iter().any(|w| w.matches(webview))
  || cmd.windows.iter().any(|w| w.matches(window))
```

所以 `titlebar` **必须**写在 `webviews` 里；写成 `windows: ["titlebar"]` 是**不匹配**的
（窗口 label 是 `main`），顶栏所有按钮会**静默失效**，只在 devtools 里能看到
`not allowed` 之类的拒绝。

**另外，故意不把 `main` 放进 `windows`**：那会让主窗口的**所有**子 webview
（包括加载远程 DSH 页面的 `content`）都被这条 capability 覆盖。虽然 `local: true`
的来源检查仍会挡住远程来源，但显式只授权 `titlebar` 更清晰、更安全。

> `cargo test` 里有一条 `capability_covers_titlebar_webview_but_not_main_window`
> 专门盯住这个接线；改 label 或改权限会立刻测挂。

### `capabilities/remote-main.json.example`（默认不生效）

Tauri 只加载 `capabilities/*.json`，所以 `.example` 后缀天然是「关掉的」。需要时改名即可：

```json
{
  "identifier": "remote-main",
  "description": "主窗口加载远程页面时的权限（remote.urls 必须与窗口实际加载的 URL 完全一致）。",
  "windows": ["content"],
  "local": false,
  "remote": {
    "urls": ["http://127.0.0.1:3080", "https://dsh.example.com"]
  },
  "permissions": ["core:default"]
}
```

要点：

1. **主窗口即使没有任何 capability 也能正常渲染网页**。capability 只控制 IPC / 插件权限，不控制页面加载。
   远程的 `content` 子 webview 就是这种情况：无权限 → 正好符合「远程页面不需要本地能力」的默认假设。
2. 应用**自定义命令**（`load_config` 等）不需要在 `permissions` 里逐条列出；只要该 webview 被任一 capability 覆盖，就能 `invoke`。
3. 远程页面要用 Tauri API，必须 `"local": false` + `"remote": { "urls": [...] }`，且 **URL 必须完全匹配**（scheme + host + port）。改地址就要改这里。
4. 本项目 URL 是运行时可配置的，所以默认不启用——否则用户换个地址就会遇到「静默没权限」。这是有意的安全取舍，详见 [TROUBLESHOOTING §5](docs/TROUBLESHOOTING.md)。

---

## 8. `.github/workflows/release-windows.yml`

路径：[.github/workflows/release-windows.yml](.github/workflows/release-windows.yml)

```yaml
name: release-windows

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      create_release:
        description: "构建完成后创建 GitHub Release 并附带 NSIS 安装包"
        type: boolean
        default: false

permissions:
  contents: write

env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: "1"

jobs:
  build-windows:
    name: Build NSIS installer (Windows x86_64)
    runs-on: windows-latest
    # 版本号 / 渠道全部由 scripts/version.mjs 统一推导（v.A.B.C，release | rc）
    outputs:
      version:      ${{ steps.app.outputs.version }}
      channel:      ${{ steps.app.outputs.channel }}
      prerelease:   ${{ steps.app.outputs.prerelease }}
      display:      ${{ steps.app.outputs.display }}
      release_name: ${{ steps.app.outputs.release_name }}
      asset_name:   ${{ steps.app.outputs.asset_name }}
      tag:          ${{ steps.app.outputs.tag }}
      title:        ${{ steps.app.outputs.title }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: x86_64-pc-windows-msvc }
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri -> target
          key: windows-x86_64-msvc
      - name: Resolve version + channel (v.A.B.C, release | rc)
        id: app
        shell: pwsh
        run: node scripts/version.mjs --github
      - run: npm ci
      - name: Run tests (JS 单测 + 顶栏静态校验 + Rust 单测)
        run: |
          npm run test:js
          npm run verify
          npm run test:rust
      - run: npm run tauri build -- --bundles nsis
      - name: List bundle output
        shell: pwsh
        run: Get-ChildItem -Recurse src-tauri/target/release/bundle | Select-Object FullName, Length
      - uses: actions/upload-artifact@v4
        with:
          # 名字里带渠道，Release 与 RC 的产物不会互相覆盖
          name: ${{ steps.app.outputs.release_name }}-nsis
          path: src-tauri/target/release/bundle/nsis/*
          if-no-files-found: error
          retention-days: 30

  release:
    needs: build-windows
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' && inputs.create_release
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: ${{ needs.build-windows.outputs.release_name }}-nsis
          path: dist
          merge-multiple: true
      - name: Rename installer to release asset name
        run: |
          set -euo pipefail
          asset="${{ needs.build-windows.outputs.asset_name }}"
          src="$(ls dist/*.exe | head -1)"
          mv "$src" "dist/$asset"
          ls -l dist
      - uses: softprops/action-gh-release@v2
        with:
          # 渠道决定 tag：正式版 v.0.3.3，候选版 v.0.3.3-rc，两者互不覆盖
          tag_name: ${{ needs.build-windows.outputs.tag }}
          target_commitish: ${{ github.sha }}
          name: ${{ needs.build-windows.outputs.title }}
          draft: false
          prerelease: ${{ needs.build-windows.outputs.prerelease }}
          files: dist/*.exe
```

对应要求：触发 = push 到 `main` + `workflow_dispatch` ✅；runner = `windows-latest` ✅；
Node 22 / Rust stable / `x86_64-pc-windows-msvc` ✅；Rust 缓存 = `Swatinem/rust-cache@v2` ✅；
`npm ci` + `npm run tauri build -- --bundles nsis` ✅；
artifact 路径 = `src-tauri/target/release/bundle/nsis/*` ✅；顶层 `permissions: contents: write` ✅。

额外做的三件事：

1. **构建前跑测试**：`npm run test:js`（配置规则 + 顶栏 + 设置窗口单测）+ `npm run verify`（顶栏静态校验）+ `npm run test:rust`（Rust 单测）。
2. **版本号 + 渠道统一推导**：`node scripts/version.mjs --github` 产出 artifact 名、Release tag、标题、安装包文件名
   与 `prerelease` 标志，全部遵循 [§0.5 版本规则](README.md#63-版本规则)，不用手工改 workflow。
3. **渠道决定 Release 类型**：`release` 渠道出普通 Release，`rc` 渠道出 GitHub **prerelease**
   （`prerelease: ${{ needs.build-windows.outputs.prerelease }}`）。

> **注意**：`npm ci` 需要 `package-lock.json` 已提交；`npm ci` 不会写入 lockfile，也不会安装 `package.json` 之外的包。
> 如果你的环境设置了 `NODE_ENV=production`，`npm ci` 会跳过 devDependencies（Tauri CLI 就是 devDependency），
> 此时改用 `npm ci --include=dev`。GitHub Actions 默认不设这个变量，一般不用管。

---

### 能不能让 GitHub 自己测程序？（能，已实现）

**能。** `windows-latest` 有可用的交互桌面（实测 session 2），可以真正启动 GUI 程序并用 Win32 API 驱动/检查它。
所以本项目加了一个 `smoke-windows` job（与出包 job 并行），**不需要你在 Win11 上手动点**：

[`scripts/smoke-windows.ps1`](scripts/smoke-windows.ps1) 在 runner 上做的事：

分四段，共 39 条断言：

**A. 首次连接**

| 检查 | 手段 |
| --- | --- |
| 应用能启动 | `Start-Process` + 进程存活 |
| 选择窗口出来了且尺寸对 | 按进程枚举顶层窗口（`EnumWindows`），匹配标题或客户区 560×460 |
| 点击「本地」 | `SetCursorPos` + `mouse_event` 按客户区坐标点击（和真人点击同一条路径） |
| 主窗口出来了 | 匹配标题 `DSHTauri` 或客户区 ~1200×800（runner 屏幕小，会被钳制到 1028×749，所以用容差） |
| **界面没卡死** | `IsHungAppWindow` + `SendMessageTimeout(WM_NULL, SMTO_ABORTIFHUNG)` |
| **页面真的在加载（不是白屏）** | 本地测试服务是否收到来自 WebView2 的 HTTP 请求 |
| 连接后选择窗口隐藏 | `IsWindowVisible=false` |
| 顶栏 / 内容子 webview 几何正确 | 命中测试：顶栏在客户区顶部且高 ≈ 40×scale（防 DPI 双重缩放） |
| **「网页对话」不卡死** | 点击后 `IsHungAppWindow=false`、仍响应 `WM_NULL`、进程存活、多出侧栏子 webview |
| 侧栏动画结束位置正确 | 动画结束后侧栏停在客户区右侧（overlay 目标位置），可反复切换 |
| **关闭 = 隐藏到托盘** | `PostMessage(WM_CLOSE)` 后：进程仍存活 且主窗口不可见 |

**B. 切换连接方式**（模拟托盘「重新选择连接方式」）

| 检查 | 手段 |
| --- | --- |
| 选择窗口能重新显示 | `ShowWindow` + `IsWindowVisible` |
| **主窗口被复用而不是销毁重建** | 切换后原 HWND 仍然有效（`IsWindow`） |
| 切换后主窗口未卡死 / 仍可见 / 仍是活动窗口 | `IsResponsive` / `IsWindowVisible` / `GetForegroundWindow` |
| **确实切到了新地址** | 第二个测试服务收到来自 WebView2 的请求 |

**C. 进程生命周期**（自动启动的本地服务必须随主程序结束）

| 检查 | 手段 |
| --- | --- |
| 服务确实被拉起来了 | 假服务端口进入监听 |
| **主程序退出后服务也结束** | 强杀主程序 → 端口关闭 |

**D. Cookie / 登录态持久化**

| 检查 | 手段 |
| --- | --- |
| 页面能写入 cookie | 测试服务记录到页面写入 |
| **持久 cookie 跨重启保留** | 重启后仍能读到 |
| **会话 cookie 也被转成持久 cookie** | 重启后会话 cookie 仍在（`persist_session_cookies`） |

> A 段那几条「卡死 / 白屏 / × 点不动」的检查抓出了本项目的 Windows 专属 bug：
> 修复前 `12 通过 / 2 失败`，修复后 `14 通过 / 0 失败`。
> B、C 两段是 v0.1.2 为「切换连接无反应」「本地服务不随主程序退出」两个问题补的；
> D 段是 v0.2.0 为「每次启动都要重新登录」补的。

**怎么读 CI 的日志？** job 日志和 artifact 都要 token 才能下载。所以这个 job 会把完整输出推到
**`ci-logs` 分支**的 `smoke-windows.txt`（该分支不触发 workflow），直接用浏览器或 curl 就能看：

```bash
curl -s https://raw.githubusercontent.com/tianyimc/DSH-Tauri/ci-logs/smoke-windows.txt
```

内容包含：脚本逐条 `[PASS]/[FAIL]`、应用自身的 stdout/stderr、以及失败时进程/桌面的窗口清单。

> ⚠️ 这个测试**不能替代**安装向导本身的验收（NSIS 交互、开始菜单快捷方式、卸载），
> 但「应用跑起来之后的所有行为」都能在 CI 上自动覆盖。

---

## 9. 在 Debian 上从零到推送的完整命令

```bash
# ---------- 0. 系统依赖（Debian 12/13，仅 Linux 开发/验证需要）----------
sudo apt-get update
sudo apt-get install -y \
  curl build-essential pkg-config file \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# ---------- 1. Node 22 + Rust stable ----------
node -v          # 需要 >= 22；否则用 nvm：nvm install 22 && nvm use 22
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"          # ★ 必须执行！否则 npm run tauri dev 会报
                                   #   failed to run 'cargo metadata' ... No such file or directory
rustc -Vv && cargo -V

# ---------- 2. 拿到项目（二选一）----------
# 2a. 已经在本地写好了：直接进目录
cd ~/projects/DSHTauri

# 2b. 或者从零建一个空仓库
#   mkdir -p ~/projects/DSHTauri && cd ~/projects/DSHTauri && git init

# ---------- 2c. 环境自检（强烈建议先跑一次）----------
node scripts/check-env.mjs
#   Rust 若装在非标准位置（例如项目内的 .toolchain/），它会直接打印可复制的修复命令。
#   本项目自带的工具链也可以一条命令接入当前 shell：
#   source scripts/env.sh

# ---------- 3. 安装依赖 ----------
npm install                 # 生成 package-lock.json（只需一次，之后 CI 用 npm ci）

# ---------- 4. 图标（仓库已包含生成结果；换了 logo 才需要重跑）----------
#   换 logo：把新的鲸鱼 PNG（透明底、方形）放到 src-tauri/icons/tray-light.png，然后
node scripts/post-icon.mjs  # 清理移动端图标 + 调用 make-logo.mjs 派生全套（icon.ico / app-*.png / 各尺寸 PNG）
#   需要 ImageMagick（convert）；没有它 make-logo.mjs 会安全跳过，不会让打包失败

# ---------- 5. 本地跑起来（验收标准 1）----------
npm run tauri dev
#   无桌面环境时用虚拟显示：
#   xvfb-run -a -s "-screen 0 1400x900x24" npm run tauri dev

# ---------- 5b. 跑单元测试 ----------
npm run test:js                        # 配置规则（含「只配一个地址」）+ 顶栏 + 设置窗口
npm run verify                         # 顶栏静态校验（防止手算 scale_factor 之类的回归）
npm run test:rust                      # Rust 单测：图标、版本号、配置序列化

# ---------- 5c.（可选）无头自动冒烟测试：21 项断言 ----------
sudo apt-get install -y xvfb xdotool wmctrl openbox dbus-x11
(cd src-tauri && cargo build)          # 脚本用 target/debug/dshtauri
npm run smoke                          # 期望输出：21 通过, 0 失败

# ---------- 6.（可选）验证 Windows 目标能编译，不需要 Windows 机器 ----------
rustup target add x86_64-pc-windows-msvc
(cd src-tauri && cargo check --target x86_64-pc-windows-msvc)
#   Debian 上需要 llvm-rc 才能跑 tauri-build 的资源嵌入步骤：
#   sudo apt-get install -y llvm

# ---------- 7. 初始化 git 并推送 ----------
git init
git add .
git status                  # 确认没有 node_modules / target / .toolchain
git commit -m "feat: DSHTauri Tauri 2 desktop shell (WebView2 + tray + local/remote selector)"
git branch -M main

# 在 GitHub 网页上先建一个空仓库（不要勾 README/.gitignore），然后：
# 本仓库的 origin 已经配好了：
#   git@github.com:tianyimc/DSH-Tauri.git
git remote -v
git push -u origin main
```

**在 GitHub 上要做的操作**（你要求的流程）：

1. 打开 <https://github.com/new>，Repository name 填 `DSHTauri`，**不要**勾 "Add a README file"，点 Create。
2. 回到终端执行上面的 `git remote add` + `git push -u origin main`。
3. 推送成功后，仓库页顶部会出现 **Actions** 标签页，点进去能看到 `release-windows` 工作流已经因为 push 到 `main` 自动开始运行。
4. 首次运行大约 8–15 分钟（要编译整个 Tauri 依赖树 + 下载 NSIS）。之后有 Rust 缓存，通常 3–6 分钟。
5. 想要一个 GitHub Release（可分享的 `.exe` 下载页）：**Actions → release-windows → Run workflow → 勾选 `create_release` → Run**。

> SSH key：`ssh-keygen -t ed25519 -C "you@example.com"`，把 `~/.ssh/id_ed25519.pub` 内容贴到 GitHub → Settings → SSH and GPG keys → New SSH key。

---

## 10. 构建成功后：看 Actions、下载 `.exe`

**看 Actions 日志**

1. 仓库页 → **Actions** → 左侧 `release-windows` → 点本次运行（绿勾 ✅ / 红叉 ❌）。
2. 点 `Build NSIS installer (Windows x86_64)` job，展开每一步看日志。
3. 关键步骤：
   - `Install frontend dependencies` → 应显示 `added N packages`
   - `Build NSIS bundle` → 最后应有 `Finished 1 bundle at: ...\bundle\nsis\DSHTauri_0.3.3_x64-setup.exe`
   - `List bundle output` → 打印产物全路径和大小
4. 失败了先看 **红叉那一步的最后 30 行**，对照 [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)。

**下载 `.exe`**

两种方式：

| 方式 | 步骤 | 适合 |
| --- | --- | --- |
| **Artifact**（每次运行都有） | 运行详情页最下方 **Artifacts** → 点 `DSHTauri v.0.3.3-nsis` 下载 zip → 解压得到 `DSHTauri_0.3.3_x64-setup.exe`（Tauri 自己的命名） | 自己测试 |
| **Release**（勾了 `create_release` 才有） | 仓库页右侧 **Releases** → 点对应版本 → **Assets** 里直接下 `.exe` | 发给别人 |

Release 里的文件名按 [§0.5 版本规则](README.md#63-版本规则) 命名，例如正式版 `DSHTauri-v.0.3.3-setup.exe`、
RC 版 `DSHTauri-v.0.4.0-RC-setup.exe`；两者 tag 不同（`v0.4.0` / `v0.4.0-rc`），**不会覆盖前一份**。

> Tauri 自己产出的文件始终叫 `DSHTauri_<A.B.C>_x64-setup.exe`（它不认识渠道后缀），
> Release 步骤会把它改名成规则里的名字再上传，并据渠道设置 `prerelease`。

---

## 11. 排错用的环境自检与日志命令

> 面向用户的常见问题与排查入口见 [README.md 常见问题与排查](README.md#5-常见问题与排查)。

完整版见 **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**，覆盖 7 类典型问题，外加 1 类必踩的环境问题：

1. [托盘图标不显示](docs/TROUBLESHOOTING.md#1-托盘图标不显示)
2. [关闭窗口未隐藏到托盘](docs/TROUBLESHOOTING.md#2-关闭窗口未隐藏到托盘程序直接退出了)
3. [NSIS 打包失败](docs/TROUBLESHOOTING.md#3-nsis-打包失败)
4. [图标格式错误](docs/TROUBLESHOOTING.md#4-图标格式错误)
5. [remote capabilities 权限错误](docs/TROUBLESHOOTING.md#5-remote-capabilities-权限错误)
6. [WebView2 加载远程 URL 白屏](docs/TROUBLESHOOTING.md#6-webview2-加载远程-url-白屏)
7. [选择界面到主窗口的 URL 传递失败](docs/TROUBLESHOOTING.md#7-选择界面到主窗口的-url-传递失败)
8. [`npm run tauri dev` 报 `cargo metadata ... No such file or directory`](docs/TROUBLESHOOTING.md#8-npm-run-tauri-dev-报-cargo-metadata--no-such-file-or-directory) ← **第一次跑最常踩，先看这条**

**先跑一次环境自检，能省掉大半排查**：

```bash
node scripts/check-env.mjs      # 检查 Node / cargo / RUSTUP_HOME / Tauri CLI / 前端资源 / 构建目标
```

**遇到编译或打包错误时，请把这两样贴出来**（你要求的「先要完整日志」）：

```bash
npm run tauri info                                            # 环境快照
npm run tauri build -- --bundles nsis --verbose 2>&1 | tail -100   # 完整打包日志
```

---

## 验收标准对照

| 验收标准 | 状态 | 证据 |
| --- | --- | --- |
| Debian 上 `npm run tauri dev` 能打开选择界面 | ✅ 已验证 | Linux `cargo build` 成功；Xvfb 下真实启动，`xdotool` 检测到标题「选择 DSH 连接方式」、尺寸 560x460 的窗口 |
| 点击「本地」/「远程」后主窗口加载对应 URL | ✅ 已验证 | 点击后出现标题 `DSHTauri`、**1200x800** 的窗口；本地测试 HTTP 服务记录到来自 WebView 的 `GET /`（UA: `AppleWebKit/605.1.15 ... Safari/605.1.15`） |
| 关闭主窗口后程序仍在托盘中运行 | ✅ 已验证 | 发送真正的 `WM_DELETE_WINDOW` 后：进程仍存活、窗口不可见、无 GTK 报错 |
| 托盘菜单可以重新显示窗口或退出 | ✅ 代码已实现（托盘创建已实测成功） | 应用日志无「系统托盘创建失败」告警 ⇒ `setup_tray` 返回 `Ok`；而「关闭即隐藏」只在托盘就绪时生效，它确实生效了 ⇒ 托盘已建好。菜单项点击本身需要真实桌面面板，无法在无头环境自动化 |
| 首次点击要求用户提供配置并记录 | ✅ 已验证 | 地址默认为空；无 `config.json` 时点击「本地」：**不打开主窗口、不写配置**；填入地址并保存后才生成 `config.json` 并打开主窗口 |
| **本地 / 远程允许只配一个** | ✅ 已验证（端到端 + 单测） | 冒烟测试分两轮：只填本地 → 连上，`config.json` 里 `"remoteUrl":""`；清空重来只填远程 → 同样连上，`"localUrl":""`。另有 23 条 JS 单测覆盖校验规则 |
| 推送到 GitHub 后 Actions 在 `windows-latest` 成功运行 | ✅ 已验证 | [run #36974080393](https://github.com/tianyimc/DSH-Tauri/actions/runs/36974080393) @ `4ac4267`：全部步骤绿（含 `Resolve version` / `Run tests` / `Build NSIS bundle` / `Upload NSIS installer`） |
| Artifact 中存在 NSIS `.exe` | ✅ 已验证 | Artifact 名形如 `DSHTauri v.0.3.3-nsis`，1.21 MB，未过期。`Upload NSIS installer` 设了 `if-no-files-found: error`，步骤成功即证明 `bundle/nsis/` 非空。（下载 artifact 走 API 需要 token，我没法直接取包内文件） |
| Windows 11 安装后功能正常 | ✅ 核心链路已在真实 Windows 上验证 | `windows-latest` 上的 GUI 冒烟测试 **26/26 通过**：选择窗口 560x460 → 点击「本地」→ 主窗口出现且不卡死 → WebView2 真的发起了请求（不再白屏）→ `WM_CLOSE` 后进程存活且窗口隐藏（× 可用）。剩余的人工项只有 NSIS 安装向导交互本身 |
| ~~主窗口白屏 + × 点不动~~ | ✅ 已修复并验证 | 同一套冒烟测试：修复前 `12 通过 / 2 失败`，修复后 `14 通过 / 0 失败`。根因与修复见 [CHANGELOG](CHANGELOG.md#v011) |
| ~~切换连接方式无反应~~ | ✅ 已修复并验证 | 冒烟测试 B 段：切换后主窗口被复用（HWND 不变）、未卡死、新地址确实收到 WebView2 请求。见 [CHANGELOG](CHANGELOG.md#v012) |
| ~~本地服务不随主程序退出~~ | ✅ 已修复并验证 | 冒烟测试 C 段：假服务端口在监听 → 强杀主程序 → 端口关闭。见 [CHANGELOG](CHANGELOG.md#v012) |
| ~~每次启动都要重新登录~~ | ✅ 已修复并验证 | 冒烟测试 D 段：重启后**持久 cookie 与会话 cookie 都在**。见 [CHANGELOG](CHANGELOG.md#v020) |
| 自定义标题栏 / 侧栏 | ✅ 已实现并验证 | 主窗口无系统标题栏、顶部 40px 自绘菜单栏（应用 / 操作 / 网页对话），冒烟测试仍能识别并操作主窗口 |

复现方式：`npm run smoke`（需要 `xvfb xdotool wmctrl openbox dbus-x11`）。当前结果：**21 通过 / 0 失败**。

---

## 设计决策速查

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 前端方案 | 纯静态 HTML/CSS/JS | 无构建步骤、无框架依赖，二进制最小、启动最快 |
| 单窗口路由 vs 双窗口 | 双窗口（`selector` + `main`） | 主窗口要加载**外部 URL**，和本地选择页面的 origin 不同，拆开最干净 |
| 托盘 | Tauri 2 官方 `tauri::tray` | 不引第三方插件，符合「优先官方 API」 |
| 配置存储 | 手写 JSON 到 app config dir | 少一个插件依赖；格式可读、可手改 |
| 本地服务等待 | 前端轮询 `probe_url` | 同步命令跑主线程，Rust 里 sleep 会冻界面 |
| 命令是否 async | **建窗口的命令一律 `async fn`** | 同步命令跑在主线程（事件循环）里，若这条命令来自某个 webview 的 IPC，则主线程正处于该 webview 的回调中；此时同步创建「窗口 + WebView2」会让新 webview 永远初始化不完（白屏），并让消息处理进入坏状态（点 × 无反应）。详见 [CHANGELOG](CHANGELOG.md) |
| 选择窗口 | 打开主窗口时 `hide()`，不 `destroy()` | 销毁「正在执行 IPC 的 webview」会出问题；留着还能用托盘「重新选择连接方式」叫回来 |
| 远程页面权限 | 默认关闭 | 用户可改 URL，静态 capability 无法覆盖；默认最小权限 |
| 打包目标 | 只做 NSIS | 按需求，不要 MSI |
| 版本号 | `v.A.B.C` + 渠道（`release` / `rc`）；`A.B.C` 在 `tauri.conf.json`，渠道在 `version.json` | 两处各自唯一，`scripts/version.mjs` 负责同步与推导发布名；渠道决定显示名（` RC`）、文件名（`-RC`）与 tag（`-rc`），RC 与正式版可共存 |
| 图标 | 单一 logo，由 `scripts/make-logo.mjs` 从 `tray-light.png` 派生 | 用户要求「统一成托盘那只小鲸鱼」；ico 固定深藏青（资源管理器不认主题），运行时窗口/托盘图标另出 `app-dark`/`app-light` 按主题切换 |
| 配置校验 | 抽成 `src/config-rules.js` 纯函数，浏览器与 Node 共用 | 「只配一个地址」是核心规则，必须可单测；前端因此用 ES module |
| 地址默认值 | 两个都留空 | 需求要求允许只配一个，预填反而要用户先删 |

---

## 验证记录（本仓库实际跑过的检查）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| `tauri.conf.json` 符合官方 schema | `ajv validate -s https://schema.tauri.app/config/2` | ✅ VALID |
| capability 符合 Tauri 生成的 schema | `ajv validate -s src-tauri/gen/schemas/desktop-schema.json` | ✅ VALID（`default.json` 与 `remote-main.json.example` 都通过） |
| capability 被正确加载 | 查看 `src-tauri/gen/schemas/capabilities.json` | ✅ 只含 `default`（`windows: ["selector"]`, `local: true`），`.example` 未生效 |
| Windows 目标可编译 | `cargo check --target x86_64-pc-windows-msvc` | ✅ `Finished` |
| Linux 目标可编译 | `cargo build` | ✅ `Finished` |
| Clippy 无告警 | `cargo clippy --all-targets` | ✅ 0 warning |
| JS 单元测试 | `npm run test:js` | ✅ 109 通过（配置规则、顶栏纯函数与接线对账、设置窗口、双通道更新检查） |
| 顶栏静态校验 | `npm run verify` | ✅ 64 通过 / 0 失败 |
| Rust 单元测试 | `npm run test:rust` | ✅ 44 通过（图标解码与主题配色、配置 camelCase 契约与补丁语义、侧栏几何、版本号与 tauri.conf.json 一致） |
| 版本号 / 渠道工具 | `npm run ver` / `--set` / `--set-channel` | ✅ 当前 `0.3.3` + `release` → 显示 `v.0.3.3`、包名 `DSHTauri-v.0.3.3-setup.exe`、tag `v.0.3.3`、`prerelease=false` |
| 图标 | `node scripts/post-icon.mjs` → `src-tauri/icons/icon.ico` | ✅ 7 档：256/128/64/48/32/24/16（实测解析 ICO 头） |
| 工作流 YAML | `python3 -c "yaml.safe_load(...)"` | ✅ 解析通过，`permissions: contents: write` 就位 |
| Linux 端到端冒烟 | `npm run smoke` | ✅ 21 通过 / 0 失败 |
| **Windows 真实 GUI 冒烟** | CI job `smoke-windows`（`scripts/smoke-windows.ps1`） | ✅ **30 通过 / 0 失败** —— 在 `windows-latest` 上真正启动 exe：窗口尺寸、界面不卡死（`IsHungAppWindow`）、WebView2 真的发起了 HTTP 请求、`WM_CLOSE` 后隐藏到托盘、切换连接复用主窗口、自动启动的服务随主程序退出、**持久 cookie 与会话 cookie 都跨重启保留** |

> 说明：`cargo check --target x86_64-pc-windows-msvc` 在 Debian 上需要 `llvm`（提供 `llvm-rc`，`tauri-build` 用它嵌入 Windows 资源）。这只影响**在 Linux 上预检 Windows 目标**；GitHub Actions 上用的是真正的 MSVC 工具链，不需要这一步。
>
> 踩过的坑记录：`xdotool windowclose` 是**销毁窗口**（不触发 `CloseRequested`），用它测「关闭到托盘」会得到假结论。必须用 `wmctrl -i -c` 发送真正的 `WM_DELETE_WINDOW`。`scripts/smoke-linux.sh` 里用的是后者。

---

## 6.6 内存与挂起策略（v0.3.4）

### 模块

`src-tauri/src/wv_suspend.rs` —— WebView2 挂起（等价 Edge 的「标签页休眠」）。

- `SuspendSlot`：每个 webview 一份「代次 + 挂起标志」，纯逻辑、可单测。
- `suspend()` / `resume()`：调 `ICoreWebView2_3::TrySuspend` / `Resume`。
- `set_controller_visible()`：显式设 controller 可见性。
- 非 Windows 下全部为空实现（保证 Linux 上 `cargo test` / `cargo check` 通过）。

### 两个硬性约束（违反会**静默失效**）

1. **`TrySuspend` 要求 controller 的 `IsVisible == false`**，否则返回
   `ERROR_INVALID_STATE`。
   - 子 webview 的 `hide()` 会设它 ⇒ 「关侧栏挂起 chat」顺序天然正确；
   - 但 `Window::hide()`（收托盘）**不会** ⇒ 必须先 `set_controller_visible(false)`。
   两条路径的顺序都有静态守卫断言。
2. **`GetCookies` 这类 API 可能意外唤醒挂起的 webview** ⇒ cookie 保活线程
   （每 20 秒遍历 content/chat）必须先查 `should_skip_cookie_persist()`，
   否则挂起每 20 秒失效一次。

### 代次（generation）防竞态

`TrySuspend` 回调是异步的，用户可能「关掉侧栏立刻又打开」。
`confirm_suspend(generation, ok)` 只在代次未变时认账；代次变了就拒绝
（否则迟到的回调会把刚打开的侧栏又标记成挂起 —— 与 `anim.rs` 的
`ANIM_GENERATION` / `should_run_on_done` 是同一类防护）。

### 关闭策略（`close_disposition`）

| label | 点「×」时 | 理由 |
| --- | --- | --- |
| `main` | 收进托盘 | 关闭 ≠ 退出 |
| `selector` | **有主窗口→销毁；无主窗口→隐藏** | 一次性界面，连接后销毁以释放 renderer；但它是唯一窗口时不能销毁（销毁最后一个窗口会让程序退出）。重建见 `reveal_selector` |
| `about` / `settings` | **销毁** | 本地小页面，重建快；隐藏则 renderer 一直占内存 |
| 其它 | 隐藏 | 保守，绝不误销毁未知窗口 |

⚠️ `close_disposition(label, has_main_window)` 是**纯函数**（两个参数），
`has_main_window` 在事件处理器里**现查**（主窗口可能刚创建或刚销毁）。

`selector` 与 `about` / `settings` 的重建都带一次重试（间隔 150ms）：
`destroy()` 是异步的，`build()` 可能赶在旧 WebView2 释放前执行。

### ⚠️ 实测结论：挂起**不降**任务管理器数字

CI（windows-latest）实测：`TrySuspend` **调用成功**（日志有「已挂起 webview」），
但工作集与私有内存**都没下降**。原因是 API 语义 —— 文档原文
*"allows the operating system to **reuse** the memory"*，即标记为**可回收**
而非立即释放；测试机有约 13GB 空闲内存，内核没有回收压力。

**因此不要用「内存下降」来验证挂起是否生效** —— 必须看日志。
也不能用「隐藏后页面心跳停止」验证：Chromium 自己就会节流隐藏页的定时器，
两者行为上无法区分（这个推理错误在 v0.3.4 开发中被发现并修正）。

真正降常驻内存只能靠**销毁**（挂起只把内存标记为可回收，不降工作集）。
实测增量：多开一个**重型**远程页面（chat）私有 +109MB、WV2 进程 +2；
两个**轻量**页面（顶栏 + 本地测试页）+63MB。
注意**不要**把「只有选择窗口时整个应用的私有内存」当成「选择窗口一个 renderer 的占用」
—— 前者含主程序与 WebView2 browser/GPU/utility。代价见 README §4.7。

### 内存测量

`scripts/smoke-windows.ps1` 的 `Get-AppMemoryMB` / `Write-MemSample`：
以 `dshtauri.exe` 为根**递归**收集子进程（只统计这棵树，避免把 CI 机器上
其它 WebView2 宿主算进来），记录工作集 + 私有 + WV2 进程数 + 系统可用内存。

⚠️ 实现中踩过的坑（都已修）：
- `@($byParent[$cur])` 在无子进程时得到 `@($null)` ⇒ 会往结果里塞空行；
- 循环变量**不能叫 `$pid`**（PowerShell 只读自动变量，赋值直接抛异常）；
- 汇总表用 `"{1,>10}"` 会**运行时**抛 .NET 格式异常（`ParseFile` 语法检查抓不住），
  已加静态守卫拦 `{n,>...}`。

---

## 12. 许可证与项目定位

### 许可证

本项目以 **Apache License 2.0** 授权，全文见仓库根目录 [LICENSE](LICENSE)。

对贡献者的实际含义：

- **可以**自由使用、修改、分发，**包括商业用途**；
- **必须保留**版权、作者与出处信息；
- **必须保留 NOTICE 文件**（若提供）中的署名信息；
- 若修改了文件，需**标注修改**；
- 分发时需附带一份 Apache-2.0 许可证副本。

> 这正是用户要求的「**必须永远保留原作者信息**」的落地方式：Apache-2.0 允许自由使用，
> 但不允许抹掉作者信息。

现状说明（诚实记录）：本仓库目前**没有** `NOTICE` 文件，源文件里也**尚未**统一添加
版权/许可头（各文件只有描述性注释）。因此「保留作者信息」目前主要靠
**LICENSE 全文 + 仓库元信息**（`package.json` 的 `description` / `authors`、
`tauri.conf.json` 的 `publisher`）承载。若后续要加强合规，可考虑补一个 `NOTICE` 文件，
并给源文件加统一的版权头。

### 项目定位：第三方客户端，与 DeepSeek 官方无关

- DSHTauri 是**第三方**开源项目，**非** DeepSeek 官方出品，**未获**官方背书或授权。
- 它是**客户端连接程序**：只把用户**自己**运行起来的 DSH WebUI 装进原生窗口，
  **不包含、不捆绑、不代替** DSH 本体（模型、Agent、工具链、WebUI 服务都不在本仓库与安装包内）。
- DSH 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 本项目仓库：<https://github.com/tianyimc/DSH-Tauri>
- 作者主页：<https://tianyimc.com>

> 面向用户的同一说明见 [README.md §1.1](README.md#11-第三方客户端声明与-deepseek-官方无关)。
