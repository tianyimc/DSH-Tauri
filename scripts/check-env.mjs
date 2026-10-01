#!/usr/bin/env node
/*
 * DSHTauri 环境自检：node scripts/check-env.mjs
 *
 * 专门解决这个报错：
 *   failed to run 'cargo metadata' command ... No such file or directory (os error 2)
 *   rustup could not choose a version of cargo to run ... no default is configured
 * 两者都是「Rust 工具链没被正确暴露给当前 shell」，不是项目问题。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

let problems = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { problems += 1; console.log(`  ❌ ${m}`); };
const info = (m) => console.log(`     ${m}`);

function tryRun(cmd, args, env) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: env ? { ...process.env, ...env } : process.env,
    }).trim();
  } catch {
    return null;
  }
}

/** 候选的 (CARGO_HOME, RUSTUP_HOME) 组合 */
function toolchainCandidates() {
  const list = [];
  if (process.env.CARGO_HOME || process.env.RUSTUP_HOME) {
    list.push([process.env.CARGO_HOME, process.env.RUSTUP_HOME]);
  }
  list.push([join(homedir(), ".cargo"), join(homedir(), ".rustup")]);
  list.push([join(ROOT, ".toolchain", "cargo"), join(ROOT, ".toolchain", "rustup")]);
  return list.filter(([c]) => c && existsSync(join(c, "bin", `cargo${exe}`)));
}

console.log("DSHTauri 环境自检\n");

/* ---------------------------------------------------------------- Node */
console.log("[Node.js]");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 22) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node}（Tauri 2 需要 >= 22）`);

/* ---------------------------------------------------------------- cargo */
console.log("\n[Rust / cargo]");
let working = null; // { cargoHome, rustupHome, source }
let onPathVersion = tryRun("cargo", ["--version"]);

if (onPathVersion) {
  ok(`cargo 在 PATH 上：${onPathVersion}`);
  const r = tryRun("rustc", ["--version"]);
  if (r) ok(r);
  else bad("rustc 不在 PATH 上（cargo 在但 rustc 不在，通常 PATH 只加了一半）");
} else {
  const onPathButBroken = tryRun(isWin ? "where" : "which", ["cargo"]);
  if (onPathButBroken) {
    bad("PATH 上有 cargo，但它跑不起来（rustup 找不到默认工具链）");
    info("原因是 RUSTUP_HOME 没设或指向了空的 ~/.rustup");
  } else {
    bad("cargo 不在 PATH 上 —— 这就是 'cargo metadata ... No such file or directory' 的原因");
  }

  for (const [cargoHome, rustupHome] of toolchainCandidates()) {
    const v = tryRun(join(cargoHome, "bin", `cargo${exe}`), ["--version"], {
      CARGO_HOME: cargoHome,
      RUSTUP_HOME: rustupHome,
    });
    if (v) { working = { cargoHome, rustupHome, version: v }; break; }
  }

  if (working) {
    info("");
    info(`本机已装有可用的 Rust，只是没暴露给当前 shell：`);
    info(`  ${working.cargoHome}  (CARGO_HOME)`);
    info(`  ${working.rustupHome}  (RUSTUP_HOME)`);
    info(`  ${working.version}`);
    info("");
    info("修复方式（二选一）：");
    info("");
    if (isWin) {
      info("  【A】当前会话临时生效（PowerShell）");
      info(`      $env:CARGO_HOME  = "${working.cargoHome}"`);
      info(`      $env:RUSTUP_HOME = "${working.rustupHome}"`);
      info(`      $env:Path        = "${join(working.cargoHome, "bin")};$env:Path"`);
      info("");
      info("  【B】永久生效：把上面三行写进 $PROFILE，然后重开终端");
    } else {
      info("  【A】项目自带一键脚本（推荐，立刻生效）");
      info("      source scripts/env.sh");
      info("");
      info("  【B】手动 export（三个变量缺一不可）");
      info(`      export CARGO_HOME="${working.cargoHome}"`);
      info(`      export RUSTUP_HOME="${working.rustupHome}"`);
      info(`      export PATH="${join(working.cargoHome, "bin")}:$PATH"`);
      info("");
      info("      想每次开终端都生效：");
      info(`      echo 'export CARGO_HOME="${working.cargoHome}" RUSTUP_HOME="${working.rustupHome}"' >> ~/.bashrc`);
      info(`      echo 'export PATH="${join(working.cargoHome, "bin")}:$PATH"' >> ~/.bashrc`);
      info("      source ~/.bashrc");
    }
  } else {
    info("");
    info("本机没找到可用的 Rust 工具链，请先安装（之后重开终端）：");
    if (isWin) {
      info("  下载运行 https://win.rustup.rs/x86_64 ，完成后重开终端");
    } else {
      info("  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y");
      info('  source "$HOME/.cargo/env"');
    }
  }
}

/* ------------------------------------------------------------ tauri cli */
console.log("\n[Tauri CLI]");
const cli = join(ROOT, "node_modules", ".bin", `tauri${isWin ? ".cmd" : ""}`);
if (existsSync(cli)) ok("已安装：node_modules/.bin/tauri");
else bad("未安装，请先执行：npm install   （若 NODE_ENV=production 用 npm install --include=dev）");

/* ------------------------------------------------------------- frontend */
console.log("\n[前端资源]");
if (existsSync(join(ROOT, "src", "index.html"))) ok("src/index.html 存在");
else bad("src/index.html 缺失");

/* -------------------------------------------------------------- targets */
console.log("\n[构建目标]");
const rustupEnv = working
  ? { CARGO_HOME: working.cargoHome, RUSTUP_HOME: working.rustupHome }
  : undefined;
const rustupBin = working
  ? join(working.cargoHome, "bin", `rustup${exe}`)
  : "rustup";
const targets = tryRun(rustupBin, ["target", "list", "--installed"], rustupEnv) || "";
if (targets.includes("x86_64-pc-windows-msvc")) ok("已安装 x86_64-pc-windows-msvc");
else info("未安装 x86_64-pc-windows-msvc（Windows 产物由 GitHub Actions 构建，本地可不装）");
if (isWin) info("当前就是 Windows：可以直接 npm run tauri build -- --bundles nsis");

console.log(
  problems === 0
    ? "\n全部就绪，可以运行：npm run tauri dev\n"
    : `\n发现 ${problems} 个问题，按上面的提示处理后重试。\n`,
);
process.exit(problems === 0 ? 0 : 1);
