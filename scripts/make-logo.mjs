/*
 * 生成 DSHTauri 的统一 logo 资源。
 *
 * ## 背景（用户要求）
 *
 * 「采用目前应用在系统托盘上的那个小鲸鱼作为程序统一 logo；
 *   它在深色模式以白色小鲸鱼出现，浅色模式以黑色小鲸鱼出现，自动变。
 *   另外 setup.exe 和 uninstall.exe 的图标也应该是这个统一小鲸鱼，
 *   而不是 tauri 默认图标。」
 *
 * ## 素材（都在 src-tauri/icons/ 里，是同一只鲸鱼的两个配色）
 *
 *   tray-dark.png   → 白色鲸鱼 + 透明底（用于**深色**任务栏）
 *   tray-light.png  → 深藏青 #020E36 鲸鱼 + 透明底（用于**浅色**任务栏）
 *
 * 两者 artwork 完全一致（同一张矢量图的两个填色），只是颜色不同。
 *
 * ## 产出
 *
 *   1. `icon.ico`            —— 统一 logo（深藏青，透明底），7 档多尺寸。
 *      用于：exe 图标、安装包图标、卸载器图标、资源管理器里的文件图标。
 *      **注意**：Windows 资源管理器/桌面**不会**按深浅色主题自动切换
 *      exe/ico 的颜色（它只认 ico 里那一个图像）。所以这里固定用深藏青版
 *      —— 浅色背景（默认）下清晰；深色主题下任务栏/标题栏的**运行时**图标
 *      由下面的 app-dark/app-light 在代码里按主题切换（见 lib.rs）。
 *
 *   2. `app-dark.png` / `app-light.png` —— 运行时窗口/任务栏图标的两套配色，
 *      由 Rust 侧按当前系统主题 `Window::set_icon()` 动态切换，
 *      这样标题栏与任务栏上的图标能跟随深浅色（与托盘图标同一套逻辑）。
 *
 *   3. `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.png` / StoreLogo 等
 *      —— 统一成同一只鲸鱼，避免仓库里同时存在「白色圆角方块」与「透明鲸鱼」
 *      两种风格（之前就是这样，用户明确要求统一）。
 *
 * 依赖 ImageMagick（`convert`）。CI 的 windows-latest 没有它，所以找不到时
 * **安全跳过**（仓库里已提交生成结果），不让打包失败。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = resolve(ROOT, "src-tauri", "icons");

/** 深藏青版（浅色背景用）—— 也作为 exe/安装包/卸载器的固定图标。 */
const SRC_LIGHT = resolve(ICONS, "tray-light.png");
/** 白色版（深色背景用）。 */
const SRC_DARK = resolve(ICONS, "tray-dark.png");

/** ICO 里包含的尺寸。小尺寸（16/24/32）是资源管理器与任务栏实际会用的。 */
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

function hasConvert() {
  try {
    execFileSync("convert", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 把 src 缩放成 size×size 的 PNG（保留透明底）。 */
function resize(src, dst, size) {
  execFileSync("convert", [src, "-background", "none", "-resize", `${size}x${size}`, dst]);
}

/** 生成多尺寸 ICO。 */
function makeIco(src, dst) {
  const tmp = mkdtempSync(join(tmpdir(), "dshtauri-ico-"));
  try {
    const master = join(tmp, "master.png");
    // 先规整到 256 再让 ImageMagick 逐档降采样，边缘更干净。
    resize(src, master, 256);
    execFileSync("convert", [
      master,
      "-background",
      "none",
      "-define",
      `icon:auto-resize=${ICO_SIZES.join(",")}`,
      dst,
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  for (const [name, p] of [
    ["tray-light.png", SRC_LIGHT],
    ["tray-dark.png", SRC_DARK],
  ]) {
    if (!existsSync(p)) {
      console.warn(`[DSHTauri] 警告：找不到 ${name}，跳过 logo 生成。`);
      return;
    }
  }

  if (!hasConvert()) {
    console.log(
      "[DSHTauri] 未找到 ImageMagick 的 convert，跳过 logo 重新生成" +
        "（仓库内已提交现成结果，打包不受影响）。",
    );
    return;
  }

  try {
    // 1) 统一 ICO：exe / 安装包 / 卸载器 / 资源管理器都用它。
    makeIco(SRC_LIGHT, resolve(ICONS, "icon.ico"));

    // 2) 运行时按主题切换的两套窗口/任务栏图标。
    resize(SRC_DARK, resolve(ICONS, "app-dark.png"), 64);
    resize(SRC_LIGHT, resolve(ICONS, "app-light.png"), 64);

    // 3) 其余尺寸统一成同一只鲸鱼（透明底深藏青）。
    //    Windows 需要这些尺寸；tauri 的 bundle.icon 也引用它们。
    const flat = [
      ["32x32.png", 32],
      ["128x128.png", 128],
      ["128x128@2x.png", 256],
      ["icon.png", 512],
      ["Square30x30Logo.png", 30],
      ["Square44x44Logo.png", 44],
      ["Square71x71Logo.png", 71],
      ["Square89x89Logo.png", 89],
      ["Square107x107Logo.png", 107],
      ["Square142x142Logo.png", 142],
      ["Square150x150Logo.png", 150],
      ["Square284x284Logo.png", 284],
      ["Square310x310Logo.png", 310],
      ["StoreLogo.png", 50],
      ["64x64.png", 64],
    ];
    for (const [name, size] of flat) {
      resize(SRC_LIGHT, resolve(ICONS, name), size);
    }

    console.log(
      `[DSHTauri] 统一 logo 已生成：icon.ico(${ICO_SIZES.length} 档) + ` +
        `app-dark/app-light(运行时主题切换) + ${flat.length} 个尺寸 PNG`,
    );
  } catch (err) {
    console.warn(`[DSHTauri] 警告：logo 生成失败，保持原文件。原因：${err.message}`);
  }
}

main();
