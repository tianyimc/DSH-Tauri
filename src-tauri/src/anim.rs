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
//! # 关键设计：动画期间尺寸恒定、只改位置
//!
//! 最贵的操作是「让 WebView2 重新布局网页」。逐帧改 bounds 时，**只有位置在变、
//! 尺寸全程不变** —— 于是**内容页**（`content`）在整个动画里完全不需要重排，
//! 只有侧栏自己在平移。
//!
//! 这条不只是「设计意图」，而是被**代码结构强制**的：
//!
//! - 每一帧要做的事由纯函数 [`frame_ops`] 算出来（返回 [`Op`] 列表），
//!   线程/IO 只负责执行；
//! - [`frame_ops`] 保证 `SetSize` **只出现在首帧和末帧**，中间帧**只有** `SetPosition`；
//! - `tests::animation_never_resizes_between_first_and_last_frame` 直接断言这条不变量。
//!
//! ## v0.3.1 修复：为什么原来会「卡帧」
//!
//! v0.3.0 每帧无条件调 `set_position` **和** `set_size`。看 `tauri-runtime-wry-2.12.1`
//! 的消息处理（`src/lib.rs:3741` / `:3762`）可以确认：**两条消息最终都走到
//! `webview.set_bounds(bounds)`**，而 wry 的 `set_bounds` 会调
//! `controller.SetBounds(...)`（`wry-0.57.0/src/webview2/mod.rs:1526`）。
//!
//! ⚠️ **必须说清一条容易搞错的事实**：`controller.SetBounds` 收到的 `RECT`
//! 里 `left` / `top` 被**硬编码为 0**（只传尺寸）；真正的位置由紧随其后的
//! `SetWindowPos` 施加在 HWND 上。所以「只调 `set_position` 就不会触发重排」是
//! **不成立**的 —— 它同样会走到 `controller.SetBounds`。
//!
//! 那么去掉中间帧的 `set_size` 到底省了什么？省的是**重复的那一次**：
//! 动画期间尺寸根本没变，`set_size` 会让同一个 `RECT` 被**再传一遍**
//! （一次多余的主线程 IPC 投递 + 一次多余的同参数 `SetBounds`）。
//! 整段 13 帧里投递次数从 26 降到 15（**少 42%**），主线程消息队列压力
//! 与重复 `SetBounds` 调用都随之下降。
//!
//! **诚实的边界**：这**没有**把 `SetBounds` 从动画路径里彻底去掉，
//! 只是去掉了每帧重复的那一次。真正的「零重排平移」需要绕过 Tauri 直接对
//! 子 webview 的 HWND 调 `SetWindowPos`；但 Tauri 公开 API 拿不到子 webview 的
//! HWND（`Window::hwnd()` 只给主窗口），靠枚举 `WRY_WEBVIEW` 子窗口去猜风险过高
//! （猜错会移动错的 webview），**本版不做**。
//!
//! 因此本版对「卡帧」的改善来自三处，按把握从高到低：
//!   1. **深色白闪被消除**（`background_color`）—— 用户描述的「白色卡顿」直接成因；
//!   2. 中间帧不再重复投递 `set_size`（少 42% 的主线程投递）；
//!   3. `layout_main_webviews` 不再与动画抢侧栏位置（消除开关瞬间的「闪一下 / 弹一下」）。
//!
//! # 每帧重新读时钟，而不是累加 15ms
//!
//! `std::thread::sleep(15ms)` 在 Windows 上实际会睡 15~31ms（系统定时器粒度）。
//! 所以位置**永远按真实经过的时间**算（`started.elapsed()`），某帧睡过头不会让
//! 整段动画越滑越慢、也不会让终点对不上。配合 [`TimerResolution`] 把粒度压到 1ms。
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

