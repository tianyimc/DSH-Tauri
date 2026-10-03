//! WebView2「挂起」（休眠）—— 不可见的 webview 省内存。
//!
//! # 为什么需要
//!
//! 我们的每个 webview（选择窗口、顶栏、内容页、对话侧栏）在关闭时都只是
//! `hide()`，**从不销毁**。隐藏之后 renderer 仍然占着完整的 JS 堆与 DOM，
//! 而用户实测「平时非活动 350–450MB、开对话 500–600MB」。
//!
//! WebView2 官方为此提供了 `ICoreWebView2_3::TrySuspend`，语义等价于
//! **Edge 的「标签页休眠」**：
//!
//! - *"Suspending pauses WebView script timers and animations, minimizes CPU usage
//!   for the associated browser renderer process and allows the operating system to
//!   reuse the memory that was used by the renderer process"*
//! - *"All WebView APIs can still be accessed when a WebView is suspended."*
//! - *"The WebView will be automatically resumed when it becomes visible."*
//!
//! 关键：挂起**不是**重新加载、**不是**导航 —— DOM 与输入框内容都留在内存里，
//! 只是把这块内存标记为「系统可回收」。所以「用户没发出去的草稿」不会丢。
//!
//! # 两个必须遵守的约束（都是实测/文档得来的，违反会静默失效）
//!
//! 1. **`CoreWebView2Controller::IsVisible` 必须为 `false`**，否则
//!    `TrySuspend` 直接返回 `HRESULT_FROM_WIN32(ERROR_INVALID_STATE)`。
//!    - 子 webview（`Webview`）的 `hide()` **恰好**会走到
//!      `controller.SetIsVisible(false)`（见 `tauri-runtime-wry` 的
//!      `WebviewMessage::Hide` → `webview.set_visible(false)`），所以
//!      「关侧栏后挂起 chat」是顺的。
//!    - 但 `WebviewWindow::hide()`（选择/关于/设置）与 `Window::hide()`
//!      （主窗口收托盘）**只隐藏 HWND，不碰 controller** —— 收托盘时子 webview
//!      的 controller 仍认为可见。所以那条路径必须先显式
//!      [`set_controller_visible`]`(false)`。
//!
//! 2. **挂起是异步且「尽力而为」的**。完成回调可能返回 `isSuccessful = false`
//!    （被 Sleeping Tabs 的条件阻止）。这不是错误，只是没省到内存，功能不受影响。
//!
//! # 代次（generation）—— 防止「挂起追着恢复跑」
//!
//! `TrySuspend` 的完成回调是异步的。用户可能「关掉侧栏后立刻又打开」，此时
//! 一个还在飞的挂起回调若直接认账，就会把刚恢复的侧栏又标记成挂起。
//! 所以每次 `suspend`/`resume` 都递增代次，回调只在**代次未变**时才认账；
//! 若代次已变（说明期间有人调了 `resume`），回调会主动补一次 `Resume`。
//!
//! 这与 `anim.rs` 里 `ANIM_GENERATION` / `should_run_on_done` 是同一套思路。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// 一个 webview 的挂起状态。
///
/// 用「代次 + 挂起标志」两个原子量表达，纯逻辑、可在非 Windows 上单测
/// （见本文件末尾的测试）。
#[derive(Debug)]
pub struct SuspendSlot {
    /// 每次 `suspend`/`resume` 请求都 +1。
    generation: AtomicU64,
    /// 我们**认为**该 webview 当前处于挂起态。
    ///
    /// 注意语义：这是「我们请求过挂起、且回调确认成功、且期间没有 resume」
    /// 的结果，不是实时去问 COM。用它来跳过 cookie 持久化是安全的：
    /// 真挂起时不该去打扰它；万一没挂成，代价也只是少跑一轮持久化
    /// （上一轮 20 秒内已经写过 cookie）。
    suspended: AtomicBool,
}

