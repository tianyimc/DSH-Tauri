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

; ---------------------------------------------------------------- 开始菜单图标
;
; 缺陷（v0.3.1 用户实测）：**开始菜单**里的快捷方式图标是旧的「白色圆角方块 + 深色
; 鲸鱼」，不是 v0.3.1 统一的透明鲸鱼。
;
; ## 根因（两层，缺一不可）
;
; 1. Tauri 的 NSIS 模板创建开始菜单快捷方式时**没有传 `IconFile`**：
;
;      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
;
;    少一个参数 ⇒ 快捷方式继承 **exe 内嵌的图标资源**（`32512`，由 tauri-build 从
;    `bundle.icon` 里第一个 `.ico` 写入）。于是「开始菜单显示什么」完全取决于
;    exe 里的资源，无法单独指定。
;
; 2. 更麻烦的是模板的 `CreateOrUpdateStartMenuShortcut` 在**更新模式**下直接返回：
;
;      ${If} $UpdateMode = 1
;        Return
;      ${EndIf}
;
;    也就是说：**覆盖安装永远不会修好已存在的旧快捷方式**。用户升级到 v0.3.1 后，
;    磁盘上那个 `.lnk` 还是更早版本创建的，图标自然还是旧的
;    （这也是为什么「仓库里图标已经统一了、用户看到的却还是旧的」）。
;
; ## 修法
;
; 在 `NSIS_HOOK_POSTINSTALL` 里**无条件**重建这个快捷方式，并显式指定图标：
;
;   · `NSIS_HOOK_POSTINSTALL` 在「复制文件 + 建快捷方式」之后执行，**不受
;     `$UpdateMode` 影响** —— 所以它既能建、也能**修好旧安装**（这是关键：
;     走模板自己的函数做不到）。
;   · 图标用单独打包的 `startmenu.ico`（白鲸鱼 + 细描边）。**不能**复用 `icon.ico`：
;     `.lnk` 的图标是静态的，**不跟随系统深浅色**。深藏青的 `icon.ico` 落在深色
;     开始菜单上几乎看不见；纯白又会在浅色开始菜单上消失。白鲸鱼 + 深色细描边
;     在两种背景上都清晰（双背景可读）。
;   · `startmenu.ico` 由 `tauri.conf.json` 的 `bundle.resources` 打包到
;     `$INSTDIR\icons\startmenu.ico`。
;   · 最后调 `SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH, 0, 0)` 通知 shell
;     刷新图标缓存 —— 否则即使 `.lnk` 已改对，资源管理器仍会显示缓存里的旧图标。
;     这两个常量值与 Tauri 模板自己的 `UPDATEFILEASSOC` 宏完全一致
;     （`SHCNE_ASSOCCHANGED = 0x08000000`、`SHCNF_FLUSH = 0x1000`）。
;
; 注意：这里**不**判断 `$UpdateMode` —— 恰恰要覆盖更新场景。
; 但**要**判断 `$NoShortcutMode`：它表示「用户明确不要开始菜单快捷方式」，
; 此时不该凭空新建。区分两种情况的写法是：
;   · `.lnk` **已存在** ⇒ 无条件重建（这正是修复旧安装图标的路径）；
;   · `.lnk` **不存在** ⇒ 只有用户没要求「不要快捷方式」时才创建
;     （与模板 `CreateOrUpdateStartMenuShortcut` 的正常安装行为一致）。
;
; ## 路径必须与模板保持一致（否则将来设了 `startMenuFolder` 就会失效）
;
; 模板用 `!if "${STARTMENUFOLDER}" != ""` 在**两种**布局间选择：
;   · 设了 `startMenuFolder` ⇒ `$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk`；
;   · 没设 ⇒ 扁平路径 `$SMPROGRAMS\${PRODUCTNAME}.lnk`。
;
; ⚠️ **`$AppStartMenuFolder` 不能直接假设还有值**（独立验证发现的坑）。
;
; 本钩子运行在模板的 `MUI_STARTMENU_WRITE_END` **之后**。而 MUI2 的
; `MUI_PAGE_STARTMENU` 只在**图形化**安装时给该变量赋值；**静默 / 被动安装**
; （`/S`、`/P` —— 正是本项目 CI 与发布流程使用的方式）会 `Skip` 那个页面，
; 变量可能是空的。届时会算出 `$SMPROGRAMS\\${PRODUCTNAME}.lnk`（多一个反斜杠）
; ⇒ 既修不好图标，又在错路径建了重名快捷方式。
;
; 模板**自己**在需要这个值时用的是 `MUI_STARTMENU_GETFOLDER`（**从注册表读回**），
; 而不是依赖变量存活。这里照做 —— 与模板**同源**，且对静默安装同样成立。
;
; 本项目当前**没有**设 `startMenuFolder`（走扁平路径），所以这段目前不会被触发；
; 但它保证「将来启用分组」时不会踩坑。
;
; 注：`MUI_STARTMENU_GETFOLDER` 只在 `!if` 为真时插入 —— 因为该宏读的是
; 「上次写入的文件夹」，未启用分组时注册表里根本没有这个值，读了也没意义。
!macro NSIS_HOOK_POSTINSTALL
  ; 图标文件必须真的被复制到位，否则 `CreateShortcut` 会写一个指向不存在文件的
  ; 图标路径（快捷方式会显示成白纸图标，比旧图标更糟）。
  ${If} ${FileExists} "$INSTDIR\icons\startmenu.ico"
    ; 目标 exe 存在才建（正常安装流程下必然存在，这里只是防御性判断）。
    ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; 按模板的规则算出快捷方式路径，并判断它是否已存在：
      ; 存在 ⇒ 无论 $NoShortcutMode 如何都要修（覆盖安装的旧图标就是这么修好的）；
      ; 不存在 ⇒ 尊重 $NoShortcutMode，不擅自新建。
      !if "${STARTMENUFOLDER}" != ""
        ; 与模板同源：从注册表把开始菜单文件夹读回来，不依赖变量存活。
        !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
        StrCpy $R9 "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      !else
        StrCpy $R9 "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      !endif

      ${If} ${FileExists} "$R9"
        StrCpy $R8 1
      ${Else}
        StrCpy $R8 0
      ${EndIf}

      ${If} $R8 = 1
      ${OrIf} $NoShortcutMode <> 1
        ; 第 4 个参数 = IconFile，第 5 个 = 图标索引（0 = 第一帧，即 256px 那档）。
        ; 重建快捷方式：即使它已存在也会被覆盖成正确图标 ⇒ 顺带修好旧安装。
        ;
        ; 用 `$R9` 作为路径（而不是把 `CreateShortcut` 写两遍），保证
        ; 「判断存在」与「创建」用的是**同一个**路径。
        ; ⚠️ `$R9` / `$R8` 在本模板里**零使用**（`$R0` 用了 45 次），所以是安全的暂存器。
        CreateShortcut "$R9" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\icons\startmenu.ico" 0
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 刷新 shell 图标缓存：不通知的话，资源管理器仍会显示缓存中的旧图标，
  ; 用户会以为「改了但没生效」。
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend
