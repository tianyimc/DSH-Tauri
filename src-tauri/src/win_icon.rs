//! Windows 任务栏图标的**主题适配**。
//!
//! # 为什么需要这个模块（v0.3.2 缺陷）
//!
//! v0.3.1 用 `Window::set_icon()` 给主窗口换图标，期望「任务栏按钮」跟着变。
//! 但用户实测：**任务栏上显示的仍是深藏青鲸鱼**（在深色任务栏上几乎看不见），
//! 而托盘图标却正确变成了白色。
//!
//! ## 根因（读源码确认，不是猜测）
//!
//! Windows 上一个窗口有**两个**图标槽，由 `WM_SETICON` 的两个 `wParam` 区分：
//!
//! | 槽 | 常量 | 谁在用 |
//! | --- | --- | --- |
//! | 小图标 | `ICON_SMALL` (0) | 标题栏左上角、`Alt+Tab` 的小图 |
//! | 大图标 | `ICON_BIG` (1) | **任务栏按钮**、`Alt+Tab` 的大图 |
//!
//! Tauri 的 `Window::set_icon()` 最终落到 tao 的 `set_window_icon()`
//! （`tauri-runtime-wry-2.12.1/src/lib.rs:3463` → `WindowMessage::SetIcon`
//!  → `tao-0.37.1/src/platform_impl/windows/window.rs:846`），而它**只设置 `ICON_SMALL`**：
//!
//! ```ignore
//! pub fn set_window_icon(&self, window_icon: Option<Icon>) {
//!   if let Some(ref window_icon) = window_icon {
//!     window_icon.inner.set_for_window(self.hwnd(), IconType::Small); // ← 只有 Small
//!   }
//!   ...
//! }
//! ```
//!
//! tao 里确实有 `set_taskbar_icon()`（用 `IconType::Big`，见同文件 :858），
//! 但 **Tauri 完全没有暴露它**（`grep taskbar_icon` 在 tauri / tauri-runtime /
//! tauri-runtime-wry 里零命中），创建时也没有对应的 builder 选项
//! （`tao/src/platform_impl/windows/window.rs:1222` 那句
//! `win.set_taskbar_icon(self.pl_attribs.taskbar_icon.clone())` 收到的永远是 `None`）。
//!
//! 于是任务栏按钮一直用**创建时**由窗口类/资源决定的图标 —— 也就是 exe 里那个
//! 静态的 `icon.ico`（深藏青），`set_icon()` 怎么调都影响不到它。
//!
//! ## 修法
//!
//! 绕过 Tauri，直接对主窗口 HWND 发 `WM_SETICON` / `ICON_BIG`，把当前主题对应的
//! `HICON` 塞进**大图标槽**。`Window::hwnd()` 是 Tauri 公开 API，拿得到主窗口句柄。
//!
//! ## 为什么用 `CreateIcon` 而不是 `LoadImageW(文件)`
//!
//! `LoadImageW` 只能从**文件路径**或**模块资源**加载图标，而我们手上的两套配色是
//! 编译期 `include_bytes!` 进二进制的 PNG（`tray-dark.png` / `tray-light.png`）。
//! 落盘再加载会引入临时文件与清理问题，所以直接把 PNG 解成 RGBA、用 `CreateIcon`
//! 现场造一个 `HICON` —— 这也正是 tray-icon crate 的做法
//! （`tray-icon-0.25.1/src/platform_impl/windows/icon.rs:26` `into_windows_icon`）。
//!
//! ## 生命周期
//!
//! `CreateIcon` 造出的 `HICON` **必须由我们负责销毁**（`DestroyIcon`）。
//! 但 `WM_SETICON` 之后窗口持有该句柄，立刻销毁会让任务栏拿到野句柄。
//! Windows 的约定是：**发送 `WM_SETICON` 后，新图标的所有权转移给窗口**
//! —— 系统不会替你销毁，但也**不允许**你在窗口仍在使用时销毁。
//!
//! 所以这里**故意不销毁**。量级：图标源是 64×64（`tray-*.png`），
//! 一个 32bpp 的 `HICON` 约 **16KB**（64×64×4 的彩色位图 + 512B 掩码），
//! 每次 `apply_theme_icons` 泄漏一个。触发时机只有「应用启动 / 主窗口创建 /
//! 系统主题切换」这几种**极低频**事件，一个进程生命周期内通常个位数次
//! ⇒ 总计几十 KB 量级，可以接受。
//!
//! ⚠️ 如果将来把它挂到**高频**路径上（例如每次开侧栏都设一次图标），
//! 就必须改成「先建新的、`WM_SETICON` 后再 `DestroyIcon` 旧的」，
//! 并自己持有旧句柄。现在不做，是因为那会让状态管理复杂化，
//! 而当前收益为零。

