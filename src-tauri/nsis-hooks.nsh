; DSHTauri —— NSIS 安装器钩子
;
; 由 `src-tauri/tauri.conf.json` 的 `bundle.windows.nsis.installerHooks` 引入。
; Tauri 会在 installer.nsi 的**顶部**（`!include MUI2.nsh` 之后、各页面 `!insertmacro`
; 之前）`!include` 本文件，所以在这里 `!define` 能影响到后面插入的页面。

; ---------------------------------------------------------------- 桌面快捷方式
;
; 需求：「安装时默认**不勾选**创建快捷方式」。
;
; Tauri 的 NSIS 模板把「创建桌面快捷方式」做成了完成页上的一个复选框 —— 它复用的是
; MUI2 的 `MUI_FINISHPAGE_SHOWREADME` 机制（见模板里 `CreateOrUpdateDesktopShortcut`）：
;
;   !define MUI_FINISHPAGE_SHOWREADME
;   !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
;   !define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
;
; 而 MUI2 的 `SHOWREADME` 复选框**默认是勾选的**。官方提供的关闭默认勾选的开关就是
; `MUI_FINISHPAGE_SHOWREADME_NOTCHECKED`（NSIS MUI2 文档：
; 「If defined, the show readme checkbox will not be checked by default」）。
;
; 所以这里只需定义它。效果：
;   · 图形化安装：完成页的「创建桌面快捷方式」**默认不勾选**，用户想创建可以自己勾；
;   · 静默 / 被动安装（/S、/P）：模板会无条件调用 CreateOrUpdateDesktopShortcut，
;     也就是照旧创建 —— 这是打包脚本的行为，保持不变（CI 的冒烟/发布流程依赖它）。
;
; 注意：这个 `!define` 必须在 `!insertmacro MUI_PAGE_FINISH` **之前**出现，
; 而本文件正是在那之前被 include 的，所以位置天然正确。
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
