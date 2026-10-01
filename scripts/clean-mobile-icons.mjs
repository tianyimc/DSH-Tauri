/*
 * tauri icon 会顺带生成 android/ 和 ios/ 两套图标。
 * 本项目只做 Windows 桌面端（NSIS），这两套用不到，删掉保持仓库精简。
 *
 * 由 package.json 的 `posticon` 钩子在 `npm run icon` 之后自动执行。
 * 以后真要支持移动端，删掉 package.json 里的 posticon 即可。
 */
import { existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const iconsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

for (const name of ["android", "ios"]) {
  const dir = resolve(iconsDir, name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[DSHTauri] 已移除 ${name}/ （本项目不使用）`);
  }
}
