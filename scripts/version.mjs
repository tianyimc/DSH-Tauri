#!/usr/bin/env node
/*
 * DSHTauri 版本号 / 发布渠道工具 —— 版本格式 v.A.B.C
 *
 *   A    文集网页核心版本。只有网页核心发生重大变化时才提升。
 *   B    重要功能版本。当前 GUI 管理器属于重要更新，因此是 1.1.x。
 *   C    普通更新，例如小功能、优化和修复。
 *
 * 渠道（channel）只有两个：
 *   release  正式版：显示 `v.0.3.2`，安装包 `DSHTauri-v.0.3.2-setup.exe`，tag `v.0.3.2`
 *   rc       候选版：显示 `v.0.3.2 RC`，安装包 `DSHTauri-v.0.3.2-RC-setup.exe`，tag `v.0.3.2-rc`，
 *            GitHub Release 标记为 prerelease
 *
 * 历史说明：旧的多快照代次机制**已取消**，版本号只由 A.B.C 与渠道决定。
 *
 * 数据来源（各自唯一，不重复维护）：
 *   A.B.C    ->  src-tauri/tauri.conf.json 的 version（与 Cargo.toml / package.json 同步）
 *   channel  ->  version.json 的 channel（缺失 / 未知一律当作 release）
 *
 * 用法：
 *   node scripts/version.mjs                 人读输出
 *   node scripts/version.mjs --json          JSON（供脚本消费）
 *   node scripts/version.mjs --github        写入 $GITHUB_OUTPUT（供 Actions 用）
 *   node scripts/version.mjs --set 0.3.2     改 A.B.C（三处一起写），渠道保持不变
 *   node scripts/version.mjs --set-channel rc|release
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CONF = resolve(ROOT, "src-tauri", "tauri.conf.json");
const CARGO_TOML = resolve(ROOT, "src-tauri", "Cargo.toml");
const PACKAGE_JSON = resolve(ROOT, "package.json");
const VERSION_JSON = resolve(ROOT, "version.json");

const APP = "DSHTauri";

const RELEASE = "release";
const RC = "rc";
const CHANNELS = [RELEASE, RC];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** 读渠道。文件缺失 / 键缺失 / 值未知一律退回 release —— 发布渠道不该让流程炸掉。 */
function readChannel() {
  try {
    const channel = readJson(VERSION_JSON).channel;
    return CHANNELS.includes(channel) ? channel : RELEASE;
  } catch {
    return RELEASE;
  }
}

function writeChannel(channel) {
  writeFileSync(VERSION_JSON, `${JSON.stringify({ channel }, null, 2)}\n`);
}

/** 把 A.B.C 同步到所有声明版本号的地方（避免三处各写各的）。 */
function writeVersion(version) {
  const conf = readJson(TAURI_CONF);
  conf.version = version;
  writeFileSync(TAURI_CONF, `${JSON.stringify(conf, null, 2)}\n`);

  const pkg = readJson(PACKAGE_JSON);
  pkg.version = version;
  writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

  const toml = readFileSync(CARGO_TOML, "utf8");
  const patched = toml.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]*"/,
    `$1"${version}"`,
  );
  if (patched === toml) {
    throw new Error(`没能在 Cargo.toml 的 [package] 段里找到 version = "..."`);
  }
  writeFileSync(CARGO_TOML, patched);
}

function describe(version, channel) {
  const isRc = channel === RC;
  // 显示 / 标题用的 ` RC` 后缀（带空格）；文件名 / tag 用的 `-RC` / `-rc` 后缀。
  const spaced = isRc ? " RC" : "";
  const dashed = isRc ? "-RC" : "";
  return {
    version,
    channel,
    // 界面上显示的版本：`v.0.3.2` / `v.0.3.2 RC`
    display: `v.${version}${spaced}`,
    // 发布 / artifact 名
    release_name: `${APP} v.${version}${spaced}`,
    // 安装包文件名
    asset_name: `${APP}-v.${version}${dashed}-setup.exe`,
    // Git tag / Release tag：RC 与正式版必须能共存
    tag: `v.${version}${isRc ? "-rc" : ""}`,
    // Release 标题
    title: `${APP} v.${version}${spaced}`,
    // GitHub Release 是否标记为预发布
    prerelease: isRc,
  };
}

/* -------------------------------------------------------------------- main */

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has("--set")) {
  const next = args[args.indexOf("--set") + 1];
  if (!/^\d+\.\d+\.\d+$/.test(next || "")) {
    console.error(`--set 需要 A.B.C 形式，例如 0.3.2（收到：${next}）`);
    process.exit(1);
  }
  writeVersion(next);
  console.log(`[DSHTauri] 版本已设为 ${next}（渠道保持 ${readChannel()}）`);
}

if (has("--set-channel")) {
  const next = args[args.indexOf("--set-channel") + 1];
  if (!CHANNELS.includes(next)) {
    console.error(
      `--set-channel 需要 ${CHANNELS.join(" | ")}（收到：${next}）`,
    );
    process.exit(1);
  }
  writeChannel(next);
  console.log(`[DSHTauri] 发布渠道已设为 ${next}`);
}

const version = readJson(TAURI_CONF).version;
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error(`tauri.conf.json 的 version 不是 A.B.C 形式：${version}`);
  process.exit(1);
}

// 顺带校验 Cargo.toml / package.json 没有跑偏
const cargoVersion = readFileSync(CARGO_TOML, "utf8").match(
  /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/,
)?.[1];
const pkgVersion = readJson(PACKAGE_JSON).version;
for (const [name, v] of [
  ["Cargo.toml", cargoVersion],
  ["package.json", pkgVersion],
]) {
  if (v !== version) {
    console.error(
      `版本不一致：tauri.conf.json=${version}，${name}=${v}\n` +
        `用 \`node scripts/version.mjs --set ${version}\` 同步。`,
    );
    process.exit(1);
  }
}

const info = describe(version, readChannel());

if (has("--json")) {
  console.log(JSON.stringify(info, null, 2));
} else if (has("--github")) {
  const out = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(info)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  if (out) {
    writeFileSync(out, `${lines}\n`, { flag: "a" });
    console.log(lines);
  } else {
    // 本地跑 --github 时退化成打印，方便调试
    console.log(lines);
  }
} else {
  console.log(`${info.title}`);
  console.log(`  version      ${info.version}`);
  console.log(`  channel      ${info.channel}`);
  console.log(`  display      ${info.display}`);
  console.log(`  release_name ${info.release_name}`);
  console.log(`  asset_name   ${info.asset_name}`);
  console.log(`  tag          ${info.tag}`);
  console.log(`  prerelease   ${info.prerelease}`);
}
