//! DSHTauri —— DSH WebUI 的轻量桌面壳（Tauri 2）。
//!
//! 职责：
//! 1. 启动时显示「选择 DSH 连接方式」窗口（本地 / 远程）。
//! 2. 接收前端的连接请求，按需启动本地服务，然后打开主窗口加载对应 URL。
//! 3. 创建系统托盘：显示主窗口 / 退出。
//! 4. 关闭窗口时不退出程序，而是隐藏到托盘。
//!
//! 全部使用 Tauri 2 官方 API（`tauri::tray` + `tauri::menu`），不依赖任何插件。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// 侧栏开 / 关的过渡动画（Windows 11「动画效果」适配）。
///
/// 见模块文档与 `docs/ANIMATION-FEASIBILITY.md`：
/// wry 最终用 `SetWindowPos` 摆放子 webview，**没有**任何框架级动画能力，
/// 所以这里自己逐帧插值。系统关掉「动画效果」时自动退化为直接切换。
mod anim;

/// Windows 任务栏图标的主题适配。
///
/// Tauri 的 `Window::set_icon()` **只设置 `ICON_SMALL`**，而任务栏按钮用的是
/// `ICON_BIG` —— 所以 v0.3.1 的任务栏图标根本没跟着主题变。见模块文档。
mod win_icon;

/// 启动选择窗口的 label（在 `setup()` 里创建）。
pub const SELECTOR_LABEL: &str = "selector";
/// 主窗口的 label。
///
/// **这是一个纯 `Window`（容器），本身不加载任何页面。** 页面由它的子 webview 承载：
/// 顶栏 [`TITLEBAR_LABEL`] + 内容 [`CONTENT_LABEL`]（+ 可选的对话侧栏 [`CHAT_LABEL`]）。
pub const MAIN_LABEL: &str = "main";
/// 主窗口顶部自定义标题栏子 webview 的 label。
///
/// 它加载**本地页面** `titlebar.html`，因此命中 `capabilities/default.json`
/// （`webviews: ["titlebar"]` + `local: true`），**拥有 IPC 权限**。
/// 这是它能调 `chrome_action` / `window_control` 等命令的前提。
pub const TITLEBAR_LABEL: &str = "titlebar";
/// 主窗口内容子 webview 的 label（加载用户配置的**远程** DSH 页面）。
///
/// 远程页面**故意不授予任何 capability** —— 见 `docs/TROUBLESHOOTING.md §5`。
pub const CONTENT_LABEL: &str = "content";
/// 右侧「网页对话」侧栏子 webview 的 label。
pub const CHAT_LABEL: &str = "chat";
/// 「关于」窗口的 label。
pub const ABOUT_LABEL: &str = "about";
/// 「设置」窗口的 label（独立 `WebviewWindow`，加载本地 `settings.html` ⇒ 有 IPC）。
pub const SETTINGS_LABEL: &str = "settings";

/// 版本号（`v.A.B.C`，可选 ` RC` 后缀），由 `build.rs` 从 `Cargo.toml` + `version.json` 生成。
///
/// - `APP_VERSION`：`0.3.2`（纯数字三段，不带前缀）
/// - `APP_CHANNEL`：`"release"` 或 `"rc"` —— **RC 与 Release 是两条发布通道**，
///   Release 版不带后缀，RC 版显示为 ` RC`。
/// - `APP_DISPLAY_VERSION`：`v.0.3.2`（Release）或 `v.0.3.2 RC`（RC）
mod version_info {
    include!(concat!(env!("OUT_DIR"), "/version_info.rs"));
}
pub use version_info::{APP_CHANNEL, APP_DISPLAY_VERSION, APP_VERSION};

const SELECTOR_TITLE: &str = "选择 DSH 连接方式";
const SELECTOR_WIDTH: f64 = 560.0;
const SELECTOR_HEIGHT: f64 = 460.0;

const MAIN_TITLE: &str = "DSHTauri";
const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 800.0;
const MAIN_MIN_WIDTH: f64 = 640.0;
const MAIN_MIN_HEIGHT: f64 = 480.0;

/// 自定义标题栏高度（**逻辑**像素）。
///
/// ⚠️ 这是一个**逻辑**值，直接传给 `LogicalSize` / `LogicalPosition`。
/// **绝对不要再乘以 `scale_factor`** —— Tauri 的 `inner_size(f64)` 等 API 收的就是逻辑单位，
/// 框架内部会自己乘一次。旧实现手算 `CHROME_HEIGHT * scale` 再当逻辑值传，
/// 导致顶栏被缩放两次（用户截图 P1 实测 158 device px ≈ 40×2×2，而正确的 P2 是 78 ≈ 40×2）。
const TITLEBAR_HEIGHT: f64 = 40.0;

/// 右侧「网页对话」侧栏（现在是主窗口内右侧的一个子 webview，不再是独立窗口）。
const CHAT_URL: &str = "https://chat.deepseek.com/";
const CHAT_WIDTH: f64 = 420.0;

/// 「关于」窗口。
const ABOUT_TITLE: &str = "关于 DSHTauri";
const ABOUT_WIDTH: f64 = 520.0;
const ABOUT_HEIGHT: f64 = 440.0;

/// 「设置」窗口。
const SETTINGS_TITLE: &str = "DSHTauri 设置";
const SETTINGS_WIDTH: f64 = 560.0;
const SETTINGS_HEIGHT: f64 = 520.0;

const TRAY_ID: &str = "dshtauri-tray";
const MENU_SHOW: &str = "show";
const MENU_SELECT: &str = "select";
const MENU_QUIT: &str = "quit";

/// 本地 / 远程地址的**示例**（只出现在界面的占位符里，不写进默认配置）。
///
/// 默认配置里两个地址都是空字符串：本地和远程**允许只配一个**，
/// 由用户在首次启动时按需填写。示例值见 `src/index.html` 的 placeholder。
pub const EXAMPLE_LOCAL_URL: &str = "http://127.0.0.1:3080";
pub const EXAMPLE_REMOTE_URL: &str = "https://dsh.example.com";
pub const EXAMPLE_LOCAL_COMMAND: &str = "dsh web";

/// 托盘是否创建成功。
///
/// 托盘失败（例如 Linux 上没有 StatusNotifier 宿主）时不能让程序直接崩掉，
/// 但也**不能**继续「关闭即隐藏」——那会让窗口藏起来却没有任何入口找回来。
/// 所以这个开关同时决定 `CloseRequested` 的行为：托盘不可用就正常关闭。
static TRAY_READY: AtomicBool = AtomicBool::new(false);

/// 深色任务栏/深色主题用的 logo：**白色**鲸鱼 + 透明底。
///
/// 同一张图既用于托盘图标，也用于窗口/任务栏图标（见 [`apply_theme_icons`]）——
/// 用户要求「统一 logo，深色模式白色小鲸鱼、浅色模式深色小鲸鱼，自动变」。
const ICON_ON_DARK: &[u8] = include_bytes!("../icons/tray-dark.png");
/// 浅色任务栏/浅色主题用的 logo：深藏青 `#020E36` 鲸鱼 + 透明底。
const ICON_ON_LIGHT: &[u8] = include_bytes!("../icons/tray-light.png");

/// 持久化在 `<app config dir>/config.json` 的用户配置。
///
/// 前端首次点击「本地 / 远程」时会要求用户确认地址，保存后再连接；
/// 之后的每次启动都读取这里，直接点击即可。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// 是否已经完成首次配置。
    pub configured: bool,
    /// 本地地址。**默认为空**——本地和远程允许只配一个，由用户首次启动时按需填写。
    pub local_url: String,
    /// 远程地址。默认为空，理由同上。
    pub remote_url: String,
    /// 选择「本地」时是否自动执行 `local_start_command`。
    pub auto_start_local: bool,
    /// 启动本地 DSH 服务的命令（Windows 下通过 PowerShell 后台执行）。
    pub local_start_command: String,
    /// 「网页对话」侧栏的加载模式：`false` = `overlay`（默认，覆盖在内容页之上，
    /// 内容页面积不变）；`true` = `docked`（内容页让出右侧 `CHAT_WIDTH`，两者并排）。
    ///
    /// **默认 `false`** 保证向后兼容：老配置文件里没有这个字段时，
    /// `#[serde(default)]` 会取 `bool::default()` = `false` ⇒ 行为与升级前完全一致。
    pub chat_docked: bool,
}

/// 前端 `open_main_window({ request })` 的载荷。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub url: String,
}

/* ------------------------------------------------------------------ config */

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录 {}：{e}", dir.display()))?;
    Ok(dir.join("config.json"))
}

fn read_config<R: Runtime>(app: &AppHandle<R>) -> AppConfig {
    let Ok(path) = config_path(app) else {
        return AppConfig::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<AppConfig>(&text).unwrap_or_default(),
        // 首次启动时文件不存在：使用默认值，前端会引导用户确认。
        Err(_) => AppConfig::default(),
    }
}

fn write_config<R: Runtime>(app: &AppHandle<R>, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败：{e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入配置失败 {}：{e}", path.display()))
}

/* --------------------------------------------------------------- local svc */

/// 在后台启动本地 DSH 服务。Windows 上用 PowerShell 且不弹窗口。
/// Windows 作业对象：保证「应用启动的本地服务」**随主程序一起结束**。
///
/// `Command::spawn()` 出来的是分离进程 —— 主程序退出后它照跑不误，
/// 用户会在后台白白养着一个 DSH 服务，一直吃内存/CPU。
///
/// Windows 的标准做法是把子进程放进一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
/// 的作业对象：作业句柄由本进程持有，进程一退出句柄就被系统关闭，
/// 作业内所有进程（含子进程自己再拉起的孙进程）会被一起终止。
///
/// 句柄故意存进 `static` 且永不关闭，这样它的生命周期 == 进程生命周期；
/// 无论正常退出、`app.exit()`、还是被任务管理器强杀，都会触发。
#[cfg(windows)]
mod service_job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        let raw = JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                // 设置失败就放弃，避免留下一个「不会杀子进程」的作业造成误导
                let _ = CloseHandle(job);
                return 0;
            }
            job as usize
        });
        if *raw == 0 {
            None
        } else {
            Some(*raw as HANDLE)
        }
    }

    /// 把刚 spawn 的子进程放进作业对象。失败只返回 false，不阻断服务启动。
    pub fn assign(child: &Child) -> bool {
        match job() {
            Some(job) => unsafe {
                AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) != 0
            },
            None => false,
        }
    }
}

#[cfg(windows)]
fn spawn_local_service(command: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    /// CREATE_NO_WINDOW
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let child = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            command,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动本地服务失败：{e}"))?;

    // 关键：挂到作业对象上，主程序一退出它就跟着结束。
    if !service_job::assign(&child) {
        eprintln!(
            "[DSHTauri] 警告：未能把本地服务加入作业对象，\n\
             [DSHTauri] 主程序退出后它可能会继续在后台运行。"
        );
    }
    Ok(())
}

/// 非 Windows（开发机 Debian 上跑 `tauri dev`）用 sh 执行同样的命令。
///
/// 注意：**这里没有**「随主程序退出而结束」的保证 —— 作业对象是 Windows 机制。
/// 目标平台是 Windows，Linux 这条路径只用于开发机自测。
#[cfg(not(windows))]
fn spawn_local_service(command: &str) -> Result<(), String> {
    std::process::Command::new("sh")
        .arg("-lc")
        .arg(command)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动本地服务失败：{e}"))
}

/// 单次 TCP 连通性探测（300ms 超时，绝不长时间阻塞主线程）。
fn probe_tcp(host: &str, port: u16) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs.into_iter().any(|addr| {
        TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
    })
}

/* ------------------------------------------------------------------ window */

/// 所有窗口共用的 WebView2 用户数据目录。
///
/// 不显式指定时 `data_directory` 是 `None`，wry 会把**空字符串**传给
/// `CreateCoreWebView2EnvironmentWithOptions`，用户数据目录就落到 WebView2 的默认位置。
/// 显式固定到 `%LOCALAPPDATA%\<identifier>\webview2` 有两个好处：
///   1. Cookie / localStorage / 登录态**确定性地**落盘并跨重启保留；
///   2. 所有窗口共用同一份 profile —— 选择窗口、主窗口、侧栏、关于窗口共享登录态，
///      而且只起一个 WebView2 浏览器进程（更省内存）。
fn webview_data_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("webview2"))
}

/// 给窗口构造器套上共享的数据目录。
///
/// 图标不在这里设 —— 见 [`set_creation_icon`] 的说明（`builder.icon()` 按值消耗
/// `builder`，失败时无法回退；而 `.build()` 之后用 `set_icon(&self)` 没有这个问题）。
fn with_shared_profile<'a, R: Runtime, M: Manager<R>>(
    app: &AppHandle<R>,
    mut builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    if let Some(dir) = webview_data_dir(app) {
        builder = builder.data_directory(dir);
    }
    builder
}

