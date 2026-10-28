mod google;
mod builds;
mod launch;
mod rojo;
mod unreal;

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
        .manage(unreal::UnrealState::default())
        .invoke_handler(tauri::generate_handler![google::google_login, launch::open_with, launch::room_dir, builds::download_asset, builds::write_build_file, builds::reveal_build, rojo::rojo_start, rojo::rojo_stop, rojo::rojo_info, rojo::rojo_install, unreal::unreal_engines, unreal::unreal_open, unreal::unreal_server_start, unreal::unreal_server_stop, unreal::unreal_status])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Não deixa `rojo serve` nem o servidor do Multi-User órfãos quando o app fecha.
            if let tauri::RunEvent::Exit = event {
                tauri::Manager::state::<rojo::RojoState>(app).kill_all();
                tauri::Manager::state::<unreal::UnrealState>(app).kill_all();
            }
        });
}
