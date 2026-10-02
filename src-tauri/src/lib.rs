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

/// 版本号（`v.A.B.C GenX`），由 `build.rs` 从 `Cargo.toml` + `version.json` 生成。
///
/// - `APP_VERSION`：`1.1.1`
/// - `APP_GENERATION`：`GenX` 里的 X，Gen1 时不在界面上显示
/// - `APP_DISPLAY_VERSION`：`v1.1.1` 或 `v1.1.1 Gen2`
mod version_info {
    include!(concat!(env!("OUT_DIR"), "/version_info.rs"));
}
pub use version_info::{APP_DISPLAY_VERSION, APP_GENERATION, APP_VERSION};

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

/// 托盘图标 · 深色任务栏：把原始深色 logo（#020E36）**反转为白色**，透明背景不变。
const TRAY_ICON_ON_DARK: &[u8] = include_bytes!("../icons/tray-dark.png");
/// 托盘图标 · 浅色任务栏：原始深色 logo。
const TRAY_ICON_ON_LIGHT: &[u8] = include_bytes!("../icons/tray-light.png");

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
fn with_shared_profile<'a, R: Runtime, M: Manager<R>>(
    app: &AppHandle<R>,
    mut builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    if let Some(dir) = webview_data_dir(app) {
        builder = builder.data_directory(dir);
    }
    builder
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
    with_shared_profile(app, builder).build()?;
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

/// 给子 webview 构造器套上共享的 WebView2 数据目录。
///
/// 所有 webview 共用同一份 profile ⇒ 登录态共享，且 cookie 仍然落盘
/// （会话 cookie 转持久 cookie 的 keeper 依赖这一点）。
fn child_webview_builder<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: WebviewUrl,
) -> tauri::webview::WebviewBuilder<R> {
    let builder = tauri::webview::WebviewBuilder::new(label, url);
    match webview_data_dir(app) {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    }
}

