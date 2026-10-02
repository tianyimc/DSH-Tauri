# DSHTauri — Windows 无头冒烟测试（在 GitHub Actions 的 windows-latest 上跑）
#
# 目的：不用人工在 Win11 上点，就能验证「选择 → 打开主窗口 → 关闭到托盘」整条链路，
#       并且能抓出「主窗口白屏 / 界面卡死」这类只在 Windows 上暴露的问题。
#
# 判定手段（全部基于 Win32，不依赖截图 —— WebView2 走 DirectComposition，PrintWindow 常返回空白）：
#   1) 进程启动后有 560x460 的选择窗口
#   2) 点击「本地」后出现 ~1200x800 的主窗口
#   3) 主窗口**没有卡死**：IsHungAppWindow=false 且 SendMessageTimeout(WM_NULL, SMTO_ABORTIFHUNG) 不超时
#      ← 这条正是「同步命令里创建窗口导致主线程死锁」的检测点
#   4) 本地测试服务收到来自 WebView2 的 HTTP 请求（证明页面真的在加载，不是白屏空转）
#   5) 发 WM_CLOSE 后进程仍存活且主窗口不可见（关闭 = 隐藏到托盘）
#
# 用法：pwsh -File scripts/smoke-windows.ps1 -AppPath <dshtauri.exe>

param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [int]$Port = 3080
)

$ErrorActionPreference = "Stop"
$script:Pass = 0
$script:Fail = 0

function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
  if ($Ok) { Write-Host "  [PASS] $Name" -ForegroundColor Green; $script:Pass++ }
  else { Write-Host "  [FAIL] $Name  $Detail" -ForegroundColor Red; $script:Fail++ }
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

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  public const uint WM_NULL  = 0x0000;
  public const uint WM_CLOSE = 0x0010;
  public const uint SMTO_ABORTIFHUNG = 0x0002;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP   = 0x0004;

  public static string Title(IntPtr h) {
    int len = GetWindowTextLengthW(h);
    var sb = new StringBuilder(len + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
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
$HTTP_LOG = Join-Path $WORK "httpd.log"

$CONFIG_DIR = Join-Path $env:APPDATA "com.dsh.dshtauri"
$CONFIG_FILE = Join-Path $CONFIG_DIR "config.json"

$proc = $null
$httpd = $null

# 按客户区尺寸找窗口：选择窗口 560x460，主窗口 ~1200x800
function Find-WindowByClientSize([IntPtr[]]$Handles, [int]$W, [int]$H, [int]$Tolerance) {
  foreach ($h in $Handles) {
    $s = [Win32]::ClientSize($h)
    if ([Math]::Abs($s[0] - $W) -le $Tolerance -and [Math]::Abs($s[1] - $H) -le $Tolerance) { return $h }
  }
  return [IntPtr]::Zero
}

try {
  Write-Host "== 0. 前置检查 =="
  Check "应用可执行文件存在" (Test-Path $AppPath) $AppPath
  if (-not (Test-Path $AppPath)) { throw "找不到 $AppPath" }
  Check "Node 可用" ([bool](Get-Command node -ErrorAction SilentlyContinue))

  Write-Host "== 1. 启动本地测试服务 http://127.0.0.1:$Port =="
  $serverFile = Join-Path $WORK "httpd.js"
  @"
const http=require('http'),fs=require('fs');
http.createServer((q,s)=>{fs.appendFileSync(process.argv[2],q.method+' '+q.url+'\n');
s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
s.end('<!doctype html><meta charset=utf-8><title>DSH LOCAL</title><h1>DSH LOCAL OK</h1>');})
.listen($Port,'127.0.0.1');
"@ | Set-Content -Path $serverFile -Encoding UTF8
  Set-Content -Path $HTTP_LOG -Value "" -NoNewline
  $httpd = Start-Process node -ArgumentList @($serverFile, $HTTP_LOG) -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  try {
    $resp = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
    Check "测试服务已就绪" ($resp.StatusCode -eq 200)
  } catch { Check "测试服务已就绪" $false $_.Exception.Message }
  Set-Content -Path $HTTP_LOG -Value "" -NoNewline

  Write-Host "== 2. 预置配置（只配本地地址）=="
  New-Item -ItemType Directory -Force -Path $CONFIG_DIR | Out-Null
  $cfg = @{ configured = $true; localUrl = "http://127.0.0.1:$Port"; remoteUrl = "";
            autoStartLocal = $false; localStartCommand = "" } | ConvertTo-Json -Compress
  Set-Content -Path $CONFIG_FILE -Value $cfg -Encoding UTF8
  Check "config.json 已写入" (Test-Path $CONFIG_FILE) $CONFIG_FILE

  Write-Host "== 3. 启动 DSHTauri =="
  $proc = Start-Process $AppPath -PassThru
  Start-Sleep -Seconds 8
  Check "进程存活" (-not $proc.HasExited) "exit=$($proc.ExitCode)"
  if ($proc.HasExited) { throw "应用启动即退出" }

  Write-Host "== 4. 选择窗口 =="
  $sel = [IntPtr]::Zero
  for ($i = 0; $i -lt 15; $i++) {
    $sel = Find-WindowByClientSize ([Win32]::TopLevelWindows([uint32]$proc.Id)) 560 460 4
    if ($sel -ne [IntPtr]::Zero) { break }
    Start-Sleep -Seconds 2
  }
  Check "选择窗口已出现（客户区 560x460）" ($sel -ne [IntPtr]::Zero)
  if ($sel -eq [IntPtr]::Zero) {
    Write-Host "  当前进程的顶层窗口："
    foreach ($h in [Win32]::TopLevelWindows([uint32]$proc.Id)) {
      $s = [Win32]::ClientSize($h)
      Write-Host ("    hwnd={0} title='{1}' client={2}x{3} visible={4}" -f $h, [Win32]::Title($h), $s[0], $s[1], [Win32]::IsWindowVisible($h))
    }
    throw "选择窗口没出现 —— 可能 runner 上没有可用的交互桌面"
  }
  Check "选择窗口未卡死" ([Win32]::IsResponsive($sel, 3000))

  Write-Host "== 5. 点击「本地」卡片 =="
  [void][Win32]::SetForegroundWindow($sel)
  Start-Sleep -Milliseconds 500
  [Win32]::ClickClient($sel, 280, 103)   # 卡片中心：横向居中，纵向约 103px（与 CSS 布局一致）
  Start-Sleep -Seconds 8

  Write-Host "== 6. 主窗口 =="
  $main = [IntPtr]::Zero
  for ($i = 0; $i -lt 15; $i++) {
    $main = Find-WindowByClientSize ([Win32]::TopLevelWindows([uint32]$proc.Id)) 1200 800 40
    if ($main -ne [IntPtr]::Zero) { break }
    Start-Sleep -Seconds 2
  }
  Check "主窗口已出现（客户区 ~1200x800）" ($main -ne [IntPtr]::Zero)

  if ($main -ne [IntPtr]::Zero) {
    $ms = [Win32]::ClientSize($main)
    Write-Host ("  主窗口标题='{0}' 客户区={1}x{2}" -f [Win32]::Title($main), $ms[0], $ms[1])

    # ★ 本次 Win11 白屏 bug 的检测点：
    #   在同步命令（主线程）里创建窗口会死锁，窗口既不响应消息也画不出内容。
    $hung = [Win32]::IsHungAppWindow($main)
    Check "主窗口没有卡死（IsHungAppWindow=false）" (-not $hung) "IsHungAppWindow=$hung"
    Check "主窗口响应 WM_NULL 不超时" ([Win32]::IsResponsive($main, 5000))
    Check "主窗口可见" ([Win32]::IsWindowVisible($main))

    Start-Sleep -Seconds 3
    $httpText = ""
    if (Test-Path $HTTP_LOG) { $httpText = (Get-Content $HTTP_LOG -Raw) }
    if ($null -eq $httpText) { $httpText = "" }
    Check "本地服务收到 WebView2 的请求（页面真的在加载）" ($httpText -match "GET /") "日志：'$httpText'"

    Write-Host "== 7. 关闭主窗口 = 隐藏到托盘 =="
    [void][Win32]::PostMessage($main, [Win32]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Seconds 5
    Check "关闭后进程仍存活" (-not $proc.HasExited)
    $visible = [Win32]::IsWindowVisible($main)
    Check "关闭后主窗口不可见（已隐藏到托盘）" (-not $visible) "IsWindowVisible=$visible"
  }
}
finally {
  Write-Host "== 清理 =="
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  if ($httpd -and -not $httpd.HasExited) { Stop-Process -Id $httpd.Id -Force -ErrorAction SilentlyContinue }
  Get-Process dshtauri -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "== 结果: $script:Pass 通过, $script:Fail 失败 =="
if ($script:Fail -gt 0) { exit 1 }
