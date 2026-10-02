/*
 * `npm run icon` 之后自动执行（package.json 的 posticon 钩子）。
 *
 * 做两件事：
 *   1. 删除 tauri icon 顺带生成的 android/ 、ios/ —— 本项目只做 Windows 桌面端。
 *   2. 用**统一 logo** 覆盖 `tauri icon` 生成的图标。
 *
 * 为什么第 2 步必要：`tauri icon app-icon.png` 会从 `app-icon.png`
 * （那只「鲸鱼画在白色圆角方块上」的旧图）重新生成全部图标，
 * 把我们的统一鲸鱼覆盖掉。用户明确要求统一成**托盘那只小鲸鱼**，
 * 所以每次生成后都要用 `scripts/make-logo.mjs` 修正回来。
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

/* 2. 覆盖成统一 logo（icon.ico + 运行时主题图标 + 各尺寸 PNG） */
try {
  execFileSync(process.execPath, [resolve(ROOT, "scripts", "make-logo.mjs")], {
    stdio: "inherit",
  });
} catch (err) {
  console.warn(
    `[DSHTauri] 警告：make-logo.mjs 执行失败，图标保持 tauri icon 生成的结果。原因：${err.message}`,
  );
}
