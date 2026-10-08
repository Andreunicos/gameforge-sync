//! Pasta da sala no PC (direto na pasta do usuário, ex.: C:\Users\André\games) e
//! atalhos para abri-la no VS Code, no Claude Code (terminal) ou no Explorer.

use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// Nomes que o Windows não deixa usar como pasta.
const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"];

fn home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|e| e.to_string())
}

/// A pasta pertence a esta sala? (vazia, ou com .gfs/state.json desta sala)
fn usable_for(dir: &Path, room_id: &str) -> bool {
    if !dir.exists() {
        return true;
    }
    let state = dir.join(".gfs").join("state.json");
    if let Ok(text) = std::fs::read_to_string(&state) {
        return serde_json::from_str::<serde_json::Value>(&text)
            .map(|v| v["roomId"].as_str() == Some(room_id))
            .unwrap_or(false);
    }
    std::fs::read_dir(dir).map(|mut it| it.next().is_none()).unwrap_or(false)
}

/// Escolhe, cria e libera (só para esta sessão) a pasta da sala dentro da pasta do usuário.
/// Se já existir uma pasta com esse nome que não é desta sala (ex.: "Documents"), usa nome-<id>.
#[tauri::command]
pub fn room_dir(app: tauri::AppHandle, slug: String, room_id: String) -> Result<String, String> {
    let ok_name = |s: &str| {
        !s.is_empty()
            && s.len() <= 60
            && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    let id: String = room_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect::<String>().to_lowercase();
    if !ok_name(&slug) || id.is_empty() {
        return Err("nome de sala inválido".into());
    }
    let home = home(&app)?;
    let mut candidates = vec![];
    if !RESERVED.contains(&slug.as_str()) {
        candidates.push(home.join(&slug));
    }
    candidates.push(home.join(format!("{slug}-{id}")));

    let dir = candidates
        .into_iter()
        .find(|d| usable_for(d, &room_id))
        .ok_or("já existe uma pasta com o nome desta sala que não é dela")?;
    std::fs::create_dir_all(dir.join(".gfs")).map_err(|e| e.to_string())?;
    // Libera esta pasta (e só ela) para o plugin de arquivos nesta sessão.
    let _ = app.fs_scope().allow_directory(&dir, true);
    Ok(dir.to_string_lossy().into_owned())
}

/// Só pastas de sala: filha direta da pasta do usuário (ou da antiga ~/GameForge) e com .gfs dentro.
pub(crate) fn check_room_dir(app: &tauri::AppHandle, dir: &str) -> Result<PathBuf, String> {
    let home = home(app)?;
    let target = PathBuf::from(dir);
    let parent_ok = target.parent() == Some(home.as_path()) || target.parent() == Some(home.join("GameForge").as_path());
    if !parent_ok || target.components().any(|c| matches!(c, Component::ParentDir)) || !target.join(".gfs").is_dir() {
        return Err("essa não é uma pasta de sala".into());
    }
    Ok(target)
}

#[tauri::command]
pub fn open_with(app: tauri::AppHandle, tool: String, dir: String) -> Result<(), String> {
    let target = check_room_dir(&app, &dir)?;
    spawn(&tool, &target)
}

#[cfg(windows)]
fn spawn(tool: &str, dir: &Path) -> Result<(), String> {
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
fn spawn(tool: &str, dir: &Path) -> Result<(), String> {
    use std::process::Command;
    let result = match tool {
        "vscode" => Command::new("code").arg(dir).spawn(),
        "folder" if cfg!(target_os = "macos") => Command::new("open").arg(dir).spawn(),
        "folder" => Command::new("xdg-open").arg(dir).spawn(),
        _ => return Err("disponível só no Windows por enquanto".into()),
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}