/// 给**刚创建好的**窗口设上当前主题对应的 logo（v0.3.3 修的缺陷）。
///
/// # 修的是什么
///
/// 用户实测：**「关于」与「设置」窗口左上角（标题栏）的图标仍是深藏青的静态
/// `icon.ico`**，而主窗口已经能跟随主题。根因是**创建时机**：
///
/// - [`apply_theme_icons`] 只在三个时刻跑：`setup()` 末尾、主窗口创建后、系统主题变化时；
/// - 而「关于」/「设置」窗口是用户**点菜单时才创建**的（`show_about_window` /
///   `show_settings_window`），远晚于上面那几个时刻。
///
/// 于是它们拿到的是 Tauri 的**默认窗口图标**（bundle 里那个静态 `icon.ico`，
/// 固定深藏青），之后再没有机会被纠正 —— `apply_theme_icons` 里那句
/// `for label in [...] { set_icon }` 只对**当时已存在**的窗口生效。
///
/// 修法：每个窗口 `.build()` 成功后立刻设一次图标，这样无论窗口何时被打开，
/// 都必然带上当前主题对应的鲸鱼。
///
/// # 为什么用 `set_icon` 而不是 `builder.icon()`
///
/// `WebviewWindowBuilder::icon(self, ...)` **按值消耗** builder 并返回 `Result<Self>`；
/// 一旦返回 `Err`，原 builder 已被移走，**无法回退**，窗口就建不出来了。
/// 而 `WebviewWindow::set_icon(&self, ...)` 借用 `&self`，失败只是这一行无效，
/// 窗口照常存在 —— 对「图标是锦上添花」这个定位更合适。
///
/// 失败静默忽略（拿不到图标或设不上都不该影响窗口使用）。
fn set_creation_icon<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Some(icon) = creation_icon(window.app_handle()) {
        let _ = window.set_icon(icon);
    }
}

/// 创建启动选择窗口。
fn create_selector_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, SELECTOR_LABEL, WebviewUrl::App("index.html".into()))
        .title(SELECTOR_TITLE)
        .inner_size(SELECTOR_WIDTH, SELECTOR_HEIGHT)
        .min_inner_size(460.0, 380.0)
        .resizable(true)
        .maximizable(false)
        .center()
        .visible(true);
    let selector = with_shared_profile(app, builder).build()?;
    // v0.3.3：创建后立刻设主题对应的 logo（选择窗口是**第一个**窗口，
    // 此时还没有任何窗口可问主题 ⇒ 内部走注册表，见 `creation_icon`）。
    set_creation_icon(&selector);
    Ok(())
}

/// 主窗口客户区的**逻辑**尺寸。
///
/// 统一在这里做「物理 → 逻辑」换算，避免任何地方手算 `* scale`。
/// 旧实现手算 `CHROME_HEIGHT * scale` 又把它当逻辑值传给 Tauri，
/// 被框架再乘一次 scale ⇒ 顶栏被缩放两次（用户截图 P1 实测 158 device px）。
fn main_logical_size<R: Runtime>(window: &tauri::Window<R>) -> Option<(f64, f64)> {
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some((size.width, size.height))
}

/// 子 webview 的**预绘制底色** —— 专治深色模式下的「白色闪烁 / 白色卡顿」。
///
/// # 为什么需要它
///
/// WebView2 在**页面内容绘制出来之前**会先用自己的默认背景色填满整块区域，
/// 而那个默认色是**白色**。于是深色模式下：
///
/// - 侧栏 `chat` 刚 `show()` / 刚创建、还在加载 `https://chat.deepseek.com/` 时，
///   会在右侧露出一大块白底；
/// - 滑入/滑出动画期间，这块白底跟着一起平移 ⇒ 用户看到的就是「白色卡顿」。
///
/// 这不是动画的错，是**底色**的错：动画只是把一块本来就白的区域移动了起来。
///
/// # 取值依据
///
/// 按系统主题取，与 `src/titlebar/titlebar.css` 里 `:root` / `prefers-color-scheme: light`
/// 的实测值**逐位一致**，保证顶栏与侧栏的预绘制底色不会互相打架：
///
/// | 主题 | 取值 | 依据 |
/// | --- | --- | --- |
/// | 深色（含探测不到） | `#1b1b1c` = (27,27,28) | 官方 DeepSeek 桌面端实测底色，见 titlebar.css 注释 |
/// | 浅色 | `#f3f3f3` | titlebar.css 浅色主题的 `--dsht-bg` |
///
/// 探测不到主题时按**深色**处理，理由与托盘图标一致：Windows 11 默认深色，
/// 而白底在深色界面里最刺眼（反过来只是「不够亮」）。
///
/// # 为什么不用 `transparent(true)`
///
/// `transparent(true)` 在 wry 里等价于把底色设成 `(0,0,0,0)`
/// （`wry-0.57.0/src/webview2/mod.rs:127`），而且要走 DirectComposition 的
/// 透明合成路径 —— 对一个**不透明**的远程网页来说没有收益，反而多一层合成开销。
/// 所以这里用**不透明**的深色底，正是我们想要的「别露白」。
fn child_background_color(theme: Option<Theme>) -> tauri::webview::Color {
    match theme {
        Some(Theme::Light) => tauri::webview::Color(0xf3, 0xf3, 0xf3, 0xff),
        _ => tauri::webview::Color(0x1b, 0x1b, 0x1c, 0xff),
    }
}

/// 把所有**已存在**的子 webview 底色刷成当前主题对应的值。
///
/// 系统在浅色 / 深色之间切换时调用：底色是**创建时**烧进 WebView2 控制器的，
/// 不刷新的话，切到深色后预绘制底色仍是浅色（反之亦然）⇒ 又出现一次闪烁。
fn refresh_child_background_colors<R: Runtime>(app: &AppHandle<R>, theme: Option<Theme>) {
    let color = child_background_color(theme);
    for label in [TITLEBAR_LABEL, CONTENT_LABEL, CHAT_LABEL] {
        if let Some(webview) = app.get_webview(label) {
            let _ = webview.set_background_color(Some(color));
        }
    }
}

/// 给子 webview 构造器套上共享的 WebView2 数据目录 + **预绘制底色**。
///
/// 所有 webview 共用同一份 profile ⇒ 登录态共享，且 cookie 仍然落盘
/// （会话 cookie 转持久 cookie 的 keeper 依赖这一点）。
///
/// 底色见 [`child_background_color`]：没有它，深色模式下每个子 webview
/// 在首次绘制前都会先露一块白底。
fn child_webview_builder<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: WebviewUrl,
) -> tauri::webview::WebviewBuilder<R> {
    let builder = tauri::webview::WebviewBuilder::new(label, url)
        .background_color(child_background_color(current_theme(app)));
    match webview_data_dir(app) {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    }
}

/* ------------------------------------------------------- chat 布局模式缓存 */

/// 「网页对话」是否处于 `docked`（并排）模式 —— 即 [`AppConfig::chat_docked`] 的内存副本。
///
/// # 为什么用 `static AtomicBool` 而不是每次都读配置
///
/// [`layout_main_webviews`] 会被 `WindowEvent::Resized` / `ScaleFactorChanged` 调用，
/// 而窗口缩放期间这两个事件**每帧都会来**（拖动窗口边缘时一秒几十次）。
/// `read_config()` 是 `fs::read_to_string` + `serde_json::from_str` —— 每次都读盘会让
/// 主线程在缩放时被文件 IO 拖住（机械盘/杀软实时扫描下尤其明显），
/// 而且这个值在一次设置保存之间根本不会变。
///
/// 所以：**只在两个时刻**更新这个缓存 ——
///   1. 应用启动时（[`sync_chat_docked_from_disk`]）；
///   2. 设置窗口保存配置时（[`save_config`] 命令）。
///
/// 取舍说明：缓存与磁盘理论上可以不一致（例如用户手动编辑 config.json 后不重启），
/// 但配置文件的**唯一写入方**就是本进程的 `save_config`，所以这个窗口不存在。
/// 手动改文件的用户需要重启程序才生效 —— 这是可接受的，也在文档里写明了。
static CHAT_DOCKED: AtomicBool = AtomicBool::new(false);

/// 把磁盘上的 `chat_docked` 读进 [`CHAT_DOCKED`] 缓存。启动时调用一次。
fn sync_chat_docked_from_disk<R: Runtime>(app: &AppHandle<R>) {
    let docked = read_config(app).chat_docked;
    CHAT_DOCKED.store(docked, Ordering::Relaxed);
}

/// 当前是否 docked 模式（供设置窗口回显、布局分支判断使用）。
fn chat_docked() -> bool {
    CHAT_DOCKED.load(Ordering::Relaxed)
}

/// 一个子 webview 的几何：`(x, y, 宽, 高)`，全部是**逻辑**单位。
type Rect = (f64, f64, f64, f64);

/// **对话侧栏的目标几何**（`(x, y, 宽, 高)`，逻辑单位）—— 与对话模式**无关**。
///
/// 这是侧栏打开/关闭时**唯一**的位置与尺寸来源：无论 `overlay` 还是 `docked`，
/// 侧栏都是贴在客户区右侧、顶栏下方的那块 `CHAT_WIDTH × (高-40)`；
/// 两种模式的差别只在**内容页要不要让出宽度**（见 [`main_webview_rects`]）。
///
/// 之所以独立成一个纯函数，是给「侧栏开/关过渡动画」留一个稳定的接入点：
/// 动画只需把「如何到达这个目标」换成逐帧插值，
/// **不必碰布局逻辑**（谁占多宽、谁盖在谁上面仍只由 [`main_webview_rects`] 决定）。
fn chat_target_bounds(width: f64, height: f64) -> Rect {
    // 窗口比侧栏还窄时把侧栏压到窗口宽度，避免算出负宽度。
    let chat_width = CHAT_WIDTH.min(width).max(1.0);
    let content_height = (height - TITLEBAR_HEIGHT).max(1.0);
    (width - chat_width, TITLEBAR_HEIGHT, chat_width, content_height)
}

/// 主窗口客户区尺寸 → 三个子 webview 的几何。
///
/// **纯函数**（不碰 `AppHandle`、不读盘），所以两种模式的分支可以直接单测 ——
/// 见 `tests::docked_mode_shrinks_content_and_tiles_with_chat`。
///
/// `docked` = 「chat 已创建 **且** 当前可见 **且** 配置为 docked」。
fn main_webview_rects(width: f64, height: f64, docked: bool) -> (Rect, Rect, Rect) {
    let content_height = (height - TITLEBAR_HEIGHT).max(1.0);
    let chat_width = CHAT_WIDTH.min(width).max(1.0);
    // overlay：内容页占**整宽**，chat 盖在它右侧之上。
    // docked：内容页让出 chat_width，两者**精确平铺**、不重叠。
    let content_width = if docked { (width - chat_width).max(1.0) } else { width };

    let titlebar = (0.0, 0.0, width, TITLEBAR_HEIGHT);
    let content = (0.0, TITLEBAR_HEIGHT, content_width, content_height);
    // 侧栏几何统一走 chat_target_bounds（动画接入点），这里不重复计算。
    let chat = chat_target_bounds(width, height);
    (titlebar, content, chat)
}

/// 摆放主窗口里的子 webview（顶栏 / 内容 / 对话侧栏）。
///
/// 这里**只做 `set_position` / `set_size`**：它们是非阻塞的消息投递，
/// 可以在窗口事件（主线程）里安全调用。**绝不在这里创建 webview**
/// （`add_child` 会阻塞等主线程 ⇒ 主线程里调用必然死锁）。
///
/// 全部使用**逻辑**单位；Tauri 会自己换算成物理像素。
///
/// # 两种对话模式
///
/// 判定依据是 [`chat_docked`]（内存缓存，**不读盘** —— 见该 static 的说明）：
///
/// | 模式 | content | chat |
/// | --- | --- | --- |
/// | `overlay`（`chat_docked == false`，默认） | `(0, 40)` `(宽, 高-40)` 整宽 | `(宽-chatW, 40)` `(chatW, 高-40)`，**盖在**内容页右侧 |
/// | `docked`（`chat_docked == true`） | `(0, 40)` `(宽-chatW, 高-40)` 让出右侧 | `(宽-chatW, 40)` `(chatW, 高-40)`，与内容页**并排** |
///
/// 注意：`docked` 只改变**子 webview 的宽度分配**，**不动主窗口本身的尺寸**
/// （用户明确要求「不改变程序窗口大小」）。chat 子 webview 尚未创建时
/// （用户还没点过「网页对话」）两种模式的结果完全一致 —— content 占整宽。
fn layout_main_webviews<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_window(MAIN_LABEL) else {
        return;
    };
    let Some((width, height)) = main_logical_size(&main) else {
        return;
    };

    // 只有「侧栏已创建 且 当前可见 且 docked 模式」才让出宽度，否则维持整宽。
    // `CHAT_VISIBLE` 是「用户当前有没有把侧栏打开」—— 侧栏被 `hide()` 之后
    // docked 模式同样不该继续占着内容宽度。
    let docked = chat_docked()
        && CHAT_VISIBLE.load(Ordering::Relaxed)
        && app.get_webview(CHAT_LABEL).is_some();

    let (titlebar_rect, content_rect, chat_rect) = main_webview_rects(width, height, docked);

    if let Some(titlebar) = app.get_webview(TITLEBAR_LABEL) {
        let _ = titlebar
            .set_position(tauri::LogicalPosition::new(titlebar_rect.0, titlebar_rect.1));
        let _ = titlebar.set_size(tauri::LogicalSize::new(titlebar_rect.2, titlebar_rect.3));
    }
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
        let _ = content
            .set_position(tauri::LogicalPosition::new(content_rect.0, content_rect.1));
        let _ = content.set_size(tauri::LogicalSize::new(content_rect.2, content_rect.3));
    }
    // ⚠️ 动画正在跑时**绝不碰侧栏**：它的位置由 `anim` 逐帧决定，
    // 这里再摆一次会互相打架 —— 打开时会把还没滑入的侧栏先摆到终点（闪一下），
    // 关闭时会把正在滑出的侧栏先拽回终点（弹一下）。两种都像「卡帧」。
    // 内容页与顶栏不受影响，照常摆放。
    if anim::is_animating() {
        return;
    }
    if let Some(chat) = app.get_webview(CHAT_LABEL) {
        let _ = chat.set_position(tauri::LogicalPosition::new(chat_rect.0, chat_rect.1));
        let _ = chat.set_size(tauri::LogicalSize::new(chat_rect.2, chat_rect.3));
    }
}

