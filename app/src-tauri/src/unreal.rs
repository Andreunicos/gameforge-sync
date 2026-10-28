//! Salas Unreal: achar a engine instalada, abrir o editor no projeto da sala (MCP ligado e, se pedido, já entrando
//! na sessão do Multi-User Editing) e subir/derrubar o servidor do Multi-User no PC de quem hospeda.
//! Nomes das flags conferidos no código da 5.8 (ConcertSyncClientModule.cpp, ConcertSyncServerModule.cpp,
//! UdpMessagingModule.cpp, ModelContextProtocolSettings.cpp).

use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

use crate::launch::check_room_dir;
use crate::rojo::quiet;

/// Servidores do Multi-User que este app abriu (pasta da sala → processo). Só estes são encerrados.
#[derive(Default)]
pub struct UnrealState(Mutex<HashMap<String, Child>>);

impl UnrealState {
    /// Fecha os servidores que o app abriu (ao sair do app). Nunca mexe em outro UnrealMultiUserServer.
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, child) in map.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            map.clear();
        }
    }
}

#[derive(serde::Serialize)]
pub struct Engine {
    root: String,
    version: String,
}

/// "5.8.1" lido de Engine/Build/Build.version; None se a pasta não é uma engine com editor.
fn engine_version(root: &Path) -> Option<String> {
    if !root.join("Engine").join("Binaries").join("Win64").join("UnrealEditor.exe").is_file() {
        return None;
    }
    let text = std::fs::read_to_string(root.join("Engine").join("Build").join("Build.version")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(format!("{}.{}.{}", v["MajorVersion"].as_u64()?, v["MinorVersion"].as_u64()?, v["PatchVersion"].as_u64().unwrap_or(0)))
}

/// Engines instaladas: as do Epic Games Launcher (LauncherInstalled.dat), as pastas padrão UE_* e a que a pessoa indicou.
#[tauri::command]
pub fn unreal_engines(extra: Option<String>) -> Vec<Engine> {
    let mut roots: Vec<PathBuf> = vec![];
    if let Some(p) = extra.filter(|p| !p.trim().is_empty()) {
        roots.push(PathBuf::from(p.trim()));
    }
    let program_data = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    if let Ok(text) = std::fs::read_to_string(program_data.join("Epic").join("UnrealEngineLauncher").join("LauncherInstalled.dat")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            for item in v["InstallationList"].as_array().into_iter().flatten() {
                if item["AppName"].as_str().is_some_and(|n| n.starts_with("UE_")) {
                    if let Some(loc) = item["InstallLocation"].as_str() {
                        roots.push(PathBuf::from(loc));
                    }
                }
            }
        }
    }
    for base in [std::env::var_os("ProgramFiles"), Some(r"C:\Program Files".into())].into_iter().flatten() {
        if let Ok(dir) = std::fs::read_dir(PathBuf::from(base).join("Epic Games")) {
            roots.extend(dir.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("UE_"))));
        }
    }
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|r| seen.insert(r.to_string_lossy().to_lowercase().trim_end_matches(['\\', '/']).to_string()))
        .filter_map(|r| engine_version(&r).map(|version| Engine { root: r.to_string_lossy().into_owned(), version }))
        .collect()
}

fn engine_exe(root: &str, exe: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    engine_version(&root).ok_or("essa pasta não é uma instalação do Unreal (falta Engine\\Binaries\\Win64\\UnrealEditor.exe)")?;
    let p = root.join("Engine").join("Binaries").join("Win64").join(exe);
    if p.is_file() {
        Ok(p)
    } else {
        Err(format!("{exe} não existe nesta instalação do Unreal"))
    }
}

/// O único .uproject na raiz da pasta da sala.
fn uproject(room: &Path) -> Result<PathBuf, String> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(room)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("uproject")))
        .collect();
    match found.len() {
        0 => Err("SEM_UPROJECT".into()),
        1 => Ok(found.remove(0)),
        _ => Err("há mais de um .uproject na pasta da sala: deixe só um".into()),
    }
}

/// Nome de sessão/servidor/pessoa: só letras, números, _ e - (vão na linha de comando; espaço cortaria o valor).
fn name_ok(s: &str, max: usize) -> Result<&str, String> {
    if !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Ok(s)
    } else {
        Err(format!("nome inválido: \"{s}\" (use só letras sem acento, números, _ e -, até {max})"))
    }
}

