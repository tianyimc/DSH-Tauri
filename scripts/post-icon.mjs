/*
 * `npm run icon` 之后自动执行（package.json 的 posticon 钩子）。
 *
 * 做两件事：
 *   1. 删除 `tauri icon` 顺带生成的 android/ 、ios/ —— 本项目只做 Windows 桌面端。
 *   2. 用**统一 logo** 覆盖 `tauri icon` 生成的结果。
 *
 * ⚠️ v0.3.2 起 `npm run icon` **不再**调用 `tauri icon`：
 * `package.json` 的 `"icon"` 脚本直接指向本文件。
 * 原因：旧的 `tauri icon app-icon.png` 依赖 `app-icon.png`（那只「鲸鱼画在白色圆角
 * 方块上」的旧图），会生成一整套**风格不一致**的图标，再由本文件覆盖回去 ——
 * 绕一圈还有「覆盖失败就留下旧风格」的风险。`app-icon.png`、`deepseek.ico`、
 * `deepseek_harness.ico`、`scripts/make-icon.mjs` 都已在本版删除。
 *
 * 现在图标只有**一个**来源：`scripts/make-logo.mjs`（源自 `src-tauri/icons/` 里
 * 同一只鲸鱼的深浅两套配色）。本文件保留是为了兼容直接跑 `npm run posticon`
 * 的老习惯，并继续清理移动端目录。
 *
 * 统一 logo 的定义、配色与产出见 `scripts/make-logo.mjs` 的头部注释。
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

/* 2. 生成统一 logo（icon.ico + startmenu.ico + 运行时主题图标 + 各尺寸 PNG） */
try {
  execFileSync(process.execPath, [resolve(ROOT, "scripts", "make-logo.mjs")], {
    stdio: "inherit",
  });
} catch (err) {
  console.warn(
    `[DSHTauri] 警告：make-logo.mjs 执行失败，保持仓库里已提交的图标。原因：${err.message}`,
  );
}
