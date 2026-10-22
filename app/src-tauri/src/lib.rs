mod google;
mod builds;
mod launch;
mod rojo;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .manage(rojo::RojoState::default())
        .invoke_handler(tauri::generate_handler![google::google_login, launch::open_with, launch::room_dir, builds::download_asset, builds::write_build_file, builds::reveal_build, rojo::rojo_start, rojo::rojo_stop, rojo::rojo_info, rojo::rojo_install])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Não deixa `rojo serve` órfão quando o app fecha.
            if let tauri::RunEvent::Exit = event {
                tauri::Manager::state::<rojo::RojoState>(app).kill_all();
            }
        });
}
