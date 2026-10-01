#!/usr/bin/env bash
#
# DSHTauri — Linux 无头冒烟测试
#
# 在 Xvfb 上真实启动应用，验证：
#   1) 选择窗口「选择 DSH 连接方式」出现
#   2) 首次点击「本地」时先弹出配置表单（不直接连接）
#   3) 保存后主窗口「DSHTauri」出现，尺寸 1200x800
#   4) 主窗口确实加载了配置里的 URL（本地测试服务收到请求）
#   5) 关闭主窗口 = 隐藏到托盘（进程仍存活，窗口不可见）
#
# 依赖（Debian）：
#   sudo apt-get install -y xvfb xdotool wmctrl openbox dbus-x11 curl nodejs
#
# 用法：bash scripts/smoke-linux.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/src-tauri/target/debug/dshtauri"
OUT="$(mktemp -d /tmp/dshtauri-smoke.XXXXXX)"
DISPLAY_NUM=:99
PORT=8080

PASS=0; FAIL=0
check() { # check <描述> <实际> <期望子串>
  if [[ "$2" == *"$3"* ]]; then echo "  ✅ $1"; PASS=$((PASS+1));
  else echo "  ❌ $1  (实际: '$2', 期望包含: '$3')"; FAIL=$((FAIL+1)); fi
}
check_empty() { # check_empty <描述> <实际> —— 期望为空
  if [[ -z "$2" ]]; then echo "  ✅ $1"; PASS=$((PASS+1));
  else echo "  ❌ $1  (实际: '$2', 期望为空)"; FAIL=$((FAIL+1)); fi
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
  echo "找不到 $APP，请先构建：npm run tauri build -- --debug  (或 cd src-tauri && cargo build)"
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

echo "== 2. 启动本地测试服务 127.0.0.1:$PORT =="
node -e "
const http=require('http'),fs=require('fs');
http.createServer((q,s)=>{fs.appendFileSync('$OUT/httpd.log',q.method+' '+q.url+'\n');
s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
s.end('<!doctype html><meta charset=utf-8><title>DSH LOCAL</title><h1>DSH LOCAL OK</h1>');})
.listen($PORT,'127.0.0.1');" >"$OUT/httpd.out" 2>&1 & HTTPD_PID=$!
sleep 1
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" || { echo "测试服务启动失败"; exit 1; }
: > "$OUT/httpd.log"

echo "== 3. 首次启动（不预置 config.json）=="
export XDG_CONFIG_HOME="$OUT/config" XDG_DATA_HOME="$OUT/data"
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11
CONFIG_FILE="$XDG_CONFIG_HOME/com.dsh.dshtauri/config.json"
"$APP" >"$OUT/app.log" 2>&1 & APP_PID=$!
sleep 6
kill -0 "$APP_PID" 2>/dev/null || { echo "应用启动即退出："; cat "$OUT/app.log"; exit 1; }

find_main() { xdotool search --name "^DSHTauri$" 2>/dev/null | while read -r w; do
  eval "$(xdotool getwindowgeometry --shell "$w" 2>/dev/null)"
  [[ "${WIDTH:-0}" -ge 1000 ]] && echo "$w"; done | head -1; }

SEL=$(xdotool search --name "选择 DSH 连接方式" 2>/dev/null | head -1)
echo "== 4. 断言 =="
check "选择窗口已创建（标题=选择 DSH 连接方式）" "${SEL:-<无>}" "1"

eval "$(xdotool getwindowgeometry --shell "$SEL")"
check "选择窗口尺寸 560x460" "${WIDTH}x${HEIGHT}" "560x460"

echo "   → 点击「本地」"
xdotool mousemove $((X + WIDTH / 2)) $((Y + 84)) click 1
sleep 3
check "首次点击不直接开主窗口（先要求确认配置）" "$(find_main || echo '<无>')" "<无>"
check "首次点击不写 config.json" "$([[ -f "$CONFIG_FILE" ]] && echo YES || echo NO)" "NO"

echo "   → Tab x3 聚焦「保存」+ 回车"
xdotool windowactivate "$SEL" 2>/dev/null || true; sleep 1
for _ in 1 2 3; do xdotool key --clearmodifiers Tab; sleep 0.4; done
xdotool key --clearmodifiers Return
sleep 6

MAIN=$(find_main)
check "保存后主窗口已创建" "${MAIN:-<无>}" "1"
check "config.json 已写入" "$([[ -f "$CONFIG_FILE" ]] && echo YES || echo NO)" "YES"
if [[ -n "${MAIN:-}" ]]; then
  eval "$(xdotool getwindowgeometry --shell "$MAIN")"
  check "主窗口尺寸 1200x800" "${WIDTH}x${HEIGHT}" "1200x800"
fi
check_empty "选择窗口已关闭" "$(xdotool search --name "选择 DSH 连接方式" 2>/dev/null | head -1 || true)"
sleep 1
check "本地服务收到 WebView 的请求" "$(cat "$OUT/httpd.log" 2>/dev/null)" "GET /"

echo "   → 发送 WM_DELETE_WINDOW 关闭主窗口"
wmctrl -i -c "$MAIN"
sleep 4
check "关闭后进程仍存活（隐藏到托盘）" "$(kill -0 "$APP_PID" 2>/dev/null && echo ALIVE || echo DEAD)" "ALIVE"
check_empty "关闭后主窗口不可见" "$(xdotool search --onlyvisible --name "^DSHTauri$" 2>/dev/null | head -1 || true)"
check "托盘创建成功（无降级告警）" "$(grep -c '系统托盘创建失败' "$OUT/app.log" 2>/dev/null || echo 0)" "0"

echo
echo "== 结果: $PASS 通过, $FAIL 失败 =="
echo "   日志目录: $OUT"
[[ "$FAIL" -eq 0 ]]
