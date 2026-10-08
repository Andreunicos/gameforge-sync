fn main() {
    // Lista explícita dos comandos do app: só os liberados nas capabilities podem ser chamados
    // (a tela vem do site gameforge-sync.web.app, então nada fica liberado por padrão).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["google_login", "open_with", "room_dir", "download_asset", "write_build_file", "reveal_build"])),
    )
    .expect("failed to run tauri-build");
}
