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
    AppHandle, Manager, Runtime, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// 启动选择窗口的 label（在 tauri.conf.json 中预创建）。
pub const SELECTOR_LABEL: &str = "selector";
/// 主窗口的 label（选择完成后由 Rust 动态创建）。
pub const MAIN_LABEL: &str = "main";

const SELECTOR_TITLE: &str = "选择 DSH 连接方式";
const SELECTOR_WIDTH: f64 = 560.0;
const SELECTOR_HEIGHT: f64 = 460.0;

const MAIN_TITLE: &str = "DSHTauri";
const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 800.0;
const MAIN_MIN_WIDTH: f64 = 640.0;
const MAIN_MIN_HEIGHT: f64 = 480.0;

const TRAY_ID: &str = "dshtauri-tray";
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

const DEFAULT_LOCAL_URL: &str = "http://127.0.0.1:8080";
const DEFAULT_REMOTE_URL: &str = "https://dsh.example.com";

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// 是否已经完成首次配置。
    pub configured: bool,
    pub local_url: String,
    pub remote_url: String,
    /// 选择「本地」时是否自动执行 `local_start_command`。
    pub auto_start_local: bool,
    /// 启动本地 DSH 服务的命令（Windows 下通过 PowerShell 后台执行）。
    pub local_start_command: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            configured: false,
            local_url: DEFAULT_LOCAL_URL.to_string(),
            remote_url: DEFAULT_REMOTE_URL.to_string(),
            auto_start_local: false,
            local_start_command: String::new(),
        }
    }
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
#[cfg(windows)]
fn spawn_local_service(command: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    /// CREATE_NO_WINDOW
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    std::process::Command::new("powershell")
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
        .map(|_| ())
        .map_err(|e| format!("启动本地服务失败：{e}"))
}

/// 非 Windows（开发机 Debian 上跑 `tauri dev`）用 sh 执行同样的命令。
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

/// 托盘「显示主窗口」/ 左键点击托盘：优先主窗口，其次选择窗口，都没有就重建选择窗口。
fn reveal_window<R: Runtime>(app: &AppHandle<R>) {
    for label in [MAIN_LABEL, SELECTOR_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
    }

    // 理论上不会走到这里（选择窗口不会被 destroy），保底重建。
    let _ = WebviewWindowBuilder::new(app, SELECTOR_LABEL, WebviewUrl::App("index.html".into()))
        .title(SELECTOR_TITLE)
        .inner_size(SELECTOR_WIDTH, SELECTOR_HEIGHT)
        .resizable(true)
        .center()
        .build();
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
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(MAIN_TITLE)
        .menu(&menu)
        // 左键单击直接唤出窗口，右键才弹菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => reveal_window(app),
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
fn probe_url(url: String) -> Result<bool, String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("URL 无效：{e}"))?;
    let host = parsed.host_str().ok_or_else(|| "URL 缺少主机名。".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "URL 缺少端口，且协议没有默认端口。".to_string())?;
    Ok(probe_tcp(host, port))
}

/// 打开主窗口并加载 `request.url`，最后关闭选择窗口。
#[tauri::command]
fn open_main_window(app: AppHandle, request: OpenRequest) -> Result<(), String> {
    let raw = request.url.trim();
    let url = tauri::Url::parse(raw).map_err(|e| format!("URL 无效（{raw}）：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("不支持的协议 `{other}`，只允许 http / https。")),
    }

    // 已经存在主窗口（例如用户从托盘重新选择）：先销毁再按新地址重建，保证 URL 生效。
    if let Some(existing) = app.get_webview_window(MAIN_LABEL) {
        let _ = existing.destroy();
    }

    let window = WebviewWindowBuilder::new(&app, MAIN_LABEL, WebviewUrl::External(url))
        .title(MAIN_TITLE)
        .inner_size(MAIN_WIDTH, MAIN_HEIGHT)
        .min_inner_size(MAIN_MIN_WIDTH, MAIN_MIN_HEIGHT)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .center()
        .visible(true)
        .build()
        .map_err(|e| format!("创建主窗口失败：{e}"))?;

    let _ = window.set_focus();

    // 选择窗口使命完成：destroy() 不触发 CloseRequested，不会被「隐藏到托盘」逻辑拦下。
    if let Some(selector) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = selector.destroy();
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
            open_main_window
        ])
        .setup(|app| {
            match setup_tray(app.handle()) {
                Ok(()) => TRAY_READY.store(true, Ordering::Relaxed),
                Err(err) => eprintln!(
                    "[DSHTauri] 系统托盘创建失败：{err}\n\
                     [DSHTauri] 已降级运行：关闭窗口将直接退出程序（不会隐藏到托盘）。"
                ),
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 关闭窗口 ≠ 退出程序：隐藏到托盘，由托盘菜单「退出」真正结束。
            // 托盘不可用时不能隐藏，否则用户再也找不回窗口。
            WindowEvent::CloseRequested { api, .. } => {
                if TRAY_READY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
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
