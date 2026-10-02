//! 侧栏（网页对话）开 / 关的过渡动画。
//!
//! # 为什么需要自己写
//!
//! 侧栏是一个**子 webview**，它的位置/尺寸最终由 wry 在 Windows 上落到
//! `SetWindowPos`（`wry-0.57.0/src/webview2/mod.rs:1539`）。`SetWindowPos` 是**瞬时**的，
//! 没有任何动画参数；Tauri / wry 也没有提供「带动画地改变 webview 布局」的 API。
//! 所以要做到平滑滑动，只能**自己逐帧改 bounds**。
//!
//! 详细取舍与平台证据见 `docs/ANIMATION-FEASIBILITY.md`。
//!
//! # 关键设计：动画期间尽量不重排 content
//!
//! 最贵的操作是「让 WebView2 重新布局网页」。所以本模块的动画**只改位置**：
//! 整段动画里 webview 的**尺寸保持不变**，只有 `x` 在动。
//! 这样 overlay 模式下 content 完全不需要重排，只有侧栏自己在平移。
//!
//! （docked 模式下 content 宽度必须变，那一次重排躲不掉，由调用方直接切到位，
//! 不在本模块里逐帧缩放。）
//!
//! # 尊重系统的「动画效果」开关
//!
//! Windows 11：设置 → 辅助功能 → 视觉效果 → **动画效果**。
//! 关闭时 `SPI_GETCLIENTAREAANIMATION` 返回 0，我们**直接跳到终态**、不做过渡
//! —— 这既是用户预期，也是无障碍的正确行为。

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

/// 动画时长（毫秒）。Windows 11 原生抽屉/侧栏过渡大致在 150~250ms，取 180ms。
pub const SLIDE_MS: u64 = 180;

/// 帧间隔（毫秒），约 60fps。
const FRAME_MS: u64 = 15;

/// 当前动画的「代次」。
///
/// 用自增代次而不是布尔量：用户快速连点（开→关→开）时，
/// 旧动画线程必须自己退出，不能去改新动画正在改的位置。
static ANIM_GENERATION: AtomicU32 = AtomicU32::new(0);

/// 系统是否允许播放动画（Windows 11 的「动画效果」开关）。
///
/// 非 Windows 返回 true（开发机没有这个开关，动画照跑）。
#[cfg(windows)]
pub fn system_animations_enabled() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION,
    };

    let mut enabled: i32 = 1;
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            &mut enabled as *mut i32 as *mut core::ffi::c_void,
            0,
        )
    };
    // 读不到设置时按「允许动画」处理：宁可多一个动画，也不要完全没有反馈。
    ok != 0 && enabled != 0
}

#[cfg(not(windows))]
pub fn system_animations_enabled() -> bool {
    true
}

/// 缓动：ease-out cubic（起步快、收尾慢，接近 Windows 11 原生观感）。
///
/// 纯函数，单独抽出来便于单测。
pub fn ease_out_cubic(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

/// 线性插值，输入会夹到 `0..=1`。
pub fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t.clamp(0.0, 1.0)
}

/// 给定已播放的毫秒数，算出当前应在的 `x`。
///
/// 这是动画的**纯函数核心**：把「时间 → 位置」的映射从线程/IO 里剥出来，
/// 于是它可以被单测，而且改观感只需要改这一个地方。
pub fn x_at(elapsed_ms: f64, from_x: f64, to_x: f64, duration_ms: f64) -> f64 {
    if duration_ms <= 0.0 {
        return to_x;
    }
    let t = elapsed_ms / duration_ms;
    lerp(from_x, to_x, ease_out_cubic(t))
}