/// 谁**当前独占着侧栏的几何** —— 存的是拥有者的代次，`0` 表示没有人在独占。
///
/// 为什么需要它：动画期间侧栏的位置由动画线程逐帧决定，
/// 而 `layout_main_webviews`（窗口 Resized / 开关侧栏时都会调）会**无条件**把侧栏
/// 摆回 `chat_target_bounds`。两者同时生效就会出现：
///
/// - **打开时**：侧栏刚 `show()` 就被 layout 摆到「完全打开」的位置，
///   紧接着又被动画挪到屏幕外 ⇒ 用户看到一帧「已经打开了」的侧栏（闪一下）；
/// - **关闭时**：layout 先把侧栏挪回目标位，滑出动画再从那里出发 ⇒ 看起来「弹一下」。
///
/// 所以只要有人独占，layout 就**不碰侧栏**（内容页/顶栏照常）。
///
/// # 为什么存「代次」而不是一个 `bool`
///
/// 用一个 `bool` 会有**丢标志**的竞态：动画 A 放完时判断「代次还是我」→ 准备清标志，
/// 就在这两步之间用户又点了开关、动画 B 起跑并置位 —— 然后 A 把 B 的标志清掉。
/// 结果 B 动画期间 layout 又开始抢侧栏，B 的位置被拽走（正是我们要消除的跳变）。
///
/// 存代次后用 **CAS** 清标志（[`release`]），「检查 + 清除」是一个原子操作：
/// 只有当独占者**仍然是我**时才清得掉，A 不可能误清 B。
///
/// 置位/清位的责任划分（保证不会「永远占着」）：
/// - 起动画的调用方**同步**置位（见 [`slide_x_with`]）；
/// - 动画正常放完 → 线程用 CAS 释放（只有自己仍是独占者才成功）；
/// - [`cancel()`] → 立刻释放（layout 随即接管，把侧栏摆到正确位置）；
/// - 被更新的动画抢占的旧线程 → **不碰**这个值（它已经属于接管者了）。
static ANIM_OWNER: AtomicU32 = AtomicU32::new(0);

/// 当前是否有动画正在独占侧栏几何（供 `layout_main_webviews` 判断要不要跳过侧栏）。
pub fn is_animating() -> bool {
    ANIM_OWNER.load(Ordering::SeqCst) != 0
}

/// 释放几何独占权 —— **仅当独占者仍是我**（`generation`）时才生效。
///
/// 用 CAS 把「检查是不是我」和「清除」合成一个原子操作，
/// 避免旧动画把新动画刚置上的独占权清掉（见 [`ANIM_OWNER`] 的说明）。
fn release(generation: u32) {
    let _ = ANIM_OWNER.compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst);
}

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

/// Windows 定时器精度的 RAII 守卫。
///
/// `sleep(15ms)` 在 Windows 上受**系统定时器粒度**支配：默认约 15.6ms，
/// 于是 15ms 的睡眠实际会变成 15~31ms —— 帧间隔忽长忽短，看起来就是「一顿一顿」。
/// `timeBeginPeriod(1)` 把粒度压到 1ms，帧间隔明显更均匀。
///
/// ⚠️ 这是**全局**设置，且会增加耗电，所以：
/// - 只在动画真的开始时获取（见 [`slide_x_with`] 的线程体）；
/// - 用 RAII 保证**任何**退出路径（正常结束 / 被抢占 return）都会配对 `timeEndPeriod`；
/// - 动画只有 180ms，不会长期占着。
///
/// 非 Windows 上是空操作（Linux/macOS 的 `sleep` 精度本来就好得多）。
#[cfg(windows)]
struct TimerResolution;

#[cfg(windows)]
impl TimerResolution {
    fn acquire() -> Self {
        use windows_sys::Win32::Media::timeBeginPeriod;
        // 返回值只表示「成功/已被占用」，失败也无所谓：拿不到 1ms 就退回系统默认粒度，
        // 动画依然正确，只是帧间隔抖动大一点。
        let _ = unsafe { timeBeginPeriod(1) };
        Self
    }
}

#[cfg(windows)]
impl Drop for TimerResolution {
    fn drop(&mut self) {
        use windows_sys::Win32::Media::timeEndPeriod;
        let _ = unsafe { timeEndPeriod(1) };
    }
}

#[cfg(not(windows))]
struct TimerResolution;

#[cfg(not(windows))]
impl TimerResolution {
    fn acquire() -> Self {
        Self
    }
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

/// 动画一帧要投递到子 webview 的操作。
///
/// **纯数据**：把「每帧到底调了什么」从线程/IO 里剥出来，
/// 于是「动画期间不重排页面」这条不变量可以被单测**直接断言调用序列**
/// （见 `tests::animation_never_resizes_between_first_and_last_frame`）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    /// 只改位置 —— 动画中间帧**唯一**允许的操作。
    ///
    /// ⚠️ 注意它**并非零成本**：位置最终也是通过 `set_bounds` → `SetWindowPos`
    /// 施加的（见模块文档）。但它不会改变尺寸，所以**内容页无需重排**，
    /// 也不会把同一个 `RECT` 重复传给 `controller.SetBounds`。
    SetPosition { x: f64, y: f64 },
    /// 改尺寸 —— 只在**首帧/末帧**各做一次；中间帧尺寸没变，调它纯属重复开销。
    SetSize { w: f64, h: f64 },
}