impl SuspendSlot {
    const fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            suspended: AtomicBool::new(false),
        }
    }

    /// 记一次「请求挂起」，返回本次请求的代次。
    pub fn begin_suspend(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// 记一次「请求恢复」，返回本次请求的代次。
    pub fn begin_resume(&self) -> u64 {
        self.suspended.store(false, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// 挂起回调回来时调用：只有**代次仍是自己那一次**且成功时才认账。
    ///
    /// 返回 `true` 表示已记为挂起；返回 `false` 表示期间有人调了 `resume`
    /// （调用方应当补一次 `Resume`，因为挂起可能已经生效）。
    pub fn confirm_suspend(&self, my_generation: u64, is_successful: bool) -> bool {
        if self.generation.load(Ordering::Acquire) != my_generation {
            return false; // 期间被 resume 了 —— 不要认账
        }
        if is_successful {
            self.suspended.store(true, Ordering::Release);
        }
        true
    }

    pub fn is_suspended(&self) -> bool {
        self.suspended.load(Ordering::Acquire)
    }
}

/// 对话侧栏的挂起状态。
pub static CHAT_SUSPEND: SuspendSlot = SuspendSlot::new();
/// 内容页的挂起状态（收托盘时挂起）。
pub static CONTENT_SUSPEND: SuspendSlot = SuspendSlot::new();

// ===========================================================================
// Windows 实现
// ===========================================================================

#[cfg(windows)]
mod imp {
    use super::SuspendSlot;
    use tauri::Runtime;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_3, ICoreWebView2Controller,
    };
    use webview2_com::TrySuspendCompletedHandler;
    use windows_core::{Interface, BOOL};

    /// 取该 webview 的 `ICoreWebView2Controller`，并在闭包里回调。
    ///
    /// `with_webview` 是**非阻塞**的（内部 `send_user_message` 投递到事件循环），
    /// 所以从异步命令、事件处理器、后台线程调用都安全 —— 不会像 `add_child`
    /// 那样（`run_on_main_thread` + `recv()`）在主线程上死锁。
    fn with_controller<R: Runtime, F>(webview: &tauri::Webview<R>, f: F)
    where
        F: FnOnce(ICoreWebView2Controller) + Send + 'static,
    {
        let _ = webview.with_webview(move |platform| {
            f(platform.controller());
        });
    }

    /// 取 `ICoreWebView2_3`（`TrySuspend`/`Resume`/`IsSuspended` 所在的接口）。
    ///
    /// 该接口自 WebView2 运行时 **1.0.774.44** 起可用；`cast()` 在更旧的运行时上
    /// 会失败，此时我们静默放弃（只是没省到内存，功能不受影响）。
    fn core3(controller: &ICoreWebView2Controller) -> Option<ICoreWebView2_3> {
        let core = unsafe { controller.CoreWebView2() }.ok()?;
        core.cast::<ICoreWebView2_3>().ok()
    }

    /// 挂起一个 webview。**非阻塞、幂等、失败只记录**。
    ///
    /// 前置条件：controller 的 `IsVisible` 必须已经是 `false`（见模块文档）。
    pub fn suspend<R: Runtime>(webview: &tauri::Webview<R>, slot: &'static SuspendSlot) {
        if slot.is_suspended() {
            return; // 幂等：已经在挂起态，不重复请求
        }
        let my_generation = slot.begin_suspend();
        let _ = webview.with_webview(move |platform| {
            let controller = platform.controller();
            let Some(core3) = core3(&controller) else {
                eprintln!("[DSHTauri] 挂起跳过：当前 WebView2 运行时不支持 ICoreWebView2_3");
                return;
            };
            // 先问一次实时状态：若已经是挂起态就什么都不做。
            let mut already = BOOL(0);
            if unsafe { core3.IsSuspended(&mut already) }.is_ok() && already.as_bool() {
                // 与我们的记账对齐（可能上次回调丢过）。
                let _ = slot.confirm_suspend(my_generation, true);
                return;
            }
            let handler = TrySuspendCompletedHandler::create(Box::new(
                move |result: windows_core::Result<()>, is_successful: bool| {
                    match result {
                        Ok(()) if is_successful => {
                            let _ = slot.confirm_suspend(my_generation, true);
                        }
                        Ok(()) => {
                            // 文档：可能被 Sleeping Tabs 的条件阻止，此时 errorCode 为
                            // S_OK 但 isSuccessful = false。不是错误，只是没省到内存。
                            let _ = slot.confirm_suspend(my_generation, false);
                            eprintln!("[DSHTauri] 挂起未生效（被系统策略阻止），功能不受影响");
                        }
                        Err(err) => {
                            let _ = slot.confirm_suspend(my_generation, false);
                            eprintln!("[DSHTauri] 挂起失败：{err}");
                        }
                    }
                    Ok(())
                },
            ));
            if let Err(err) = unsafe { core3.TrySuspend(&handler) } {
                // 最常见的原因是 controller 仍可见（ERROR_INVALID_STATE）。
                let _ = slot.confirm_suspend(my_generation, false);
                eprintln!("[DSHTauri] TrySuspend 调用失败（controller 可能仍可见）：{err}");
            }
        });
    }

    /// 恢复一个 webview。**非阻塞、幂等**。
    ///
    /// 即使 `show()` 会按文档自动恢复，我们也显式调一次：
    /// 一是更确定，二是让页面**立刻**开始跑（自动恢复要等它变可见那一刻）。
    pub fn resume<R: Runtime>(webview: &tauri::Webview<R>, slot: &'static SuspendSlot) {
        let my_generation = slot.begin_resume();
        let _ = my_generation; // 代次已递增，足以让在飞的挂起回调不认账
        let _ = webview.with_webview(move |platform| {
            let controller = platform.controller();
            let Some(core3) = core3(&controller) else {
                return;
            };
            let mut is_suspended = BOOL(0);
            let suspended =
                unsafe { core3.IsSuspended(&mut is_suspended) }.is_ok() && is_suspended.as_bool();
            if suspended {
                if let Err(err) = unsafe { core3.Resume() } {
                    eprintln!("[DSHTauri] Resume 失败：{err}");
                }
            }
        });
    }

    /// 显式设置 controller 的可见性。
    ///
    /// 收托盘时 `Window::hide()` 只隐藏 HWND，子 webview 的 controller 仍认为可见，
    /// 于是 `TrySuspend` 会因 `ERROR_INVALID_STATE` 失败 —— 必须先调这个。
    pub fn set_controller_visible<R: Runtime>(webview: &tauri::Webview<R>, visible: bool) {
        with_controller(webview, move |controller| {
            if let Err(err) = unsafe { controller.SetIsVisible(visible) } {
                eprintln!("[DSHTauri] 设置 webview 可见性失败：{err}");
            }
        });
    }

    /// 同步查询是否处于挂起态。
    ///
    /// ⚠️ 只给**非主线程**用（内部会阻塞等主线程回结果）。
    /// 目前只有 cookie 保活线程需要它，而那是独立后台线程，安全。
    pub fn is_suspended_blocking<R: Runtime>(webview: &tauri::Webview<R>) -> Option<bool> {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = webview.with_webview(move |platform| {
            let controller = platform.controller();
            let value = core3(&controller).and_then(|core3| {
                let mut out = BOOL(0);
                unsafe { core3.IsSuspended(&mut out) }.ok().map(|_| out.as_bool())
            });
            let _ = tx.send(value);
        });
        // 超时兜底：万一事件循环正忙，不要让保活线程卡死。
        rx.recv_timeout(std::time::Duration::from_millis(500))
            .ok()
            .flatten()
    }
}

// ===========================================================================
// 非 Windows：全部空实现，保证 Linux 上 `cargo test` / `cargo check` 能过
// ===========================================================================

#[cfg(not(windows))]
mod imp {
    use super::SuspendSlot;
    use tauri::Runtime;

    pub fn suspend<R: Runtime>(_webview: &tauri::Webview<R>, _slot: &'static SuspendSlot) {}
    pub fn resume<R: Runtime>(_webview: &tauri::Webview<R>, _slot: &'static SuspendSlot) {}
    pub fn set_controller_visible<R: Runtime>(_webview: &tauri::Webview<R>, _visible: bool) {}
    pub fn is_suspended_blocking<R: Runtime>(_webview: &tauri::Webview<R>) -> Option<bool> {
        None
    }
}

pub use imp::{is_suspended_blocking, resume, set_controller_visible, suspend};

/// cookie 保活是否应当**跳过**这个 webview。
///
/// 为什么要跳过：官方文档明确警告 ——
/// *"Some APIs like Navigate will auto resume the WebView. To avoid unexpected
/// auto resume, check IsSuspended property before calling APIs that might change
/// WebView state."*
///
/// 我们的 cookie 保活线程每 20 秒会遍历内容页与侧栏调 `GetCookies`。若在挂起态
/// 还去调它，可能把 webview **唤醒**，于是挂起每 20 秒失效一次、白做。
///
/// 跳过是安全的：这些页面在**可见期间**已经每 20 秒持久化过一轮，
/// 关闭前的登录态不会因为跳过而丢失。
pub fn should_skip_cookie_persist(slot: &SuspendSlot) -> bool {
    slot.is_suspended()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suspend_slot_starts_clean() {
        let slot = SuspendSlot::new();
        assert!(!slot.is_suspended());
    }

    #[test]
    fn confirm_suspend_records_only_when_generation_matches() {
        let slot = SuspendSlot::new();
        let gen = slot.begin_suspend();
        assert!(slot.confirm_suspend(gen, true));
        assert!(slot.is_suspended());
    }

    #[test]
    fn confirm_suspend_failure_does_not_mark_suspended() {
        let slot = SuspendSlot::new();
        let gen = slot.begin_suspend();
        assert!(slot.confirm_suspend(gen, false));
        assert!(!slot.is_suspended(), "未成功就不该记为挂起");
    }

    /// 核心竞态：关侧栏（挂起在飞）→ 立刻打开侧栏（resume）
    /// ⇒ 迟到的挂起回调**不得**把状态改回挂起，且要告诉调用方补一次 Resume。
    #[test]
    fn stale_suspend_callback_is_rejected_after_resume() {
        let slot = SuspendSlot::new();
        let gen = slot.begin_suspend();
        slot.begin_resume(); // 用户立刻又打开了侧栏
        let accepted = slot.confirm_suspend(gen, true);
        assert!(!accepted, "代次已变，迟到的挂起回调必须被拒绝");
        assert!(!slot.is_suspended(), "侧栏已恢复，不能被标记成挂起");
    }

    #[test]
    fn resume_clears_suspended_flag() {
        let slot = SuspendSlot::new();
        let gen = slot.begin_suspend();
        assert!(slot.confirm_suspend(gen, true));
        assert!(slot.is_suspended());
        slot.begin_resume();
        assert!(!slot.is_suspended());
    }

    /// 幂等性：连续两次 suspend 请求，只有后一次的代次有效。
    #[test]
    fn repeated_suspend_only_latest_generation_counts() {
        let slot = SuspendSlot::new();
        let first = slot.begin_suspend();
        let second = slot.begin_suspend();
        assert!(!slot.confirm_suspend(first, true), "旧代次不该认账");
        assert!(!slot.is_suspended());
        assert!(slot.confirm_suspend(second, true));
        assert!(slot.is_suspended());
    }

    /// cookie 保活在挂起时必须跳过（否则每 20 秒唤醒一次，挂起白做）。
    #[test]
    fn cookie_persist_is_skipped_while_suspended() {
        let slot = SuspendSlot::new();
        assert!(!should_skip_cookie_persist(&slot));
        let gen = slot.begin_suspend();
        assert!(slot.confirm_suspend(gen, true));
        assert!(should_skip_cookie_persist(&slot), "挂起期间必须跳过 cookie 保活");
        slot.begin_resume();
        assert!(!should_skip_cookie_persist(&slot));
    }

    /// 静态槽位初值必须是「未挂起」—— 否则启动就会跳过 cookie 保活。
    #[test]
    fn static_slots_start_unsuspended() {
        assert!(!CHAT_SUSPEND.is_suspended());
        assert!(!CONTENT_SUSPEND.is_suspended());
    }
}
