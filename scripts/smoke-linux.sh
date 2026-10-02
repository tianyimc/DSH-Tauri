#!/usr/bin/env bash
#
# DSHTauri — Linux 无头冒烟测试
#
# 在 Xvfb 上真实启动应用，验证：
#   1) 选择窗口「选择 DSH 连接方式」出现（560x460）
#   2) 首次启动地址为空：点击「本地」先弹配置表单，不直接连接、不写配置文件
#   3) 只填本地地址（远程留空）→ 保存后主窗口「DSHTauri」1200x800 出现，
#      且确实加载了该 URL（本地测试服务收到请求）
#   4) 关闭主窗口 = 隐藏到托盘（进程仍存活，窗口不可见）
#   5) 重启后仍然要求选择，但地址已记住、无需再设置
#   6) 清空配置重来，**只配远程**同样能连上（本地留空）
#
# 依赖（Debian）：
#   sudo apt-get install -y xvfb xdotool wmctrl openbox dbus-x11 curl nodejs
#
# 用法：bash scripts/smoke-linux.sh    （或 npm run smoke）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/src-tauri/target/debug/dshtauri"
OUT="$(mktemp -d /tmp/dshtauri-smoke.XXXXXX)"
DISPLAY_NUM=:99
PORT=3080
BASE_URL="http://127.0.0.1:$PORT"

# 选择窗口 560x460，卡片纵向排列。实测（截图扫描中轴线得到）：
#   卡片 1「本地」y≈68..139（中心 103），卡片 2「远程」y≈150..221（中心 185）
CARD1_Y=103
CARD2_Y=185

PASS=0; FAIL=0
check() { # check <描述> <实际> <期望子串>
  if [[ "$2" == *"$3"* ]]; then echo "  ✅ $1"; PASS=$((PASS+1));
  else echo "  ❌ $1  (实际: '$2', 期望包含: '$3')"; FAIL=$((FAIL+1)); fi
}
check_empty() { # 期望为空
  if [[ -z "$2" ]]; then echo "  ✅ $1"; PASS=$((PASS+1));
  else echo "  ❌ $1  (实际: '$2', 期望为空)"; FAIL=$((FAIL+1)); fi
}
check_nonempty() { # 期望非空（用于「窗口存在」这类断言）
  if [[ -n "$2" ]]; then echo "  ✅ $1"; PASS=$((PASS+1));
  else echo "  ❌ $1  (期望非空，实际为空)"; FAIL=$((FAIL+1)); fi
}

cleanup() {
  [[ -n "${APP_PID:-}"   ]] && kill "$APP_PID"   2>/dev/null
  [[ -n "${HTTPD_PID:-}" ]] && kill "$HTTPD_PID" 2>/dev/null
  [[ -n "${OB_PID:-}"    ]] && kill "$OB_PID"    2>/dev/null
  [[ -n "${XVFB_PID:-}"  ]] && kill "$XVFB_PID"  2>/dev/null
  [[ -n "${DBUS_SESSION_BUS_PID:-}" ]] && kill "$DBUS_SESSION_BUS_PID" 2>/dev/null
}
trap cleanup EXIT

echo "== 0. 前置检查 =="
if [[ ! -x "$APP" ]]; then
  echo "找不到 $APP，请先构建：cd src-tauri && cargo build"
  exit 1
fi
for bin in Xvfb xdotool wmctrl openbox node curl; do
  command -v "$bin" >/dev/null || { echo "缺少命令：$bin"; exit 1; }
done

echo "== 1. 启动 Xvfb $DISPLAY_NUM =="
Xvfb "$DISPLAY_NUM" -screen 0 1400x900x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 & XVFB_PID=$!
export DISPLAY="$DISPLAY_NUM"
sleep 2
xdpyinfo >/dev/null 2>&1 || { echo "Xvfb 启动失败"; cat "$OUT/xvfb.log"; exit 1; }

eval "$(dbus-launch --sh-syntax 2>/dev/null)" || true
openbox >"$OUT/openbox.log" 2>&1 & OB_PID=$!

echo "== 2. 启动本地测试服务 $BASE_URL =="
node -e "
const http=require('http'),fs=require('fs');
http.createServer((q,s)=>{fs.appendFileSync('$OUT/httpd.log',q.method+' '+q.url+'\n');
s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
s.end('<!doctype html><meta charset=utf-8><title>DSH LOCAL</title><h1>DSH LOCAL OK</h1>');})
.listen($PORT,'127.0.0.1');" >"$OUT/httpd.out" 2>&1 & HTTPD_PID=$!
sleep 1
curl -sf -o /dev/null "$BASE_URL/" || { echo "测试服务启动失败"; exit 1; }
: > "$OUT/httpd.log"

export XDG_CONFIG_HOME="$OUT/config" XDG_DATA_HOME="$OUT/data"
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11
CONFIG_FILE="$XDG_CONFIG_HOME/com.dsh.dshtauri/config.json"

find_main() { xdotool search --name "^DSHTauri$" 2>/dev/null | while read -r w; do
  eval "$(xdotool getwindowgeometry --shell "$w" 2>/dev/null)"
  [[ "${WIDTH:-0}" -ge 1000 ]] && echo "$w"; done | head -1; }

selector_id() { xdotool search --name "选择 DSH 连接方式" 2>/dev/null | head -1; }

launch_app() {
  "$APP" >>"$OUT/app.log" 2>&1 & APP_PID=$!
  sleep 6
  kill -0 "$APP_PID" 2>/dev/null || { echo "应用启动即退出："; cat "$OUT/app.log"; exit 1; }
}