/// 把窗口状态推给顶栏 webview，让它把「最大化」按钮切成「还原」图标。
///
/// 这**只是锦上添花**：顶栏在没有收到任何事件时依然完全可用
/// （前端对「收不到事件」做了降级）。所以这里失败也不报错。
///
/// 「最大化时不允许拖动」不依赖这个事件 —— 那个判断放在 `start_drag` 里做。
fn emit_window_state<R: Runtime>(app: &AppHandle<R>, window: &tauri::Window<R>) {
    let payload = serde_json::json!({
        "maximized": window.is_maximized().unwrap_or(false),
        "fullscreen": window.is_fullscreen().unwrap_or(false),
    });
    let _ = app.emit_to(TITLEBAR_LABEL, "dsht:window-state", payload);
}

/// 在主窗口里挂上顶栏子 webview（**本地**页面 ⇒ 命中 capability ⇒ 有 IPC）。
///
/// 创建失败时调用方会把窗口退回系统标题栏，保证用户至少还能移动 / 关闭窗口。
fn ensure_titlebar_webview<R: Runtime>(
    app: &AppHandle<R>,
    main: &tauri::Window<R>,
) -> Result<(), String> {
    if app.get_webview(TITLEBAR_LABEL).is_some() {
        return Ok(());
    }
    let (width, _) =
        main_logical_size(main).ok_or_else(|| "无法读取主窗口尺寸".to_string())?;
    main.add_child(
        child_webview_builder(app, TITLEBAR_LABEL, WebviewUrl::App("titlebar.html".into())),
        tauri::LogicalPosition::new(0.0, 0.0),
        tauri::LogicalSize::new(width, TITLEBAR_HEIGHT),
    )
    .map_err(|e| format!("创建顶栏 webview 失败：{e}"))?;
    Ok(())
}

/// 在主窗口里挂上内容子 webview（**远程**页面 ⇒ 按设计不授予任何 capability）。
fn ensure_content_webview<R: Runtime>(
    app: &AppHandle<R>,
    main: &tauri::Window<R>,
    url: tauri::Url,
) -> Result<(), String> {
    if app.get_webview(CONTENT_LABEL).is_some() {
        return Ok(());
    }
    let (width, height) =
        main_logical_size(main).ok_or_else(|| "无法读取主窗口尺寸".to_string())?;
    main.add_child(
        child_webview_builder(app, CONTENT_LABEL, WebviewUrl::External(url)),
        tauri::LogicalPosition::new(0.0, TITLEBAR_HEIGHT),
        tauri::LogicalSize::new(width, (height - TITLEBAR_HEIGHT).max(1.0)),
    )
    .map_err(|e| format!("创建内容 webview 失败：{e}"))?;
    Ok(())
}

/// 内容 webview 导航到新地址（托盘「重新选择连接方式」切换地址时用）。
///
/// 复用同一个 webview 而不是销毁重建：销毁「正在执行 IPC 的 webview」会让
/// Windows 的消息处理进入坏状态（历史 bug，见 CHANGELOG v0.1.x）。
fn navigate_content<R: Runtime>(app: &AppHandle<R>, url: tauri::Url) -> Result<(), String> {
    let content = app
        .get_webview(CONTENT_LABEL)
        .ok_or_else(|| "内容页面尚未就绪".to_string())?;
    content
        .navigate(url)
        .map_err(|e| format!("切换连接地址失败：{e}"))
}

/// 主窗口（连同顶栏、内容、侧栏）整体隐藏 —— 「关闭 = 隐藏到托盘」走这里。
///
/// 子 webview 随父窗口一起隐藏，不需要逐个处理。
fn hide_main_windows<R: Runtime>(app: &AppHandle<R>) {
    // 先掐掉可能还在跑的侧栏过渡动画：窗口都要收起来了，
    // 让一个后台线程继续改 webview 位置既没意义，也可能和「重新显示」打架。
    anim::cancel();
    if let Some(main) = app.get_window(MAIN_LABEL) {
        let _ = main.hide();
    }
}

/// 主窗口整体显示 —— 托盘「显示主窗口」走这里。
fn show_main_windows<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_window(MAIN_LABEL) else {
        return;
    };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    // 显示后重新摆一次子 webview：窗口可能在隐藏期间被改过尺寸。
    layout_main_webviews(app);
}

/// 对话侧栏当前是否可见。
///
/// `Webview`（子 webview）**没有** `is_visible()`（那是 `WebviewWindow` 才有的），
/// 所以自己记一份状态。它只在命令路径上被读写，用 `AtomicBool` 足够。
static CHAT_VISIBLE: AtomicBool = AtomicBool::new(false);

/// 「网页对话」：创建 / 显示 / 隐藏右侧侧栏子 webview。
///
/// ⚠️ **必须从异步命令调用**：`add_child` 内部是 `run_on_main_thread` + `recv()`，
/// 在 Windows 上从主线程（同步命令 / 事件处理器）调用会**死锁**。
/// 这正是用户报告的「点『网页对话』整个程序卡死、只能任务管理器强杀」的根因。
///
/// # 目标几何的唯一来源
///
/// 侧栏打开时的位置/尺寸**只**取自 [`chat_target_bounds`]（纯函数）；
/// 内容页要不要让宽度则由 [`layout_main_webviews`] 按当前模式决定。
/// 两者职责分离，是为了让「开/关过渡动画」只改「如何到达目标」而不动布局逻辑。
fn toggle_chat_webview<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(main) = app.get_window(MAIN_LABEL) else {
        return Err("还没有主窗口，请先连接".to_string());
    };

    // 已创建：切换显示 / 隐藏。
    if let Some(chat) = app.get_webview(CHAT_LABEL) {
        if CHAT_VISIBLE.load(Ordering::Relaxed) {
            // ---------------- 关闭 ----------------
            CHAT_VISIBLE.store(false, Ordering::Relaxed);
            // 先掐掉可能还在跑的滑入动画：本次「关闭」要接管侧栏的几何。
            // （`cancel()` 会同时清掉 `is_animating()`，让下面的 layout 能摆放侧栏。）
            anim::cancel();

            // ⚠️ **两种模式共用同一条滑出动画**（v0.3.2 起）。
            //
            // v0.3.1 里 docked 是「直接切到位、不滑动」，理由是「逐帧缩放会让内容页
            // 每帧重排」。但那条理由**只对「逐帧改内容页宽度」成立**，而下面的做法
            // 把内容页的宽度变化**只做一次**、且**在侧栏滑走的同时**完成 ——
            // 于是既没有逐帧重排，也没有 v0.3.1 那种「啪一下跳过去」的生硬感。
            let (width, height) =
                main_logical_size(&main).ok_or_else(|| "无法读取主窗口尺寸".to_string())?;
            let (target_x, y, chat_w, chat_h) = chat_target_bounds(width, height);

            // 从**当前真实位置**出发（可能正停在动画中途）。
            // 必须在 `layout_main_webviews` **之前**读：layout 会把侧栏摆回目标位，
            // 之后再读就只能读到目标位，滑出会从「完全打开」突然开始（可见跳变）。
            //
            // 夹到 `[target_x, width]`：
            // - 下界：中途位置不该比目标更靠左（否则滑出会先向右倒退一下）；
            // - 上界：窗口在侧栏可见期间被**改窄**时，旧位置可能已经在 `width` 之外，
            //   从那里出发会「向左滑入可见区再消失」，看起来是闪一下。
            //   夹到 `width` 后它就正好是「从屏幕边缘滑出」，观感正确。
            //
            // `Webview::position()` 返回**物理**坐标，要除 scale 换回逻辑单位 ——
            // 这正是旧实现翻车的地方（物理/逻辑混用），所以这里显式换算并注释。
            let from_x = chat
                .position()
                .ok()
                .and_then(|p| main.scale_factor().ok().map(|s| p.x as f64 / s))
                .map(|x| x.clamp(target_x, width))
                .unwrap_or(target_x);

            // ⚠️ **顺序：先起动画、再 layout**（与 v0.3.1 的 overlay 分支一致）。
            //
            // `slide_x_with` 会在返回前**同步**取得侧栏几何独占权，于是紧随其后的
            // `layout_main_webviews` 只摆顶栏和内容页、**不碰侧栏**
            // （否则它会把刚要从 `from_x` 出发的侧栏一把拽到 `target_x` ⇒ 闪一下）。
            //
            // 这一步同时把**内容页的宽度还回去**，这就是「白闪」的根治点：
            // `CHAT_VISIBLE` 在上面已置 false，layout 据此算出 `docked = false`，
            // 于是 docked 模式下内容页从「让出 chatW」恢复成整宽。
            //
            // 为什么这一次重排不会闪：内容页变宽与侧栏滑出**在同一时刻**开始，
            // 变宽发生在侧栏**底下**；等侧栏滑走时，那一块已经有内容页画好了。
            // v0.3.1 的 docked 分支是「先 layout 让宽、再 hide」——两者之间没有任何
            // 过渡，`[target_x, width]` 那块会先空一帧再被内容页填上，看着就是白闪。
            anim::slide_x_with(app, CHAT_LABEL, from_x, width, y, chat_w, chat_h, |app| {
                if let Some(chat) = app.get_webview(CHAT_LABEL) {
                    let _ = chat.hide();
                }
            });
            layout_main_webviews(app);
            eprintln!("[DSHTauri] 对话侧栏已隐藏");
        } else {
            // ---------------- 打开 ----------------
            // 先读当前位置（可能正停在**滑出**动画中途），**再**掐掉旧动画。
            // 顺序不能反：要的是「接管之前」的真实位置，用来决定滑入起点。
            // `Webview::position()` 返回**物理**坐标，要除 scale 换回逻辑单位 ——
            // 这正是旧实现翻车的地方（物理/逻辑混用），所以这里显式换算并注释。
            //
            // `was_animating` 也必须在 `cancel()` **之前**读：它区分「接管一个半途的
            // 滑出动画」（从当前位置反向滑回）与「侧栏本来就藏着」（从屏幕外完整滑入）。
            let was_animating = anim::is_animating();
            let resume_x = chat
                .position()
                .ok()
                .and_then(|p| main.scale_factor().ok().map(|s| p.x as f64 / s));

            // 「打开」= 接管侧栏几何。必须掐掉可能在飞的**滑出**动画：
            // 它的收尾回调是 `hide()`，若不取消，它会在我们 `show()` **之后**
            // 把侧栏又藏起来，留下「CHAT_VISIBLE=true 但侧栏不可见」的坏状态。
            // （用户快速「关→开」、或在设置里切换 overlay/docked 时都会撞上。）
            anim::cancel();

            // overlay：内容页整宽不动，侧栏从客户区右侧外滑入。
            // 侧栏**尺寸全程不变**，所以动画期间不需要重排任何页面。
            let (width, height) =
                main_logical_size(&main).ok_or_else(|| "无法读取主窗口尺寸".to_string())?;
            let (target_x, y, chat_w, chat_h) = chat_target_bounds(width, height);

            // 起点怎么定，分两种情况：
            //
            // 1. **刚接管一个半途的滑出动画**：从当前位置接着滑回来，
            //    观感是平滑反向，不会「跳」回屏幕外重来一次。
            // 2. **侧栏本来就藏着**（含 docked 隐藏后切到 overlay）：
            //    必须从「完全移出客户区右侧」的 `width` 出发。
            //    ⚠️ 不能直接沿用「上次停留的 x」—— docked 隐藏时它停在 `target_x`，
            //    而窗口在隐藏期间被改过宽度时它又可能落在可视区内；
            //    两种情况都会让侧栏先「闪现」在某个位置再滑，看起来是闪一下。
            //
            // 两种都夹到 `[target_x, width]`：中途位置不该比目标更靠左（那会先倒退），
            // 也不该超出屏幕外（那会多滑一段空白）。
            let from_x = if was_animating {
                resume_x
                    .map(|x| x.clamp(target_x, width))
                    .unwrap_or(width)
            } else {
                width
            };

            // ⚠️ **先摆位、再 `show()`**：`show()` 是瞬时的，
            // 如果它先执行，侧栏会在「上一次隐藏时停留的位置」上露一帧
            // （docked 隐藏后就停在目标位 ⇒ 用户看到侧栏先闪现在目标位再跳去屏幕外）。
            // 摆位必须在隐藏状态下完成，用户看不到这一步。
            let _ = chat.set_position(tauri::LogicalPosition::new(from_x, y));
            let _ = chat.set_size(tauri::LogicalSize::new(chat_w, chat_h));
            chat.show().map_err(|e| e.to_string())?;
            CHAT_VISIBLE.store(true, Ordering::Relaxed);

            // ⚠️ **先起动画、再排版**：`slide_x` 会在返回前**同步**取得几何独占权，
            // 于是 `layout_main_webviews` 不会把刚摆到屏幕外的侧栏又拽回目标位。
            //
            // docked 与 overlay 在这里**唯一**的差别是「内容页什么时候收窄」：
            //
            // · overlay：内容页本来就整宽，layout 只是幂等地重摆一次 —— 随时调都行。
            // · docked：内容页必须从整宽缩到「宽 - chatW」。**不能在动画开始时就缩**，
            //   因为那一刻侧栏还在窗口外，`[target_x, width]` 那块会先变成没有页面
            //   覆盖的空带（深色主题下就是用户看到的「白闪」），侧栏随后才滑进来盖住它。
            //   所以改成**等侧栏滑到位（`on_done`）再缩**：收窄发生在侧栏**已经盖住**
            //   右侧之后，那条空带从未露出来。
            //
            // 诚实说明：docked 下**必然有一次**内容页重排（并排模式本来就要变窄）。
            // 本版把这次重排从「滑动过程中」挪到了「滑动结束、被侧栏遮住时」，
            // 于是**滑动过程本身是零重排**的 —— 这正是 overlay 之所以顺的原因。
            //
            // `on_done` 在动画线程上执行；`layout_main_webviews` 只投递
            // `set_position` / `set_size`（非阻塞消息），是线程安全的，
            // 与关闭分支在 `on_done` 里调 `hide()` 同理。
            if chat_docked() {
                anim::slide_x_with(app, CHAT_LABEL, from_x, target_x, y, chat_w, chat_h, |app| {
                    layout_main_webviews(app);
                });
            } else {
                anim::slide_x(app, CHAT_LABEL, from_x, target_x, y, chat_w, chat_h);
                layout_main_webviews(app);
            }
            eprintln!("[DSHTauri] 对话侧栏已显示");
        }
        return Ok(());
    }

    // 首次打开：创建子 webview，初始几何 = chat_target_bounds（唯一的侧栏目标几何）。
    let (width, height) =
        main_logical_size(&main).ok_or_else(|| "无法读取主窗口尺寸".to_string())?;
    let (x, y, chat_width, chat_height) = chat_target_bounds(width, height);
    let url = CHAT_URL
        .parse()
        .map_err(|e| format!("对话页地址无效：{e}"))?;

    // **两种模式都从客户区右侧外创建**，再滑入到目标位 —— 与「已创建后打开」
    // 走完全相同的路径，所以第一次点「网页对话」也有动画。
    //
    // v0.3.0 这里是「直接创建在目标位」—— 第一次点根本没有动画，观感与后续不一致。
    // v0.3.1 只给 overlay 补了滑入，docked 仍然直接建在目标位（理由同样是
    // 「逐帧缩放会让内容页重排」）。v0.3.2 起 docked 也滑入：
    // 滑动期间内容页**不收窄**（见下面的 `on_done`），所以滑动过程零重排。
    //
    // 先建在屏幕外还有个额外好处：侧栏页面正好利用这段时间开始加载。
    let create_x = width;

    main.add_child(
        child_webview_builder(app, CHAT_LABEL, WebviewUrl::External(url)),
        tauri::LogicalPosition::new(create_x, y),
        tauri::LogicalSize::new(chat_width, chat_height),
    )
    .map_err(|e| format!("打开对话侧栏失败：{e}"))?;

    CHAT_VISIBLE.store(true, Ordering::Relaxed);
    // ⚠️ 先起动画再排版：`slide_x` / `slide_x_with` 返回时 `anim::is_animating()`
    // 已同步置 true，于是 `layout_main_webviews` 不会把侧栏从屏幕外拽回目标位。
    //
    // docked：内容页在 `on_done`（侧栏滑到位、已经盖住右侧）之后才收窄，
    // 避免「侧栏还在窗口外、右侧先空出一条带子」的那一帧（用户看到的就是白闪）。
    if chat_docked() {
        anim::slide_x_with(app, CHAT_LABEL, create_x, x, y, chat_width, chat_height, |app| {
            layout_main_webviews(app);
        });
    } else {
        anim::slide_x(app, CHAT_LABEL, create_x, x, y, chat_width, chat_height);
        layout_main_webviews(app);
    }
    // 这行日志是「缺陷 B 已修复」的运行时证据：能打印出来说明
    // `add_child` 返回了（没有在主线程上死锁），命令链顺利走完。
    eprintln!("[DSHTauri] 对话侧栏 webview 已创建");
    Ok(())
}

