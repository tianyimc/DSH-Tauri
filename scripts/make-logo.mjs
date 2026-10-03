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
 *   4. `startmenu.ico` —— **开始菜单快捷方式专用**：白鲸鱼 + 细描边。
 *      为什么不直接复用 `icon.ico`（深藏青）：开始菜单快捷方式的图标是 `.lnk` 里
 *      写死的一个图标，**不会跟随系统深浅色主题**。深藏青的鲸鱼落在深色开始菜单上
 *      几乎看不见；纯白鲸鱼落在浅色开始菜单上同样看不见。
 *      所以这里给白鲸鱼描一圈**细的深色边**：浅色背景靠描边勾出轮廓，
 *      深色背景靠白色本体 —— 两种背景都能看清（dual-legibility）。
 *      每一档尺寸都用「该尺寸自己的描边宽度」单独合成，**不是**
 *      先做 256 再用 `icon:auto-resize` 缩下来 —— 后者会把细描边在小尺寸上
 *      稀释成几乎不可见的浅灰（实测 32px 时最暗像素只有 213/255）。
 *
 * 依赖 ImageMagick（`convert`）。CI 的 windows-latest 没有它，所以找不到时
 * **安全跳过**（仓库里已提交生成结果），不让打包失败。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** 开始菜单图标上那圈描边的颜色（近黑的深灰，比纯黑柔和一点）。 */
const OUTLINE_COLOR = "#16181D";

/**
 * 描边宽度（像素，指**该尺寸自己的像素**）。
 *
 * 必须随尺寸变化：32px 下 1px 的描边刚好，256px 下 1px 就细得看不见了；
 * 反过来 256px 的 4px 描边放到 16px 上会把整只鲸鱼吃掉（实测 16px 时
 * 白色鲸鱼只剩 74 个像素，几乎认不出）。所以按尺寸线性取值并钳到 1..4。
 */
function outlineRadius(size) {
  return Math.max(1, Math.min(4, Math.round(size / 64)));
}

/**
 * 白鲸鱼 + 细描边，**每一档尺寸单独合成**。
 *
 * 流程（对每个 size）：
 *   1. 把白鲸鱼缩到该尺寸；
 *   2. 取它的 alpha，做形态学膨胀 —— 得到「比鲸鱼大一圈」的轮廓；
 *   3. 造一张该尺寸的纯深色画布，用 2 的轮廓当遮罩（CopyOpacity）→ 描边层；
 *   4. 把 1 的白鲸鱼叠在描边层上 → 白鲸鱼 + 细深色边。
 *
 * 注意 2 里**不能**加 `-channel A`：那会把整张画布的 alpha 一起膨胀到全不透明
 * （实测 min=max=65535），描边层就变成一整块黑色方块。直接对
 * `-alpha extract` 出来的灰度图做 `-morphology Dilate` 才是对的。
 */
function makeOutlinedPng(src, dst, size) {
  const tmp = mkdtempSync(join(tmpdir(), "dshtauri-outline-"));
  try {
    const whale = join(tmp, "whale.png");
    const alpha = join(tmp, "alpha.png");
    const dilated = join(tmp, "dilated.png");
    const dark = join(tmp, "dark.png");
    const ring = join(tmp, "ring.png");

    execFileSync("convert", [src, "-background", "none", "-resize", `${size}x${size}`, `PNG32:${whale}`]);
    execFileSync("convert", [whale, "-alpha", "extract", "-depth", "8", `PNG32:${alpha}`]);
    // 注意：`Dilate` 与核 `Disk:N` **必须是两个独立参数**。
    // 写成单个 "Dilate Disk:4" 时 ImageMagick 会把整个字符串当核名，
    // 然后继续吃掉后面的输出路径，报 `invalid argument for option '-morphology'`。
    execFileSync("convert", [
      alpha,
      "-depth",
      "8",
      "-morphology",
      "Dilate",
      `Disk:${outlineRadius(size)}`,
      `PNG32:${dilated}`,
    ]);
    execFileSync("convert", ["-size", `${size}x${size}`, `xc:${OUTLINE_COLOR}`, `PNG32:${dark}`]);
    execFileSync("convert", [
      dark,
      dilated,
      "-alpha",
      "off",
      "-compose",
      "CopyOpacity",
      "-composite",
      `PNG32:${ring}`,
    ]);
    execFileSync("convert", [ring, whale, "-composite", "-depth", "8", `PNG32:${dst}`]);

    // 去掉 PNG 里的时间戳与辅助块，保证**字节级可复现**：
    // ImageMagick 默认会写 tIME（以及 cHRM/bKGD/tEXt date:*），同样输入每次生成
    // 出来的 md5 都不同。`-strip` 只去掉 tEXt，去不掉 tIME；
    // 真正有效的是 `png:include-chunk=none`（只保留 IHDR/IDAT/IEND）。
    execFileSync("convert", [
      dst,
      "-define",
      "png:include-chunk=none",
      "-depth",
      "8",
      `PNG32:${dst}`,
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 手工打包多尺寸 ICO。
 *
 * 不用 `-define icon:auto-resize`：那条路会拿一张 256 的图逐档降采样，
 * 把上面辛苦按尺寸调好的描边又抹掉。这里直接把已经合成好的各档 PNG
 * **原样**塞进 ICO 容器（ICO 允许每帧是 PNG，Vista 以后 Windows 都支持）。
 */
function packIco(frames, dst) {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved，必须为 0
  header.writeUInt16LE(1, 2); // type=1 表示图标
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  frames.forEach(({ size, data }, i) => {
    const e = 16 * i;
    // 宽高字段是 1 字节：256 要写 0（ICO 的约定）
    entries.writeUInt8(size >= 256 ? 0 : size, e + 0);
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1);
    entries.writeUInt8(0, e + 2); // 调色板数
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += data.length;
    blobs.push(data);
  });

  writeFileSync(dst, Buffer.concat([header, entries, ...blobs]));
}

/** 生成「白鲸鱼 + 细描边」的开始菜单专用图标。 */
function makeStartMenuIco(src, dst) {
  const tmp = mkdtempSync(join(tmpdir(), "dshtauri-startmenu-"));
  try {
    const frames = ICO_SIZES.map((size) => {
      const png = join(tmp, `frame-${size}.png`);
      makeOutlinedPng(src, png, size);
      return { size, data: readFileSync(png) };
    });
    packIco(frames, dst);
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

    // 2.5) 开始菜单快捷方式专用图标：白鲸鱼 + 细描边（深浅背景都看得清）。
    //      与 icon.ico 分开是有意的 —— 见文件头注释第 4 点。
    makeStartMenuIco(SRC_DARK, resolve(ICONS, "startmenu.ico"));

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
        `startmenu.ico(白鲸鱼+细描边) + ` +
        `app-dark/app-light(运行时主题切换) + ${flat.length} 个尺寸 PNG`,
    );
  } catch (err) {
    console.warn(`[DSHTauri] 警告：logo 生成失败，保持原文件。原因：${err.message}`);
  }
}

main();
