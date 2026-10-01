# DSHTauri 常见错误与排查

> 所有命令默认在仓库根目录执行。Windows 路径以 `C:\` 为例，Debian 用 `/`。

排查任何编译/打包问题前，先收集这三份信息（提 issue 时也请附上）：

```bash
npm run tauri info          # 环境快照：Node / Rust / WebView2 / 系统依赖
npm run tauri build -- --bundles nsis --verbose   # 完整打包日志
# Windows 上再补一份：
#   rustc -Vv ; cargo -V ; node -v ; npm -v
```

---

## 1. 托盘图标不显示

**现象**：程序能启动，任务栏有窗口，但右下角托盘区没有图标（或图标是空白方块）。

| 原因 | 判断方法 | 修复 |
| --- | --- | --- |
| Windows 把新图标折叠进了「隐藏的图标」弹出面板 | 点托盘区 `^` 箭头能看到 | 拖到任务栏常驻即可，不是 bug |
| `Cargo.toml` 缺少 `tray-icon` feature | `grep tray-icon src-tauri/Cargo.toml` 无输出 | `tauri = { version = "2", features = ["tray-icon"] }` |
| 托盘用了一个「透明/空白」的图标 | 图标资源本身有问题 | 用 `icons/icon.ico` 里 16x16 或 32x32 的实体图标；本项目用 `app.default_window_icon()`，它来自 `bundle.icon` |
| 图标是 ico 但只有 256x256 一档 | 小尺寸下被系统缩放成空白 | 用 `npm run icon` 重新生成（本项目 `icon.ico` 含 16/24/32/48/64/256 六档） |
| 托盘在 `setup` 里创建失败但被忽略了 | 日志里有 `tray` 相关 error | 本项目 `setup_tray(...)?` 会把错误直接抛出来；看控制台/`--verbose` 日志 |
| `TrayIcon` 被 drop 了 | 旧版本 Tauri 的坑 | Tauri 2 里 `TrayIconBuilder::build()` 返回的 `TrayIcon` 由 App 托管，不需要自己存；本项目不保存也不影响 |

**验证**：托盘创建成功后，右键应弹出「显示主窗口 / 退出」两项。左键单击直接唤出窗口（本项目 `show_menu_on_left_click(false)`）。

> 提示：在 Debian 上用 `tauri dev` 跑托盘，需要 `libayatana-appindicator3-dev`（GNOME 还需要 AppIndicator 扩展），否则托盘可能不出现——这只影响 Linux 开发机，不影响 Windows 产物。

---

## 2. 关闭窗口未隐藏到托盘（程序直接退出了）

**现象**：点窗口右上角 `X`，程序从任务管理器里消失，托盘图标也没了。

**根因**：没有拦截 `CloseRequested`，或者用了 `app.exit()`。

**本项目的正确写法**（`src-tauri/src/lib.rs`）：

```rust
.on_window_event(|window, event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();          // 关键 1：阻止真正关闭
        let _ = window.hide();        // 关键 2：隐藏到托盘
    }
})
```

常见错误与修正：

1. **只写了 `prevent_close()` 没写 `hide()`** → 窗口关不掉也退不出去，界面卡住。
2. **用 `window.close()` 关选择窗口** → `close()` 会再次触发 `CloseRequested`，被上面这段拦住，选择窗口永远关不掉。
   本项目改用 `window.destroy()`（不触发 `CloseRequested`）：
   ```rust
   if let Some(selector) = app.get_webview_window(SELECTOR_LABEL) {
       let _ = selector.destroy();
   }
   ```
3. **托盘「退出」用了 `window.close()`** → 只是隐藏。必须用 `app.exit(0)`；`exit` 不会走 `CloseRequested`，所以是真正的退出。
4. **在 `tauri.conf.json` 里写了 `"closable": false`** → `X` 按钮变灰，用户只能从托盘退出。本项目保持 `closable: true`。
5. **Windows 上「关闭 = 隐藏」后任务栏图标还在** → 正常；如果希望同时从任务栏隐藏，可加 `window.set_skip_taskbar(true)`。

**自测**：启动 → 点 `X` → 窗口消失、托盘图标还在 → 右键托盘「显示主窗口」→ 窗口回来 → 右键托盘「退出」→ 进程结束（任务管理器里 `DSHTauri.exe` 消失）。

---

## 3. NSIS 打包失败

**现象**：`cargo build --release` 成功，但最后一步 `bundling` 报错。

### 3.1 `failed to bundle project: error running light.exe` / `makensis` 相关

最常见是**路径里有中文或空格**，或者 Windows 用户目录名非 ASCII。

```text
Error: failed to run makensis
  caused by: ...
