# DSHTauri — Windows 无头冒烟测试（在 GitHub Actions 的 windows-latest 上跑）
#
# 目的：不用人工在 Win11 上点，就能验证整条链路，并且能抓出「只在 Windows 上暴露」的问题。
#
# 覆盖：
#   A. 首次连接：选择窗口 560x460 → 点击「本地」→ 主窗口出现且不卡死
#                → WebView2 真的发请求（不是白屏）→ WM_CLOSE 隐藏到托盘
#   B. 切换连接：把选择窗口重新叫出来 → 点击「远程」→ **复用同一个主窗口导航**（不是销毁重建）
#   C. 进程生命周期：勾了「自动启动本地服务」时，主程序退出后本地服务必须跟着结束
#
# 判定手段全部基于 Win32（不依赖截图 —— WebView2 走 DirectComposition，PrintWindow 常返回空白）。
#
# 用法：pwsh -File scripts/smoke-windows.ps1 -AppPath <dshtauri.exe>

param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [int]$Port = 3080,      # 本地地址对应的测试服务
  [int]$Port2 = 3081,     # 远程地址对应的测试服务
  [int]$SvcPort = 3099,   # C 段：被自动启动的「本地服务」
  [int]$CookiePort = 3090 # D 段：Cookie 持久化测试服务
)

$ErrorActionPreference = "Stop"
$script:Pass = 0
$script:Fail = 0
$script:Failures = @()

function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
  if ($Ok) { Write-Host "  [PASS] $Name" -ForegroundColor Green; $script:Pass++ }
  else {
    Write-Host "  [FAIL] $Name  $Detail" -ForegroundColor Red
    $script:Fail++
    $script:Failures += ("{0}  {1}" -f $Name, $Detail)
  }
}

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);

  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int max);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  public const uint WM_NULL  = 0x0000;
  public const uint WM_CLOSE = 0x0010;
  public const uint SMTO_ABORTIFHUNG = 0x0002;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP   = 0x0004;
  public const int  SW_SHOWNORMAL = 1;

  public static string Title(IntPtr h) {
    int len = GetWindowTextLengthW(h);
    var sb = new StringBuilder(len + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static IntPtr[] AllTopLevelWindows() {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }

  public static IntPtr[] TopLevelWindows(uint targetPid) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public static int[] ClientSize(IntPtr h) {
    RECT r;
    if (!GetClientRect(h, out r)) return new int[] { 0, 0 };
    return new int[] { r.Right - r.Left, r.Bottom - r.Top };
  }

  public static bool IsResponsive(IntPtr h, uint timeoutMs) {
    IntPtr result;
    IntPtr ok = SendMessageTimeout(h, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, timeoutMs, out result);
    return ok != IntPtr.Zero && !IsHungAppWindow(h);
  }

  public const uint GW_CHILD = 5;
  public const uint GW_HWNDNEXT = 2;

  public static string ClassName(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassNameW(h, sb, sb.Capacity);
    return sb.ToString();
  }

  /// 直接子窗口（Tauri 的 multiwebview 会把每个 webview 做成主窗口的子 HWND）
  public static IntPtr[] DirectChildren(IntPtr parent) {
    var list = new List<IntPtr>();
    IntPtr c = GetWindow(parent, GW_CHILD);
    while (c != IntPtr.Zero) { list.Add(c); c = GetWindow(c, GW_HWNDNEXT); }
    return list.ToArray();
  }

  /// 所有后代窗口（WebView2 内部还会再嵌容器，顶栏/内容可能是更深一层）
  public static IntPtr[] Descendants(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }

  /// 子窗口相对**父窗口客户区**的矩形：{x, y, w, h}
  public static int[] RectInClient(IntPtr parent, IntPtr child) {
    RECT r;
    if (!GetWindowRect(child, out r)) return new int[] { 0, 0, 0, 0 };
    var tl = new POINT { X = r.Left, Y = r.Top };
    ScreenToClient(parent, ref tl);
    return new int[] { tl.X, tl.Y, r.Right - r.Left, r.Bottom - r.Top };
  }

  // 按「客户区坐标」点击，自动换算到屏幕坐标
  public static void ClickClient(IntPtr h, int cx, int cy) {
    var p = new POINT { X = cx, Y = cy };
    ClientToScreen(h, ref p);
    SetCursorPos(p.X, p.Y);
    System.Threading.Thread.Sleep(150);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(70);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }
}
'@

$WORK = Join-Path $env:RUNNER_TEMP "dshtauri-smoke"
New-Item -ItemType Directory -Force -Path $WORK | Out-Null

# 选择 DSH 连接方式 —— 用 Unicode 码点构造，避免脚本文件编码带来的问题
$SELECTOR_TITLE = -join ([char[]]@(0x9009, 0x62E9, 0x20, 0x44, 0x53, 0x48, 0x20, 0x8FDE, 0x63A5, 0x65B9, 0x5F0F))
$MAIN_TITLE = "DSHTauri"

$CONFIG_DIR = Join-Path $env:APPDATA "com.dsh.dshtauri"
$CONFIG_FILE = Join-Path $CONFIG_DIR "config.json"

$proc = $null
$proc2 = $null
$servers = @()

# 卡片中心（客户区坐标，与 CSS 布局一致）：卡片1「本地」≈103，卡片2「远程」≈185
$CARD_LOCAL_Y = 103
$CARD_REMOTE_Y = 185

# 顶栏「网页对话」按钮中心的 x（**逻辑**像素，客户区坐标），y 取顶栏中线 20。
#
# ⚠️ 这个值必须是**唯一来源**：顶栏按钮顺序是
#   应用(左0，中心≈27) → 操作(左54，中心≈81) → 网页对话(左108，中心≈148)
# （按 `.menu` padding 0 14px、字体 13px、CJK 全角约 13px/字 推算）。
# 历史上这里曾在两个分支里分别写 148 和 68，而 68 会点到「操作」弹出原生菜单
# ⇒ 侧栏根本不开、断言必然失败。抽成常量就是为了不再分叉。
$CHAT_BTN_X = 148

function Start-TestServer([int]$ListenPort, [string]$LogFile) {
  $js = Join-Path $WORK "httpd-$ListenPort.js"
  @"
const http=require('http'),fs=require('fs');
http.createServer((q,s)=>{fs.appendFileSync(process.argv[2],q.method+' '+q.url+'\n');
s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
s.end('<!doctype html><meta charset=utf-8><title>DSH $ListenPort</title><h1>OK $ListenPort</h1>');})
.listen($ListenPort,'127.0.0.1');
"@ | Set-Content -Path $js -Encoding UTF8
  Set-Content -Path $LogFile -Value "" -NoNewline
  return Start-Process node -ArgumentList @($js, $LogFile) -PassThru -WindowStyle Hidden
}

function Start-CookieServer([int]$ListenPort, [string]$LogFile) {
  $js = Join-Path $WORK "cookie-$ListenPort.js"
  @'
const http = require("http"), fs = require("fs");
// 页面先把「当前已有的 cookie」上报，再设置两种 cookie，最后再上报一次。
// 于是第二次启动时的 /before 就能看出哪些 cookie 真的落盘了。
const page = "<!doctype html><meta charset=utf-8><title>COOKIE</title><script>" +
  "fetch('/before?c='+encodeURIComponent(document.cookie));" +
  "document.cookie='persist=1; Max-Age=86400; Path=/';" +
  "document.cookie='sess=1; Path=/';" +
  "fetch('/after?c='+encodeURIComponent(document.cookie));" +
  "<\/script>";
http.createServer((q, s) => {
  fs.appendFileSync(process.argv[2], q.url + "\n");
  s.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  s.end(page);
}).listen(process.argv[3], "127.0.0.1");
'@ | Set-Content -Path $js -Encoding UTF8
  Set-Content -Path $LogFile -Value "" -NoNewline
  return Start-Process node -ArgumentList @($js, $LogFile, $ListenPort) -PassThru -WindowStyle Hidden
}

function Test-Port([int]$P) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $t = $c.ConnectAsync("127.0.0.1", $P)
    $ok = $t.Wait(1500) -and $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}