/// "host:porta" (IP ou nome de máquina).
fn addr_ok(s: &str) -> Result<&str, String> {
    let (host, port) = s.rsplit_once(':').ok_or_else(|| format!("endereço inválido: \"{s}\" (use IP:porta, ex.: 100.64.0.5:6666)"))?;
    let host_ok = !host.is_empty() && host.len() <= 100 && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if host_ok && port.parse::<u16>().is_ok_and(|p| p > 0) {
        Ok(s)
    } else {
        Err(format!("endereço inválido: \"{s}\" (use IP:porta, ex.: 100.64.0.5:6666)"))
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Concert {
    server: String,
    session: String,
    display_name: String,
    /// IP:porta do servidor, para quem está em outra rede (VPN). Vazio = descoberta automática na rede local.
    static_addr: String,
}

/// Abre o editor no .uproject da sala com o MCP ligado na porta dada e, se `concert` vier, entrando na sessão do
/// Multi-User. O editor é da pessoa: o app não o acompanha nem o fecha. Devolve o nome do .uproject.
#[tauri::command]
pub fn unreal_open(app: tauri::AppHandle, dir: String, root: String, mcp_port: u16, concert: Option<Concert>) -> Result<String, String> {
    let room = check_room_dir(&app, &dir)?;
    let project = uproject(&room)?;
    let exe = engine_exe(&root, "UnrealEditor.exe")?;
    if mcp_port < 1024 {
        return Err("porta do MCP inválida (use 1024 a 65535)".into());
    }
    let mut cmd = Command::new(exe);
    cmd.arg(&project).arg("-ModelContextProtocolStartServer").arg(format!("-ModelContextProtocolPort={mcp_port}"));
    if let Some(c) = concert {
        cmd.arg("-ConcertAutoConnect")
            .arg("-ConcertRetryAutoConnectOnError")
            .arg(format!("-ConcertServer={}", name_ok(&c.server, 60)?))
            .arg(format!("-ConcertSession={}", name_ok(&c.session, 60)?))
            .arg(format!("-ConcertDisplayName={}", name_ok(&c.display_name, 32)?));
        if !c.static_addr.is_empty() {
            cmd.arg(format!("-UDPMESSAGING_TRANSPORT_STATIC={}", addr_ok(&c.static_addr)?));
        }
    }
    cmd.current_dir(&room).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    Ok(project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// Sobe o servidor do Multi-User (sem janela, log em .gfs/mue-server.log) com a sessão já criada.
/// `unicast` = IP:porta fixa deste PC na VPN (vazio = rede local, porta automática).
#[tauri::command]
pub async fn unreal_server_start(app: tauri::AppHandle, dir: String, root: String, server: String, session: String, unicast: String) -> Result<(), String> {
    // Fora da thread da janela: a espera de 1,5 s abaixo não pode travar a tela.
    tauri::async_runtime::spawn_blocking(move || server_start(&app, dir, &root, &server, &session, &unicast)).await.map_err(|e| e.to_string())?
}

fn running(state: &UnrealState, dir: &str) -> bool {
    state.0.lock().map(|mut map| matches!(map.get_mut(dir).map(|c| c.try_wait()), Some(Ok(None)))).unwrap_or(false)
}

fn server_start(app: &tauri::AppHandle, dir: String, root: &str, server: &str, session: &str, unicast: &str) -> Result<(), String> {
    let state = app.state::<UnrealState>();
    let room = check_room_dir(app, &dir)?;
    let project = uproject(&room)?;
    let exe = engine_exe(root, "UnrealMultiUserServer.exe")?;
    if running(&state, &dir) {
        return Ok(());
    }
    let mut args = vec![
        format!("-CONCERTSERVER={}", name_ok(server, 60)?),
        format!("-CONCERTSESSION={}", name_ok(session, 60)?),
    ];
    // A sessão só aceita editores de um projeto com este nome (ConcertSettings.h compara o nome do .uproject).
    let stem = project.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    args.push(format!("-CONCERTPROJECT={}", name_ok(&stem, 100).map_err(|_| "o nome do .uproject precisa ser só letras sem acento, números, _ e -".to_string())?));
    if !unicast.is_empty() {
        let a = addr_ok(unicast)?;
        let port: u16 = a.rsplit_once(':').and_then(|(_, p)| p.parse().ok()).unwrap_or(0);
        if UdpSocket::bind(("0.0.0.0", port)).is_err() {
            return Err(format!("a porta UDP {port} já está em uso neste PC (outro servidor do Multi-User aberto?). Feche-o ou escolha outra porta."));
        }
        args.push(format!("-UDPMESSAGING_TRANSPORT_UNICAST={a}"));
    }
    let log_path = room.join(".gfs").join("mue-server.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = quiet(Command::new(exe).args(&args))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| e.to_string())?;
    // Se cair logo ao subir (porta, sessão inválida), devolve a última linha do log.
    std::thread::sleep(Duration::from_millis(1500));
    if let Ok(Some(_)) = child.try_wait() {
        let why = std::fs::read_to_string(&log_path).unwrap_or_default();
        return Err(format!("o servidor do Multi-User fechou ao iniciar: {}", why.trim().lines().last().unwrap_or("sem mensagem")));
    }
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if matches!(map.get_mut(&dir).map(|c| c.try_wait()), Some(Ok(None))) {
        // Dois cliques ao mesmo tempo: fica o primeiro, este (que o app acabou de abrir) fecha.
        let _ = child.kill();
        let _ = child.wait();
        return Ok(());
    }
    map.insert(dir, child);
    Ok(())
}

/// Derruba o servidor do Multi-User que este app abriu para esta sala (pelo processo, nunca pelo nome).
#[tauri::command]
pub fn unreal_server_stop(state: State<UnrealState>, dir: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = map.remove(&dir) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct UnrealStatus {
    /// Algo responde na porta do MCP (o editor com o Unreal MCP ligado, ou outro programa nessa porta).
    mcp: bool,
    /// O servidor do Multi-User que este app abriu para esta sala está rodando.
    server: bool,
}

#[tauri::command]
pub fn unreal_status(state: State<UnrealState>, dir: String, mcp_port: u16) -> UnrealStatus {
    let mcp = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], mcp_port)), Duration::from_millis(300)).is_ok();
    UnrealStatus { mcp, server: running(&state, &dir) }
}

/// Abre o Content/ da sala no app do Diversion (`dv view`). O `dv` devolve 0 mesmo quando falha (testado na 1.6.795),
/// então antes conferimos com `dv status`, que sai com código diferente de 0 fora de uma pasta do Diversion.
pub(crate) fn diversion_view(app: &tauri::AppHandle, room: &Path) -> Result<(), String> {
    let content = room.join("Content");
    if !content.is_dir() {
        return Err("a sala ainda não tem a pasta Content/".into());
    }
    let mut dv = vec![PathBuf::from("dv")];
    if let Ok(home) = app.path().home_dir() {
        dv.push(home.join(".diversion").join("bin").join("dv.exe"));
    }
    let dv = dv
        .into_iter()
        .find(|p| quiet(Command::new(p).arg("--version")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok())
        .ok_or("o Diversion (dv) não está instalado neste PC")?;
    let code = quiet(Command::new(&dv).args(["status", "--sync-only", "--nowait"]))
        .current_dir(&content)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?
        .code()
        .unwrap_or(-1);
    if code != 0 {
        return Err(format!("o Content/ desta sala não é uma pasta do Diversion (dv status saiu com código {code}). Veja o passo a passo no painel."));
    }
    quiet(Command::new(&dv).arg("view")).current_dir(&content).stdin(Stdio::null()).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_e_enderecos() {
        assert!(name_ok("gameforge", 60).is_ok());
        assert!(name_ok("Andre_Luiz-2", 32).is_ok());
        for bad in ["", "com espaco", "acentuação", "a\"b", "-x=1 -y", &"x".repeat(33)] {
            assert!(name_ok(bad, 32).is_err(), "{bad}");
        }
        assert!(addr_ok("100.64.0.5:6666").is_ok());
        assert!(addr_ok("pc-do-andre:55000").is_ok());
        for bad in ["100.64.0.5", "1.2.3.4:0", "1.2.3.4:70000", ":6666", "a b:1", "1.2.3.4:66 -x"] {
            assert!(addr_ok(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn versao_da_engine() {
        let root = std::env::temp_dir().join(format!("gfs-ue-test-{}", std::process::id()));
        let bin = root.join("Engine").join("Binaries").join("Win64");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join("Engine").join("Build")).unwrap();
        assert_eq!(engine_version(&root), None, "sem UnrealEditor.exe");
        std::fs::write(bin.join("UnrealEditor.exe"), b"").unwrap();
        std::fs::write(root.join("Engine").join("Build").join("Build.version"), r#"{"MajorVersion":5,"MinorVersion":8,"PatchVersion":1}"#).unwrap();
        assert_eq!(engine_version(&root).as_deref(), Some("5.8.1"));
        let found = unreal_engines(Some(root.to_string_lossy().into_owned()));
        assert_eq!(found[0].root, root.to_string_lossy());
        assert!(engine_exe(&root.to_string_lossy(), "UnrealMultiUserServer.exe").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
