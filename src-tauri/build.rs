use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();
    embed_version_info();
}

/// 把版本号编译进二进制，供托盘 tooltip 和前端「关于」信息使用。
///
/// - `A.B.C` 来自本 crate 的 `version`（即 `Cargo.toml`，与 `tauri.conf.json` 保持一致，
///   由 `node scripts/version.mjs --set` 一次性同步）。
/// - `GenX` 来自仓库根目录的 `version.json`。
///
/// 生成 `$OUT_DIR/version_info.rs`，由 `src/lib.rs` 用 `include!` 引入。
fn embed_version_info() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let generation_file = manifest_dir.join("..").join("version.json");
    println!("cargo:rerun-if-changed={}", generation_file.display());

    // 读不到 / 解析失败都退回 Gen1 —— 构建不应该因为版本号文件坏了而失败。
    let generation = fs::read_to_string(&generation_file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("generation").and_then(|g| g.as_u64()))
        .map(|g| g.max(1).min(u32::MAX as u64) as u32)
        .unwrap_or(1);

    let version = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string());

    // Gen1 不显示：v1.1.1；Gen2 起：v1.1.1 Gen2
    let display = if generation >= 2 {
        format!("v{version} Gen{generation}")
    } else {
        format!("v{version}")
    };

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let out_file = out_dir.join("version_info.rs");
    fs::write(
        &out_file,
        format!(
            "// 由 build.rs 生成，请勿手改。\n\
             pub const APP_VERSION: &str = {version:?};\n\
             pub const APP_GENERATION: u32 = {generation};\n\
             pub const APP_DISPLAY_VERSION: &str = {display:?};\n"
        ),
    )
    .expect("写入 version_info.rs 失败");
}
