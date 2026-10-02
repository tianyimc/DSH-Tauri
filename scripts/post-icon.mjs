/*
 * `npm run icon` 之后自动执行（package.json 的 posticon 钩子）。
 *
 * 做两件事：
 *   1. 删除 tauri icon 顺带生成的 android/ 、ios/ —— 本项目只做 Windows 桌面端。
 *   2. 用官方的 deepseek_harness.ico 覆盖 src-tauri/icons/icon.ico —— 安装包/exe/应用图标
 *      必须**始终**是这个官方白底版本（7 档 16/24/32/48/64/128/256），比 tauri icon
 *      自己生成的 6 档更完整，所以不重新生成、直接原样使用。
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

/* 2. 安装包图标固定为官方白底版本 */
const official = resolve(ROOT, "deepseek_harness.ico");
const target = resolve(iconsDir, "icon.ico");
if (existsSync(official)) {
  copyFileSync(official, target);
  console.log("[DSHTauri] icon.ico ← deepseek_harness.ico（官方白底版本）");
} else {
  console.warn(
    "[DSHTauri] 警告：找不到 deepseek_harness.ico，icon.ico 保持 tauri icon 生成的结果。",
  );
}
