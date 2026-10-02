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