/// 把「注册表里读到的值」翻译成「任务栏是否浅色」。
///
/// **纯函数**，与注册表读取分开 —— 这样「翻译规则」可以被单测覆盖，
/// 而不用去断言依赖运行环境的注册表读取结果。
///
/// 为什么要分开：CI（`windows-latest`）上 `SystemUsesLightTheme` **确实存在**，
/// 值可能是 0（深色外壳）。如果测试直接断言 `taskbar_prefers_light(true) == true`，
/// 就会在 CI 上失败 —— 因为 Windows 上它真的会去读注册表。
/// （这正是 v0.3.2 第一次推送时 CI 红掉的原因。）
///
/// `raw`：
/// - `Some(v)` ⇒ 读到值，`v != 0` 表示浅色；
/// - `None` ⇒ 没读到（键不存在 / 权限问题 / 非 Windows），退回 `fallback`。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn taskbar_light_from_registry_value(raw: Option<u32>, fallback: bool) -> bool {
    match raw {
        Some(v) => v != 0,
        None => fallback,
    }
}

/// 读取**任务栏实际使用的**深浅色（`true` = 浅色任务栏）。
///
/// # 为什么不能直接用 Tauri/tao 的 `Window::theme()`
///
/// Windows 把「应用深浅色」和「系统（外壳）深浅色」分成**两个独立设置**：
///
/// | 注册表值 | 影响范围 |
/// | --- | --- |
/// | `AppsUseLightTheme` | 应用窗口（资源管理器正文、UWP 应用…） |
/// | `SystemUsesLightTheme` | **任务栏**、开始菜单、操作中心等外壳 |
///
/// 用户在「个性化 → 颜色」里可以选「浅色 / 深色 / 自定义」——选**自定义**时这两项
/// 就能不一致（例如「Windows 模式 = 深色」+「应用模式 = 浅色」）。
///
/// 而 tao 的 `Theme` 只读 `AppsUseLightTheme`
/// （`tao-0.37.1/src/platform_impl/windows/dark_mode.rs:234` `read_apps_use_light_theme`），
/// 并在读不到时退回不可靠的 `ShouldAppsUseDarkMode` 序数、读不到就返回 `Theme::Light`。
///
/// 任务栏背景是**外壳**的一部分，跟的是 `SystemUsesLightTheme`。所以「应用浅色 +
/// 系统深色」这种配置下，tao 报 `Light` ⇒ 我们摆上深藏青鲸鱼 ⇒ 落在**深色任务栏**上
/// —— 几乎看不见。这正是用户截图里的现象。
///
/// 所以任务栏图标必须按 `SystemUsesLightTheme` 选色，而不是按 `Window::theme()`。
///
/// 读不到该值时退回 `fallback`（调用方传 tao 的主题），保持原有行为。
#[cfg(windows)]
pub fn taskbar_prefers_light(fallback: bool) -> bool {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
    };

    /// `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`
    ///
    /// 用 UTF-16 字面量（`RegGetValueW` 要 `PCWSTR`）。这里手写而不是引 `w!` 宏，
    /// 是为了不额外引入 `windows` crate 的宏依赖（本项目只用 `windows-sys`）。
    const SUBKEY: &[u16] = &[
        'S' as u16, 'o' as u16, 'f' as u16, 't' as u16, 'w' as u16, 'a' as u16, 'r' as u16,
        'e' as u16, '\\' as u16, 'M' as u16, 'i' as u16, 'c' as u16, 'r' as u16, 'o' as u16,
        's' as u16, 'o' as u16, 'f' as u16, 't' as u16, '\\' as u16, 'W' as u16, 'i' as u16,
        'n' as u16, 'd' as u16, 'o' as u16, 'w' as u16, 's' as u16, '\\' as u16, 'C' as u16,
        'u' as u16, 'r' as u16, 'r' as u16, 'e' as u16, 'n' as u16, 't' as u16, 'V' as u16,
        'e' as u16, 'r' as u16, 's' as u16, 'i' as u16, 'o' as u16, 'n' as u16, '\\' as u16,
        'T' as u16, 'h' as u16, 'e' as u16, 'm' as u16, 'e' as u16, 's' as u16, '\\' as u16,
        'P' as u16, 'e' as u16, 'r' as u16, 's' as u16, 'o' as u16, 'n' as u16, 'a' as u16,
        'l' as u16, 'i' as u16, 'z' as u16, 'e' as u16, 0,
    ];
    /// `SystemUsesLightTheme`
    const VALUE: &[u16] = &[
        'S' as u16, 'y' as u16, 's' as u16, 't' as u16, 'e' as u16, 'm' as u16, 'U' as u16,
        's' as u16, 'e' as u16, 's' as u16, 'L' as u16, 'i' as u16, 'g' as u16, 'h' as u16,
        't' as u16, 'T' as u16, 'h' as u16, 'e' as u16, 'm' as u16, 'e' as u16, 0,
    ];

    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: 两个键名都是 NUL 结尾的 UTF-16 常量，`data`/`size` 指向有效栈内存。
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            SUBKEY.as_ptr(),
            VALUE.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut _ as *mut _,
            &mut size,
        )
    };
    // 读到 ⇒ 交给纯函数翻译（可单测）；读不到 ⇒ `None` ⇒ 退回 fallback。
    let raw = if status == 0 { Some(data) } else { None };
    taskbar_light_from_registry_value(raw, fallback)
}

