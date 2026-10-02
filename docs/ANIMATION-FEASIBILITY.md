# 任务 1：网页对话开/关的过渡动画

**最终结论：已实现（方案见下），但只对 `overlay` 模式做逐帧滑动；
`docked` 模式刻意不做滑动。** 框架确实没有动画能力，所以是自己逐帧插值实现的。

---

## 为什么框架层面没有现成能力

DSHTauri 的「网页对话」是一个**子 webview**（`chat`，label `chat`），
它的位置/尺寸由 Rust 通过 Tauri 的 `Webview::set_position` / `set_size` 设置。

调用链（都在本仓库锁定版本里查证）：

1. `tauri::Webview::set_bounds/set_size/set_position`
   → `tauri-runtime-wry` 的 `WebviewDispatcher::set_size`
   → 往事件循环投递 `WebviewMessage::SetSize`（`send_user_message`，异步投递，无动画概念）。
2. `wry` 的 Windows 实现（`wry-0.57.0/src/webview2/mod.rs:1539`）最终是：

```rust
SetWindowPos(
  self.hwnd, None,
  position.x, position.y, size.width, size.height,
  SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
)?;
```

`SetWindowPos` 是**瞬时生效**的 Win32 API，**没有任何动画参数**。
（`AnimateWindow` 是另一个 API，只能做整窗口的淡入/滑动，且**不能**用于 WebView2 这类
子 HWND —— WebView2 是 DirectComposition 合成，`AnimateWindow` 对它无效。）

3. **连「只动位置、不改尺寸」这条捷径也没有专门通道**：
   看 `tauri-runtime-wry-2.12.1/src/lib.rs` 的 `WebviewMessage::SetPosition` 分支（3759 行起），
   它把新位置写回 `bounds` 之后调用的仍是 `webview.set_bounds(bounds)` ——
   而 `set_bounds` 在 Windows 上是**一次性 `SetWindowPos` 同时设置位置和尺寸**。
   也就是说 `set_position` 与 `set_size` 最终走同一条路，都会重新 `SetBounds`。

⇒ 框架没有动画能力，**只能自己逐帧调用 `set_position` 插值**。

## 实现（`src-tauri/src/anim.rs`）

- **逐帧插值**：180ms、约 60fps（15ms/帧），ease-out cubic 缓动。
- **动画期间只改 `x`，尺寸全程不变**：这是把「重排成本」压到最低的关键 ——
  尺寸不变时 WebView2 不需要重新布局网页，只是合成层平移。
- **代次（generation）防抢占**：用户快速连点时，旧动画线程会发现自己过期并立即退出，
  不会去改新动画正在改的位置；被抢占的动画**不执行收尾回调**，
  否则「旧的关闭动作」会把「新打开的东西」关掉。
- **尊重 Windows 11 的「动画效果」开关**：
  读 `SPI_GETCLIENTAREAANIMATION`，关闭时**直接跳到终态**（无障碍正确行为）。
- **缩放窗口 / 收进托盘时 `anim::cancel()`**：避免旧动画把侧栏停在错误位置。

### 为什么 `docked` 模式不做滑动

`docked` 模式要求内容页**让出宽度**，这是一次真正的重排。
如果逐帧改宽度，两个 webview 每帧都要重排内容页 ⇒ 必然掉帧、闪烁。
所以 docked 模式下直接切到位（一次重排），只对 overlay 模式做滑动。

| 模式 | 打开/关闭的表现 | 理由 |
|---|---|---|
| `overlay`（默认） | 侧栏从右侧滑入 / 滑出，内容页**整宽不动** | 零重排，动画顺滑 |
| `docked` | 直接并排 / 收起（无滑动） | 躲开逐帧重排 |

## 仍然无法在本机验证的部分

- **实际观感**（滑得顺不顺、180ms 是否合适）只能在 Windows 真机上确认。
  CI 冒烟测试能验证「点网页对话不卡死、子 webview 数量变化」，
  但**看不出流畅度** —— 那需要人眼。
- Linux 上 wry 忽略子 webview 坐标（`docs/VERIFICATION.md` 2.4），
  且子 webview 收不到鼠标点击，所以 Linux 下无法验证动画。

## 未采用的方案（备查）

### 方案 B：本地外壳 + iframe，让「内容」也能有 CSS 过渡
让 `chat` 加载本地 `chat-frame.html`，内部用 `<iframe src="https://chat.deepseek.com/">`，
外层由我们控制，于是可以对外壳做 CSS 过渡、还能自绘侧栏标题栏。

- 风险：`chat.deepseek.com` 可能用 `X-Frame-Options` / CSP `frame-ancestors` 禁止被嵌入，
  那样聊天会**直接不可用**，且对方策略变化时我们会被动损坏。
- **未验证**：本开发容器访问该站超时/403，读不到响应头。
  要用这个方案必须先验证嵌入可行性。
