#!/usr/bin/env node
/*
 * DSHTauri 版本号工具 —— 版本格式 v.A.B.C GenX
 *
 *   A    文集网页核心版本。只有网页核心发生重大变化时才提升。
 *   B    重要功能版本。当前 GUI 管理器属于重要更新，因此是 1.1.x。
 *   C    普通更新，例如小功能、优化和修复。
 *   GenX 同一个 C 小版本内部更小的修复快照（补丁位），只增不减。
 *
 * 硬性规则：
 *   - 一旦 C 提升（例如 1.1.10 → 1.1.11），Gen 立即重置为 1。
 *     不同 C 的 Gen 互不相干：`1.1.10 Gen3` 的下一版是 `1.1.11`（Gen1），不是 Gen4。
 *   - Gen1 不显示：显示 `v1.1.11`；从 Gen2 起显示 `v1.1.11 Gen2`、`v1.1.11 Gen3`。
 *   - 发布包文件名同理：Gen1 为 `DSHTauri-v1.1.11-setup.exe`，
 *     Gen2 起为 `DSHTauri-v1.1.11Gen2-setup.exe`，同一 C 的多代包不会互相覆盖。
 *
 * 数据来源（各自唯一，不重复维护）：
 *   A.B.C  ->  src-tauri/tauri.conf.json 的 version（与 Cargo.toml / package.json 同步）
 *   GenX   ->  version.json 的 generation
 *
 * 用法：
 *   node scripts/version.mjs                 人读输出
 *   node scripts/version.mjs --json          JSON（供脚本消费）
 *   node scripts/version.mjs --github        写入 $GITHUB_OUTPUT（供 Actions 用）
 *   node scripts/version.mjs --bump-gen      同一个 C 内做新快照：generation +1
 *   node scripts/version.mjs --set 1.2.0     改 A.B.C，并把 generation 重置为 1
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

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function readGeneration() {
  try {
    const gen = readJson(VERSION_JSON).generation;
    return Number.isInteger(gen) && gen >= 1 ? gen : 1;
  } catch {
    return 1;
  }
}

function writeGeneration(generation) {
  writeFileSync(VERSION_JSON, `${JSON.stringify({ generation }, null, 2)}\n`);
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

function describe(version, generation) {
  const genSuffix = generation >= 2 ? `Gen${generation}` : "";
  const genSuffixSpaced = generation >= 2 ? ` Gen${generation}` : "";
  return {
    version,
    generation,
    // 显示用：Gen1 不显示
    display: `v${version}${genSuffixSpaced}`,
    // 发布包 / artifact 名：Gen1 不带后缀
    release_name: `${APP}-v${version}${genSuffix}`,
    // 安装包文件名
    asset_name: `${APP}-v${version}${genSuffix}-setup.exe`,
    // Git tag / Release tag：同一 C 的多代必须能共存
    tag: `v${version}${genSuffix}`,
    title: `${APP} v${version}${genSuffixSpaced}`,
  };
}

/* -------------------------------------------------------------------- main */

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has("--set")) {
  const next = args[args.indexOf("--set") + 1];
  if (!/^\d+\.\d+\.\d+$/.test(next || "")) {
    console.error(`--set 需要 A.B.C 形式，例如 1.2.0（收到：${next}）`);
    process.exit(1);
  }
  writeVersion(next);
  // 硬性规则：C 提升 -> Gen 立刻重置为 1
  writeGeneration(1);
  console.log(`[DSHTauri] 版本已设为 ${next}，generation 重置为 1`);
}

if (has("--bump-gen")) {
  const next = readGeneration() + 1;
  writeGeneration(next);
  console.log(`[DSHTauri] 同一个 C 内的新快照：generation -> ${next}`);
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

const info = describe(version, readGeneration());

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
  console.log(`  generation   ${info.generation}${info.generation === 1 ? "（不显示）" : ""}`);
  console.log(`  display      ${info.display}`);
  console.log(`  release_name ${info.release_name}`);
  console.log(`  asset_name   ${info.asset_name}`);
  console.log(`  tag          ${info.tag}`);
}