/// 摆放主窗口里的子 webview（顶栏 / 内容 / 对话侧栏）。
///
/// 这里**只做 `set_position` / `set_size`**：它们是非阻塞的消息投递，
/// 可以在窗口事件（主线程）里安全调用。**绝不在这里创建 webview**
/// （`add_child` 会阻塞等主线程 ⇒ 主线程里调用必然死锁）。
///
/// 全部使用**逻辑**单位；Tauri 会自己换算成物理像素。
fn layout_main_webviews<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_window(MAIN_LABEL) else {
        return;
    };
    let Some((width, height)) = main_logical_size(&main) else {
        return;
    };
    let content_height = (height - TITLEBAR_HEIGHT).max(1.0);

    if let Some(titlebar) = app.get_webview(TITLEBAR_LABEL) {
        let _ = titlebar.set_position(tauri::LogicalPosition::new(0.0, 0.0));
        let _ = titlebar.set_size(tauri::LogicalSize::new(width, TITLEBAR_HEIGHT));
    }
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
        let _ = content.set_position(tauri::LogicalPosition::new(0.0, TITLEBAR_HEIGHT));
        let _ = content.set_size(tauri::LogicalSize::new(width, content_height));
    }
    if let Some(chat) = app.get_webview(CHAT_LABEL) {
        let chat_width = CHAT_WIDTH.min(width).max(1.0);
        let _ = chat.set_position(tauri::LogicalPosition::new(
            width - chat_width,
            TITLEBAR_HEIGHT,
        ));
        let _ = chat.set_size(tauri::LogicalSize::new(chat_width, content_height));
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
fn toggle_chat_webview<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(main) = app.get_window(MAIN_LABEL) else {
        return Err("还没有主窗口，请先连接".to_string());
    };

    // 已创建：切换显示 / 隐藏。
    if let Some(chat) = app.get_webview(CHAT_LABEL) {
        if CHAT_VISIBLE.load(Ordering::Relaxed) {
            let _ = chat.hide();
            CHAT_VISIBLE.store(false, Ordering::Relaxed);
            eprintln!("[DSHTauri] 对话侧栏已隐藏");
        } else {
            layout_main_webviews(app);
            chat.show().map_err(|e| e.to_string())?;
            CHAT_VISIBLE.store(true, Ordering::Relaxed);
            eprintln!("[DSHTauri] 对话侧栏已显示");
        }
        return Ok(());
    }

    // 首次打开：创建子 webview。
    let (width, height) =
        main_logical_size(&main).ok_or_else(|| "无法读取主窗口尺寸".to_string())?;
    let chat_width = CHAT_WIDTH.min(width).max(1.0);
    let content_height = (height - TITLEBAR_HEIGHT).max(1.0);
    let url = CHAT_URL
        .parse()
        .map_err(|e| format!("对话页地址无效：{e}"))?;

    main.add_child(
        child_webview_builder(app, CHAT_LABEL, WebviewUrl::External(url)),
        tauri::LogicalPosition::new(width - chat_width, TITLEBAR_HEIGHT),
        tauri::LogicalSize::new(chat_width, content_height),
    )
    .map_err(|e| format!("打开对话侧栏失败：{e}"))?;

    CHAT_VISIBLE.store(true, Ordering::Relaxed);
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
    with_shared_profile(app, builder)
        .build()
        .map_err(|e| format!("打开关于窗口失败：{e}"))?;
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

/// 按系统主题挑托盘图标：深色任务栏用反转成白色的 logo，浅色任务栏用原始深色 logo。
///
/// 主题探测不到时按**深色**处理——Windows 11 默认就是深色任务栏，
/// 而深色 logo 落在深色底上会直接看不见，比反过来更糟。
fn tray_icon(theme: Option<Theme>) -> Option<Image<'static>> {
    let bytes = match theme {
        Some(Theme::Light) => TRAY_ICON_ON_LIGHT,
        _ => TRAY_ICON_ON_DARK,
    };
    Image::from_bytes(bytes).ok()
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

    // 托盘图标跟随系统主题：深色任务栏用反转成白色的 logo，浅色用原始深色 logo。
    // 内嵌 PNG 解码失败时退回 bundle.icon 生成的默认图标。
    if let Some(icon) = tray_icon(current_theme(app)) {
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

/// 写入配置文件。
#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    write_config(&app, &config)
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

/// 返回显示用版本号：`v1.1.1` 或 `v1.1.1 Gen2`。
#[tauri::command]
fn app_version() -> String {
    APP_DISPLAY_VERSION.to_string()
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
            let check = item("check-update", "检查更新")?;
            let reconnect = item("reconnect", "重新连接")?;
            let sep = separator()?;
            Menu::with_items(&app, &[&about, &check, &sep, &reconnect]).map_err(|e| e.to_string())?
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
fn run_action<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<(), String> {
    match action {
        "about" => show_about_window(app),
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
            chrome_action,
            window_control,
            start_drag,
            popup_menu
        ])
        .setup(|app| {
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
                    layout_main_webviews(app);
                    emit_window_state(app, window);
                }
            }
            // 系统在浅色 / 深色之间切换时，同步把托盘图标换成对应版本。
            WindowEvent::ThemeChanged(theme) => {
                if let Some(tray) = window.app_handle().tray_by_id(TRAY_ID) {
                    if let Some(icon) = tray_icon(Some(*theme)) {
                        let _ = tray.set_icon(Some(icon));
                    }
                }
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
    fn embedded_tray_icons_decode() {
        for theme in [Theme::Dark, Theme::Light] {
            let icon = tray_icon(Some(theme))
                .unwrap_or_else(|| panic!("托盘图标解码失败：{theme:?}"));
            assert_eq!(icon.width(), 64, "托盘图标宽度应为 64");
            assert_eq!(icon.height(), 64, "托盘图标高度应为 64");
        }
    }

    /// 主题探测不到时按深色处理（Windows 11 默认深色任务栏）。
    #[test]
    fn tray_icon_falls_back_to_white_version() {
        assert!(tray_icon(None).is_some());
    }

    /// 深色版应该是白鲸鱼，浅色版应该是深色鲸鱼——反色确实生效了。
    #[test]
    fn tray_icons_are_inverted_versions_of_each_other() {
        let dark = tray_icon(Some(Theme::Dark)).unwrap();
        let light = tray_icon(Some(Theme::Light)).unwrap();
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
        ] {
            assert!(json.contains(key), "序列化结果缺少 {key}：{json}");
        }
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.local_url, AppConfig::default().local_url);
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
        let generation: u32 = APP_GENERATION;
        assert!(generation >= 1, "GenX 最小为 1");
    }

    /// 版本显示规则：Gen1 不显示；从 Gen2 起显示 ` GenX`。
    #[test]
    fn display_version_hides_gen1() {
        let expected = if APP_GENERATION >= 2 {
            format!("v{APP_VERSION} Gen{APP_GENERATION}")
        } else {
            format!("v{APP_VERSION}")
        };
        assert_eq!(APP_DISPLAY_VERSION, expected);
        if APP_GENERATION == 1 {
            assert!(!APP_DISPLAY_VERSION.contains("Gen"), "Gen1 不该显示 Gen");
        }
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