/// 「关于」窗口。
fn show_about_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(about) = app.get_webview_window(ABOUT_LABEL) {
        let _ = about.show();
        let _ = about.set_focus();
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, ABOUT_LABEL, WebviewUrl::App("about.html".into()))
        .title(ABOUT_TITLE)
        .inner_size(ABOUT_WIDTH, ABOUT_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .visible(true);
    let about = with_shared_profile(app, builder)
        .build()
        .map_err(|e| format!("打开关于窗口失败：{e}"))?;
    // v0.3.3：关于窗口是**按需创建**的，远晚于 `apply_theme_icons` 的最后一次调用，
    // 不在这里设图标就会一直用 bundle 里那个静态深藏青 `icon.ico`（用户实测的缺陷）。
    set_creation_icon(&about);
    Ok(())
}

/// 「设置」窗口。
///
/// 与「关于」完全同构：独立 `WebviewWindow`，加载**本地** `settings.html`，
/// 因此命中 `capabilities/default.json` 的 `windows` 列表 ⇒ **有 IPC**，
/// 可以直接 `invoke("load_config" / "save_config" / "chrome_action")`。
///
/// 单例：已经存在就 `show()` + `set_focus()`，不重复创建
/// （重复 `build()` 同 label 窗口在 Windows 上会因旧 WebView2 尚未销毁而失败）。
fn show_settings_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(settings) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = settings.unminimize();
        let _ = settings.show();
        let _ = settings.set_focus();
        return Ok(());
    }
    let builder =
        WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("settings.html".into()))
            .title(SETTINGS_TITLE)
            .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
            .min_inner_size(480.0, 400.0)
            .resizable(true)
            .maximizable(false)
            .minimizable(true)
            .center()
            .visible(true);
    let settings = with_shared_profile(app, builder)
        .build()
        .map_err(|e| format!("打开设置窗口失败：{e}"))?;
    // v0.3.3：同「关于」窗口 —— 按需创建，必须在这里设图标（见 `set_creation_icon`）。
    set_creation_icon(&settings);
    Ok(())
}


/// 托盘「显示主窗口」/ 左键点击托盘：优先主窗口（连同标题栏和侧栏），
/// 其次选择窗口，都没有就重建选择窗口。
fn reveal_window<R: Runtime>(app: &AppHandle<R>) {
    if app.get_window(MAIN_LABEL).is_some() {
        show_main_windows(app);
        return;
    }
    reveal_selector(app);
}

/// 托盘「重新选择连接方式」/ 自定义标题栏的「重新连接」：
/// 把选择窗口叫出来（它只是被隐藏了，没有销毁）。
fn reveal_selector<R: Runtime>(app: &AppHandle<R>) {
    if let Some(selector) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = selector.unminimize();
        let _ = selector.show();
        let _ = selector.set_focus();
        return;
    }
    // 理论上不会走到这里（选择窗口不会被销毁），保底重建。
    if let Err(err) = create_selector_window(app) {
        eprintln!("[DSHTauri] 重建选择窗口失败：{err}");
    }
}


/// 把 WebView2 里的**会话 cookie** 改成持久 cookie。
///
/// Chromium 的会话 cookie（没有 Expires 的那种）只活在内存里，浏览器进程一退就没了。
/// Cloudflare Access 的 `CF_Authorization` 正是会话 cookie —— 这就是「每次开程序都要重新登录」
/// 的原因（持久 cookie 我们已经在冒烟测试里验证过能跨重启保留）。
///
/// 做法：取出该页面可见的 cookie，凡是 `IsSession == true` 的，把 `Expires` 设成正数
/// （WebView2 里 Expires >= 0 即视为持久 cookie），再 `AddOrUpdateCookie` 写回去。
#[cfg(windows)]
fn persist_session_cookies<R: Runtime>(webview: &tauri::Webview<R>, page_url: &str) {
    use webview2_com::GetCookiesCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Cookie, ICoreWebView2CookieList, ICoreWebView2_2,
    };
    use windows_core::{Interface, BOOL, HSTRING};

    /// 转换后的有效期
    const KEEP_DAYS: f64 = 30.0;

    let uri = HSTRING::from(page_url);
    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(_) => return,
        };
        // CookieManager 是在 ICoreWebView2_2 上新增的，需要从 ICoreWebView2 cast 过去
        let core2: ICoreWebView2_2 = match core.cast() {
            Ok(core2) => core2,
            Err(_) => return,
        };
        let manager = match unsafe { core2.CookieManager() } {
            Ok(manager) => manager,
            Err(_) => return,
        };
        let manager_in_handler = manager.clone();

        // 注意：webview2-com 已经把 HRESULT 转成 Result 再传给闭包（见 ClosureArg for HRESULT）
        let handler = GetCookiesCompletedHandler::create(Box::new(
            move |result: windows_core::Result<()>,
                  cookies: Option<ICoreWebView2CookieList>|
                  -> windows_core::Result<()> {
            result?;
            let Some(cookies) = cookies else {
                return Ok(());
            };
            let mut count = 0u32;
            unsafe { cookies.Count(&mut count)? };

            let expires = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0)
                + KEEP_DAYS * 24.0 * 3600.0;

            for index in 0..count {
                let cookie: ICoreWebView2Cookie = unsafe { cookies.GetValueAtIndex(index)? };
                let mut is_session = BOOL(0);
                unsafe { cookie.IsSession(&mut is_session)? };
                if is_session.as_bool() {
                    unsafe { cookie.SetExpires(expires)? };
                    unsafe { manager_in_handler.AddOrUpdateCookie(&cookie)? };
                }
            }
            Ok(())
        }));

        let _ = unsafe { manager.GetCookies(&uri, &handler) };
    });
}

/// 非 Windows 上没有 WebView2，什么都不做。
#[cfg(not(windows))]
fn persist_session_cookies<R: Runtime>(_webview: &tauri::Webview<R>, _page_url: &str) {}

/// 后台定期把会话 cookie 转成持久 cookie。
///
/// 不能只在页面加载完成时做一次：Cloudflare Access 的授权 cookie 往往是在
/// 跳转/异步请求之后才落下来的。所以起一个轻量线程，启动后很快跑一次，之后每 20 秒一次
/// （`GetCookies` 很便宜，开销可以忽略）。
fn spawn_cookie_keeper<R: Runtime>(app: AppHandle<R>) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
    std::thread::spawn(move || {
        let mut first = true;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(if first { 5 } else { 20 }));
            first = false;
            for label in [CONTENT_LABEL, CHAT_LABEL] {
                let Some(webview) = app.get_webview(label) else {
                    continue;
                };
                let Ok(url) = webview.url() else { continue };
                let url = url.to_string();
                if !url.starts_with("http") {
                    continue;
                }
                persist_session_cookies(&webview, &url);
            }
        }
    });
    });
}

/* -------------------------------------------------------------------- tray */

/// 按系统主题挑 logo 图标：深色主题用**白色**鲸鱼，浅色主题用**深藏青**鲸鱼。
///
/// 主题探测不到时按**深色**处理——Windows 11 默认就是深色任务栏，
/// 而深色 logo 落在深色底上会直接看不见，比反过来更糟。
///
/// 同一个函数同时服务**托盘图标**与**窗口/任务栏图标**（见 [`apply_theme_icons`]），
/// 保证两处配色始终一致。
fn themed_icon(theme: Option<Theme>) -> Option<Image<'static>> {
    let bytes = match theme {
        Some(Theme::Light) => ICON_ON_LIGHT,
        _ => ICON_ON_DARK,
    };
    Image::from_bytes(bytes).ok()
}

/// 给**窗口创建时**用的图标：不依赖任何窗口已经存在。
///
/// # 为什么不能直接用 [`current_theme`]
///
/// `current_theme()` 靠 `Window::theme()` 读，而它要求**窗口已经存在**。
/// 创建**第一个**窗口（选择窗口）时一个窗口都还没有 ⇒ 只能得到 `None`
/// ⇒ [`themed_icon`] 按「深色」给**白色**鲸鱼 ⇒ 浅色系统上这个图标
/// 落在白色标题栏里几乎看不见。
///
/// 所以这里优先读注册表（不依赖窗口），读不到才退回 `current_theme()`，
/// 最后仍读不到就交给 [`themed_icon`] 的「按深色」默认。
fn creation_icon<R: Runtime>(app: &AppHandle<R>) -> Option<Image<'static>> {
    // 1) 注册表：无窗口依赖，创建第一个窗口时也能拿到正确主题。
    if let Some(light) = win_icon::apps_prefers_light() {
        return themed_icon(Some(if light { Theme::Light } else { Theme::Dark }));
    }
    // 2) 已有窗口（例如「关于」窗口是在选择窗口之后才开的）⇒ 问窗口。
    // 3) 都没有 ⇒ `themed_icon(None)` 按深色处理。
    themed_icon(current_theme(app))
}

