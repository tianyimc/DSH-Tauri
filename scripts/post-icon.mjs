/*
 * `npm run icon` 之后自动执行（package.json 的 posticon 钩子）。
 *
 * 做两件事：
 *   1. 删除 tauri icon 顺带生成的 android/ 、ios/ —— 本项目只做 Windows 桌面端。
 *   2. 把 `icons/icon.ico` 换成**托盘那个 logo**（透明背景的深藏青鲸鱼）。
 *
 * 关于第 2 点为什么不再用 `deepseek_harness.ico`：
 * 那个文件是「鲸鱼画在白色圆角方块上」的应用图标风格，而用户要求安装包图标用
 * **托盘 logo**（透明背景版）。`icons/tray-light.png` 就是那张图，且与
 * `deepseek.ico` 的 artwork **逐像素一致**（已用 compare 验证 0 差异）。
 * 具体生成逻辑见 `scripts/make-ico.mjs`。
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = resolve(ROOT, "src-tauri", "icons");

/* 1. 移除移动端图标 */
for (const name of ["android", "ios"]) {
  const dir = resolve(iconsDir, name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[DSHTauri] 已移除 ${name}/ （本项目不使用）`);
  }
}

/* 2. 安装包/exe 图标 = 托盘 logo（透明背景鲸鱼），7 档多尺寸 */
try {
  execFileSync(process.execPath, [resolve(ROOT, "scripts", "make-ico.mjs")], {
    stdio: "inherit",
  });
} catch (err) {
  console.warn(`[DSHTauri] 警告：make-ico.mjs 执行失败，icon.ico 保持原样。原因：${err.message}`);
}
