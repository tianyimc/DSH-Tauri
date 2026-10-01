# DSHTauri

把 DSH 终端的 WebUI 封装成 **Windows 11 轻量桌面应用**：Tauri 2 + 系统原生 **WebView2**（绝不捆绑 Chromium）+ 系统托盘 + 启动时「本地 / 远程」二选一。

- 目标平台：Windows 10/11 x86_64
- 安装包：**NSIS `.exe`**（不用 MSI）
- 开发机：Debian x86_64，只跑 `tauri dev` 验证界面；**Windows 产物全部由 GitHub Actions 在 `windows-latest` 上原生编译**
- 代码签名：暂不要求

> 本文档里的所有代码都在仓库里，文件即最终产物。下面按你要求的顺序逐项说明，每个文件都给出路径和要点。

---

## 0. 模板变量对照

需求里的占位符在本项目中的取值（**改这些地方即可**）：

| 占位符 | 取值 | 改哪里 |
| --- | --- | --- |
| `{{APP_NAME}}` | `DSHTauri` | `src-tauri/tauri.conf.json` → `productName`、`src-tauri/src/lib.rs` → `MAIN_TITLE` |
| `{{NODE_VERSION}}` | `22` | `.github/workflows/release-windows.yml` → `node-version` |
| `{{LOCAL_URL}}` | `http://127.0.0.1:8080` | 运行时在「设置」里改；默认值在 `lib.rs` 的 `DEFAULT_LOCAL_URL` 和 `src/selector.js` 的 `DEFAULT_CONFIG` |
| `{{REMOTE_URL}}` | `https://dsh.example.com` | 同上（`DEFAULT_REMOTE_URL`） |
| `{{WINDOW_SIZE}}` | `1200x800` | `src-tauri/src/lib.rs` → `MAIN_WIDTH` / `MAIN_HEIGHT` |
| 远程页面是否需要本地 Rust 命令 | **否**（默认不开放） | 需要时见 [§7](#7-src-tauri-capabilities权限配置) |

**每次启动都要选，地址只设置一次**（需求里「首次点击要求用户提供并记录在配置文件」和「选择不需要持久化」看起来冲突，本项目按下面这条语义实现，已与需求方确认）：

- **每次启动都显示选择界面**，必须点「本地」或「远程」——**「选择」本身不持久化**；
- **首次**点击时弹出表单让用户确认地址，保存进 `config.json`——**「地址」持久化**；
- 之后每次启动读同一份配置，点一下就直接连接，**不需要再设置地址**；
- 地址随时可在「设置」里改。

对应代码：`src/selector.js` 的 `pick()` 判断 `config.configured`——未配置过才弹表单，已配置直接 `connect(mode)`。

---

## 1. 项目文件树

```text
DSHTauri/
├── .github/
│   └── workflows/
│       └── release-windows.yml     # 第 8 项：windows-latest + NSIS + artifact
├── docs/
│   └── TROUBLESHOOTING.md          # 第 11 项：常见错误与排查
├── scripts/
│   ├── check-env.mjs               # 环境自检：cargo 不在 PATH 等问题直接给修复命令
│   ├── env.sh                      # `source scripts/env.sh` 接入项目自带 Rust 工具链
│   ├── make-icon.mjs               # 生成 app-icon.png（纯 Node，无需图形库）
│   └── smoke-linux.sh              # Xvfb 下的无头冒烟测试（15 项断言）
├── src/                            # 前端（无框架、无构建步骤，直接嵌入二进制）
│   ├── index.html                  # 选择界面
│   ├── selector.css
│   └── selector.js                 # 调用 Rust 命令
├── src-tauri/
│   ├── capabilities/
│   │   ├── default.json            # 第 7 项：选择窗口权限
│   │   └── remote-main.json.example# 第 7 项：远程页面 IPC 权限（可选，默认不生效）
│   ├── icons/                      # 由 `npm run icon` 生成（含 icon.ico）
│   ├── src/
│   │   ├── lib.rs                  # 第 6 项：托盘 / 关闭隐藏 / 命令
│   │   └── main.rs                 # 薄壳入口
│   ├── build.rs
│   ├── Cargo.toml                  # 第 5 项
│   ├── Cargo.lock                  # 提交它，保证 CI 可复现
│   └── tauri.conf.json             # 第 3 项
├── app-icon.png                    # 图标源文件（当前为 DeepSeek 鲸鱼 logo，225x225 透明 PNG）
├── deepseek.ico                    # 用户提供的原始 ico（保留备查，不参与构建）
├── package.json                    # 第 2 项
├── package-lock.json               # `npm ci` 依赖它
├── .gitignore
└── README.md
```

> `src-tauri/gen/schemas/` 是 `tauri-build` 在构建时生成的权限 schema，已在 `.gitignore` 中忽略，不要提交。

---

## 2. `package.json`

路径：[package.json](package.json)

```json
{
  "name": "dshtauri",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build",
    "build:nsis": "tauri build --bundles nsis",
    "icon": "tauri icon app-icon.png"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.12.1"
  }
}
```

要点：
- **只有一个依赖**：Tauri CLI。前端是纯静态 HTML/CSS/JS，**没有 Vite / 没有框架**，所以不需要 `beforeDevCommand`，也不需要 `beforeBuildCommand`，打包体积和启动开销都最小。
- `npm run tauri build -- --bundles nsis` 里的 `--` 是把参数透传给 `tauri` 子命令，必须写。

---

## 3. `src-tauri/tauri.conf.json`

路径：[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "DSHTauri",
  "version": "0.1.0",
  "identifier": "com.dsh.dshtauri",
  "build": {
    "frontendDist": "../src"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "selector",
        "title": "选择 DSH 连接方式",
        "url": "index.html",
        "width": 560,
        "height": 460,
        "minWidth": 460,
        "minHeight": 380,
        "resizable": true,
        "maximizable": false,
        "center": true,
        "visible": true,
        "decorations": true,
        "focus": true
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
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
      "webviewInstallMode": { "type": "downloadBootstrapper", "silent": true },
      "nsis": {
        "installMode": "currentUser",
        "languages": ["SimpChinese", "English"],
        "displayLanguageSelector": false,
        "compression": "lzma"
      }
    }
  }
}
```

对应你的要求逐条说明：

| 要求 | 实现方式 |
| --- | --- |
| 主窗口不直接加载 URL，先加载本地选择页面 | `app.windows[0]` 只有一个 `label: "selector"` 的窗口，`url: "index.html"`（来自 `frontendDist: "../src"`）。主窗口**完全由 Rust 动态创建**（见 §6） |
| 两个窗口 or 单窗口路由切换 | 采用**两个窗口**：`selector`（静态配置）+ `main`（`WebviewWindowBuilder` 运行时创建）。选择完成后 `selector.destroy()` |
| `bundle.targets` 含 `nsis` | `"targets": ["nsis"]` |
| `bundle.icon` 含 `.ico` | `"icons/icon.ico"`（路径相对 `src-tauri/`） |
| 窗口标题为 `{{APP_NAME}}` | 主窗口标题在 `lib.rs` 的 `MAIN_TITLE = "DSHTauri"`；选择窗口标题是「选择 DSH 连接方式」 |
| 无构建步骤 | 不写 `devUrl` / `beforeDevCommand`。Tauri CLI 官方说明：*"If you don't have a dev server or don't want to use one, ignore this option and use `frontendDist` … Tauri CLI will run its built-in dev server and provide a simple hot-reload experience."* |
| `withGlobalTauri` | 必须为 `true`，否则静态页面拿不到 `window.__TAURI__`，选择界面无法调用 Rust 命令 |
| CSP | 设为 `null` = 不注入 CSP。远程 WebUI 往往有自己的 CSP/内联脚本，由 Tauri 再注入一份容易白屏。见 [§4 安全说明](#4-选择界面前端) |

### 图标

| 项 | 值 |
| --- | --- |
| 源文件 | `app-icon.png` —— DeepSeek 鲸鱼 logo，225×225，透明背景，纯色 `#020E36` |
| 原始素材 | `deepseek.ico`（用户提供，单帧 225×225 BMP）—— 保留备查，**不参与构建** |
| 生成命令 | `npm run icon`（= `tauri icon app-icon.png`） |
| 产物 | `src-tauri/icons/` 全套；其中 `icon.ico` 含 **16/24/32/48/64/256** 六档，全部内嵌 PNG |
| 用在哪 | NSIS 安装器图标、exe 文件图标、任务栏、系统托盘（`app.default_window_icon()` 复用 `bundle.icon`） |