```

处理：
- 把仓库放到纯 ASCII 路径，例如 `C:\src\DSHTauri`（不要放 `C:\Users\张三\桌面\...`）。
- GitHub Actions 上仓库路径天然是 `D:\a\<repo>\<repo>`，一般不会踩到；本地复现时才需要。

### 3.2 `NSIS error: invalid icon` / `could not read icon file`

`bundle.icon` 里列的 `.ico` 不存在或格式不对 → 见第 4 节。

### 3.3 `WebView2` 下载失败

默认 `webviewInstallMode = { "type": "downloadBootstrapper" }`，打包时 Tauri 会把 bootstrapper 下载下来内嵌到安装包。**内网 / 无外网** 的机器上会失败：

```text
Error: failed to download https://go.microsoft.com/fwlink/p/?LinkId=2124703
```

三种处理：

| 场景 | 配置 |
| --- | --- |
| 目标机器都能联网 | 保持 `downloadBootstrapper`（安装时下载，包最小） |
| 完全离线安装 | `{ "type": "offlineInstaller" }`（包大约 +130 MB） |
| 目标机器确定已装 WebView2（Win11 默认自带） | `{ "type": "skip" }` |

### 3.4 `Permission denied` / `Access is denied` 覆盖旧文件

上一次的 `DSHTauri.exe` 还在运行（或托盘里没退出）→ 在任务管理器结束 `DSHTauri.exe`，或先点托盘「退出」，再重新打包。

### 3.5 `error: linker 'link.exe' not found`（只会在 Windows 上出现）

说明装的是 GNU toolchain 而不是 MSVC。确认：

```powershell
rustup show            # 应显示 x86_64-pc-windows-msvc
rustup target list --installed
```

本项目 CI 里用 `dtolnay/rust-toolchain@stable` + `targets: x86_64-pc-windows-msvc` 显式指定，不会踩到。

### 3.6 打包成功但找不到 `.exe`

产物不在 `target/release/`（那是裸二进制），而在：

```text
src-tauri/target/release/bundle/nsis/DSHTauri_0.1.0_x64-setup.exe
```

CI 里已经用 `Get-ChildItem -Recurse src-tauri/target/release/bundle` 打印全部产物，Artifact 路径也写的是 `src-tauri/target/release/bundle/nsis/*`。

---

## 4. 图标格式错误

**现象**：

```text
Error: icon ... is not a valid icon: unsupported format
Error: `bundle.icon` file `icons/icon.ico` does not exist
```

Tauri 对图标有硬性要求：

| 平台 | 必需文件 | 要求 |
| --- | --- | --- |
| Windows（NSIS） | `icons/icon.ico` | 真正的 ICO 容器，建议含 16/24/32/48/64/256 多档 |
| 通用 | `icons/32x32.png`、`icons/128x128.png`、`icons/128x128@2x.png` | 32 位带 alpha 的 PNG |
| Linux | `icons/icon.png` | PNG |

**绝对不要**把 `.png` 直接改名成 `.ico` —— 文件头不对，`makensis` 会拒绝。

**正确做法**（本项目）：

```bash
node scripts/make-icon.mjs      # 生成 1024x1024 的 app-icon.png
npm run icon                    # = tauri icon app-icon.png，派生全套尺寸
```

校验生成的 ico：

```bash
python3 -c "import struct;d=open('src-tauri/icons/icon.ico','rb').read();n=struct.unpack('<H',d[4:6])[0];print('entries:',n,[ (d[6+i*16] or 256) for i in range(n)])"
```

本项目 `icons/icon.ico` 实测为 `type=1, count=6`，尺寸 `16/24/32/48/64/256`，每档都是内嵌 PNG。

其它易错点：
- `bundle.icon` 的路径**相对于 `src-tauri/`**，所以写 `"icons/icon.ico"` 而不是 `"src-tauri/icons/icon.ico"`。
- 换图标后要重新跑 `tauri icon`，光替换 `icon.ico` 会导致各尺寸不一致（Windows 任务栏/托盘用不同尺寸）。
- 图标文件被 `.gitignore` 忽略 → CI 上 `icons/` 为空 → 打包失败。本项目只忽略了 `gen/schemas`。

---

## 5. remote capabilities 权限错误

**现象**：

```text
Error: failed to parse capability `remote-main`
Error: capability `xxx` has remote urls but is not `local: false`
```

或者**没有报错但远程页面里 `window.__TAURI__` 不可用 / invoke 被拒绝**：

```text
Error: ... not allowed. Permissions associated with this command: ...
```

### 关键规则

1. **远程页面默认没有任何 Tauri 权限。** 主窗口加载 `https://...` 时，即使 `withGlobalTauri: true` 注入了 `window.__TAURI__`，任何 `invoke` 都会被拒绝。
2. 想让远程页面用本地能力，必须写一个 capability，并且：
   - `"windows": ["main"]`（label 必须和 `WebviewWindowBuilder::new(&app, "main", ...)` 一致）
   - `"local": false`
   - `"remote": { "urls": ["https://dsh.example.com"] }`
   - **URL 必须完全匹配**：scheme + host + port。`https://dsh.example.com` 不匹配 `https://dsh.example.com:8443`，也不匹配 `https://www.dsh.example.com`。
3. **改地址就要改 capability。** 本项目 URL 是运行时可配置的，所以默认**不启用**远程权限：文件是 `capabilities/remote-main.json.example`（Tauri 只加载 `.json`，`.example` 后缀不会生效）。
4. 本地选择窗口（`tauri://localhost` 上的 `index.html`）由 `capabilities/default.json` 覆盖，`"windows": ["selector"]`，`"permissions": ["core:default"]`。应用**自定义命令**（`load_config` / `save_config` / `open_main_window`）不需要在 permissions 里列出来，只要该窗口被任一 capability 覆盖即可调用。
5. **不要把 `windows` 写错**：写 `["main"]` 但窗口 label 是 `"dshtauri-main"` → 权限静默不生效，只在 `tauri dev` 的日志里能看到 `capability ... does not match any window`。

### 启用远程 IPC 的步骤

```bash
cd src-tauri/capabilities
mv remote-main.json.example remote-main.json
# 编辑 remote.urls 为你的真实地址
npm run tauri dev
```

启用后，远程页面获得 `core:default`。如果还需要调用本地命令，把命令名加进 permissions 或自定义权限集（应用自定义命令本身不需要）。

> **安全提醒**：一旦启用，该页面就获得了这些能力。如果远程页面不需要任何本地能力（本项目的默认假设就是「不需要」），保持 `.example` 后缀是最安全的选择——主窗口渲染网页完全不受影响。

---

## 6. WebView2 加载远程 URL 白屏

**现象**：窗口打开了，但一片空白，或显示 `无法访问此页面`。

按顺序排查：

1. **URL 本身打不开**。先在 Windows 上用 Edge 打开同一个 URL。注意本项目的「本地」地址是 `http://127.0.0.1:8080`，指**运行 DSHTauri 的那台 Windows 机器自己**，不是 Debian 开发机。
2. **本地服务没起来**。如果勾选了自动启动，命令是异步执行的，服务可能需要几秒。本项目在拉起服务后由**前端轮询** `probe_url`（`lib.rs` 里的单次 TCP 探测，300ms 超时）直到端口可连接，最多等 20 秒，然后才加载页面。若 20 秒后仍未就绪，说明命令本身失败了：
   - PowerShell 里的命令必须**非交互**：加 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden`（本项目已加）。
   - 命令里如果依赖某个工作目录，先 `Set-Location`：`Set-Location C:\dsh; dsh web --port 8080`。
   - 想看它到底报什么错：把命令改成先重定向日志，例如
     `dsh web --port 8080 *> $env:TEMP\dshtauri-service.log`，然后看那个文件。
3. **HTTPS 证书不受信任**（自签名证书）→ WebView2 会拦截，表现为白屏或 `NET::ERR_CERT_AUTHORITY_INVALID`。用可信证书，或在开发期改用 `http://`。
4. **混合内容**：页面是 `https://`，内部又请求 `http://127.0.0.1:8080` → 被浏览器内核拦掉。反过来（`http` 页面请求 `https`）没问题。
5. **CSP**：本项目 `app.security.csp = null`，即**不注入任何 CSP**，所以不会因为 CSP 白屏。如果你自己设置了 `csp`，远程页面的 `script-src` / `connect-src` 必须显式放行，否则白屏 + 控制台报 `Refused to ...`。
6. **想开 DevTools 看真实错误**：`WebviewWindowBuilder` 上链一个 `.devtools(true)`（debug 构建默认可用），或临时用 `tauri dev` 跑，然后在窗口里按 `F12`。这是定位白屏最快的手段。
7. **代理 / 企业网络**：WebView2 走系统代理。若需要独立代理，可在窗口配置里用 `proxyUrl`，或给 WebView2 传 `additionalBrowserArgs`。
8. **Cookie / 登录态丢失**：Tauri 2 默认把 WebView2 的用户数据目录放在应用数据目录下（由 `identifier` 决定，本项目 `com.dsh.dshtauri`），**Cookie、localStorage、登录态会跨重启保留**。如果登录态每次都没了，检查：
   - 是否改了 `identifier`（改了就等于换了 profile 目录）；
   - 是否在窗口配置里设了 `"incognito": true`（隐身模式不落盘）；
   - 是否用 `"dataDirectory"` 指向了临时目录。

---

## 7. 选择界面到主窗口的 URL 传递失败

**现象**：点了「本地 / 远程」没反应；或主窗口开了但地址不对；或报 `invalid args`。

### 7.1 `invalid args \`request\` for command \`open_main_window\``

Tauri 2 会把 JS 的 **camelCase 参数名转成 Rust 的 snake_case**。踩坑点在于字段名：

- Rust：`pub start_command: Option<String>` + `#[serde(rename_all = "camelCase")]` → JS 传 `startCommand`。
- 命令参数本身用了单词名 `request`，避免歧义。

正确调用（见 `src/selector.js`）：

```js
await invoke("open_main_window", {
  request: { url: "http://127.0.0.1:8080", startCommand: null },
});
```

如果字段名写错，Tauri 会直接报 `invalid args`，并在 `tauri dev` 的终端里打印缺失字段名。

### 7.2 点了按钮完全没反应

- **`window.__TAURI__` 是 undefined** → `app.withGlobalTauri` 没开。本项目 `tauri.conf.json` 里是 `"withGlobalTauri": true`。控制台会报 `Cannot destructure property 'invoke' of 'window.__TAURI__.core'`。
- **选择窗口没有 capability** → `invoke` 被拒绝。确认 `capabilities/default.json` 的 `windows` 含 `"selector"`，且窗口 label 确实是 `selector`（`tauri.conf.json -> app.windows[0].label`）。
- **JS 抛异常被吞掉**：本项目所有 `invoke` 都在 `try/catch` 里，并把错误写到页面底部的状态行，先看那一行。

### 7.3 主窗口打开了但 URL 不对

- 前端传的是 `config.localUrl` / `config.remoteUrl`，来自 `load_config`。如果配置文件里是旧值，点「设置」改完**必须点保存**（保存后页面底部会显示 `配置已保存。`）。
- 配置文件位置：
  - Windows：`%APPDATA%\com.dsh.dshtauri\config.json`
  - Linux：`~/.config/com.dsh.dshtauri/config.json`
  删掉它即可恢复「首次配置」流程。

### 7.4 `不支持的协议 \`file\`，只允许 http / https。`

`open_main_window` 里做了白名单校验（`lib.rs`）。传 `file:///C:/...` 或 `tauri://localhost` 会被拒绝——这是有意的，避免把本地文件加载进主窗口。

### 7.5 主窗口开了但选择窗口没关

`open_main_window` 末尾用 `selector.destroy()` 关闭选择窗口。如果没关掉，说明 window label 不匹配（`SELECTOR_LABEL` 常量 vs `tauri.conf.json` 的 `label`）。两处必须都是 `selector`。

---

## 附：快速自检清单

```bash
# 0. 环境自检（先跑这个，能直接定位 90% 的「跑不起来」）
node scripts/check-env.mjs

# 1. 配置能过 schema
npx --yes ajv-cli@5 validate -s <(curl -s https://schema.tauri.app/config/2) -d src-tauri/tauri.conf.json

# 2. Rust 能过编译（Windows 目标，无需 Windows 机器）
rustup target add x86_64-pc-windows-msvc
cd src-tauri && cargo check --target x86_64-pc-windows-msvc

# 3. 完整打包（只能在 Windows / CI 上做）
npm run tauri build -- --bundles nsis --verbose
```

---

## 8. `npm run tauri dev` 报 `cargo metadata ... No such file or directory`

**现象**（第一次跑必踩，实测过）：

```text
$ npm run tauri dev
failed to run 'cargo metadata' command to get workspace directory:
failed to run command cargo metadata --no-deps --format-version 1:
No such file or directory (os error 2)
```

**根因**：Tauri CLI 在启动前会调用 `cargo metadata` 探测 workspace，而 **`cargo` 不在当前 shell 的 `PATH` 上**。跟项目代码、`tauri.conf.json` 都没关系。

**一分钟定位**：

```bash
node scripts/check-env.mjs
```

它会告诉你 cargo 在哪、缺哪个环境变量，并**直接打印可以复制的修复命令**。

### 情况 A：Rust 装在标准位置（rustup 默认），只是没 source

```bash
source "$HOME/.cargo/env"     # 立刻生效
echo 'source "$HOME/.cargo/env"' >> ~/.bashrc   # 永久生效
```

验证：`cargo --version` 有输出。

### 情况 B：`cargo` 能在 PATH 上找到，但运行报 rustup 错误

```text
error: rustup could not choose a version of cargo to run, because one wasn't
specified explicitly, and no default is configured.
```

这是**只加了 PATH、没设 `RUSTUP_HOME`**。`cargo` 本身只是 rustup 的代理，它要靠 `RUSTUP_HOME` 找到真正的工具链（默认 `~/.rustup`）。三个变量缺一不可：

```bash
export CARGO_HOME="/path/to/cargo-home"
export RUSTUP_HOME="/path/to/rustup-home"
export PATH="$CARGO_HOME/bin:$PATH"
```

### 情况 C：Rust 装在项目内（本项目开发机就是这种）

```bash
source scripts/env.sh          # 项目自带脚本，一次搞定三个变量
cargo --version
npm run tauri dev
```

永久生效：

```bash
echo 'export CARGO_HOME="/root/projects/DSHTauri/.toolchain/cargo"' >> ~/.bashrc
echo 'export RUSTUP_HOME="/root/projects/DSHTauri/.toolchain/rustup"' >> ~/.bashrc
echo 'export PATH="$CARGO_HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### 情况 D：根本没装 Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

> 注意：`.toolchain/` 在 `.gitignore` 里，**不会**跟着仓库走。换机器/新克隆后要重新装 Rust（情况 D），不要指望拷过来就能用。
>
> 另外 `npm install` 如果报「added 0 packages」且 `node_modules/.bin/tauri` 不存在，多半是 `NODE_ENV=production` 导致 devDependencies 被跳过，用 `npm install --include=dev`。
