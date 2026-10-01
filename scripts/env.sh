# DSHTauri 开发环境 —— 用法：
#
#   source scripts/env.sh
#
# 作用：把项目自带的 Rust 工具链（.toolchain/）暴露给当前 shell。
# 什么时候需要它：`npm run tauri dev` 报
#   failed to run 'cargo metadata' ... No such file or directory
# 或
#   rustup could not choose a version of cargo to run ... no default is configured
#
# 如果你已经把 Rust 装到了标准位置（~/.cargo + ~/.rustup）并 source 过
# ~/.cargo/env，就不需要这个脚本。

_DSHTAURI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

if [ -x "$_DSHTAURI_ROOT/.toolchain/cargo/bin/cargo" ]; then
  export CARGO_HOME="$_DSHTAURI_ROOT/.toolchain/cargo"
  export RUSTUP_HOME="$_DSHTAURI_ROOT/.toolchain/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
  echo "[DSHTauri] CARGO_HOME=$CARGO_HOME"
  echo "[DSHTauri] RUSTUP_HOME=$RUSTUP_HOME"
  echo "[DSHTauri] $(cargo --version 2>/dev/null || echo 'cargo 仍不可用')"
elif command -v cargo >/dev/null 2>&1; then
  echo "[DSHTauri] 项目内没有 .toolchain/，但 PATH 上已有：$(cargo --version)"
else
  echo "[DSHTauri] 没找到 Rust 工具链。请安装："
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
  echo '  source "$HOME/.cargo/env"'
  return 1 2>/dev/null || exit 1
fi

unset _DSHTAURI_ROOT
