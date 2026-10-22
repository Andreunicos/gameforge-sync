//! Servidor do Rojo (salas de Roblox): `rojo serve` na pasta da sala, sem janela, uma porta por sala.
//! O plugin do Rojo no Roblox Studio conecta em localhost:<porta> e recebe o que a pasta sincronizada tem.

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};

use crate::launch::check_room_dir;

#[derive(Default)]
pub struct RojoState(Mutex<HashMap<String, (Child, u16)>>);

impl RojoState {
    /// Fecha todos os servidores (ao sair do app).
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, (child, _)) in map.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            map.clear();
        }
    }
}

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// `rojo` no PATH, ou nos lugares onde o winget e o Rokit o instalam.
fn find_rojo(app: &tauri::AppHandle) -> Option<PathBuf> {
    let works = |p: &PathBuf| quiet(Command::new(p).arg("--version")).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    let exe = if cfg!(windows) { "rojo.exe" } else { "rojo" };
    let mut candidates = vec![PathBuf::from("rojo")];
    if let Ok(home) = app.path().home_dir() {
        candidates.push(home.join(".rokit").join("bin").join(exe));
        candidates.push(home.join(".aftman").join("bin").join(exe));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links").join(exe));
    }
    candidates.into_iter().find(works)
}

/// Primeira porta livre a partir da preferida (uma por sala, para não bater com outro Rojo aberto).
fn free_port(start: u16) -> Option<u16> {
    (start..start.saturating_add(200)).find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
}

/// Liga o Rojo de um local (pasta `place` dentro da sala). Devolve a porta usada (se já estava ligado, a mesma de antes).
#[tauri::command]
pub fn rojo_start(app: tauri::AppHandle, state: State<RojoState>, dir: String, place: String, port: u16) -> Result<u16, String> {
    let room = check_room_dir(&app, &dir)?;
    // `place` é uma pasta direta da sala: nada de caminhos, ".." ou pastas do próprio app.
    if place.is_empty() || place.starts_with('.') || !place.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("nome de local inválido".into());
    }
    let target = room.join(&place);
    if !target.join("default.project.json").is_file() {
        return Err("default.project.json ainda não chegou na pasta".into());
    }
    let key = format!("{dir}|{place}");
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some((child, p)) = map.get_mut(&key) {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(*p);
        }
        map.remove(&key);
    }
    let rojo = find_rojo(&app).ok_or("ROJO_NAO_ENCONTRADO")?;
    let port = free_port(port).ok_or("nenhuma porta livre para o Rojo")?;
    let log_path = room.join(".gfs").join(format!("rojo-{place}.log"));
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = quiet(Command::new(rojo).args(["serve", "default.project.json", "--port", &port.to_string()]))
        .current_dir(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| e.to_string())?;
    // Se o Rojo cair logo ao subir (projeto inválido, porta ocupada), devolve o motivo.
    std::thread::sleep(std::time::Duration::from_millis(700));
    if let Ok(Some(_)) = child.try_wait() {
        let why = std::fs::read_to_string(&log_path).unwrap_or_default();
        return Err(format!("o Rojo fechou ao iniciar: {}", why.trim().lines().last().unwrap_or("sem mensagem")));
    }
    map.insert(key, (child, port));
    Ok(port)
}

/// Desliga os Rojos de uma sala (todos os locais).
#[tauri::command]
pub fn rojo_stop(state: State<RojoState>, dir: String) -> Result<(), String> {
    let prefix = format!("{dir}|");
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let keys: Vec<String> = map.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    for k in keys {
        if let Some((mut child, _)) = map.remove(&k) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

// ── instalar / atualizar o Rojo (mesmo caminho manual: winget + `rojo plugin install`) ──

#[derive(serde::Serialize)]
pub struct RojoInfo {
    version: Option<String>,
    plugin: bool,
}

fn rojo_version(rojo: &PathBuf) -> Option<String> {
    let out = quiet(Command::new(rojo).arg("--version")).output().ok()?;
    // "Rojo 7.7.1" -> "7.7.1"
    String::from_utf8_lossy(&out.stdout).split_whitespace().last().map(str::to_string)
}

/// Plugin que o `rojo plugin install` grava na pasta de plugins do Studio.
fn plugin_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Roblox").join("Plugins").join("RojoManagedPlugin.rbxm"))
}

/// O que há neste PC: versão do Rojo (se achar) e se o plugin do Studio está instalado.
#[tauri::command]
pub fn rojo_info(app: tauri::AppHandle) -> RojoInfo {
    RojoInfo {
        version: find_rojo(&app).and_then(|r| rojo_version(&r)),
        plugin: plugin_file().map(|p| p.is_file()).unwrap_or(false),
    }
}

// Códigos do winget que significam "já está certo": 0, sem atualização disponível (0x8A15002B), já instalado (0x8A150061).
const WINGET_OK: [i32; 3] = [0, -1978335189, -1978335135];

fn winget(verb: &str) -> Result<i32, String> {
    quiet(Command::new("winget").args([
        verb,
        "--id",
        "Rojo.Rojo",
        "-e",
        "--source",
        "winget",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
    ]))
    .stdin(Stdio::null())
    .output()
    .map(|o| o.status.code().unwrap_or(-1))
    .map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "O winget não foi encontrado neste PC. Atualize o Windows ou instale o \"App Installer\" na Microsoft Store.".to_string(),
        _ => e.to_string(),
    })
}

/// Instala (ou atualiza) o Rojo pelo winget e reinstala o plugin do Studio na mesma versão. Pode levar um minuto.
#[tauri::command]
pub async fn rojo_install(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app)).await.map_err(|e| e.to_string())?
}

fn install(app: &tauri::AppHandle) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("A instalação automática é só para Windows. Veja https://rojo.space/docs para instalar.".into());
    }
    let had = find_rojo(app).is_some();
    let mut code = winget(if had { "upgrade" } else { "install" })?;
    if !WINGET_OK.contains(&code) && had {
        code = winget("install")?; // o Rojo que existe não veio do winget
    }
    if !WINGET_OK.contains(&code) {
        return Err(format!(
            "O winget não conseguiu instalar o Rojo (código {code:#x}). Se houver um \"rojo serve\" aberto em outra janela (PowerShell), feche e tente de novo."
        ));
    }
    // A fonte da verdade é o próprio rojo.exe: o PATH deste app não enxerga a instalação recém-feita, então procuramos nos lugares conhecidos.
    let rojo = find_rojo(app).ok_or("O Rojo foi instalado, mas não achei o rojo.exe. Feche e abra o GameForge e tente de novo.")?;
    let version = rojo_version(&rojo).unwrap_or_else(|| "?".into());
    let plugin = quiet(Command::new(&rojo).args(["plugin", "install"])).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !plugin.status.success() {
        return Err(format!("Rojo {version} instalado, mas o plugin do Studio falhou: {}", String::from_utf8_lossy(&plugin.stderr).trim()));
    }
    Ok(format!("Rojo {version} e o plugin do Studio instalados. Se o Roblox Studio estiver aberto, feche e abra de novo."))
}