/// 非 Windows：没有任务栏概念，直接沿用调用方给的主题。
#[cfg(not(windows))]
pub fn taskbar_prefers_light(fallback: bool) -> bool {
    fallback
}

/// 给窗口的**大图标槽**（任务栏按钮）设置主题对应的图标。
///
/// 非 Windows 平台是空实现 —— 这样调用方（`lib.rs`）不必到处 `#[cfg]`。
#[cfg(windows)]
pub fn set_taskbar_icon<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    icon: &tauri::image::Image<'_>,
) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIcon, SendMessageW, ICON_BIG, WM_SETICON,
    };

    // `hwnd()` 只在 Windows 上有；失败就静默跳过（拿不到句柄不该影响主流程）。
    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    // ⚠️ 类型转换是必须的：Tauri 用的是 `windows` crate 的 `HWND`（一个 newtype
    // 结构体），而本项目依赖的是 `windows-sys`，它的 `HWND` 是 `*mut c_void`。
    // 两者布局相同（都只是一个指针），所以取 `.0` 再转指针。
    let hwnd = hwnd.0 as *mut core::ffi::c_void;

    let width = icon.width();
    let height = icon.height();
    let rgba = icon.rgba();

    // `CreateIcon` 要的是 **BGRA**（Windows 的 DIB 字节序）+ 一张 1bpp 的 AND 掩码。
    // `Image::rgba()` 给的是 RGBA，所以这里逐像素换 R/B。
    //
    // AND 掩码按 Windows 约定「1 = 透明」：对 32bpp 带 alpha 的图标，系统优先看
    // alpha 通道，掩码基本被忽略，但**必须**提供一张尺寸正确的掩码，否则
    // `CreateIcon` 会失败。所以这里按「alpha < 128 ⇒ 掩码置 1」生成。
    let pixel_count = (width as usize) * (height as usize);
    let mut bgra = Vec::with_capacity(pixel_count * 4);
    let mut and_mask = Vec::with_capacity(pixel_count);
    for i in 0..pixel_count {
        let r = rgba[i * 4];
        let g = rgba[i * 4 + 1];
        let b = rgba[i * 4 + 2];
        let a = rgba[i * 4 + 3];
        bgra.extend_from_slice(&[b, g, r, a]);
        // 1bpp：每像素 1 bit。alpha 半透明以下算透明（掩码位 = 1）。
        and_mask.push(if a < 128 { 1u8 } else { 0u8 });
    }

    // 掩码是 **1bpp** 位图：每像素 1 bit，且**每行补齐到 2 字节（WORD）边界**
    // —— 这是 DIB 的规范（`biWidth` 为 1bpp 时，行距 = `((width + 15) / 16) * 2`）。
    //
    // ⚠️ 这里**不能**用 DWORD（4 字节）对齐：16 / 33 / 48 这类宽度下两者结果不同
    // （例如 width=16：WORD 行距 = 2，DWORD 行距 = 4），从第 2 行起掩码位会整体错位。
    // 当前实际传入的是 64×64（`tray-dark.png` / `tray-light.png` 都是 64×64），
    // 该尺寸下 WORD 与 DWORD 恰好都等于 8 ⇒ 即使写错也看不出问题 ——
    // 这正是它容易被写错却长期不暴露的原因。按规范写成 WORD 才不埋雷。
    let mask_stride = (width as usize).div_ceil(16) * 2;
    let mut packed_mask = vec![0u8; mask_stride * height as usize];
    for y in 0..height as usize {
        for x in 0..width as usize {
            if and_mask[y * width as usize + x] == 1 {
                // MSB 在前：位图每行最左边的像素对应字节的最高位。
                packed_mask[y * mask_stride + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }

    // SAFETY: 两个缓冲区的长度都按 `width * height` 精确构造，且在整个调用期间存活。
    let hicon = unsafe {
        CreateIcon(
            std::ptr::null_mut(),
            width as i32,
            height as i32,
            1,    // 颜色平面数：图标恒为 1
            32,   // 每像素位数
            packed_mask.as_ptr(),
            bgra.as_ptr(),
        )
    };
    if hicon.is_null() {
        // 造图标失败（极少见）：保留原有图标，不破坏现状。
        return;
    }

    // SAFETY: `hwnd` 来自 Tauri，`hicon` 刚由 `CreateIcon` 造出且非空。
    // 所有权随 `WM_SETICON` 转移给窗口 —— 见模块文档「生命周期」。
    unsafe {
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, hicon as isize);
    }
}

/// 非 Windows：任务栏图标由平台自己处理（本项目的验收平台只有 Windows）。
#[cfg(not(windows))]
pub fn set_taskbar_icon<R: tauri::Runtime>(
    _window: &tauri::Window<R>,
    _icon: &tauri::image::Image<'_>,
) {
}