/// 取消任何正在进行的动画（窗口关闭、切换连接方式等）。
///
/// 只把代次 +1，正在跑的线程会自行退出。
pub fn cancel() {
    ANIM_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// 让某个子 webview 沿水平方向从 `from_x` 平滑滑到 `to_x`。
///
/// - **尺寸在整段动画里保持不变**（只有 x 在动），把重排成本降到最低。
/// - `y` / `width` / `height` 由调用方给出，本模块不关心布局策略。
///
/// 返回 `true` 表示真的起了动画线程；`false` 表示已直接落到终点
/// （系统关了动画，或距离太短不值得动画）。
pub fn slide_x<R: Runtime>(
    app: &AppHandle<R>,
    label: &'static str,
    from_x: f64,
    to_x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> bool {
    slide_x_with(app, label, from_x, to_x, y, width, height, |_| {})
}

/// 同 [`slide_x`]，但动画结束后会调用 `on_done`。
///
/// 关闭侧栏要用它：必须**等滑出动画放完**再 `hide()`，
/// 否则侧栏会在半路突然消失，看起来像闪了一下。
///
/// `on_done` 在**动画线程**上执行（不在主线程），所以里面只能做
/// 「通过 AppHandle 投递窗口操作」这类线程安全的事 —— 我们的用法正是如此。
pub fn slide_x_with<R, F>(
    app: &AppHandle<R>,
    label: &'static str,
    from_x: f64,
    to_x: f64,
    y: f64,
    width: f64,
    height: f64,
    on_done: F,
) -> bool
where
    R: Runtime,
    F: FnOnce(&AppHandle<R>) + Send + 'static,
{
    // 系统关了动画 / 距离太短：直接落到终点，不折腾。
    let too_short = (to_x - from_x).abs() < 1.0;
    if !system_animations_enabled() || too_short {
        apply(app, label, to_x, y, width, height);
        on_done(app);
        return false;
    }

    let my_generation = ANIM_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();

    std::thread::spawn(move || {
        let started = Instant::now();

        loop {
            // 有更新的动画启动了 —— 立刻退出，把位置让给它。
            //
            // ⚠️ 这里**不调用** `on_done`：被抢占意味着「有新的开/关动作接管了」，
            // 此时再执行旧动作的收尾（例如 hide 侧栏）会把新动画刚打开的东西关掉。
            if ANIM_GENERATION.load(Ordering::SeqCst) != my_generation {
                return;
            }

            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            let x = x_at(elapsed_ms, from_x, to_x, SLIDE_MS as f64);
            apply(&app, label, x, y, width, height);

            if elapsed_ms >= SLIDE_MS as f64 {
                // 收尾：确保精确落在终点（浮点误差不该留下半个像素）。
                apply(&app, label, to_x, y, width, height);
                on_done(&app);
                return;
            }
            std::thread::sleep(Duration::from_millis(FRAME_MS));
        }
    });

    true
}

/// 把位置/尺寸真正写进子 webview。
///
/// 单独一个函数，方便将来替换成别的实现（也让 `slide_x` 的逻辑更好读）。
fn apply<R: Runtime>(app: &AppHandle<R>, label: &str, x: f64, y: f64, w: f64, h: f64) {
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
        let _ = webview.set_size(tauri::LogicalSize::new(w, h));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ease_starts_at_zero_and_ends_at_one() {
        assert!((ease_out_cubic(0.0) - 0.0).abs() < 1e-9);
        assert!((ease_out_cubic(1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn ease_is_monotonic_and_clamped() {
        let mut prev = -1.0;
        for i in 0..=100 {
            let t = i as f64 / 100.0;
            let v = ease_out_cubic(t);
            assert!(v >= prev, "缓动必须单调不减：t={t} v={v} prev={prev}");
            assert!((0.0..=1.0).contains(&v), "缓动必须落在 0..1：t={t} v={v}");
            prev = v;
        }
        // 越界输入要被夹住，不能外推。
        assert!((ease_out_cubic(-5.0) - 0.0).abs() < 1e-9);
        assert!((ease_out_cubic(5.0) - 1.0).abs() < 1e-9);
    }

    /// ease-out 的特征：前半段就走完一半以上路程（起步快）。
    #[test]
    fn ease_out_is_front_loaded() {
        assert!((ease_out_cubic(0.5) - 0.875).abs() < 1e-9);
        assert!(ease_out_cubic(0.25) > 0.25);
    }

    #[test]
    fn lerp_interpolates_and_clamps() {
        assert!((lerp(100.0, 200.0, 0.0) - 100.0).abs() < 1e-9);
        assert!((lerp(100.0, 200.0, 1.0) - 200.0).abs() < 1e-9);
        assert!((lerp(100.0, 200.0, 0.5) - 150.0).abs() < 1e-9);
        assert!((lerp(100.0, 200.0, -1.0) - 100.0).abs() < 1e-9);
        assert!((lerp(100.0, 200.0, 9.0) - 200.0).abs() < 1e-9);
    }

    /// `x_at`：起点/终点必须精确，且单调。
    #[test]
    fn x_at_hits_endpoints_and_is_monotonic() {
        assert!((x_at(0.0, 100.0, 400.0, 180.0) - 100.0).abs() < 1e-9);
        assert!((x_at(180.0, 100.0, 400.0, 180.0) - 400.0).abs() < 1e-9);
        // 超过总时长仍然停在终点（不外推）。
        assert!((x_at(9999.0, 100.0, 400.0, 180.0) - 400.0).abs() < 1e-9);

        let mut prev = f64::NEG_INFINITY;
        for ms in 0..=180 {
            let x = x_at(ms as f64, 100.0, 400.0, 180.0);
            assert!(x >= prev, "位置必须单调前进：ms={ms} x={x} prev={prev}");
            assert!((100.0..=400.0).contains(&x), "位置越界：ms={ms} x={x}");
            prev = x;
        }
    }

    /// 反向滑动（关闭侧栏）同样要能正确工作。
    #[test]
    fn x_at_supports_reverse_direction() {
        let mut prev = f64::INFINITY;
        for ms in 0..=180 {
            let x = x_at(ms as f64, 400.0, 100.0, 180.0);
            assert!(x <= prev, "反向滑动必须单调后退：ms={ms} x={x} prev={prev}");
            assert!((100.0..=400.0).contains(&x));
            prev = x;
        }
        assert!((x_at(0.0, 400.0, 100.0, 180.0) - 400.0).abs() < 1e-9);
        assert!((x_at(180.0, 400.0, 100.0, 180.0) - 100.0).abs() < 1e-9);
    }

    /// 时长为 0 时不能除零，应直接返回终点。
    #[test]
    fn x_at_handles_zero_duration() {
        assert!((x_at(0.0, 100.0, 400.0, 0.0) - 400.0).abs() < 1e-9);
        assert!((x_at(50.0, 100.0, 400.0, -1.0) - 400.0).abs() < 1e-9);
    }

    /// 过渡时长必须「不拖沓」；改大要有人注意到。
    #[test]
    fn slide_duration_is_reasonable() {
        assert!(
            (100..=300).contains(&SLIDE_MS),
            "过渡时长应在 100~300ms 之间（对齐 Windows 原生观感），实际 {SLIDE_MS}ms"
        );
    }

    /// 帧间隔必须明显小于总时长，否则动画只有两三帧、看起来是「跳」不是「滑」。
    #[test]
    fn frame_interval_gives_enough_frames() {
        let frames = SLIDE_MS / FRAME_MS;
        assert!(
            frames >= 8,
            "帧数太少（{frames} 帧）会导致动画看起来一跳一跳的；\
             请减小 FRAME_MS 或加大 SLIDE_MS"
        );
    }

    /// 代次机制：`cancel()` 之后，旧动画应当能察觉自己被取代。
    ///
    /// 这里直接验证代次语义（不启线程，避免测试不稳定）。
    #[test]
    fn cancel_bumps_generation_so_old_animation_gives_up() {
        let before = ANIM_GENERATION.load(Ordering::SeqCst);
        cancel();
        let after = ANIM_GENERATION.load(Ordering::SeqCst);
        assert_ne!(before, after, "cancel() 必须改变代次，旧动画才会退出");
    }
}
