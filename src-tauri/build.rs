use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();
    embed_version_info();
}

/// 把版本号 / 发布渠道编译进二进制，供托盘 tooltip 和前端「关于」信息使用。
///
/// - `A.B.C` 来自本 crate 的 `version`（即 `Cargo.toml`，与 `tauri.conf.json` 保持一致，
///   由 `node scripts/version.mjs --set` 一次性同步）。
/// - `channel` 来自仓库根目录的 `version.json`：`"release"` 或 `"rc"`，
///   缺失 / 未知一律当作 `"release"`。
///
/// 生成 `$OUT_DIR/version_info.rs`，由 `src/lib.rs` 用 `include!` 引入。
/// 历史说明：旧的多快照代次机制**已取消**，不再生成代次常量。
fn embed_version_info() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let channel_file = manifest_dir.join("..").join("version.json");
    println!("cargo:rerun-if-changed={}", channel_file.display());

    // 读不到 / 解析失败 / 值未知都退回 release —— 构建不应该因为版本号文件坏了而失败。
    let channel = fs::read_to_string(&channel_file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("channel").and_then(|c| c.as_str()).map(String::from))
        .filter(|c| c == "release" || c == "rc")
        .unwrap_or_else(|| "release".to_string());

    let version = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string());

    // 正式版不显示后缀：`v.0.3.2`；候选版：`v.0.3.2 RC`
    let display = if channel == "rc" {
        format!("v.{version} RC")
    } else {
        format!("v.{version}")
    };

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let out_file = out_dir.join("version_info.rs");
    fs::write(
        &out_file,
        format!(
            "// 由 build.rs 生成，请勿手改。\n\
             pub const APP_VERSION: &str = {version:?};\n\
             pub const APP_CHANNEL: &str = {channel:?};\n\
             pub const APP_DISPLAY_VERSION: &str = {display:?};\n"
        ),
    )
    .expect("写入 version_info.rs 失败");
}
