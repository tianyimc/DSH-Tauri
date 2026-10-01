// Windows release 构建不弹控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dshtauri_lib::run()
}