/// 把当前主题对应的 logo 同时应用到**托盘**与**主窗口（任务栏/标题栏）**。
///
/// 为什么窗口图标也要跟着换：Windows 的深色任务栏上，深藏青鲸鱼几乎看不见；
/// 而浅色任务栏上白色鲸鱼同样看不见。托盘图标早就有这个适配，窗口图标却没有 ——
/// 用户要求「统一 logo、自动变」，所以这里一起切。
///
/// 失败只忽略（拿不到图标或窗口时不影响主流程）。
fn apply_theme_icons<R: Runtime>(app: &AppHandle<R>, theme: Option<Theme>) {
    // ⚠️ 这里要区分**两套主题**，它们由 Windows 的两个独立开关控制：
    //
    //   · `AppsUseLightTheme`  → 应用窗口（tao 的 `Theme` 读的就是它）；
    //   · `SystemUsesLightTheme` → **任务栏 / 托盘所在的外壳**。
    //
    // 用户在「个性化 → 颜色」选「自定义」时两者可以不一致。托盘和任务栏按钮都长在
    // **任务栏**上，所以它们必须按**外壳**主题选色；窗口图标按**应用**主题选色。
    //
    // 这正是 v0.3.1「深色任务栏上鲸鱼看不见」的另一半原因（另一半是 Tauri 的
    // `set_icon()` 只设 `ICON_SMALL`，见 `win_icon` 模块文档）。
    let apps_light = matches!(theme, Some(Theme::Light));
    let taskbar_light = win_icon::taskbar_prefers_light(apps_light);

    let apps_icon = themed_icon(if apps_light { Some(Theme::Light) } else { Some(Theme::Dark) });
    let taskbar_icon = themed_icon(if taskbar_light {
        Some(Theme::Light)
    } else {
        Some(Theme::Dark)
    });

    // 托盘：长在任务栏上 ⇒ 按外壳主题选色。
    if let (Some(tray), Some(icon)) = (app.tray_by_id(TRAY_ID), taskbar_icon.as_ref()) {
        let _ = tray.set_icon(Some(icon.clone()));
    }

    let Some(icon) = apps_icon else {
        return;
    };

    // 主窗口（含任务栏按钮与无边框窗口的图标）
    if let Some(main) = app.get_window(MAIN_LABEL) {
        // 小图标槽（标题栏 / Alt+Tab 小图）：按**应用**主题。
        let _ = main.set_icon(icon.clone());
        // ⚠️ **大图标槽（任务栏按钮）必须单独设**：`set_icon()` 走 Tauri → tao 的
        // `set_window_icon()`，它**只设 `ICON_SMALL`**；任务栏按钮渲染的是
        // `ICON_BIG`。不补这一下，任务栏会一直用 exe 里那个静态的深藏青图标
        // —— 正是 v0.3.1 用户看到的「深色任务栏上几乎看不见」。
        // 而且它要按**外壳**主题选色（托盘同理）。详见 `win_icon` 模块文档。
        if let Some(taskbar) = taskbar_icon.as_ref() {
            win_icon::set_taskbar_icon(&main, taskbar);
        }
    }
    // 选择窗口 / 关于 / 设置这些独立窗口也一并统一，避免同一程序出现两种图标。
    for label in [SELECTOR_LABEL, ABOUT_LABEL, SETTINGS_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_icon(icon.clone());
        }
    }
}

/// 读取当前窗口主题。`setup` 跑之前配置里的选择窗口就已经创建好了，所以这里能拿到。
fn current_theme<R: Runtime>(app: &AppHandle<R>) -> Option<Theme> {
    [SELECTOR_LABEL, MAIN_LABEL]
        .iter()
        .find_map(|label| app.get_webview_window(label))
        .and_then(|window| window.theme().ok())
}

fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let select_item =
        MenuItem::with_id(app, MENU_SELECT, "重新选择连接方式", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &select_item, &separator, &separator2, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(format!("{MAIN_TITLE} {APP_DISPLAY_VERSION}"))
        .menu(&menu)
        // 左键单击直接唤出窗口，右键才弹菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => reveal_window(app),
            MENU_SELECT => reveal_selector(app),
            // app.exit() 不会触发 WindowEvent::CloseRequested，因此是「真退出」。
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_window(tray.app_handle());
            }
        });

    // 托盘图标跟随系统主题：深色任务栏用白色 logo，浅色用深藏青 logo。
    // 内嵌 PNG 解码失败时退回 bundle.icon 生成的默认图标。
    if let Some(icon) = themed_icon(current_theme(app)) {
        builder = builder.icon(icon);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/* ---------------------------------------------------------------- commands */

/// 读取配置文件（不存在时返回默认值）。
#[tauri::command]
fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    Ok(read_config(&app))
}

/// 写入配置文件，并**立即**把「网页对话」模式应用到主窗口布局。
///
/// # 为什么参数是 `serde_json::Value` 而不是 `AppConfig`（**补丁语义**）
///
/// 调用方**没提到的字段保持磁盘上的旧值**，而不是被重置成默认值。
///
/// 具体要防的这个 bug：选择窗口的 `buildConfig()`（`src/config-rules.js`）
/// 只产出 5 个地址/启动相关字段，**不包含** `chatDocked`。
/// 如果这里直接反序列化成 `AppConfig`，缺字段会被 `#[serde(default)]` 补成
/// `chat_docked = false` —— 于是「设置里选了 docked → 之后又改了一次地址」
/// 会**静默退回 overlay**。补丁语义从根上消除这类「局部写入顺带清空其它字段」的问题。
///
/// 设置窗口改模式时传 `{"chatDocked": true|false}` 即可（也可以整份传，都支持）。
///
/// 落盘后同步刷新 [`CHAT_DOCKED`] 缓存并调 [`layout_main_webviews`]，
/// 让布局**当场**变化（不需要重启，也不用等 `Resized`）。
/// 这里只做 `set_position` / `set_size`（非阻塞消息投递），同步命令跑在主线程上是安全的；
/// **不要**在这个命令里创建 webview（那才会死锁，见 `chrome_action` 的注释）。
#[tauri::command]
fn save_config(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    let existing = read_config(&app);
    let merged = merge_config(&existing, &config)?;
    write_config(&app, &merged)?;
    CHAT_DOCKED.store(merged.chat_docked, Ordering::Relaxed);
    layout_main_webviews(&app);
    Ok(())
}

/// 把 `patch` 里**出现过的**字段覆盖到 `existing` 上，返回合并后的配置。
///
/// 纯函数，可直接单测（见 `tests::save_config_patch_keeps_untouched_fields`）。
/// 未知字段会被 `serde` 忽略（`AppConfig` 没开 `deny_unknown_fields`），
/// 所以前端多传字段不会导致保存失败。
fn merge_config(existing: &AppConfig, patch: &serde_json::Value) -> Result<AppConfig, String> {
    let mut base = serde_json::to_value(existing)
        .map_err(|e| format!("序列化现有配置失败：{e}"))?;
    let (Some(base_obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) else {
        return Err("配置必须是一个 JSON 对象。".to_string());
    };
    for (key, value) in patch_obj {
        base_obj.insert(key.clone(), value.clone());
    }
    serde_json::from_value(base).map_err(|e| format!("配置字段无效：{e}"))
}

/// 在后台启动本地 DSH 服务（不等待其就绪）。
///
/// 注意：Tauri 的**同步命令跑在主线程**上，所以这里只负责 spawn，
/// 「等服务起来」由前端轮询 [`probe_url`] 完成，避免界面卡死。
#[tauri::command]
fn start_local_service(command: String) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("启动命令为空。".to_string());
    }
    spawn_local_service(command)
}

/// 探测 URL 的主机:端口是否可以建立 TCP 连接。
///
/// 前端在「自动启动本地服务」后轮询本命令，直到服务就绪或超时，
/// 这样主窗口不会在服务还没起来时加载出白屏。
#[tauri::command]
async fn probe_url(url: String) -> Result<bool, String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("URL 无效：{e}"))?;
    let host = parsed.host_str().ok_or_else(|| "URL 缺少主机名。".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "URL 缺少端口，且协议没有默认端口。".to_string())?;
    Ok(probe_tcp(host, port))
}

/// 返回显示用版本号：`v.0.3.2`（Release）或 `v.0.3.2 RC`（RC）。
#[tauri::command]
fn app_version() -> String {
    APP_DISPLAY_VERSION.to_string()
}

/// 返回当前**发布通道**：`"release"` 或 `"rc"`。
///
/// 「关于」窗口的「检查更新」要用它判断用户当前跑的是哪条通道，
/// 从而在**跨通道下载**（Release 用户去下 RC 版，或反过来）时先弹确认。
#[tauri::command]
fn app_channel() -> String {
    APP_CHANNEL.to_string()
}

/// 在**系统默认浏览器**里打开一个下载链接（「关于」窗口的检查更新用）。
///
/// # 为什么需要这个命令
///
/// 前端直接 `window.location.href = url` 会让**「关于」窗口自己导航走**
/// —— 用户点一次「下载」，关于窗口就变成浏览器的下载页，界面回不来了。
/// 本项目**没有**启用 `tauri-plugin-opener` / `shell` 插件（依赖越少越好），
/// 所以在这里用系统 API 打开。
///
/// # 为什么要在 Rust 侧校验协议
///
/// 只接受 `http` / `https`，拒绝 `file:`、`javascript:` 等 —— 否则前端一旦被
/// 注入一个危险 scheme，就等于把它交给系统外壳执行。
///
/// `async`：与其他会触发窗口/系统动作的命令保持一致，避免占住主线程。
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("链接无效：{e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("拒绝打开不支持的协议 `{other}`（只允许 http / https）")),
    }
    open_url_in_system(&parsed.to_string())
}

/// 用系统默认程序打开 URL。
///
/// Windows 走 `ShellExecuteW`（不经过 cmd，避免命令注入与引号转义问题）；
/// 其它平台走 `xdg-open`（本项目的验收平台只有 Windows，这里只为让 Linux 上的
/// `cargo test` / `cargo check` 能编过，不做行为保证）。
#[cfg(windows)]
fn open_url_in_system(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // 转成 NUL 结尾的 UTF-16。
    let to_wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let op = to_wide("open");
    let file = to_wide(url);

    // SAFETY: 两个字符串都是本函数内构造、以 NUL 结尾且在调用期间存活；
    // hwnd 传 null（不需要父窗口），参数与返回值按 Win32 文档约定使用。
    let ret = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // `ShellExecuteW` 返回值 > 32 表示成功（Win32 的历史约定，32 及以下是错误码）。
    if ret as isize > 32 {
        Ok(())
    } else {
        Err("系统无法打开链接（ShellExecuteW 返回错误码）".to_string())
    }
}

/// 非 Windows：用 `xdg-open`。仅用于让其它平台的编译通过。
#[cfg(not(windows))]
fn open_url_in_system(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法调用 xdg-open：{e}"))
}

/// 自定义标题栏的窗口按钮。
///
/// `async`：这些动作会间接触发窗口事件链（最大化 / 关闭 → `Resized` / `CloseRequested`），
/// 放到异步运行时执行，避免占住主线程。
#[tauri::command]
async fn window_control(app: AppHandle, action: String) -> Result<(), String> {
    // 关于窗口自己就能关自己，不需要主窗口存在
    if action == "hide-about" {
        if let Some(about) = app.get_webview_window(ABOUT_LABEL) {
            let _ = about.hide();
        }
        return Ok(());
    }

    // 设置窗口同理：它可能是在**没有主窗口**的情况下打开的（比如用户还没连接），
    // 所以这个分支必须放在取 `main` 之前。
    if action == "hide-settings" {
        if let Some(settings) = app.get_webview_window(SETTINGS_LABEL) {
            let _ = settings.hide();
        }
        return Ok(());
    }

    let main = app
        .get_window(MAIN_LABEL)
        .ok_or_else(|| "主窗口不存在".to_string())?;
    match action.as_str() {
        "minimize" => main.minimize().map_err(|e| e.to_string()),
        "toggle-maximize" => {
            if main.is_maximized().unwrap_or(false) {
                main.unmaximize().map_err(|e| e.to_string())
            } else {
                main.maximize().map_err(|e| e.to_string())
            }
        }
        // 走正常关闭流程 -> CloseRequested -> 隐藏到托盘
        "close" => main.close().map_err(|e| e.to_string()),
        other => Err(format!("未知的窗口操作：{other}")),
    }
}

/// 拖动窗口：顶栏是主窗口里的**子 webview**，拖它自己不会移动窗口，
/// 所以由它发起命令，真正 `start_dragging()` 的是主窗口。
///
/// 最大化状态下直接忽略：让用户拖动一个最大化窗口，在 Windows 上行为很怪。
/// 这个判断刻意放在 Rust 侧 —— 不依赖前端是否及时收到了窗口状态事件。
#[tauri::command]
fn start_drag(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_window(MAIN_LABEL)
        .ok_or_else(|| "主窗口不存在".to_string())?;
    if main.is_maximized().unwrap_or(false) {
        return Ok(());
    }
    main.start_dragging().map_err(|e| e.to_string())
}

/// 自定义标题栏的菜单动作（按钮直接触发，例如「网页对话」）。
///
/// ⚠️ **必须 `async`**。`chat` 会创建子 webview（`Window::add_child`），
/// 而 `add_child` 在 Windows 上内部是 `run_on_main_thread` + `recv()`：
/// 同步命令本身就跑在主线程上，从那里调用会**死锁** —— 这正是用户报告的
/// 「点『网页对话』整个程序卡死、不报未响应、只能任务管理器强杀」的根因。
#[tauri::command]
async fn chrome_action(app: AppHandle, action: String) -> Result<(), String> {
    run_action(&app, &action)
}

