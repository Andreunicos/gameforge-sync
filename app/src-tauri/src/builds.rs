//! Baixa os arquivos de um build (release privada no GitHub) para <sala>\builds\<data> e abre a pasta.

use std::io::copy;
use std::path::{Path, PathBuf};

use crate::launch::check_room_dir;

/// Só aceita <pasta da sala>\builds\<algo>.
fn check_build_dir(app: &tauri::AppHandle, dir: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(dir);
    let builds = target.parent().ok_or("pasta de build inválida")?;
    if builds.file_name().and_then(|n| n.to_str()) != Some("builds") {
        return Err("pasta de build inválida".into());
    }
    let room = builds.parent().ok_or("pasta de build inválida")?;
    check_room_dir(app, &room.to_string_lossy())?;
    let leaf = target.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if leaf.is_empty() || leaf.contains("..") {
        return Err("pasta de build inválida".into());
    }
    Ok(target)
}

fn fetch(url: &str, token: Option<&str>, accept: &str) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let mut req = agent.get(url).set("Accept", accept).set("User-Agent", "GameForge-Sync");
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    match req.call() {
        Ok(r) => Ok(r),
        Err(ureq::Error::Status(code, r)) => Err(format!("GitHub respondeu {code}: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn download_asset(app: tauri::AppHandle, url: String, token: String, dir: String, name: String) -> Result<u64, String> {
    let dir = check_build_dir(&app, &dir)?;
    if name.is_empty() || name.contains(['/', '\']) || name.contains("..") {
        return Err("nome de arquivo inválido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // A API devolve um redirecionamento para um link temporário: o token não vai junto para lá.
        let first = fetch(&url, Some(&token), "application/octet-stream")?;
        let resp = if (300..400).contains(&first.status()) {
            let loc = first.header("location").ok_or("redirecionamento sem destino")?.to_string();
            fetch(&loc, None, "application/octet-stream")?
        } else {
            first
        };
        let path = dir.join(&name);
        let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        copy(&mut resp.into_reader(), &mut file).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Grava um arquivo de texto do build Web (o app gera o .html na hora).
#[tauri::command]
pub fn write_build_file(app: tauri::AppHandle, dir: String, name: String, content: String) -> Result<(), String> {
    let dir = check_build_dir(&app, &dir)?;
    let rel = Path::new(&name);
    if name.is_empty() || rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err("nome de arquivo inválido".into());
    }
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_build(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let dir = check_build_dir(&app, &dir)?;
    std::process::Command::new(if cfg!(windows) { "explorer" } else { "xdg-open" })
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