/// 算出某一帧要投递的操作序列 —— 动画的**全部调用策略**都在这个纯函数里。
///
/// # 不变量（`mod tests` 逐条锁死）
///
/// - `SetSize` 只可能出现在**首帧**或**末帧**；
/// - 中间帧**只有** `SetPosition`，一次 `SetSize` 都没有；
/// - 每帧恰好一次 `SetPosition`；
/// - 顺序是「先尺寸、后位置」——保证位置最终落在**最终尺寸**的坐标系里。
///
/// `first` / `last` 都为真（动画只够放一帧）时只投递一次 `SetSize`，不重复。
pub fn frame_ops(first: bool, last: bool, x: f64, y: f64, w: f64, h: f64) -> Vec<Op> {
    let mut ops = Vec::with_capacity(2);
    if first || last {
        ops.push(Op::SetSize { w, h });
    }
    ops.push(Op::SetPosition { x, y });
    ops
}

/// 取消任何正在进行的动画（窗口关闭、缩放窗口、切换连接方式等）。
///
/// 把代次 +1（正在跑的线程会自行退出），并**无条件释放侧栏几何的独占权** ——
/// `cancel()` 是「外部权威接管」的信号，让 `layout_main_webviews` 能立刻把侧栏
/// 摆到正确位置。这里用无条件 `store(0)` 而不是 CAS：调用方（缩放窗口 / 收托盘）
/// 就是要让所有动画都失效，不需要关心当前独占者是谁。
pub fn cancel() {
    ANIM_GENERATION.fetch_add(1, Ordering::SeqCst);
    ANIM_OWNER.store(0, Ordering::SeqCst);
}

/// 让某个子 webview 沿水平方向从 `from_x` 平滑滑到 `to_x`。
///
/// - **尺寸在整段动画里保持不变**（只有 x 在动），内容页全程无需重排。
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
///
/// # 副作用：同步取得几何独占权
///
/// 真的起动画时，本函数会在**调用方线程**上同步把 [`ANIM_OWNER`] 置为本动画的代次
/// （然后才 spawn 线程）。调用方**必须**能依赖这一点：
/// `lib.rs` 里的顺序是「先 `slide_x` → 再 `layout_main_webviews`」，
/// 靠的就是「返回时标志已经置位」，否则 layout 会抢先把侧栏挪回目标位。
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
    // 注意这里只投递一次「尺寸 + 位置」就收工 —— 不启动线程。
    let too_short = (to_x - from_x).abs() < 1.0;
    if !system_animations_enabled() || too_short {
        // 仍然要**接管**：万一还有旧动画在飞（例如用户刚点了关闭、系统又关了动画效果），
        // 它会继续逐帧改位置，把刚摆好的终点覆盖掉。
        // `cancel()` 会掐掉旧线程并释放几何独占权，让调用方的 layout 能正常收尾。
        cancel();
        apply_ops(app, label, &frame_ops(true, true, to_x, y, width, height));
        on_done(app);
        return false;
    }

    let my_generation = ANIM_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    // ⚠️ 必须在调用方线程上**同步**置位（不能等到动画线程里再置）：
    // 调用方返回后会立刻调 `layout_main_webviews`，那时独占权必须已经生效。
    ANIM_OWNER.store(my_generation, Ordering::SeqCst);

    let app = app.clone();

    std::thread::spawn(move || {
        // 把 Windows 的定时器粒度压到 1ms，让 15ms 的睡眠更接近真的 15ms。
        // RAII：本线程无论从哪条路径 return，都会配对 timeEndPeriod。
        let _timer = TimerResolution::acquire();

        let started = Instant::now();
        let mut first = true;

        loop {
            // 有更新的动画启动了 / 被 `cancel()` 掐掉了 —— 立刻退出，把位置让出去。
            //
            // ⚠️ 这里**不碰** `ANIM_OWNER`：它要么已被 `cancel()` 清掉，
            // 要么已经属于接管的新动画。也**不调用** `on_done`：被抢占意味着
            // 「有新的开/关动作接管了」，此时再执行旧动作的收尾（例如 hide 侧栏）
            // 会把新动画刚打开的东西关掉。
            if ANIM_GENERATION.load(Ordering::SeqCst) != my_generation {
                return;
            }

            // 每帧**重新读时钟**（而不是把 15ms 累加）：即使某帧睡过头，
            // 位置也仍然精确对应真实经过的时间，不会越滑越慢、终点也不会对不上。
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            let last = elapsed_ms >= SLIDE_MS as f64;
            let x = if last {
                // 收尾：确保精确落在终点（浮点误差不该留下半个像素）。
                to_x
            } else {
                x_at(elapsed_ms, from_x, to_x, SLIDE_MS as f64)
            };

            apply_ops(&app, label, &frame_ops(first, last, x, y, width, height));

            if last {
                // 正常放完 ⇒ 释放几何独占权，layout 从下一帧起重新说了算。
                // 用 CAS：只有「独占者仍然是我」才清得掉，
                // 不会把这两步之间刚起跑的新动画的独占权误清（见 ANIM_OWNER）。
                release(my_generation);
                on_done(&app);
                return;
            }

            first = false;
            std::thread::sleep(Duration::from_millis(FRAME_MS));
        }
    });

    true
}