function Format-WindowList([int]$ProcId) {
  $lines = @()
  foreach ($h in [Win32]::TopLevelWindows([uint32]$ProcId)) {
    $cs = [Win32]::ClientSize($h)
    $lines += ("hwnd={0} title='{1}' client={2}x{3} visible={4} hung={5}" -f `
      $h, [Win32]::Title($h), $cs[0], $cs[1], [Win32]::IsWindowVisible($h), [Win32]::IsHungAppWindow($h))
  }
  if ($lines.Count -eq 0) { $lines += "(该进程没有任何顶层窗口)" }
  return ($lines -join " | ")
}

function Find-AppWindow([int]$ProcId, [string]$Title, [int]$W, [int]$H, [int]$Tolerance) {
  $handles = [Win32]::TopLevelWindows([uint32]$ProcId)
  if ($Title) {
    foreach ($h in $handles) { if ([Win32]::Title($h) -eq $Title) { return $h } }
  }
  foreach ($h in $handles) {
    $cs = [Win32]::ClientSize($h)
    if ([Math]::Abs($cs[0] - $W) -le $Tolerance -and [Math]::Abs($cs[1] - $H) -le $Tolerance) { return $h }
  }
  return [IntPtr]::Zero
}

function Wait-AppWindow([int]$ProcId, [string]$Title, [int]$W, [int]$H, [int]$Tolerance, [int]$Tries = 15) {
  for ($i = 0; $i -lt $Tries; $i++) {
    $h = Find-AppWindow $ProcId $Title $W $H $Tolerance
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Seconds 2
  }
  return [IntPtr]::Zero
}

function Stop-App([System.Diagnostics.Process]$P) {
  if ($P -and -not $P.HasExited) { Stop-Process -Id $P.Id -Force -ErrorAction SilentlyContinue }
  Get-Process dshtauri -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

try {
  Write-Host "== 0. 前置检查 =="
  Check "应用可执行文件存在" (Test-Path $AppPath) $AppPath
  if (-not (Test-Path $AppPath)) { throw "找不到 $AppPath" }
  Check "Node 可用" ([bool](Get-Command node -ErrorAction SilentlyContinue))

  Write-Host "== 1. 启动两个测试服务 =="
  $LOG_A = Join-Path $WORK "httpd-$Port.log"
  $LOG_B = Join-Path $WORK "httpd-$Port2.log"
  $servers += Start-TestServer $Port  $LOG_A
  $servers += Start-TestServer $Port2 $LOG_B
  Start-Sleep -Seconds 2
  Check "测试服务 $Port 已就绪"  (Test-Port $Port)
  Check "测试服务 $Port2 已就绪" (Test-Port $Port2)
  Set-Content -Path $LOG_A -Value "" -NoNewline
  Set-Content -Path $LOG_B -Value "" -NoNewline

  Write-Host "== 2. 预置配置（本地 + 远程都配好，便于测试切换）=="
  New-Item -ItemType Directory -Force -Path $CONFIG_DIR | Out-Null
  $cfg = @{ configured = $true;
            localUrl = "http://127.0.0.1:$Port";
            remoteUrl = "http://127.0.0.1:$Port2";
            autoStartLocal = $false; localStartCommand = "" } | ConvertTo-Json -Compress
  Set-Content -Path $CONFIG_FILE -Value $cfg -Encoding UTF8
  Check "config.json 已写入" (Test-Path $CONFIG_FILE) $CONFIG_FILE

  # ======================================================= A. 首次连接
  Write-Host "== 3. 启动 DSHTauri =="
  $APP_LOG = Join-Path $WORK "app.log"
  $proc = Start-Process $AppPath -PassThru -RedirectStandardOutput $APP_LOG -RedirectStandardError "$APP_LOG.err"
  Start-Sleep -Seconds 8
  Check "进程存活" (-not $proc.HasExited) "exit=$($proc.ExitCode)"
  if ($proc.HasExited) { throw "应用启动即退出" }

  Write-Host "== 4. 选择窗口 =="
  $sel = Wait-AppWindow $proc.Id $SELECTOR_TITLE 560 460 120
  Check "选择窗口已出现（标题或 560x460 客户区）" ($sel -ne [IntPtr]::Zero) `
    "session=$((Get-Process -Id $PID).SessionId) 进程窗口：$(Format-WindowList $proc.Id)"
  if ($sel -eq [IntPtr]::Zero) { throw "选择窗口没出现：$(Format-WindowList $proc.Id)" }
  $selCs = [Win32]::ClientSize($sel)
  Write-Host ("  选择窗口：hwnd={0} title='{1}' client={2}x{3}" -f $sel, [Win32]::Title($sel), $selCs[0], $selCs[1])
  Write-Host ("  启动后窗口清单：{0}" -f (Format-WindowList $proc.Id))

  # 冷启动（首次创建 WebView2 profile）可能比较慢，给足时间再判定卡死
  $responsive = $false
  for ($i = 0; $i -lt 15; $i++) {
    if ([Win32]::IsResponsive($sel, 2000)) { $responsive = $true; break }
    Start-Sleep -Seconds 2
  }
  Check "选择窗口未卡死" $responsive "进程窗口：$(Format-WindowList $proc.Id)"

  Write-Host "== 5. 点击「本地」= =="
  # 窗口响应了不代表页面已经渲染完（CI 上 build job 并行跑，CPU 抢占会让启动明显变慢），
  # 页面没就绪时点击会落空，所以这里多等一会儿。
  Start-Sleep -Seconds 3
  [void][Win32]::SetForegroundWindow($sel)
  Start-Sleep -Milliseconds 500
  [Win32]::ClickClient($sel, [int]($selCs[0] / 2), $CARD_LOCAL_Y)
  Start-Sleep -Seconds 8

  Write-Host "== 6. 主窗口 =="
  $main = Wait-AppWindow $proc.Id $MAIN_TITLE 1200 800 200
  Check "主窗口已出现（标题 DSHTauri 或 ~1200x800 客户区）" ($main -ne [IntPtr]::Zero) `
    "进程窗口：$(Format-WindowList $proc.Id)"

  if ($main -ne [IntPtr]::Zero) {
    $ms = [Win32]::ClientSize($main)
    Write-Host ("  主窗口标题='{0}' 客户区={1}x{2}" -f [Win32]::Title($main), $ms[0], $ms[1])
    $hung = [Win32]::IsHungAppWindow($main)
    Check "主窗口没有卡死（IsHungAppWindow=false）" (-not $hung) "IsHungAppWindow=$hung"
    Check "主窗口响应 WM_NULL 不超时" ([Win32]::IsResponsive($main, 5000))
    Check "主窗口可见" ([Win32]::IsWindowVisible($main))
    Start-Sleep -Seconds 3
    Check "本地服务($Port)收到 WebView2 的请求" ((Get-Content $LOG_A -Raw) -match "GET /") "日志：'$(Get-Content $LOG_A -Raw)'"
    # 这条走的是 Tauri 自己的 show/hide，可见性状态同步，断言有效
    Check "首次连接后选择窗口已隐藏" (-not [Win32]::IsWindowVisible($sel))

    Write-Host "== 6.5 顶栏子 webview（新架构：主窗口内的子 webview）=="
    # 这一段专门盯住用户报告的缺陷 2（顶栏错位）与缺陷 1（点「网页对话」卡死）。
    #
    # 关键断言是「顶栏在客户区顶部、高 ≈ 40 × scale」：
    # 改造前顶栏是**独立窗口** + 手工 `* scale` 同步，实测被缩放两次
    # （截图 P1 顶栏 158 device px ≈ 40×2×2，而正确的 P2 是 78 ≈ 40×2）。
    $dpi = [Win32]::GetDpiForWindow($main)
    if ($dpi -eq 0) { $dpi = 96 }
    $scale = $dpi / 96.0
    $expectTbH = [int][math]::Round(40 * $scale)
    $tol = [int][math]::Max(6.0, 4 * $scale)

    $visDesc = @([Win32]::Descendants($main) | Where-Object { [Win32]::IsWindowVisible($_) })
    $describe = (($visDesc | ForEach-Object {
      $r = [Win32]::RectInClient($main, $_)
      "$([Win32]::ClassName($_))=$($r[2])x$($r[3])@$($r[0]),$($r[1])"
    }) -join '; ')

    Write-Host ("  客户区={0}x{1} DPI={2} scale={3:N2} 期望顶栏高={4}px(±{5})" -f `
      $ms[0], $ms[1], $dpi, $scale, $expectTbH, $tol)
    foreach ($k in $visDesc) {
      $r = [Win32]::RectInClient($main, $k)
      Write-Host ("    子窗口 0x{0:X} class={1} rect=({2},{3}) {4}x{5}" -f `
        $k.ToInt64(), [Win32]::ClassName($k), $r[0], $r[1], $r[2], $r[3])
    }

    # 顶栏：贴着客户区顶部、高度≈40×scale、宽度≥客户区 90%
    $tbHit = @($visDesc | Where-Object {
      $r = [Win32]::RectInClient($main, $_)
      $r[1] -le 2 -and [math]::Abs($r[3] - $expectTbH) -le $tol -and $r[2] -ge [int]($ms[0] * 0.9)
    })
    $tbDetail = "期望高 {0}px(±{1})；实际可见子窗口：{2}" -f $expectTbH, $tol, $describe
    Check "顶栏子 webview 位于客户区顶部且高≈40×scale（未被 DPI 双重缩放）" ($tbHit.Count -ge 1) $tbDetail

    # 内容 webview：在顶栏下方，且占掉大部分客户区剩余高度
    $contentHit = @($visDesc | Where-Object {
      $r = [Win32]::RectInClient($main, $_)
      $r[1] -ge ($expectTbH - $tol) -and $r[3] -ge [int]($ms[1] * 0.5)
    })
    $contentDetail = "客户区高 {0}；实际：{1}" -f $ms[1], $describe
    Check "内容子 webview 在顶栏下方且占据主体高度" ($contentHit.Count -ge 1) $contentDetail

    Write-Host "== 6.6 点「网页对话」不得卡死（缺陷 1 回归）=="
    # 标题栏「网页对话」按钮中心：菜单在左侧，应用(0-54) 操作(54-108) 网页对话(≈108-190)
    # 客户区坐标 = 逻辑坐标 × scale
    $before = @([Win32]::Descendants($main) | Where-Object { [Win32]::IsWindowVisible($_) }).Count
    [Win32]::ClickClient($main, [int]($CHAT_BTN_X * $scale), [int](20 * $scale))
    Start-Sleep -Seconds 8
    $hungNow = [Win32]::IsHungAppWindow($main)
    Check "点「网页对话」后主窗口没有卡死（IsHungAppWindow=false）" (-not $hungNow) "IsHungAppWindow=$hungNow"
    Check "点「网页对话」后主窗口仍响应 WM_NULL（未死锁）" ([Win32]::IsResponsive($main, 5000)) `
      "若失败说明 add_child 在主线程上死锁 —— 正是用户报告的「卡死、只能任务管理器强杀」"
    Check "点「网页对话」后进程仍存活" (-not $proc.HasExited)
    $after = @([Win32]::Descendants($main) | Where-Object { [Win32]::IsWindowVisible($_) }).Count
    Check "点「网页对话」后多出侧栏子 webview" ($after -gt $before) `
      "点击前可见子窗口 $before 个，点击后 $after 个"

    # --- v0.3.0：侧栏开/关过渡动画（overlay 模式）---
    #
    # 动画是**逐帧改 x**（180ms、约 60fps）。这里等它放完，然后断言侧栏
    # **停在它该在的位置**：overlay 模式下侧栏左边缘 = 客户区宽 - CHAT_WIDTH×scale。
    # 若动画终点算错（把 offscreen 当终点、或物理/逻辑单位混用），这条会失败。
    Start-Sleep -Seconds 1
    $chatW = [int](420 * $scale)      # CHAT_WIDTH = 420 逻辑 px
    # ⚠️ 必须用 `,@(...)` 包一层：PowerShell 会把 `int[]` 在管道里**展开**成
    # 4 个独立整数，`$_[0]` 就不再是「矩形」而是一个标量（上一次 CI 就是栽在这）。
    $tbRects = @(
      [Win32]::Descendants($main) |
        Where-Object { [Win32]::IsWindowVisible($_) -and [Win32]::ClassName($_) -eq "WRY_WEBVIEW" } |
        ForEach-Object { ,@([Win32]::RectInClient($main, $_)) }
    )
    $sbDesc = ($tbRects | ForEach-Object { "($($_[0]),$($_[1])) $($_[2])x$($_[3])" }) -join '; '

    # 侧栏 = 那个「在内容区（y≈40）、左边缘在客户区右半部」的 webview。
    $sidebars = @($tbRects | Where-Object {
      $_[1] -ge ($expectTbH - $tol) -and $_[0] -ge [int]($ms[0] / 2)
    })
    $expectChatX = $ms[0] - $chatW
    $sidebarOk = $false
    foreach ($sb in $sidebars) {
      # 允许 ±6px：动画终点会精确落在目标，但窗口边框/取整可能差一两像素。
      if ([math]::Abs($sb[0] - $expectChatX) -le 6) { $sidebarOk = $true }
    }
    Check "动画结束后侧栏停在客户区右侧（overlay 目标位置）" $sidebarOk `
      ("期望左边缘≈{0}（客户区宽 {1} - 侧栏宽 {2}）；实际子 webview：{3}" -f `
        $expectChatX, $ms[0], $chatW, $sbDesc)

    # 再点一次收起，确认反复切换也不会卡
    [Win32]::ClickClient($main, [int]($CHAT_BTN_X * $scale), [int](20 * $scale))
    Start-Sleep -Seconds 4
    Check "再次点击收起侧栏后仍响应（可反复切换）" ([Win32]::IsResponsive($main, 5000))

    # --- v0.3.2：docked（并排）模式的过渡动画 ---
    #
    # v0.3.1 的 docked 模式**不做滑动**（直接切到位），用户实测「还是卡/闪」。
    # v0.3.2 起 docked 与 overlay 共用同一条滑动路径：滑动期间内容页**不收窄**，
    # 等侧栏滑到位（`slide_x_with` 的 on_done）才让出宽度。
    #
    # 做法：把 `chatDocked` 写进配置、重启应用，**走与 A 段完全相同的流程**
    # 把主窗口叫出来（启动时只有选择窗口！），再点「网页对话」，
    # 然后断言**内容页与侧栏精确平铺**（内容页让出 420 逻辑 px）。
    #
    # ⚠️ 三个坑（独立验证发现，都会让 CI 变红）：
    #   1. **启动后第一个可见顶层窗口是「选择 DSH 连接方式」，不是主窗口** ——
    #      `.setup()` 无条件创建选择窗口（不判断 `config.configured`），
    #      主窗口要等用户点「本地」卡片才建。所以必须像 A 段那样
    #      `Wait-AppWindow $SELECTOR_TITLE` → 点「本地」→ `Wait-AppWindow $MAIN_TITLE`，
    #      **不能**用 `TopLevelWindows | Select-Object -First 1`。
    #   2. **「网页对话」按钮的 x 是 148，不是 68**。顶栏按钮顺序是
    #      应用(中心≈27) → 操作(≈81) → 网页对话(≈148)；按 CSS 推算
    #      （`.menu` padding 0 14px、字体 13px）网页对话左边缘 108、中心 148。
    #      点 68 会点到「操作」弹出原生菜单，侧栏根本不会开。
    #      这里统一用 `$CHAT_BTN_X`，与上面的 overlay 分支**同一个常量**，避免再次分叉。
    #   3. 先收起侧栏再重启，避免上一段留下的状态干扰。
    [Win32]::ClickClient($main, [int]($CHAT_BTN_X * $scale), [int](20 * $scale))
    Start-Sleep -Seconds 2
    if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit(5000) }

    $cfgDock = @{ configured = $true;
                  localUrl = "http://127.0.0.1:$Port";
                  remoteUrl = "http://127.0.0.1:$Port2";
                  autoStartLocal = $false; localStartCommand = "";
                  chatDocked = $true } | ConvertTo-Json -Compress
    Set-Content -Path $CONFIG_FILE -Value $cfgDock -Encoding UTF8

    $dockLog = Join-Path $WORK "app.docked.log"
    $procDock = Start-Process $AppPath -PassThru -RedirectStandardOutput $dockLog -RedirectStandardError "$dockLog.err"

    # 与 A 段同构：选择窗口 → 点「本地」→ 主窗口。
    $selD = Wait-AppWindow $procDock.Id $SELECTOR_TITLE 560 460 120
    $mainDock = $null
    if ($selD) {
      $selDCs = [Win32]::ClientSize($selD)
      [Win32]::ClickClient($selD, [int]($selDCs[0] / 2), $CARD_LOCAL_Y)
      $mainDock = Wait-AppWindow $procDock.Id $MAIN_TITLE 1200 800 200
    }
    if ($mainDock) {
      $msD = [Win32]::ClientSize($mainDock)
      $scaleD = [Win32]::GetDpiForWindow($mainDock) / 96.0
      $tbHD = [int](40 * $scaleD)
      # 点「网页对话」——与 overlay 分支共用同一个 x 常量。
      [Win32]::ClickClient($mainDock, [int]($CHAT_BTN_X * $scaleD), [int](20 * $scaleD))
      Start-Sleep -Seconds 4   # 等动画（180ms）放完 + 页面开始加载

      $chatWD = [int](420 * $scaleD)
      $rectsD = @(
        [Win32]::Descendants($mainDock) |
          Where-Object { [Win32]::IsWindowVisible($_) -and [Win32]::ClassName($_) -eq "WRY_WEBVIEW" } |
          ForEach-Object { ,@([Win32]::RectInClient($mainDock, $_)) }
      )
      $descD = ($rectsD | ForEach-Object { "($($_[0]),$($_[1])) $($_[2])x$($_[3])" }) -join '; '

      # 内容页 = 从 y≈40 开始、左边缘为 0、宽度≈客户区宽-chatW 的那个。
      $expectContentW = $msD[0] - $chatWD
      $contentOk = $false
      foreach ($r in $rectsD) {
        if ($r[1] -ge ($tbHD - 6) -and $r[0] -le 2 -and [math]::Abs($r[2] - $expectContentW) -le 8) {
          $contentOk = $true
        }
      }
      Check "docked：内容页让出侧栏宽度（与侧栏并排、不重叠）" $contentOk `
        ("期望内容页宽≈{0}（客户区宽 {1} - 侧栏宽 {2}）；实际子 webview：{3}" -f `
          $expectContentW, $msD[0], $chatWD, $descD)

      # 侧栏左边缘应正好贴在内容页右边缘（精确平铺）。
      $expectChatXD = $expectContentW
      $chatOkD = $false
      foreach ($r in $rectsD) {
        if ($r[1] -ge ($tbHD - 6) -and [math]::Abs($r[0] - $expectChatXD) -le 8) { $chatOkD = $true }
      }
      Check "docked：侧栏左边缘与内容页右边缘对齐（精确平铺）" $chatOkD `
        ("期望侧栏左边缘≈{0}；实际：{1}" -f $expectChatXD, $descD)

      Check "docked：打开侧栏后进程仍存活（未死锁）" (-not $procDock.HasExited)
    } else {
      Check "docked：能启动并找到主窗口" $false `
        "没走到主窗口（选择窗口=$(if ($selD) {'有'} else {'无'})）"
    }
    if (-not $procDock.HasExited) { $procDock.Kill(); $procDock.WaitForExit(5000) }

    Write-Host "== 6.7 设置窗口（v0.3.0 新增）=="
    # 「应用 → 设置」走**系统原生菜单**，菜单是系统级弹出窗口、不是 DOM 元素，
    # 无法用坐标可靠点中（xdotool/Win32 点击都不稳），所以 CI 里不点它。
    #
    # 设置窗口的链路改由两条**能在 CI 稳定跑**的断言覆盖：
    #   1) `npm run test:js` 的契约对账：真解析 lib.rs，断言 `settings` 同时出现在
    #      popup_menu 的 app 分支与 run_action 分支里（少一个就会失败）；
    #   2) `npm run verify` / cargo test：断言 capability 覆盖 settings 窗口（有 IPC）。
    # 这里只登记一条 INFO，不伪造断言。
    Write-Host "  [INFO] 设置窗口通过原生菜单打开，CI 不点系统菜单；" `
      "其链路由 test-titlebar.mjs 的 lib.rs 契约对账 + capability 断言覆盖。"

    Write-Host "== 7. 关闭主窗口 = 隐藏到托盘 =="
    [void][Win32]::PostMessage($main, [Win32]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Seconds 5
    Check "关闭后进程仍存活" (-not $proc.HasExited)
    Check "关闭后主窗口不可见（已隐藏到托盘）" (-not [Win32]::IsWindowVisible($main)) `
      "IsWindowVisible=$([Win32]::IsWindowVisible($main))"
  }

  # ======================================================= B. 切换连接方式
  Write-Host "== 8. 切换连接方式（模拟托盘「重新选择连接方式」）=="
  # 主窗口已经在跑；把被隐藏的选择窗口重新显示出来，再点「远程」。
  # 这一步验证 open_main_window 在「已有主窗口」时的行为：
  # 必须是**复用同一个窗口导航**，而不是销毁再重建（重建会卡住/点了没反应）。
  [void][Win32]::ShowWindow($sel, [Win32]::SW_SHOWNORMAL)
  Start-Sleep -Seconds 2
  [void][Win32]::SetForegroundWindow($sel)
  Start-Sleep -Milliseconds 500
  Check "选择窗口重新显示成功" ([Win32]::IsWindowVisible($sel))

  Set-Content -Path $LOG_B -Value "" -NoNewline
  [Win32]::ClickClient($sel, [int]($selCs[0] / 2), $CARD_REMOTE_Y)
  Start-Sleep -Seconds 10

  if ($main -ne [IntPtr]::Zero) {
    $stillThere = [Win32]::IsWindow($main)
    Check "切换后主窗口仍然存在（复用而非销毁重建）" $stillThere "IsWindow=$stillThere"
    Check "切换后主窗口没有卡死" ([Win32]::IsResponsive($main, 5000))
    Check "切换后主窗口可见" ([Win32]::IsWindowVisible($main))
    $logB = Get-Content $LOG_B -Raw
    Check "新地址($Port2)收到 WebView2 的请求（确实切过去了）" ($logB -match "GET /") "日志：'$logB'"
  }
  # 这里**不**断言「选择窗口重新隐藏」：本测试是用外部 ShowWindow 把它显示出来的，
  # 绕过了 Tauri/tao 内部的可见性状态；tao 认为它「本来就是隐藏的」，
  # set_visible(false) 不产生差异所以不会调用 ShowWindow —— 这是测试手段的限制，
  # 不是产品问题（真实流程走托盘 -> selector.show()，状态是同步的；
  # 「连接后选择窗口隐藏」已在第 6 节用有效路径断言过）。
  Check "切换后主窗口仍是活动窗口" ([Win32]::GetForegroundWindow() -eq $main) `
    "foreground=$([Win32]::GetForegroundWindow()) main=$main"

  Stop-App $proc
  Start-Sleep -Seconds 3

  # ======================================================= C. 本地服务随主程序退出
  Write-Host "== 9. 自动启动的本地服务必须随主程序退出而结束 =="
  $svcJs = Join-Path $WORK "fake-service.js"
  @"
const http = require('http');
http.createServer((q, s) => s.end('service')).listen($SvcPort, '127.0.0.1');
setInterval(() => {}, 1000);
"@ | Set-Content -Path $svcJs -Encoding UTF8

  $cfg2 = @{ configured = $true;
             localUrl = "http://127.0.0.1:$SvcPort";
             remoteUrl = "";
             autoStartLocal = $true;
             localStartCommand = "node `"$svcJs`"" } | ConvertTo-Json -Compress
  Set-Content -Path $CONFIG_FILE -Value $cfg2 -Encoding UTF8
  Check "服务端口 $SvcPort 启动前是关闭的" (-not (Test-Port $SvcPort))

  $proc2 = Start-Process $AppPath -PassThru -RedirectStandardOutput "$APP_LOG.2" -RedirectStandardError "$APP_LOG.2.err"
  Start-Sleep -Seconds 8
  $sel2 = Wait-AppWindow $proc2.Id $SELECTOR_TITLE 560 460 120
  Check "选择窗口已出现（第二轮）" ($sel2 -ne [IntPtr]::Zero) "$(Format-WindowList $proc2.Id)"
  if ($sel2 -ne [IntPtr]::Zero) {
    $sel2Cs = [Win32]::ClientSize($sel2)
    [void][Win32]::SetForegroundWindow($sel2)
    Start-Sleep -Milliseconds 500
    [Win32]::ClickClient($sel2, [int]($sel2Cs[0] / 2), $CARD_LOCAL_Y)

    $svcUp = $false
    for ($i = 0; $i -lt 15; $i++) { if (Test-Port $SvcPort) { $svcUp = $true; break }; Start-Sleep -Seconds 2 }
    Check "自动启动的本地服务确实起来了（端口 $SvcPort 在监听）" $svcUp

    if ($svcUp) {
      Stop-App $proc2
      $gone = $false
      for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 2; if (-not (Test-Port $SvcPort)) { $gone = $true; break } }
      Check "主程序退出后本地服务已结束（端口 $SvcPort 关闭）" $gone `
        "仍在监听 —— 说明子进程没有被作业对象一起回收"
    }
  }

  # ======================================================= D. Cookie 持久化
  Write-Host "== 10. Cookie / 登录态必须跨重启保留 =="
  $COOKIE_LOG = Join-Path $WORK "cookie.log"
  $servers += Start-CookieServer $CookiePort $COOKIE_LOG
  Start-Sleep -Seconds 2
  Check "Cookie 测试服务已就绪" (Test-Port $CookiePort)

  $cfg3 = @{ configured = $true;
             localUrl = "http://127.0.0.1:$CookiePort";
             remoteUrl = "";
             autoStartLocal = $false; localStartCommand = "" } | ConvertTo-Json -Compress
  Set-Content -Path $CONFIG_FILE -Value $cfg3 -Encoding UTF8

  function Open-MainViaLocal([string]$Tag) {
    $p = Start-Process $AppPath -PassThru -RedirectStandardOutput "$APP_LOG.$Tag" -RedirectStandardError "$APP_LOG.$Tag.err"
    Start-Sleep -Seconds 8
    $s = Wait-AppWindow $p.Id $SELECTOR_TITLE 560 460 120
    if ($s -eq [IntPtr]::Zero) { return $null }
    $cs = [Win32]::ClientSize($s)
    [void][Win32]::SetForegroundWindow($s)
    Start-Sleep -Milliseconds 500
    [Win32]::ClickClient($s, [int]($cs[0] / 2), $CARD_LOCAL_Y)
    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Seconds 2
      if ((Get-Content $COOKIE_LOG -Raw) -match "/after") { break }
    }
    return $p
  }

  # 第一次运行：页面设置 cookie
  $run1 = Open-MainViaLocal "cookie1"
  $log1 = Get-Content $COOKIE_LOG -Raw
  Check "第一次运行：页面成功写入 cookie" ($log1 -match "persist%3D1") "日志：'$log1'"
  # 应用里的 cookie keeper 是主窗口出现后 5s 才第一次运行，必须等它跑过再杀进程，
  # 否则测的是「还没来得及转换就被杀了」。
  Start-Sleep -Seconds 12
  Stop-App $run1
  # 上一实例的 WebView2 子进程可能还占着用户数据目录，多等一会儿
  Start-Sleep -Seconds 6

  # 第二次运行：看第一次设置的 cookie 是否还在
  Set-Content -Path $COOKIE_LOG -Value "" -NoNewline
  $run2 = Open-MainViaLocal "cookie2"
  $log2 = Get-Content $COOKIE_LOG -Raw
  $before = (($log2 -split "`n") | Where-Object { $_ -like "/before*" } | Select-Object -First 1)
  Check "持久 cookie 跨重启保留" ($before -match "persist%3D1") "第二次启动的 /before：'$before'"
  # Chromium 默认会丢掉会话 cookie，Cloudflare Access 的 CF_Authorization 就是这种。
  # 应用里有个 cookie keeper 会把它转成持久 cookie，所以这里必须是「保留」。
  Check "会话 cookie 也被转成持久 cookie（跨重启保留）" ($before -match "sess%3D1") "第二次启动的 /before：'$before'"
  Stop-App $run2
}
catch {
  Check "脚本异常中止" $false $_.Exception.Message
}
finally {
  Write-Host "== 清理 =="
  foreach ($f in @((Join-Path $WORK "app.log"), (Join-Path $WORK "app.log.err"),
                   (Join-Path $WORK "app.log.2"), (Join-Path $WORK "app.log.2.err"))) {
    if (Test-Path $f) {
      $t = (Get-Content $f -Raw)
      if ($t) { Write-Host "--- $([IO.Path]::GetFileName($f)) ---"; Write-Host $t }
    }
  }
  Stop-App $proc
  Stop-App $proc2
  foreach ($s in $servers) { if ($s -and -not $s.HasExited) { Stop-Process -Id $s.Id -Force -ErrorAction SilentlyContinue } }
  # 兜底：把可能残留的假服务也清掉
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*fake-service.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "== 结果: $script:Pass 通过, $script:Fail 失败 =="

# 把失败项以 GitHub 注解形式发出来 —— 这样即使没有 token 也能从公开的
# check-runs/annotations API 读到失败原因（job 日志本身需要鉴权）。
foreach ($f in $script:Failures) {
  Write-Host ("::error title=SMOKE FAIL::{0}" -f $f)
}
if ($script:Fail -gt 0) { exit 1 }
