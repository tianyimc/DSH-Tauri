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

/// 托盘「重新选择连接方式」：把选择窗口叫出来（它只是被隐藏了，没有销毁）。
fn reveal_selector<R: Runtime>(app: &AppHandle<R>) {
    if let Some(selector) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = selector.unminimize();
        let _ = selector.show();
        let _ = selector.set_focus();
        return;
    }
    // 理论上不会走到这里（选择窗口不会被销毁），保底重建。
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

/// 打开主窗口并加载 `request.url`，然后把选择窗口收起来。
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
            app_version
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
}