/// 把一帧的操作序列真正写进子 webview。
///
/// 单独一个函数，既让 [`slide_x_with`] 的主循环好读，
/// 也让「每帧到底调了什么」有一个唯一的落地点（要换实现只改这里）。
fn apply_ops<R: Runtime>(app: &AppHandle<R>, label: &str, ops: &[Op]) {
    let Some(webview) = app.get_webview(label) else {
        return;
    };
    for op in ops {
        match *op {
            Op::SetPosition { x, y } => {
                let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
            }
            Op::SetSize { w, h } => {
                let _ = webview.set_size(tauri::LogicalSize::new(w, h));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 触碰全局状态（[`ANIM_GENERATION`] / [`ANIM_OWNER`]）的测试必须串行。
    ///
    /// Rust 默认并行跑测试，而这两个 static 是进程级的：
    /// 并行时「A 测试 `cancel()`」会把「B 测试刚设的 `ANIM_OWNER`」清掉，测试就会随机失败。
    /// 所有会改这两个 static 的测试都先拿这把锁。
    static GLOBAL_STATE_LOCK: Mutex<()> = Mutex::new(());

    fn lock_globals() -> std::sync::MutexGuard<'static, ()> {
        // 某个测试 panic 时锁会中毒；这里恢复内部值即可，测试本身仍会如实失败。
        GLOBAL_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

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

    /* ------------------------------------------------ 每帧调用序列（核心不变量） */

    /// 用假时间戳跑完一整段动画，收集每帧的操作序列。
    ///
    /// 和 `slide_x_with` 的主循环同构（同样的 `frame_ops` 调用方式），
    /// 但**不碰线程、不碰 webview**，所以可以在 Linux 上稳定断言。
    fn simulate(from_x: f64, to_x: f64, frame_ms: u64, duration_ms: u64) -> Vec<Vec<Op>> {
        let (y, w, h) = (40.0, 420.0, 760.0);
        let mut frames = Vec::new();
        let mut first = true;
        let mut elapsed_ms: u64 = 0;

        loop {
            let last = elapsed_ms >= duration_ms;
            let x = if last {
                to_x
            } else {
                x_at(elapsed_ms as f64, from_x, to_x, duration_ms as f64)
            };
            frames.push(frame_ops(first, last, x, y, w, h));
            if last {
                return frames;
            }
            first = false;
            elapsed_ms += frame_ms;
        }
    }

    /// **核心不变量**：动画期间**只有首帧和末帧**会改尺寸，中间帧只改位置。
    ///
    /// 尺寸没变时调 `set_size` 会走 `set_bounds` → `controller.SetBounds`，
    /// 把**同一个 `RECT` 再传一遍**（`SetBounds` 的 `left`/`top` 恒为 0，只传尺寸）。
    /// 位置本身由 `SetWindowPos` 施加，所以这一次 `set_size` 是纯粹的重复开销：
    /// 多一次主线程 IPC 投递 + 多一次同参数跨进程调用。
    #[test]
    fn animation_never_resizes_between_first_and_last_frame() {
        for (from_x, to_x, name) in [
            (780.0, 1200.0, "打开：滑出右侧"),
            (1200.0, 780.0, "关闭：滑回右侧"),
        ] {
            let frames = simulate(from_x, to_x, FRAME_MS, SLIDE_MS);
            assert!(
                frames.len() >= 8,
                "{name}：帧数太少（{}），动画会看起来一跳一跳",
                frames.len()
            );

            for (i, ops) in frames.iter().enumerate() {
                let is_edge = i == 0 || i == frames.len() - 1;
                let resizes = ops
                    .iter()
                    .filter(|op| matches!(op, Op::SetSize { .. }))
                    .count();
                let moves = ops
                    .iter()
                    .filter(|op| matches!(op, Op::SetPosition { .. }))
                    .count();

                assert_eq!(moves, 1, "{name}：第 {i} 帧必须恰好投递 1 次位置");
                if is_edge {
                    assert_eq!(
                        resizes, 1,
                        "{name}：第 {i} 帧是边缘帧，应当设一次尺寸"
                    );
                } else {
                    assert_eq!(
                        resizes, 0,
                        "{name}：第 {i} 帧是中间帧，**绝不能**调 set_size \
                         （尺寸没变时它只是把同一个 RECT 重复传一遍，\
                         多一次主线程投递 + 一次跨进程 SetBounds）。实际操作：{ops:?}"
                    );
                }
            }
        }
    }

    /// 整段动画的调用总数必须真的下降（v0.3.0 是每帧 2 次，改后中间帧 1 次）。
    ///
    /// 这条是「改前 / 改后」的量化对比，锁死在测试里防止有人改回去。
    #[test]
    fn per_frame_call_count_drops_versus_v0_3_0() {
        let frames = simulate(780.0, 1200.0, FRAME_MS, SLIDE_MS);
        let new_calls: usize = frames.iter().map(|ops| ops.len()).sum();
        // v0.3.0 的实现：每帧无条件 `set_position` + `set_size`。
        let old_calls = frames.len() * 2;

        assert_eq!(
            new_calls,
            frames.len() + 2,
            "应为「每帧 1 次位置 + 首末各 1 次尺寸」"
        );
        assert!(
            new_calls < old_calls,
            "改后调用数（{new_calls}）必须少于 v0.3.0（{old_calls}）"
        );
        // 实测：13 帧时 26 → 15，省掉 11 次重复的 set_size。
        assert_eq!(
            old_calls - new_calls,
            frames.len() - 2,
            "省下的应当正好是「中间帧的 set_size」"
        );
    }

    /// **时间戳驱动**：即使某帧睡过头（Windows 定时器粒度会让 15ms 变成 15~31ms），
    /// 位置也必须仍然对应**真实经过的时间**，而且终点绝不能漂移。
    ///
    /// 这条防的是「把 15ms 累加当时间用」的写法 —— 那样每帧的误差会累积，
    /// 动画越滑越慢、总时长被拉长（看起来就是「卡」）。
    #[test]
    fn irregular_frame_intervals_still_land_on_target() {
        let (from_x, to_x, duration) = (780.0, 1200.0, SLIDE_MS as f64);
        // 故意用抖动很大的帧间隔：15ms 名义值在 Windows 上可能是 15~31ms，
        // 这里连 4 倍都放进去，确保逻辑不依赖「睡眠一定准时」。
        let jittery = [15_u64, 31, 15, 16, 30, 15, 15, 32, 15, 15, 31, 15, 15];
        let mut elapsed_ms = 0_u64;
        let mut xs = Vec::new();

        for ms in jittery {
            let last = elapsed_ms >= SLIDE_MS;
            let x = if last {
                to_x
            } else {
                x_at(elapsed_ms as f64, from_x, to_x, duration)
            };
            xs.push(x);
            if last {
                break;
            }
            elapsed_ms += ms;
        }

        // 无论抖动多大，都必须**到达**终点（末帧精确等于 to_x）。
        assert_eq!(
            *xs.last().unwrap(),
            to_x,
            "抖动帧间隔下末帧仍必须精确落在终点"
        );
        // 单调不减，且始终在区间内 —— 抖动不能造成位置回退或越界。
        let mut prev = f64::NEG_INFINITY;
        for (i, x) in xs.iter().enumerate() {
            assert!(*x >= prev, "第 {i} 帧位置回退：{x} < {prev}");
            assert!(
                (from_x..=to_x).contains(x),
                "第 {i} 帧位置越界：{x}"
            );
            prev = *x;
        }
    }

    /// **时间戳驱动 vs 累加驱动**：证明我们选的写法不会因睡眠抖动而漂移。
    ///
    /// 这条是实打实的对照实验，不是同义反复：
    /// - 「累加驱动」（错误写法）假设每次 `sleep(FRAME_MS)` 真的睡了 `FRAME_MS`，
    ///   于是把帧号 × 15ms 当成已播放时间；
    /// - 「时间戳驱动」（我们的写法）每帧重新读真实经过时间。
    ///
    /// 在**规律**的 15ms 下两者一致；一旦抖动（Windows 上 15ms 会睡成 31ms），
    /// 累加驱动就会把动画**拉长**（真实耗时 360ms 却以为只过了 180ms），
    /// 这正是「越滑越慢 / 卡」的观感来源。时间戳驱动则不受影响。
    #[test]
    fn timestamp_driven_does_not_drift_under_jitter_but_accumulating_does() {
        let (from_x, to_x) = (780.0, 1200.0);
        let duration = SLIDE_MS as f64;
        // 每次名义 15ms，实际都睡成 31ms —— Windows 定时器粒度下完全可能。
        let real_frame_ms = 31_u64;

        // --- 时间戳驱动（我们）：按真实经过时间算 ---
        let mut real_elapsed = 0_u64;
        let mut timestamp_frames = 0_usize;
        while real_elapsed < SLIDE_MS {
            real_elapsed += real_frame_ms;
            timestamp_frames += 1;
        }
        let timestamp_wall_ms = timestamp_frames as u64 * real_frame_ms;

        // --- 累加驱动（错误写法）：按帧号 × 15ms 算 ---
        let mut accum_frames = 0_usize;
        while accum_frames as u64 * FRAME_MS < SLIDE_MS {
            accum_frames += 1;
        }
        let accum_wall_ms = accum_frames as u64 * real_frame_ms;

        // 时间戳驱动：真实耗时 ≈ 180ms（+最后一帧），不会把动画拉长一倍。
        assert!(
            timestamp_wall_ms <= SLIDE_MS + real_frame_ms,
            "时间戳驱动应在 ~{SLIDE_MS}ms 内结束，实际 {timestamp_wall_ms}ms"
        );
        // 累加驱动：同样跑完，但真实耗时被拉到接近两倍 —— 这就是「卡」的量化来源。
        assert!(
            accum_wall_ms >= 2 * SLIDE_MS,
            "累加驱动在 31ms 抖动下真实耗时应被拉长到 ≥{}ms，实际 {accum_wall_ms}ms",
            2 * SLIDE_MS
        );

        // 同一个**真实时刻**下，两种写法算出的位置差多少。
        //
        // 取 62ms 真实时间 = 2 帧 × 31ms：此时两者都还没走到终点（不会双双被夹到 to_x，
        // 那样比较就没有意义了）。
        let wall_ms = 2 * real_frame_ms; // 62ms
        let accumulate_thinks_ms = (wall_ms / real_frame_ms) * FRAME_MS; // 2 × 15 = 30ms
        assert!(
            accumulate_thinks_ms < SLIDE_MS && wall_ms < SLIDE_MS,
            "取样点必须未饱和：accum={accumulate_thinks_ms} wall={wall_ms}"
        );

        let x_accum_thinks = x_at(accumulate_thinks_ms as f64, from_x, to_x, duration);
        let x_actually_should_be = x_at(wall_ms as f64, from_x, to_x, duration);
        assert!(
            x_actually_should_be > x_accum_thinks,
            "累加驱动会把位置算得落后于真实进度（{x_accum_thinks} vs {x_actually_should_be}）"
        );
    }

    /// 末帧的位置必须**精确**等于终点 —— 动画结束不能留下半像素误差。
    #[test]
    fn final_frame_lands_exactly_on_target() {
        for (from_x, to_x) in [(780.0, 1200.0), (1200.0, 780.0), (0.0, 419.0)] {
            let frames = simulate(from_x, to_x, FRAME_MS, SLIDE_MS);
            let last_ops = frames.last().expect("至少有一帧");
            let x = last_ops
                .iter()
                .find_map(|op| match *op {
                    Op::SetPosition { x, .. } => Some(x),
                    _ => None,
                })
                .expect("末帧必须设置位置");
            assert_eq!(x, to_x, "末帧位置必须精确等于终点（from={from_x}）");
        }
    }

    /// 只够放一帧时（时长极短）不能重复投递尺寸。
    #[test]
    fn single_frame_animation_resizes_only_once() {
        let ops = frame_ops(true, true, 100.0, 40.0, 420.0, 760.0);
        assert_eq!(
            ops.iter()
                .filter(|op| matches!(op, Op::SetSize { .. }))
                .count(),
            1,
            "首帧即末帧时只该设一次尺寸：{ops:?}"
        );
        assert_eq!(ops.len(), 2);
    }

    /// 操作顺序必须是「先尺寸、后位置」：位置要落在**最终尺寸**的坐标系里。
    #[test]
    fn size_is_applied_before_position() {
        let ops = frame_ops(true, false, 10.0, 40.0, 420.0, 760.0);
        assert_eq!(ops.len(), 2);
        assert!(matches!(ops[0], Op::SetSize { .. }), "第一项应为尺寸");
        assert!(matches!(ops[1], Op::SetPosition { .. }), "第二项应为位置");
    }

    /* -------------------------------------------------------- 几何所有权（ANIM_OWNER） */

    /// 代次机制：`cancel()` 之后，旧动画应当能察觉自己被取代。
    ///
    /// 这里直接验证代次语义（不启线程，避免测试不稳定）。
    #[test]
    fn cancel_bumps_generation_so_old_animation_gives_up() {
        let _guard = lock_globals();
        let before = ANIM_GENERATION.load(Ordering::SeqCst);
        cancel();
        let after = ANIM_GENERATION.load(Ordering::SeqCst);
        assert_ne!(before, after, "cancel() 必须改变代次，旧动画才会退出");
    }

    /// `cancel()` 必须**释放侧栏几何的独占权**。
    ///
    /// 否则一旦动画被取消（窗口缩放、收进托盘），独占权会永远留着，
    /// `layout_main_webviews` 从此再也不摆放侧栏 —— 侧栏会卡在错误的位置。
    #[test]
    fn cancel_releases_geometry_ownership() {
        let _guard = lock_globals();
        ANIM_OWNER.store(7, Ordering::SeqCst);
        assert!(is_animating(), "前置条件：应当有人独占");
        cancel();
        assert!(
            !is_animating(),
            "cancel() 必须释放独占权，否则 layout 再也不会摆放侧栏"
        );
    }

    /// 没有动画时 `is_animating()` 必须是 `false`（否则 layout 永远不摆侧栏）。
    #[test]
    fn idle_state_is_not_animating() {
        let _guard = lock_globals();
        cancel();
        assert!(!is_animating(), "取消后必须处于「无动画」状态");
    }

    /// **竞态回归**：旧动画放完时**不能**清掉新动画刚取得的独占权。
    ///
    /// 这正是 [`ANIM_OWNER`] 存代次而非 `bool` 的原因。用 `bool` 的写法是
    /// 「先判断代次还是我 → 再 `store(false)`」，两步之间新动画可能已经置位，
    /// 于是旧动画把新动画的独占权清掉 ⇒ 新动画期间 layout 又开始抢侧栏。
    ///
    /// [`release`] 用 CAS 把「检查 + 清除」合成一步，所以旧代次清不掉新代次。
    #[test]
    fn stale_animation_cannot_release_newer_ownership() {
        let _guard = lock_globals();
        cancel();
        // 模拟：新动画 B 起跑并取得独占权。
        let gen_b = ANIM_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        ANIM_OWNER.store(gen_b, Ordering::SeqCst);
        // 模拟：旧动画 A（更小的代次）在此时走到收尾，试图释放。
        release(gen_b - 1);
        assert!(
            is_animating(),
            "旧动画不得清掉新动画的独占权（否则 B 期间 layout 会抢走侧栏）"
        );
        // 而 B 自己释放时应当成功。
        release(gen_b);
        assert!(!is_animating(), "独占者自己应当能正常释放");
    }

    /// `release` 对**当前独占者**必须有效（否则动画结束后 layout 永不接管）。
    #[test]
    fn owner_release_is_effective() {
        let _guard = lock_globals();
        cancel();
        let gen = ANIM_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        ANIM_OWNER.store(gen, Ordering::SeqCst);
        release(gen);
        assert!(!is_animating(), "独占者释放后必须变为「无动画」");
    }
}

