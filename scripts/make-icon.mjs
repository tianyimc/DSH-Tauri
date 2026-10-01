/*
 * 生成 DSHTauri 的图标源文件 app-icon.png（1024x1024，带透明通道）。
 *
 * 之后用 `npm run icon`（即 `tauri icon app-icon.png`）派生全套尺寸：
 *   icons/32x32.png, icons/128x128.png, icons/128x128@2x.png,
 *   icons/icon.ico (Windows/NSIS), icons/icon.icns (macOS), icons/StoreLogo.png ...
 *
 * 纯 Node 实现（zlib + 手写 PNG 编码），不需要任何图形库：
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 2; // 超采样倍数，边缘更干净

/* ----------------------------------------------------------- PNG encoding */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- geometry */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 圆角矩形 SDF（返回像素距离，内部为负）。 */
function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 线段 SDF（返回像素距离）。 */
function sdSegment(px, py, ax, ay, bx, by, halfThickness) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - halfThickness;
}

/* ---------------------------------------------------------------- render */

const bgOuter = [59, 130, 246]; // #3B82F6
const bgInner = [29, 78, 216]; // #1D4ED8
const glyph = [255, 255, 255];

function render() {
  const n = SIZE * SS;
  const scale = n / SIZE;
  const rgba = Buffer.alloc(SIZE * SIZE * 4);

  // 累积到超采样缓冲
  const acc = new Float32Array(SIZE * SIZE * 4);

  const half = n / 2 - 26 * scale;
  const radius = 232 * scale;
  const stroke = 52 * scale;

  // 终端提示符 “>” 的两段折线 + 下方下划线
  const chevron = [
    [352, 330, 560, 512],
    [560, 512, 352, 694],
  ].map((seg) => seg.map((v) => v * scale));
  const underline = [612 * scale, 694 * scale, 812 * scale, 694 * scale];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      const dRect = sdRoundRect(cx, cy, n / 2, n / 2, half, half, radius);
      let alpha = clamp(0.5 - dRect, 0, 1);
      if (alpha <= 0) continue;

      // 背景渐变（左上 -> 右下）
      const t = clamp((cx / n) * 0.5 + (cy / n) * 0.5, 0, 1);
      let r = bgOuter[0] + (bgInner[0] - bgOuter[0]) * t;
      let g = bgOuter[1] + (bgInner[1] - bgOuter[1]) * t;
      let b = bgOuter[2] + (bgInner[2] - bgOuter[2]) * t;

      // 白色字形
      let dGlyph = Infinity;
      for (const [ax, ay, bx, by] of chevron) {
        dGlyph = Math.min(dGlyph, sdSegment(cx, cy, ax, ay, bx, by, stroke));
      }
      dGlyph = Math.min(
        dGlyph,
        sdRoundRect(
          cx,
          cy,
          (underline[0] + underline[2]) / 2,
          (underline[1] + underline[3]) / 2,
          (underline[2] - underline[0]) / 2,
          stroke,
          stroke,
        ),
      );
      const gAlpha = clamp(0.5 - dGlyph, 0, 1);
      if (gAlpha > 0) {
        r = r + (glyph[0] - r) * gAlpha;
        g = g + (glyph[1] - g) * gAlpha;
        b = b + (glyph[2] - b) * gAlpha;
      }

      const i = (Math.floor(y / SS) * SIZE + Math.floor(x / SS)) * 4;
      acc[i] += r * alpha;
      acc[i + 1] += g * alpha;
      acc[i + 2] += b * alpha;
      acc[i + 3] += alpha * 255;
    }
  }

  const samples = SS * SS;
  for (let p = 0; p < SIZE * SIZE; p++) {
    const i = p * 4;
    const a = acc[i + 3] / samples;
    // 颜色按覆盖度加权平均，避免边缘发灰
    const w = acc[i + 3] / 255 || 1;
    rgba[i] = Math.round(clamp(acc[i] / w, 0, 255));
    rgba[i + 1] = Math.round(clamp(acc[i + 1] / w, 0, 255));
    rgba[i + 2] = Math.round(clamp(acc[i + 2] / w, 0, 255));
    rgba[i + 3] = Math.round(clamp(a, 0, 255));
  }

  return rgba;
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app-icon.png");
writeFileSync(out, encodePng(SIZE, SIZE, render()));
console.log(`wrote ${out} (${SIZE}x${SIZE})`);
