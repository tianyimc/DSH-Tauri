/*
 * 从「托盘 logo」生成安装包 / exe 的 icon.ico。
 *
 * 背景：项目里有两个不同外观的鲸鱼素材 ——
 *   1. `deepseek_harness.ico`：鲸鱼画在**白色圆角方块**上（应用图标风格）；
 *   2. `src-tauri/icons/tray-light.png`：**透明背景**的深藏青鲸鱼（托盘用）。
 * 用户明确要求安装包图标用**托盘那个 logo**（透明背景版），所以这里不再直接用
 * `deepseek_harness.ico`，而是从透明版素材重新派生一套多尺寸 ICO。
 *
 * 为什么要脚本化：`npm run icon`（= `tauri icon app-icon.png`）会重新生成
 * `icons/icon.ico`，把我们的定制覆盖掉。这个脚本挂在 `posticon` 钩子上，
 * 保证每次跑完 `npm run icon` 之后 icon.ico 都会被修正回来。
 *
 * 依赖：ImageMagick（`convert`）。CI 的 windows-latest 上**没有** ImageMagick，
 * 所以脚本在找不到 `convert` 时会**保留现有 icon.ico 并告警**，不让打包失败
 * —— 仓库里已经提交了生成好的 icon.ico，正常构建不需要重新生成。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = resolve(ROOT, "src-tauri", "icons");
const target = resolve(iconsDir, "icon.ico");

/** 透明背景的鲸鱼素材（与托盘 logo 同一张图）。 */
const SOURCE = resolve(iconsDir, "tray-light.png");

/** ICO 里要包含的尺寸。小尺寸（16/24/32）是资源管理器/任务栏实际会用的。 */
const SIZES = [256, 128, 64, 48, 32, 24, 16];

function hasConvert() {
  try {
    execFileSync("convert", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!existsSync(SOURCE)) {
    console.warn(`[DSHTauri] 警告：找不到 ${SOURCE}，icon.ico 保持不变。`);
    return;
  }
  if (!hasConvert()) {
    // CI（windows-latest）没有 ImageMagick。仓库里已提交生成好的 icon.ico，
    // 所以这里只是跳过重新生成，不影响打包。
    console.log(
      "[DSHTauri] 未找到 ImageMagick 的 convert，跳过 icon.ico 重新生成" +
        "（仓库内已提交现成结果，打包不受影响）。",
    );
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "dshtauri-ico-"));
  try {
    // 先放大到 256 再让 ImageMagick 逐档降采样，边缘更干净。
    const master = join(tmp, "master.png");
    execFileSync("convert", [SOURCE, "-background", "none", "-resize", "256x256", master]);

    const out = join(tmp, "icon.ico");
    execFileSync("convert", [
      master,
      "-background",
      "none",
      "-define",
      `icon:auto-resize=${SIZES.join(",")}`,
      out,
    ]);

    copyFileSync(out, target);
    console.log(
      `[DSHTauri] icon.ico ← tray-light.png（透明背景鲸鱼，${SIZES.length} 档：${SIZES.join("/")}）`,
    );
  } catch (err) {
    console.warn(`[DSHTauri] 警告：重新生成 icon.ico 失败，保持原文件。原因：${err.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
