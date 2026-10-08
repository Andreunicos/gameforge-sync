mod google;
mod builds;
mod launch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .invoke_handler(tauri::generate_handler![google::google_login, launch::open_with, launch::room_dir, builds::download_asset, builds::write_build_file, builds::reveal_build])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
