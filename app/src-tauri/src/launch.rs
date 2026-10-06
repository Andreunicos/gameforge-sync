//! Abre a pasta sincronizada da sala no VS Code, no Claude Code (terminal) ou no Explorer.

use std::path::{Component, PathBuf};
use tauri::Manager;

#[tauri::command]
pub fn open_with(app: tauri::AppHandle, tool: String, dir: String) -> Result<(), String> {
    // Só abre pastas dentro de ~/GameForge (nada de caminho arbitrário vindo do front).
    let base = app.path().home_dir().map_err(|e| e.to_string())?.join("GameForge");
    let target = PathBuf::from(&dir);
    if !target.starts_with(&base) || target.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("pasta fora de GameForge".into());
    }
    if !target.is_dir() {
        return Err("a pasta ainda não existe".into());
    }
    spawn(&tool, &target)
}

#[cfg(windows)]
fn spawn(tool: &str, dir: &PathBuf) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let result = match tool {
        // Terminal novo já na pasta, rodando o Claude Code.
        "claude" => Command::new("cmd")
            .args(["/c", "start", "Claude Code", "/D"])
            .arg(dir)
            .args(["cmd", "/k", "claude"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        // VS Code na pasta e, quando a janela estiver de pé, a conversa do Claude Code
        // (a extensão da Anthropic atende o link vscode://anthropic.claude-code/open).
        "vscode" => Command::new("cmd")
            .args(["/c", "code"])
            .arg(dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|child| {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(4000));
                    let _ = Command::new("cmd")
                        .args(["/c", "start", "", "vscode://anthropic.claude-code/open"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn();
                });
                child
            }),
        "folder" => Command::new("explorer").arg(dir).spawn(),
        _ => return Err("ferramenta desconhecida".into()),
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn spawn(tool: &str, dir: &PathBuf) -> Result<(), String> {
    use std::process::Command;
    let result = match tool {
        "vscode" => Command::new("code").arg(dir).spawn(),
        "folder" if cfg!(target_os = "macos") => Command::new("open").arg(dir).spawn(),
        "folder" => Command::new("xdg-open").arg(dir).spawn(),
        _ => return Err("disponível só no Windows por enquanto".into()),
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}