> ⚠️ **深色任务栏可见性**：该 logo 是不透明的 `#020E36`（极深藏青，亮度约 14/255），
> 在 Windows 11 默认的深色任务栏/托盘上对比度很低，可能看不清。
> 如需改善，给 `app-icon.png` 加一层浅色圆角底或白色描边后再跑 `npm run icon` 即可。
> 也可以单独给托盘用一个浅色图标（`TrayIconBuilder::icon()` 接受任意 `Image`）。

**换图标**：把自己的方形 PNG（建议 1024×1024、带透明通道）覆盖到 `app-icon.png`，然后 `npm run icon`。
不要直接把 `.png` 改名成 `.ico` —— 文件头不对，`makensis` 会拒绝（见 [TROUBLESHOOTING §4](docs/TROUBLESHOOTING.md#4-图标格式错误)）。

`npm run icon` 之后会自动跑 `posticon` 钩子（[scripts/clean-mobile-icons.mjs](scripts/clean-mobile-icons.mjs)），
把 `tauri icon` 顺带生成的 `android/`、`ios/` 两套图标删掉——本项目只做 Windows 桌面端。

---

## 4. 选择界面前端

路径：[src/index.html](src/index.html) · [src/selector.css](src/selector.css) · [src/selector.js](src/selector.js)

界面结构：

```text
┌──────────────────────────────────────────────┐
│ ● 选择 DSH 连接方式                    [设置] │
├──────────────────────────────────────────────┤
│ ⌂  本地                                      │
│    http://127.0.0.1:8080      [自动启动服务] │
├──────────────────────────────────────────────┤
│ ☁  远程                                      │
│    https://dsh.example.com    [直接加载]     │
├──────────────────────────────────────────────┤
│ 状态：请选择连接方式。                       │
│ 配置：http://127.0.0.1:8080 | https://...    │
└──────────────────────────────────────────────┘
```

「设置」/首次点击时展开的表单：本地 URL、远程 URL、**勾选「选择本地时自动执行下面的命令」**、以及 PowerShell 启动命令。

`selector.js` 的核心逻辑（完整代码见文件）：

```js
const { invoke } = window.__TAURI__.core;

// 1) 启动时读配置
config = { ...DEFAULT_CONFIG, ...(await invoke("load_config")) };

// 2) 点击「本地 / 远程」
//    - 未配置过 -> 弹出表单，保存后再连接
//    - 已配置   -> 直接连接
async function connect(mode) {
  const url = mode === "local" ? config.localUrl : config.remoteUrl;
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

### 关于 Cookie 持久化 / CSP / WebView2 兼容性 / 登录态

- **Cookie 与登录态**：Tauri 2 把 WebView2 的用户数据目录放在应用数据目录下，由 `identifier` 决定（本项目 `com.dsh.dshtauri`）。Cookie、localStorage、IndexedDB、缓存**默认跨重启保留**，登录一次即可。注意：**改 `identifier` 等于换 profile**，登录态会「丢失」。
- **不要开隐身模式**：窗口配置里 `incognito: true` 会导致不落盘。
- **CSP**：`csp: null` 表示 Tauri 不注入 CSP，远程页面的安全策略完全由它自己（HTTP 响应头）决定。这是加载第三方 WebUI 最稳的做法。如果你要自己加 CSP，必须同时放行远程页面的 `script-src` / `connect-src` / `img-src`，否则白屏。
- **WebView2 兼容性**：目标机 Win11 自带；Win10 通过 `webviewInstallMode` 自动引导安装。远程页面若用了很新的 JS/CSS 特性，取决于目标机 WebView2 版本，可用 `minimumWebview2Version` 卡最低版本。
- **混合内容**：`https://` 页面里请求 `http://127.0.0.1:8080` 会被 WebView2 拦截。本地服务请用 `http://` 直接打开，或给本地服务配可信证书。

---

## 5. `src-tauri/Cargo.toml`

路径：[src-tauri/Cargo.toml](src-tauri/Cargo.toml)

```toml
[package]
name = "dshtauri"
version = "0.1.0"
edition = "2021"
rust-version = "1.77.2"

[lib]
name = "dshtauri_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
# tray-icon = Tauri 2 官方托盘 API，不需要额外插件
tauri = { version = "2", features = ["tray-icon"] }
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
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(MAIN_TITLE)
        .menu(&menu)
        .show_menu_on_left_click(false)          // 左键单击=唤出窗口，右键=菜单
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => reveal_window(app),
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

### 本地 URL 需要先启动本地服务时怎么办

三种方式，按需选：

| 方式 | 做法 |
| --- | --- |
| **手动启动**（默认） | 设置里不勾「自动执行命令」，自己先跑 `dsh web --port 8080`，再点「本地」 |
| **应用自动启动**（推荐） | 设置里勾上并填写命令，例如 `Set-Location C:\dsh; dsh web --port 8080`。应用会后台启动它，然后轮询端口，就绪后打开主窗口 |
| **外部守护** | 用计划任务 / NSSM 把服务注册成开机自启，应用只负责连 `http://127.0.0.1:8080` |

---

## 7. `src-tauri/capabilities/` 权限配置

**默认假设：远程页面不需要调用本地 Rust 命令 → 默认不开放远程 IPC。**

### `capabilities/default.json`（生效）

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "选择窗口（本地 index.html）的默认权限：调用应用自定义命令（load_config / save_config / start_local_service / probe_url / open_main_window）+ Tauri 核心 API。",
  "windows": ["selector"],
  "permissions": ["core:default"]
}
```

### `capabilities/remote-main.json.example`（默认不生效）

Tauri 只加载 `capabilities/*.json`，所以 `.example` 后缀天然是「关掉的」。需要时改名即可：

```json
{
  "identifier": "remote-main",
  "description": "主窗口加载远程页面时的权限（remote.urls 必须与窗口实际加载的 URL 完全一致）。",
  "windows": ["main"],
  "local": false,
  "remote": {
    "urls": ["http://127.0.0.1:8080", "https://dsh.example.com"]
  },
  "permissions": ["core:default"]
}
```

要点：

1. **主窗口即使没有任何 capability 也能正常渲染网页**。capability 只控制 IPC / 插件权限，不控制页面加载。
2. 应用**自定义命令**（`load_config` 等）不需要在 `permissions` 里逐条列出；只要该窗口被任一 capability 覆盖，就能 `invoke`。
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
    outputs:
      version: ${{ steps.app.outputs.version }}
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
      - name: Read app version
        id: app
        shell: pwsh
        run: |
          $conf = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
          "version=$($conf.version)" >> $env:GITHUB_OUTPUT
      - run: npm ci
      - run: npm run tauri build -- --bundles nsis
      - name: List bundle output
        shell: pwsh
        run: Get-ChildItem -Recurse src-tauri/target/release/bundle | Select-Object FullName, Length
      - uses: actions/upload-artifact@v4
        with:
          name: dshtauri-nsis-${{ steps.app.outputs.version }}-${{ github.sha }}
          path: src-tauri/target/release/bundle/nsis/*
          if-no-files-found: error
          retention-days: 30

  release:
    needs: build-windows
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' && inputs.create_release
    steps:
      - uses: actions/download-artifact@v4
        with: { pattern: 'dshtauri-nsis-*', path: dist, merge-multiple: true }
      - run: ls -l dist
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ needs.build-windows.outputs.version }}
          target_commitish: ${{ github.sha }}
          name: DSHTauri v${{ needs.build-windows.outputs.version }}
          files: dist/*.exe
```

对应要求：触发 = push 到 main + `workflow_dispatch` ✅；runner = `windows-latest` ✅；Node 22 / Rust stable / `x86_64-pc-windows-msvc` ✅；Rust 缓存 = `Swatinem/rust-cache@v2` ✅；`npm ci` + `npm run tauri build -- --bundles nsis` ✅；artifact 路径 = `src-tauri/target/release/bundle/nsis/*` ✅；顶层 `permissions: contents: write` ✅。

> **注意**：`npm ci` 需要 `package-lock.json` 已提交；`npm ci` 不会写入 lockfile，也不会安装 `package.json` 之外的包。
> 如果你的环境设置了 `NODE_ENV=production`，`npm ci` 会跳过 devDependencies（Tauri CLI 就是 devDependency），此时改用 `npm ci --include=dev`。GitHub Actions 默认不设这个变量，一般不用管。

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
#   换图标：把自己的方形 PNG 覆盖到 app-icon.png，然后
npm run icon                # = tauri icon app-icon.png，重新派生全套（含多尺寸 icon.ico）

# ---------- 5. 本地跑起来（验收标准 1）----------
npm run tauri dev
#   无桌面环境时用虚拟显示：
#   xvfb-run -a -s "-screen 0 1400x900x24" npm run tauri dev

# ---------- 5b.（可选）无头自动冒烟测试：15 项断言 ----------
sudo apt-get install -y xvfb xdotool wmctrl openbox dbus-x11
(cd src-tauri && cargo build)          # 脚本用 target/debug/dshtauri
bash scripts/smoke-linux.sh            # 期望输出：15 通过, 0 失败

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
git remote add origin git@github.com:<你的用户名>/DSHTauri.git
# 没有配 SSH key 就用 HTTPS：
# git remote add origin https://github.com/<你的用户名>/DSHTauri.git
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
   - `Build NSIS bundle` → 最后应有 `Finished 1 bundle at: ...\bundle\nsis\DSHTauri_0.1.0_x64-setup.exe`
   - `List bundle output` → 打印产物全路径和大小
4. 失败了先看 **红叉那一步的最后 30 行**，对照 [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)。

**下载 `.exe`**

两种方式：

| 方式 | 步骤 | 适合 |
| --- | --- | --- |
| **Artifact**（每次运行都有） | 运行详情页最下方 **Artifacts** → 点 `dshtauri-nsis-0.1.0-<sha>` 下载 zip → 解压得到 `DSHTauri_0.1.0_x64-setup.exe` | 自己测试 |
| **Release**（勾了 `create_release` 才有） | 仓库页右侧 **Releases** → 点对应版本 → **Assets** 里直接下 `.exe` | 发给别人 |

**在 Windows 11 上安装验证**

1. 双击 `DSHTauri_0.1.0_x64-setup.exe`。因为是 `installMode: currentUser`，**不需要管理员权限**，装到 `%LOCALAPPDATA%\DSHTauri`。
2. 首次启动若系统缺 WebView2，安装器会自动下载引导安装（`downloadBootstrapper`）。
3. 验收：
   - 弹出「选择 DSH 连接方式」窗口；
   - 点「远程」→ 主窗口 1200x800 加载你的远程地址，标题 `DSHTauri`；
   - 点窗口 `X` → 窗口消失，**托盘图标还在**，任务管理器里 `DSHTauri.exe` 仍在；
   - 托盘右键 →「显示主窗口」→ 窗口回来；
   - 托盘右键 →「退出」→ 进程消失。
4. Windows Defender SmartScreen 可能提示「未知发布者」——因为没做代码签名，点「更多信息 → 仍要运行」。这是预期行为。

---

## 11. 常见错误与排查

完整版见 **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**，覆盖你点名的 7 类问题，外加 1 类必踩的环境问题：

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
| 首次点击要求用户提供配置并记录 | ✅ 已验证 | 无 `config.json` 时点击「本地」：**不打开主窗口、不写配置**；`Tab×3 + Enter`（保存）后才生成 `config.json` 并打开主窗口 |
| 推送到 GitHub 后 Actions 在 `windows-latest` 成功运行 | ⏳ 需要你推送后确认 | 工作流 YAML 已通过解析校验；本地已验证 `cargo check --target x86_64-pc-windows-msvc` 通过（等价于 CI 的编译步骤） |
| Artifact 中存在 NSIS `.exe` | ⏳ 需要 CI 运行后确认 | `upload-artifact` 路径 = `src-tauri/target/release/bundle/nsis/*`，`if-no-files-found: error` |
| Windows 11 安装后功能正常 | ⏳ 需要你在 Windows 上确认 | — |

复现方式：`bash scripts/smoke-linux.sh`（需要 `xvfb xdotool wmctrl openbox dbus-x11`）。当前结果：**15 通过 / 0 失败**。

---

## 设计决策速查

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 前端方案 | 纯静态 HTML/CSS/JS | 无构建步骤、无框架依赖，二进制最小、启动最快 |
| 单窗口路由 vs 双窗口 | 双窗口（`selector` + `main`） | 主窗口要加载**外部 URL**，和本地选择页面的 origin 不同，拆开最干净 |
| 托盘 | Tauri 2 官方 `tauri::tray` | 不引第三方插件，符合「优先官方 API」 |
| 配置存储 | 手写 JSON 到 app config dir | 少一个插件依赖；格式可读、可手改 |
| 本地服务等待 | 前端轮询 `probe_url` | 同步命令跑主线程，Rust 里 sleep 会冻界面 |
| 远程页面权限 | 默认关闭 | 用户可改 URL，静态 capability 无法覆盖；默认最小权限 |
| 打包目标 | 只做 NSIS | 按需求，不要 MSI |

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
| 图标 | `npm run icon` → `icons/icon.ico` | ✅ 6 档 16/24/32/48/64/256，内嵌 PNG |
| 工作流 YAML | `python3 -c "yaml.safe_load(...)"` | ✅ 解析通过，`permissions: contents: write` 就位 |
| 端到端冒烟 | `bash scripts/smoke-linux.sh` | ✅ 15 通过 / 0 失败 |

> 说明：`cargo check --target x86_64-pc-windows-msvc` 在 Debian 上需要 `llvm`（提供 `llvm-rc`，`tauri-build` 用它嵌入 Windows 资源）。这只影响**在 Linux 上预检 Windows 目标**；GitHub Actions 上用的是真正的 MSVC 工具链，不需要这一步。
>
> 踩过的坑记录：`xdotool windowclose` 是**销毁窗口**（不触发 `CloseRequested`），用它测「关闭到托盘」会得到假结论。必须用 `wmctrl -i -c` 发送真正的 `WM_DELETE_WINDOW`。`scripts/smoke-linux.sh` 里用的是后者。