/// 弹出原生下拉菜单。
///
/// 继续用原生菜单而不是 HTML 下拉：外观跟随系统，且不受 webview 边界裁剪。
#[tauri::command]
async fn popup_menu(app: AppHandle, menu: String, x: f64) -> Result<(), String> {
    use tauri::menu::ContextMenu;

    let window = app
        .get_window(MAIN_LABEL)
        .ok_or_else(|| "主窗口不存在".to_string())?;

    let item = |id: &str, label: &str| -> Result<MenuItem<tauri::Wry>, String> {
        MenuItem::with_id(&app, id, label, true, None::<&str>).map_err(|e| e.to_string())
    };
    let separator = || -> Result<PredefinedMenuItem<tauri::Wry>, String> {
        PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())
    };

    let popup = match menu.as_str() {
        "app" => {
            let about = item("about", "关于")?;
            let settings = item("settings", "设置")?;
            let check = item("check-update", "检查更新")?;
            let reconnect = item("reconnect", "重新连接")?;
            let sep = separator()?;
            Menu::with_items(&app, &[&about, &settings, &check, &sep, &reconnect])
                .map_err(|e| e.to_string())?
        }
        "actions" => {
            let refresh = item("refresh", "刷新")?;
            let undo = item("undo", "撤销")?;
            let redo = item("redo", "重做")?;
            let sep1 = separator()?;
            let sep2 = separator()?;
            Menu::with_items(&app, &[&refresh, &sep1, &undo, &redo, &sep2])
                .map_err(|e| e.to_string())?
        }
        other => return Err(format!("未知菜单：{other}")),
    };

    // 位置相对于主窗口左上角：横向对齐按钮，纵向正好在标题栏下面
    let position = tauri::LogicalPosition::new(x, TITLEBAR_HEIGHT);
    popup
        .popup_at(window, position)
        .map_err(|e| format!("弹出菜单失败：{e}"))
}

/// 菜单项 / 标题栏按钮的统一动作分发。
///
/// ⚠️ `popup_menu` 里每个菜单项的 id 都必须在这里有对应分支 —— 否则点了菜单
/// 只会打印「未知的菜单操作」而毫无反应。`scripts/test-titlebar.mjs` 有一条
/// 契约对账断言在查这个对应关系（app 分支的 id 列表 ↔ `APP_MENU_ACTIONS`）。
fn run_action<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<(), String> {
    match action {
        "about" => show_about_window(app),
        "settings" => show_settings_window(app),
        "check-update" => {
            show_about_window(app)?;
            // 让「关于」窗口自己去查 GitHub Releases（它是个本地页面，fetch 走 CORS 没问题）
            let _ = app.emit_to(ABOUT_LABEL, "check-update", ());
            Ok(())
        }
        // 与托盘「重新选择连接方式」完全相同
        "reconnect" => {
            reveal_selector(app);
            Ok(())
        }
        "refresh" => {
            // 刷新的是**内容 webview**（用户看的那个页面），不是窗口。
            let content = app
                .get_webview(CONTENT_LABEL)
                .ok_or_else(|| "内容页面尚未就绪".to_string())?;
            content.reload().map_err(|e| e.to_string())
        }
        "undo" => send_ctrl_key(app, 0x5A), // Ctrl+Z
        "redo" => send_ctrl_key(app, 0x59), // Ctrl+Y
        "chat" => toggle_chat_webview(app),
        other => Err(format!("未知的菜单操作：{other}")),
    }
}