# 点选择窗口里的第 N 张卡片（1=本地 2=远程）
click_card() {
  local sel y
  sel="$(selector_id)"
  eval "$(xdotool getwindowgeometry --shell "$sel")"
  y=$((Y + ($1 == 1 ? CARD1_Y : CARD2_Y)))
  xdotool mousemove $((X + WIDTH / 2)) "$y" click 1
  sleep 3
}

# 在表单里输入文本（焦点已在对应输入框）
type_into_focused() { xdotool type --delay 25 "$1"; sleep 0.6; }

tab_n() { for _ in $(seq 1 "$1"); do xdotool key --clearmodifiers Tab; sleep 0.4; done; }

# ============================================================ 3. 首次启动
echo "== 3. 首次启动（不预置 config.json，地址默认为空）=="
mkdir -p "$XDG_CONFIG_HOME/com.dsh.dshtauri"
launch_app

SEL="$(selector_id)"
echo "== 4. 断言 =="
check_nonempty "选择窗口已创建（标题=选择 DSH 连接方式）" "${SEL:-}"
eval "$(xdotool getwindowgeometry --shell "$SEL")"
check "选择窗口尺寸 560x460" "${WIDTH}x${HEIGHT}" "560x460"

echo "   → 点击「本地」"
click_card 1
check_empty "首次点击不直接开主窗口（地址为空，先要用户填写）" "$(find_main)"
check "首次点击不写 config.json" "$([[ -f "$CONFIG_FILE" ]] && echo YES || echo NO)" "NO"

echo "   → 只填本地地址（远程故意留空），Tab x3 到「保存」+ 回车"
xdotool windowactivate "$SEL" 2>/dev/null || true; sleep 1
type_into_focused "$BASE_URL"
tab_n 3
xdotool key --clearmodifiers Return
sleep 6

MAIN="$(find_main)"
check_nonempty "保存后主窗口已创建" "${MAIN:-}"
check "config.json 已写入" "$([[ -f "$CONFIG_FILE" ]] && echo YES || echo NO)" "YES"
check "只配了本地，远程保持为空" "$(tr -d ' \n' <"$CONFIG_FILE" 2>/dev/null)" '"remoteUrl":""'
if [[ -n "${MAIN:-}" ]]; then
  eval "$(xdotool getwindowgeometry --shell "$MAIN")"
  check "主窗口尺寸 1200x800" "${WIDTH}x${HEIGHT}" "1200x800"
fi
# 选择窗口现在是**隐藏**而不是销毁（销毁正在执行 IPC 的 webview 会出问题），
# 所以用 --onlyvisible 判断「是否还在显示」。
check_empty "选择窗口已隐藏（不再显示）" "$(xdotool search --onlyvisible --name "选择 DSH 连接方式" 2>/dev/null | head -1 || true)"
sleep 1
check "本地服务收到 WebView 的请求" "$(cat "$OUT/httpd.log" 2>/dev/null)" "GET /"

echo "   → 发送 WM_DELETE_WINDOW 关闭主窗口"
wmctrl -i -c "$MAIN"
sleep 4
check "关闭后进程仍存活（隐藏到托盘）" "$(kill -0 "$APP_PID" 2>/dev/null && echo ALIVE || echo DEAD)" "ALIVE"
check_empty "关闭后主窗口不可见" "$(xdotool search --onlyvisible --name '^DSHTauri$' 2>/dev/null | head -1 || true)"
check "托盘创建成功（无降级告警）" "$(grep -c '系统托盘创建失败' "$OUT/app.log" 2>/dev/null || echo 0)" "0"

# ============================================== 5. 重启：地址已记住
echo
echo "== 5. 重启应用：验证「每次都要选，但地址已记住」 =="
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
launch_app
SEL2="$(selector_id)"
check_nonempty "重启后仍然显示选择界面（「选择」不持久化）" "${SEL2:-}"
echo "   → 直接点击「本地」（不按任何键、不打开设置）"
click_card 1
sleep 2
check_nonempty "直接点击即连上（「地址」已持久化，无需再设置）" "$(find_main)"
check "config.json 未被改写" "$(tr -d ' \n' <"$CONFIG_FILE")" '"configured":true'

# ============================================== 6. 只配远程
echo
echo "== 6. 清空配置重来：验证「只配远程」同样可用 =="
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
rm -f "$CONFIG_FILE"
: > "$OUT/httpd.log"
launch_app
SEL3="$(selector_id)"
check_nonempty "清空配置后重新显示选择界面" "${SEL3:-}"

echo "   → 点击「远程」"
click_card 2
check_empty "首次点击远程也不直接连接（地址为空）" "$(find_main)"

echo "   → 焦点在「本地 URL」，Tab x1 跳到「远程 URL」，只填远程，再 Tab x1 到「保存」+ 回车"
echo "     （本地为空 => 复选框和命令框都是 disabled，会被 Tab 跳过）"
xdotool windowactivate "$SEL3" 2>/dev/null || true; sleep 1
tab_n 1
type_into_focused "$BASE_URL"
tab_n 1
xdotool key --clearmodifiers Return
sleep 6

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "     [调试] config.json 未生成，app.log 尾部："
  tail -5 "$OUT/app.log" | sed 's/^/       /'
fi

check_nonempty "只配远程也能连上" "$(find_main)"
check "只配了远程，本地保持为空" "$(tr -d ' \n' <"$CONFIG_FILE" 2>/dev/null)" '"localUrl":""'
check "远程 URL 收到 WebView 的请求" "$(cat "$OUT/httpd.log" 2>/dev/null)" "GET /"

echo
echo "== 结果: $PASS 通过, $FAIL 失败 =="
echo "   日志目录: $OUT"
[[ "$FAIL" -eq 0 ]]