/// 给主窗口（网页）发一个 Ctrl+<key> 组合键。
///
/// 撤销 / 重做没法用 `eval` 可靠地做到 —— 合成的 KeyboardEvent 不受信任，
/// 浏览器不会拿它去触发 undo/redo。所以用 Win32 `SendInput` 发**真实按键**：
/// 先把焦点切回主窗口（点完菜单焦点在标题栏窗口上），再发。
#[cfg(windows)]
fn send_ctrl_key<R: Runtime>(app: &AppHandle<R>, vk: u16) -> Result<(), String> {
    use std::time::Duration;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
    };

    fn key(vk: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    // 焦点要回到**内容 webview**（点完顶栏菜单后焦点在顶栏那个子 webview 上），
    // Ctrl+Z / Ctrl+Y 才会作用到用户看的页面上。
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
        let _ = content.set_focus();
    } else if let Some(main) = app.get_window(MAIN_LABEL) {
        let _ = main.set_focus();
    } else {
        return Err("主窗口不存在".to_string());
    }
    std::thread::sleep(Duration::from_millis(120));

    let inputs = [
        key(VK_CONTROL, 0),
        key(vk, 0),
        key(vk, KEYEVENTF_KEYUP),
        key(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent != inputs.len() as u32 {
        return Err("发送按键失败（SendInput 被系统拦截）".to_string());
    }
    Ok(())
}

/// 非 Windows（开发机自测）不发按键。
#[cfg(not(windows))]
fn send_ctrl_key<R: Runtime>(_app: &AppHandle<R>, _vk: u16) -> Result<(), String> {
    Err("撤销 / 重做目前只在 Windows 上实现".to_string())
}

/// 打开主窗口并加载 `request.url`，最后把选择窗口收起来。
///
/// # 为什么必须是 `async`
///
/// Tauri 的**同步命令跑在主线程（事件循环）上**。这条命令是选择窗口通过 IPC 调进来的，
/// 也就是说此刻主线程正处在 **WebView2 的 IPC 回调里**。在这个位置同步创建「窗口 + WebView2」：
///
/// * 新 WebView2 的控制器创建是异步的，嵌套在另一个 WebView2 的回调里会**永远初始化不完** ——
///   窗口出来了，但页面从不导航 ⇒ **白屏**；
/// * 紧接着销毁「正在执行这条 IPC 的那个 webview」，会让窗口消息处理进入坏状态 ——
///   后续 `hide()` 被丢弃 ⇒ **点 × 没反应，只能任务管理器强杀**。
///
/// 改成 `async fn` 后，命令由 Tauri 丢到异步运行时的**独立线程**上执行：
/// 创建窗口时会走 `proxy.send_event` 交给主线程处理（主线程此时空闲），不再有嵌套回调问题。
#[tauri::command]
async fn open_main_window(app: AppHandle, request: OpenRequest) -> Result<(), String> {
    match open_main_window_inner(&app, request).await {
        Ok(()) => Ok(()),
        Err(err) => {
            // 前端只会把错误显示在状态行里；同时写一份到 stderr，CI 上才查得到
            eprintln!("[DSHTauri] 打开主窗口失败：{err}");
            Err(err)
        }
    }
}

async fn open_main_window_inner(app: &AppHandle, request: OpenRequest) -> Result<(), String> {
    let raw = request.url.trim();
    let url = tauri::Url::parse(raw).map_err(|e| format!("URL 无效（{raw}）：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("不支持的协议 `{other}`，只允许 http / https。")),
    }

    // 已经有主窗口（用户从托盘「重新选择连接方式」回来切地址）：
    // **直接让内容 webview 导航过去**，不要 destroy 再重建。
    // 重建同 label 的窗口要等旧窗口从 Tauri 的注册表里摘掉，而 WebView2 的销毁是异步的，
    // 很容易出现「新窗口建不出来 / 卡住」，表现为点了没反应。
    if app.get_window(MAIN_LABEL).is_some() {
        navigate_content(app, url)?;
        if let Some(main) = app.get_window(MAIN_LABEL) {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
        layout_main_webviews(app);
    } else {
        // 主窗口是一个**纯 `Window`（容器，本身不加载页面）**，页面交给子 webview：
        //   · `titlebar` → 本地 `titlebar.html`，命中 capability ⇒ **有 IPC**
        //   · `content`  → 用户配置的远程 URL ⇒ 按设计**无** IPC
        // 这样顶栏跑在本地上下文里，位置又由客户区坐标决定 —— 一次性解决
        // 「顶栏错位」和「远程页面拿不到 IPC」两个问题。
        //
        // tao 在 Windows 上关掉 decorations 时只去掉 WS_CAPTION、保留 WS_THICKFRAME，
        // 所以窗口仍可拖边缘缩放，只是没有可见边框。
        // 创建会偶发失败（WebView2 环境初始化是异步的），重试几次比直接报错好。
        let mut created = None;
        let mut last_err = String::new();
        for attempt in 1..=3 {
            let builder = tauri::window::WindowBuilder::new(app, MAIN_LABEL)
                .title(MAIN_TITLE)
                .inner_size(MAIN_WIDTH, MAIN_HEIGHT)
                .min_inner_size(MAIN_MIN_WIDTH, MAIN_MIN_HEIGHT)
                .resizable(true)
                .maximizable(true)
                .minimizable(true)
                .closable(true)
                .decorations(false)
                .center()
                .visible(true);

            match builder.build() {
                Ok(window) => {
                    created = Some(window);
                    break;
                }
                Err(err) => {
                    last_err = err.to_string();
                    eprintln!("[DSHTauri] 创建主窗口失败（第 {attempt} 次）：{last_err}");
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
        let window =
            created.ok_or_else(|| format!("创建主窗口失败（已重试 3 次）：{last_err}"))?;

        // 内容 webview 先建：它是用户唯一必须看到的东西。
        ensure_content_webview(app, &window, url)?;

        // 顶栏 webview。万一建不出来，就退回**系统标题栏** ——
        // 否则会留下一个既没标题栏又没按钮、只能靠托盘操作的无边框窗口。
        if let Err(err) = ensure_titlebar_webview(app, &window) {
            eprintln!("[DSHTauri] 顶栏 webview 创建失败：{err}；已回退为系统标题栏。");
            let _ = window.set_decorations(true);
            // 没有自绘顶栏时内容要占满整个客户区，不能白空出 40px。
            if let (Some(content), Some((width, height))) =
                (app.get_webview(CONTENT_LABEL), main_logical_size(&window))
            {
                let _ = content.set_position(tauri::LogicalPosition::new(0.0, 0.0));
                let _ = content.set_size(tauri::LogicalSize::new(width, height));
            }
        } else {
            eprintln!("[DSHTauri] 顶栏 webview 已创建");
        }

        layout_main_webviews(app);
        let _ = window.set_focus();
        // 主窗口是**连接之后**才创建的（比 setup 晚），所以这里再统一一次 logo，
        // 保证它的任务栏/标题栏图标也是主题对应的那只鲸鱼。
        apply_theme_icons(app, current_theme(app));
        eprintln!(
            "[DSHTauri] 主窗口已创建：pos={:?} size={:?} visible={:?}",
            window.outer_position(),
            window.outer_size(),
            window.is_visible()
        );
    }

    // 主窗口起来了，再开始定期把会话 cookie 转成持久 cookie。
    // 放在这里（而不是 setup）是为了避开启动阶段，只在确实有网页在跑时才动手。
    spawn_cookie_keeper(app.clone());

    // 选择窗口使命完成：**隐藏**而不是销毁。
    // 销毁会干掉「正在执行这条 IPC 的 webview」，Windows 上会让消息处理进入坏状态。
    // 隐藏更安全，而且保留下来还能通过托盘「重新选择连接方式」再叫出来。
    if let Some(selector) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = selector.hide();
    }

    Ok(())
}

/* -------------------------------------------------------------------- run */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            start_local_service,
            probe_url,
            open_main_window,
            app_version,
            app_channel,
            open_external,
            chrome_action,
            window_control,
            start_drag,
            popup_menu
        ])
        .setup(|app| {
            // 把磁盘上的「网页对话」模式读进内存缓存（`layout_main_webviews` 只用缓存，
            // 因为它在 Resized 事件里被高频调用，绝不能读盘 —— 见 CHAT_DOCKED 的说明）。
            sync_chat_docked_from_disk(app.handle());

            // 选择窗口不再写在 tauri.conf.json 里：那样没法给它指定共享的 WebView2 数据目录
            // （配置里的 data_directory 是按 label 分目录的，会导致各窗口登录态不共享）。
            if let Err(err) = create_selector_window(app.handle()) {
                eprintln!("[DSHTauri] 创建选择窗口失败：{err}");
            }
            match setup_tray(app.handle()) {
                Ok(()) => TRAY_READY.store(true, Ordering::Relaxed),
                Err(err) => eprintln!(
                    "[DSHTauri] 系统托盘创建失败：{err}\n\
                     [DSHTauri] 已降级运行：关闭窗口将直接退出程序（不会隐藏到托盘）。"
                ),
            }

            // 统一 logo：按当前系统主题把托盘 + 各窗口的图标设成
            // 「深色→白色鲸鱼 / 浅色→深藏青鲸鱼」。之后系统主题变化时
            // `WindowEvent::ThemeChanged` 会再调一次。
            apply_theme_icons(app.handle(), current_theme(app.handle()));

            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Err(err) = run_action(app, event.id().as_ref()) {
                eprintln!("[DSHTauri] 菜单操作失败：{err}");
            }
        })
        .on_window_event(|window, event| match event {
            // 关闭窗口 ≠ 退出程序：隐藏到托盘，由托盘菜单「退出」真正结束。
            // 托盘不可用时不能隐藏，否则用户再也找不回窗口。
            WindowEvent::CloseRequested { api, .. } => {
                if TRAY_READY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    if window.label() == MAIN_LABEL {
                        // 主窗口关闭 = 整个主界面（含标题栏、侧栏）一起收进托盘
                        hide_main_windows(window.app_handle());
                    } else {
                        let _ = window.hide();
                    }
                }
            }
            // 主窗口缩放 / DPI 变化时，重新摆放子 webview（顶栏恒 40 逻辑 px、内容占满剩余）。
            //
            // ⚠️ 这里**只做 `set_position` / `set_size`**（非阻塞的消息投递），
            // **绝不创建 webview** —— `add_child` 会阻塞等主线程，在事件处理器里调用必然死锁。
            //
            // 不需要处理 `Moved`：子 webview 用的是**客户区坐标**，
            // 窗口整体移动不会改变它们的相对位置（旧实现正是错在这里）。
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                if window.label() == MAIN_LABEL {
                    let app = window.app_handle();
                    // 用户正在缩放窗口时，侧栏的过渡动画目标（相对客户区右侧）已经变了，
                    // 继续跑旧动画会把侧栏停在错误的位置。直接掐掉，让下面的 layout 说了算。
                    anim::cancel();
                    layout_main_webviews(app);
                    emit_window_state(app, window);
                }
            }
            // 系统在浅色 / 深色之间切换时：
            //   1. 把**托盘 + 所有窗口**的图标换成对应版本（深色 → 白色鲸鱼，浅色 → 深藏青鲸鱼）；
            //   2. 把子 webview 的**预绘制底色**也换成对应版本 —— 否则切主题后
            //      下次打开侧栏又会露一次「旧主题的底色」，白闪重新出现。
            WindowEvent::ThemeChanged(theme) => {
                let app = window.app_handle();
                apply_theme_icons(app, Some(*theme));
                refresh_child_background_colors(app, Some(*theme));
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running DSHTauri");
}

/* ------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;

    /// 两个内嵌的托盘 PNG 必须能解码。
    /// 解不出来不会报错，只会静默退回 bundle 默认图标——所以必须测。
    #[test]
    fn embedded_theme_icons_decode() {
        for theme in [Theme::Dark, Theme::Light] {
            let icon = themed_icon(Some(theme))
                .unwrap_or_else(|| panic!("托盘图标解码失败：{theme:?}"));
            assert_eq!(icon.width(), 64, "托盘图标宽度应为 64");
            assert_eq!(icon.height(), 64, "托盘图标高度应为 64");
        }
    }

    /// 主题探测不到时按深色处理（Windows 11 默认深色任务栏）。
    #[test]
    fn themed_icon_falls_back_to_white_version() {
        assert!(themed_icon(None).is_some());
    }

    /// **任务栏**图标的配色依据是外壳主题（`SystemUsesLightTheme`），
    /// 与**应用**主题（tao 的 `Theme`）是两个独立开关。
    ///
    /// 这条测试锁住「注册表值 → 深浅色」的**翻译规则**。
    #[test]
    fn taskbar_theme_falls_back_to_apps_theme() {
        // ⚠️ 这里**只**断言纯翻译函数，**不**断言 `taskbar_prefers_light()` 的返回值。
        //
        // 原因：在 CI 的 `windows-latest` 上 `SystemUsesLightTheme` **确实存在**
        // （值可能是 0 = 深色外壳），于是 `taskbar_prefers_light(true)` 会返回
        // `false` —— 直接断言「透传」会**在 Windows 上失败**。
        // v0.3.2 第一次推送时 CI 就是这样红的，所以改成测纯函数。
        use crate::win_icon::taskbar_light_from_registry_value as tr;

        // 读到 1 ⇒ 浅色任务栏。
        assert!(tr(Some(1), false), "读到 1 应判定为浅色（不受 fallback 影响）");
        // 读到 0 ⇒ 深色任务栏。
        assert!(!tr(Some(0), true), "读到 0 应判定为深色（不受 fallback 影响）");
        // 读不到 ⇒ 退回调用方给的 fallback（tao 的应用主题）。
        assert!(tr(None, true), "读不到时应退回 fallback=true");
        assert!(!tr(None, false), "读不到时应退回 fallback=false");
    }

    /// **窗口创建时的图标**必须能在「一个窗口都还没有」时给出正确配色。
    ///
    /// # 为什么这条重要（v0.3.3 修的缺陷）
    ///
    /// 「关于」/「设置」窗口是**按需创建**的，远晚于 `apply_theme_icons` 的最后一次调用，
    /// 所以它们曾经一直用 bundle 里那个静态深藏青 `icon.ico`。
    /// 修法是创建后立刻 `set_creation_icon()`。
    ///
    /// 但 `creation_icon()` 不能依赖 `current_theme()`：创建**第一个**窗口（选择窗口）时
    /// 一个窗口都没有，`current_theme()` 只能返回 `None`，于是会按「深色」给**白色**鲸鱼
    /// —— 浅色系统的白色标题栏上几乎看不见。所以它必须走注册表。
    ///
    /// 这里断言的是**两条路径都能给出图标**（解码成功），不依赖运行环境的具体主题值。
    #[test]
    fn creation_icon_is_available_without_any_window() {
        // 1) 注册表路径：读不到时 `apps_prefers_light()` 返回 None，这是允许的
        //    （非 Windows 恒为 None），但它**不能 panic**。
        let _ = win_icon::apps_prefers_light();

        // 2) 无论主题探测结果如何，`themed_icon` 都必须能解出图标
        //    —— 否则窗口会退回 bundle 默认图标（就是本次要修的缺陷）。
        for theme in [None, Some(Theme::Light), Some(Theme::Dark)] {
            assert!(
                themed_icon(theme).is_some(),
                "themed_icon({theme:?}) 解码失败 —— 窗口图标会退回 bundle 默认的深藏青版"
            );
        }
    }

    /// `set_creation_icon` 必须在**三个**按需创建 / 首建的窗口上都被调用。
    ///
    /// 这是**静态**断言（源码级），因为这三个调用点都在需要真实窗口的代码路径里，
    /// 单测跑不到。若有人漏掉其中一个，对应的窗口就会退回静态图标。
    ///
    /// ⚠️ 断言必须逐**窗口变量名**检查，不能只数总次数。
    /// 初版写的是 `src.matches("set_creation_icon(&").count() >= 3`，
    /// 结果**变异测试发现它抓不住「删掉其中一个调用」**：
    /// 本测试自身的源码里就含一处 `"set_creation_icon(&"` 字面量，
    /// 于是删掉一个真实调用后计数仍是 4 ⇒ 依然 >= 3 ⇒ **假绿**。
    /// 现在按三个变量名分别断言，删任何一个都会失败。
    #[test]
    fn creation_icon_is_wired_into_all_window_builders() {
        let src = include_str!("lib.rs");
        for var in ["selector", "about", "settings"] {
            let call = format!("set_creation_icon(&{var});");
            assert!(
                src.contains(&call),
                "缺少 `{call}` —— 该窗口会退回 bundle 里那个静态深藏青图标（v0.3.3 修的缺陷）"
            );
        }
    }

    /// v0.3.2 起 **docked 与 overlay 共用同一条滑出动画**：
    /// 两种模式下侧栏的目标几何完全相同，差别只在内容页什么时候收窄。
    ///
    /// 这条测试是「docked 不再走无动画直切」的守卫 —— 若有人把 docked 改回
    /// 「直接 hide」，它仍然通过（几何本来就一样），所以真正的行为守卫在
    /// `verify-titlebar.mjs` 的静态检查里；这里锁住的是**几何前提**：
    /// 动画的起点与终点在两种模式下是同一对值，因此动画实现无需分模式。
    #[test]
    fn slide_endpoints_are_mode_independent() {
        let (width, height) = (1200.0, 800.0);
        let (target_x, y, chat_w, chat_h) = chat_target_bounds(width, height);
        // 滑出动画的终点是 `width`（完全移出客户区右侧），起点是目标位。
        assert_eq!(target_x + chat_w, width, "侧栏目标位右边缘应等于窗口宽度");
        assert_eq!(y, TITLEBAR_HEIGHT);
        assert_eq!(chat_h, height - TITLEBAR_HEIGHT);

        // 两种模式的 chat 目标几何必须一致（否则动画终点要分模式算）。
        let (_, overlay_content, overlay_chat) = main_webview_rects(width, height, false);
        let (_, docked_content, docked_chat) = main_webview_rects(width, height, true);
        assert_eq!(overlay_chat, docked_chat, "两种模式的侧栏几何必须相同");
        // 内容页是唯一分模式的量：docked 让出 chatW，overlay 占整宽。
        assert_eq!(overlay_content.2, width);
        assert_eq!(docked_content.2, width - chat_w);
    }

    /// 深色版应该是白鲸鱼，浅色版应该是深色鲸鱼——反色确实生效了。
    #[test]
    fn theme_icons_are_opposite_colors() {
        let dark = themed_icon(Some(Theme::Dark)).unwrap();
        let light = themed_icon(Some(Theme::Light)).unwrap();
        let dark_rgba = dark.rgba();
        let light_rgba = light.rgba();

        assert_eq!(dark_rgba.len(), light_rgba.len(), "两版尺寸应一致");

        // 只比较不透明像素，透明区域两版都是 0。
        let mut compared = 0usize;
        for px in 0..dark_rgba.len() / 4 {
            let i = px * 4;
            if light_rgba[i + 3] < 200 {
                continue;
            }
            compared += 1;
            // 浅色版是深藏青 #020E36，深色版是纯白，两者应当差异明显。
            assert!(
                light_rgba[i] < 60,
                "浅色版应是深色 logo，实际 R={}",
                light_rgba[i]
            );
            assert!(
                dark_rgba[i] > 200,
                "深色版应是白色 logo，实际 R={}",
                dark_rgba[i]
            );
            // 透明背景保持不变。
            assert_eq!(
                dark_rgba[i + 3], light_rgba[i + 3],
                "反色不应改变 alpha 通道"
            );
        }
        assert!(compared > 500, "参与比较的不透明像素太少：{compared}");
    }

    #[test]
    fn default_config_has_empty_urls() {
        let config = AppConfig::default();
        assert!(!config.configured, "默认应为「未配置」，前端才会弹首次配置表单");
        // 地址留空：本地和远程允许只配一个，由用户首次启动时填写。
        assert!(config.local_url.is_empty());
        assert!(config.remote_url.is_empty());
        assert!(!config.auto_start_local);
        assert!(config.local_start_command.is_empty());
        // 网页对话默认 overlay（= 不 docked），保持升级前的行为。
        assert!(!config.chat_docked, "chat_docked 默认必须是 false（overlay）");
        // 示例值只用于界面占位符，不该混进默认配置。
        assert_eq!(EXAMPLE_LOCAL_URL, "http://127.0.0.1:3080");
        assert_eq!(EXAMPLE_REMOTE_URL, "https://dsh.example.com");
        assert_eq!(EXAMPLE_LOCAL_COMMAND, "dsh web");
    }

    /// 只配一个地址也必须能正常存取（这是明确的产品需求）。
    #[test]
    fn config_allows_only_one_url() {
        for (local, remote) in [("http://127.0.0.1:3080", ""), ("", "https://dsh.example.com")] {
            let json = format!(
                r#"{{"configured":true,"localUrl":"{local}","remoteUrl":"{remote}"}}"#
            );
            let config: AppConfig = serde_json::from_str(&json).unwrap();
            assert_eq!(config.local_url, local);
            assert_eq!(config.remote_url, remote);

            // 再序列化回去，空的那一侧应该保持空字符串（而不是变成 null）。
            let back = serde_json::to_string(&config).unwrap();
            assert!(back.contains(r#""localUrl":""#) || !local.is_empty());
            let again: AppConfig = serde_json::from_str(&back).unwrap();
            assert_eq!(again.local_url, local);
            assert_eq!(again.remote_url, remote);
        }
    }

    /// 前端用 camelCase 读写配置（见 src/selector.js），这个契约不能破。
    #[test]
    fn config_serializes_as_camel_case() {
        let json = serde_json::to_string(&AppConfig::default()).unwrap();
        for key in [
            "configured",
            "localUrl",
            "remoteUrl",
            "autoStartLocal",
            "localStartCommand",
            "chatDocked",
        ] {
            assert!(json.contains(key), "序列化结果缺少 {key}：{json}");
        }
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.local_url, AppConfig::default().local_url);
        assert_eq!(back.chat_docked, AppConfig::default().chat_docked);
    }

    /// **向后兼容**：老配置文件（v0.2.x）里没有 `chatDocked` 字段，
    /// 反序列化必须成功并取 `false`（= overlay，行为与升级前完全一致）。
    #[test]
    fn old_config_without_chat_docked_defaults_to_overlay() {
        let legacy = r#"{"configured":true,"localUrl":"http://127.0.0.1:3080",
                         "remoteUrl":"","autoStartLocal":false,"localStartCommand":"dsh web"}"#;
        let config: AppConfig = serde_json::from_str(legacy).unwrap();
        assert!(
            !config.chat_docked,
            "缺 chatDocked 的老配置必须按 false（overlay）处理"
        );

        // 显式写 true 时也必须能读回来。
        let docked: AppConfig =
            serde_json::from_str(r#"{"configured":true,"chatDocked":true}"#).unwrap();
        assert!(docked.chat_docked);
    }

    /* ------------------------------------------------------ 两种对话模式布局 */

    /// `save_config` 是**补丁语义**：调用方没提到的字段必须保持磁盘上的旧值。
    ///
    /// 这条防的是一个真实的静默 bug：选择窗口的 `buildConfig()` 只产出 5 个
    /// 地址/启动字段（不含 `chatDocked`）。若 `save_config` 直接反序列化成
    /// `AppConfig`，`#[serde(default)]` 会把 `chatDocked` 补成 `false` ——
    /// 于是「设置里选了 docked，之后又改了一次地址」会静默退回 overlay。
    #[test]
    fn save_config_patch_keeps_untouched_fields() {
        let existing = AppConfig {
            configured: true,
            local_url: "http://127.0.0.1:3080".into(),
            remote_url: "".into(),
            auto_start_local: true,
            local_start_command: "dsh web".into(),
            chat_docked: true, // 用户已经在设置里选了 docked
        };

        // 模拟选择窗口保存地址：载荷里**没有** chatDocked。
        let patch = serde_json::json!({
            "configured": true,
            "localUrl": "http://127.0.0.1:9999",
            "remoteUrl": "",
            "autoStartLocal": false,
            "localStartCommand": "",
        });
        let merged = merge_config(&existing, &patch).unwrap();

        assert_eq!(merged.local_url, "http://127.0.0.1:9999", "补丁里的字段应生效");
        assert!(!merged.auto_start_local);
        assert!(
            merged.chat_docked,
            "载荷没提 chatDocked，就**不能**把它重置成 false（否则会静默退回 overlay）"
        );

        // 只传 chatDocked 的补丁（设置窗口切模式用的最小载荷）。
        let only_mode =
            merge_config(&existing, &serde_json::json!({ "chatDocked": false })).unwrap();
        assert!(!only_mode.chat_docked);
        assert_eq!(
            only_mode.local_url, "http://127.0.0.1:3080",
            "只改模式不该动地址"
        );
        assert!(only_mode.auto_start_local);
    }

    /// 补丁里出现未知字段不应导致保存失败（serde 默认忽略未知字段）。
    #[test]
    fn save_config_patch_ignores_unknown_fields() {
        let existing = AppConfig::default();
        let patch = serde_json::json!({ "chatDocked": true, "futureField": 42 });
        let merged = merge_config(&existing, &patch).unwrap();
        assert!(merged.chat_docked);
    }

    /// 非对象载荷（前端传错类型）要报错，而不是静默写坏配置。
    #[test]
    fn save_config_patch_rejects_non_object() {
        let existing = AppConfig::default();
        assert!(merge_config(&existing, &serde_json::json!("nope")).is_err());
        assert!(merge_config(&existing, &serde_json::json!(null)).is_err());
    }

    /// `overlay`（默认）：内容页占**整宽**，chat 盖在它右侧之上，两者 x 区间重叠。
    #[test]
    fn overlay_mode_keeps_content_full_width() {
        let (titlebar, content, chat) = main_webview_rects(1200.0, 800.0, false);

        assert_eq!(titlebar, (0.0, 0.0, 1200.0, 40.0));
        assert_eq!(content, (0.0, 40.0, 1200.0, 760.0));
        assert_eq!(chat, (1200.0 - 420.0, 40.0, 420.0, 760.0));

        // 覆盖：内容页右边缘（1200）超出 chat 左边缘（780）⇒ 确实压在上面。
        assert!(
            content.0 + content.2 > chat.0,
            "overlay 模式下内容页应当被 chat 覆盖一部分"
        );
    }

    /// `docked`：内容页让出右侧 420px，两者**精确平铺、不重叠**，且窗口尺寸不变。
    #[test]
    fn docked_mode_shrinks_content_and_tiles_with_chat() {
        let (titlebar, content, chat) = main_webview_rects(1200.0, 800.0, true);

        // 顶栏仍然占整宽（它不属于内容区）。
        assert_eq!(titlebar, (0.0, 0.0, 1200.0, 40.0));
        // 内容页宽度 = 1200 - 420。
        assert_eq!(content, (0.0, 40.0, 780.0, 760.0));
        assert_eq!(chat, (780.0, 40.0, 420.0, 760.0));

        // 并排：内容页右边缘正好等于 chat 左边缘（无缝隙、无重叠）。
        assert_eq!(content.0 + content.2, chat.0, "docked 模式必须精确平铺");
        // 两者高度一致、都从顶栏下面开始。
        assert_eq!(content.1, chat.1);
        assert_eq!(content.3, chat.3);
        // 宽度守恒：内容 + 侧栏 == 窗口宽 ⇒ **没有改变窗口大小**。
        assert_eq!(content.2 + chat.2, 1200.0);
    }

    /// 窗口比侧栏还窄时不能算出负数宽度（docked 下内容宽度至少 1）。
    #[test]
    fn docked_mode_clamps_content_width_on_tiny_window() {        let (_, content, chat) = main_webview_rects(300.0, 500.0, true);
        assert!(content.2 >= 1.0, "内容宽度被压成非正数：{}", content.2);
        assert_eq!(chat.2, 300.0, "窗口比侧栏窄时侧栏应压到窗口宽度");
        assert_eq!(chat.0, 0.0);
    }

    /// 两种模式下 chat 的位置/尺寸**相同** —— 差别只在内容页让不让宽度。
    #[test]
    fn chat_rect_is_identical_in_both_modes() {
        let (_, overlay_content, overlay_chat) = main_webview_rects(1000.0, 600.0, false);
        let (_, docked_content, docked_chat) = main_webview_rects(1000.0, 600.0, true);
        assert_eq!(overlay_chat, docked_chat);
        assert_ne!(overlay_content.2, docked_content.2);
    }

    /// [`chat_target_bounds`] 是侧栏打开/关闭的**唯一**目标几何来源（动画接入点）。
    ///
    /// 这条锁死它与 `main_webview_rects` 的一致性：给「侧栏开/关过渡动画」接入时，
    /// 动画终点必须正好等于这里算出来的值，否则动画结束会出现一帧跳变。
    #[test]
    fn chat_target_bounds_matches_layout_in_both_modes() {
        for docked in [false, true] {
            let (_, _, chat) = main_webview_rects(1200.0, 800.0, docked);
            assert_eq!(
                chat,
                chat_target_bounds(1200.0, 800.0),
                "docked={docked} 时 layout 的 chat 几何必须等于 chat_target_bounds"
            );
        }
        // 与模式无关：overlay / docked 下目标几何完全一样。
        let (x, y, w, h) = chat_target_bounds(1200.0, 800.0);
        assert_eq!((x, y, w, h), (780.0, 40.0, 420.0, 760.0));
        // 极端窄窗口同样被夹住（不能出现负宽度）。
        let (x, _, w, _) = chat_target_bounds(300.0, 500.0);
        assert_eq!((x, w), (0.0, 300.0));
    }

    /// 高度不足 40px（极端最小化状态）时不能算出负高度。
    #[test]
    fn content_height_never_goes_negative() {
        let (_, content, chat) = main_webview_rects(800.0, 10.0, false);
        assert!(content.3 >= 1.0);
        assert!(chat.3 >= 1.0);
    }

    /// `target_x <= width` 恒成立 —— 侧栏动画里的 `x.clamp(target_x, width)` 依赖它。
    ///
    /// `f64::clamp` 在 `min > max` 时会 **panic**。滑入/滑出都用
    /// `clamp(target_x, width)` 把中途位置夹进合法区间，所以这条必须成立。
    #[test]
    fn chat_target_x_never_exceeds_window_width() {
        // 含极窄窗口（侧栏被压到窗口宽度 ⇒ target_x == 0）与正常窗口。
        for width in [1.0, 100.0, 419.0, 420.0, 421.0, 1200.0, 3840.0] {
            for height in [1.0, 40.0, 41.0, 800.0, 2160.0] {
                let (x, _, w, _) = chat_target_bounds(width, height);
                assert!(
                    x <= width,
                    "clamp 的下界不能大于上界：width={width} height={height} x={x}"
                );
                assert!(w >= 1.0, "宽度必须为正：width={width} w={w}");
                // 实际执行一次 clamp，确保不 panic。
                let _ = 500.0_f64.clamp(x, width);
            }
        }
    }

    /// `Cargo.toml` 与 `tauri.conf.json` 的版本号必须一致，
    /// 否则「安装包版本」和「程序自报版本」会对不上。
    #[test]
    fn app_version_matches_tauri_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["version"].as_str().unwrap(),
            APP_VERSION,
            "版本号不一致，用 `node scripts/version.mjs --set X.Y.Z` 同步"
        );
        // 绑到变量，避免 clippy 把常量断言判成无意义断言。
        let channel: &str = APP_CHANNEL;
        assert!(
            channel == "release" || channel == "rc",
            "发布通道只能是 release 或 rc，实际是 {channel:?}"
        );
    }

    /// 版本显示规则：Release 不带后缀；RC 版显示 ` RC`。
    ///
    /// 这条测试是「GenX 已取消」的守卫：显示串里**不允许**再出现 `Gen`。
    #[test]
    fn display_version_marks_rc_only() {
        let expected = if APP_CHANNEL == "rc" {
            format!("v.{APP_VERSION} RC")
        } else {
            format!("v.{APP_VERSION}")
        };
        assert_eq!(APP_DISPLAY_VERSION, expected);
        assert!(
            !APP_DISPLAY_VERSION.contains("Gen"),
            "GenX 规则已取消，显示串里不该再有 Gen：{APP_DISPLAY_VERSION}"
        );
    }

    /// 配置文件缺字段 / 是坏 JSON 时，必须退回默认值而不是崩掉。
    #[test]
    fn config_deserializes_leniently() {
        let partial: AppConfig = serde_json::from_str(r#"{"localUrl":"http://x:1"}"#).unwrap();
        assert_eq!(partial.local_url, "http://x:1");
        assert!(partial.remote_url.is_empty(), "缺失字段应取默认值（空）");
        assert!(!partial.configured);

        assert!(serde_json::from_str::<AppConfig>("{ not json").is_err());
    }

    /// **能力清单必须覆盖顶栏 webview，且不能覆盖主窗口本身。**
    ///
    /// 这是本项目最容易被静默搞坏的一处接线：
    /// - 顶栏是主窗口 `main` 里的**子 webview**（label = `titlebar`）。
    ///   Tauri 的匹配规则是「webview label 命中 `webviews`」**或**「window label 命中 `windows`」，
    ///   所以 label 必须写在 `webviews` 里 —— 写成 `windows: ["titlebar"]` 是**不匹配**的
    ///   （窗口 label 是 `main`），会让顶栏的按钮全部静默失效（只在 devtools 里能看到拒绝）。
    /// - 反过来，把 `main` 放进 `windows` 会让**所有**子 webview（含加载远程 DSH 页面的
    ///   `content`）都被这条 capability 覆盖，等于放开了远程页面的授权面。
    #[test]
    fn capability_covers_titlebar_webview_but_not_main_window() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();

        let empty = Vec::new();
        let webviews: Vec<&str> = cap["webviews"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        let windows: Vec<&str> = cap["windows"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter_map(|v| v.as_str())
            .collect();

        assert!(
            webviews.contains(&TITLEBAR_LABEL),
            "capabilities/default.json 的 webviews 必须包含顶栏 label `{TITLEBAR_LABEL}`，\
             否则顶栏拿不到 IPC、按钮全静默失效。当前 webviews={webviews:?}"
        );
        assert!(
            !windows.contains(&MAIN_LABEL),
            "不要把主窗口 `{MAIN_LABEL}` 放进 windows：那会顺带把远程 content 子 webview 也覆盖。\
             当前 windows={windows:?}"
        );
        assert!(
            !windows.contains(&"chrome"),
            "chrome 独立窗口已删除，windows 里不该再出现它。当前 windows={windows:?}"
        );
        // 顶栏与内容是同一个窗口里的两个不同 webview，label 不能撞。
        assert_ne!(TITLEBAR_LABEL, CONTENT_LABEL);
        assert_ne!(TITLEBAR_LABEL, CHAT_LABEL);
    }

    /// 「设置」窗口是**本地页面**且要读写配置 ⇒ 必须在 `windows` 里，
    /// 否则它调 `load_config` / `save_config` 会被 ACL 拒绝，表现为
    /// 「设置窗口打开了一片空白、点保存毫无反应」。
    ///
    /// 和顶栏的区别：顶栏是子 webview（写 `webviews`），设置是独立窗口（写 `windows`）。
    #[test]
    fn capability_covers_settings_window() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let windows: Vec<&str> = cap["windows"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();

        assert!(
            windows.contains(&SETTINGS_LABEL),
            "capabilities/default.json 的 windows 必须包含 `{SETTINGS_LABEL}`，\
             否则设置窗口拿不到 IPC、读不到也存不了配置。当前 windows={windows:?}"
        );
        // 关于窗口是同样的接线，一起守住。
        assert!(
            windows.contains(&ABOUT_LABEL),
            "windows 必须包含 `{ABOUT_LABEL}`。当前 windows={windows:?}"
        );
        // 设置窗口的 label 不能和别的窗口/ webview 撞。
        for other in [MAIN_LABEL, TITLEBAR_LABEL, CONTENT_LABEL, CHAT_LABEL, SELECTOR_LABEL] {
            assert_ne!(SETTINGS_LABEL, other);
        }
    }

    /// 顶栏高度是逻辑值，必须原样交给 Tauri（**不许**再乘 scale）。
    #[test]
    fn titlebar_height_is_logical_and_equals_40() {
        assert_eq!(TITLEBAR_HEIGHT, 40.0);
        // 作为逻辑值它应当在合理范围内；若有人误把它改成设备像素（例如 80），
        // 配合 Tauri 的内部换算就会得到 160 device px —— 正是用户截图 P1 的现象。
        let logical: f64 = TITLEBAR_HEIGHT;
        assert!(
            (1.0..=60.0).contains(&logical),
            "TITLEBAR_HEIGHT 看起来不像逻辑像素值：{logical}"
        );
    }
}
