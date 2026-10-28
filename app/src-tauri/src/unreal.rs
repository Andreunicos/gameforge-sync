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

    /// Este app tem um servidor do Multi-User rodando (fechar o app derruba a sessão de todos).
    pub fn hosting(&self) -> bool {
        self.0.lock().map(|mut map| map.values_mut().any(|c| matches!(c.try_wait(), Ok(None)))).unwrap_or(false)
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
#[tauri::command(async)]
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

/// Pastas onde o projeto nunca está (geradas, binárias, da sala): a busca nem entra. Igual a UE_PROJECT_SKIP (fileKinds.ts).
const SKIP: [&str; 8] = ["node_modules", "intermediate", "saved", "deriveddatacache", "binaries", "builds", "content", "build"];

/// Arquivos .uproject de uma pasta (link simbólico/junção não conta: `file_type` não segue o link).
fn uprojects(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("uproject")))
        .map(|e| e.path())
        .collect()
}

/// Pastas da sala com .uproject (relativas, com "/"; "" = raiz): a raiz e subpastas até 2 níveis (o Unreal cria o projeto
/// numa pasta com o nome dele). Não entra em pasta com ponto, nas de SKIP nem em link/junção (nada fora da sala). Raiz primeiro.
fn projects(room: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut todo = vec![(String::new(), room.to_path_buf(), 0)];
    while let Some((rel, dir, depth)) = todo.pop() {
        if !uprojects(&dir).is_empty() {
            out.push(rel.clone());
        }
        if depth == 2 {
            continue;
        }
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().is_ok_and(|t| t.is_dir()) && !name.starts_with('.') && !SKIP.contains(&name.to_lowercase().as_str()) {
                let sub = if rel.is_empty() { name } else { format!("{rel}/{name}") };
                todo.push((sub, e.path(), depth + 1));
            }
        }
    }
    out.sort_by_key(|r| (!r.is_empty(), r.to_lowercase()));
    out
}

/// O projeto da sala: (pasta do projeto, .uproject). `want` = a pasta que a tela escolheu (relativa à sala, "" = raiz): só
/// vale se for uma das que a busca achou (assim `..`, caminho absoluto ou link para fora nunca passam). Sem `want` (tela
/// antiga): a da raiz, senão a única.
fn project(room: &Path, want: Option<&str>) -> Result<(PathBuf, PathBuf), String> {
    let found = projects(room);
    let rel = match want {
        Some(w) => {
            let w = w.replace('\\', "/").trim_matches('/').to_lowercase();
            found.into_iter().find(|f| f.to_lowercase() == w).ok_or("esse projeto não está na pasta da sala (foi movido ou apagado?)")?
        }
        None if found.iter().any(|f| f.is_empty()) => String::new(),
        None if found.len() == 1 => found[0].clone(),
        None if found.is_empty() => return Err("SEM_UPROJECT".into()),
        None => return Err(format!("há mais de um projeto na pasta da sala ({}): escolha qual no 🔌 Conectar Unreal", found.join(", "))),
    };
    let dir = rel.split('/').filter(|s| !s.is_empty()).fold(room.to_path_buf(), |p, s| p.join(s));
    // Defesa extra: com os links resolvidos, a pasta do projeto continua dentro da sala.
    match (room.canonicalize(), dir.canonicalize()) {
        (Ok(r), Ok(d)) if d.starts_with(&r) => {}
        _ => return Err("o projeto está fora da pasta da sala".into()),
    }
    let mut ups = uprojects(&dir);
    match ups.len() {
        1 => Ok((dir, ups.remove(0))),
        0 => Err("SEM_UPROJECT".into()),
        _ => Err(format!("há mais de um .uproject em {}: deixe só um", if rel.is_empty() { "a pasta da sala".into() } else { rel })),
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
/// `project` = pasta do projeto relativa à sala ("" = raiz; ausente = tela antiga, acha sozinho).
#[tauri::command(async)]
pub fn unreal_open(app: tauri::AppHandle, dir: String, root: String, mcp_port: u16, concert: Option<Concert>, project: Option<String>) -> Result<String, String> {
    let room = check_room_dir(&app, &dir)?;
    let (project_dir, project) = self::project(&room, project.as_deref())?;
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
    cmd.current_dir(&project_dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    Ok(project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// Sobe o servidor do Multi-User (sem janela, log em .gfs/mue-server.log) com a sessão já criada.
/// `unicast` = IP:porta fixa deste PC na VPN (vazio = rede local, porta automática).
#[tauri::command]
pub async fn unreal_server_start(app: tauri::AppHandle, dir: String, root: String, server: String, session: String, unicast: String, project: Option<String>) -> Result<(), String> {
    // Fora da thread da janela: a espera de 1,5 s abaixo não pode travar a tela.
    tauri::async_runtime::spawn_blocking(move || server_start(&app, dir, &root, &server, &session, &unicast, project.as_deref())).await.map_err(|e| e.to_string())?
}

fn running(state: &UnrealState, dir: &str) -> bool {
    state.0.lock().map(|mut map| matches!(map.get_mut(dir).map(|c| c.try_wait()), Some(Ok(None)))).unwrap_or(false)
}

fn server_start(app: &tauri::AppHandle, dir: String, root: &str, server: &str, session: &str, unicast: &str, want: Option<&str>) -> Result<(), String> {
    let state = app.state::<UnrealState>();
    let room = check_room_dir(app, &dir)?;
    let (_, project) = project(&room, want)?;
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
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn unreal_status(state: State<UnrealState>, dir: String, mcp_port: u16) -> UnrealStatus {
    let mcp = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], mcp_port)), Duration::from_millis(300)).is_ok();
    UnrealStatus { mcp, server: running(&state, &dir) }
}

/// Abre o Content/ do projeto no app do Diversion (`dv view`). O `dv` devolve 0 mesmo quando falha (testado na 1.6.795),
/// então antes conferimos com `dv status`, que sai com código diferente de 0 fora de uma pasta do Diversion.
/// `want` = pasta do projeto escolhida na tela (como em unreal_open); sem projeto ainda, o Content/ da raiz da sala.
pub(crate) fn diversion_view(app: &tauri::AppHandle, room: &Path, want: Option<&str>) -> Result<(), String> {
    let base = match project(room, want) {
        Ok((dir, _)) => dir,
        Err(e) if e == "SEM_UPROJECT" => room.to_path_buf(),
        Err(e) => return Err(e),
    };
    let content = base.join("Content");
    if !content.is_dir() {
        return Err("o projeto ainda não tem a pasta Content/".into());
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
        return Err(format!("o Content/ do projeto não é uma pasta do Diversion (dv status saiu com código {code}). Veja o passo a passo no painel."));
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

    #[test]
    fn acha_o_projeto() {
        let base = std::env::temp_dir().join(format!("gfs-ue-proj-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mk = |room: &str, file: &str| {
            let p = base.join(room).join(file);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "{}").unwrap();
        };
        let room = |r: &str| base.join(r);

        // Projeto na raiz: como antes.
        mk("raiz", "Jogo.uproject");
        mk("raiz", "Content/Python/init_unreal.py");
        assert_eq!(projects(&room("raiz")), vec![""]);
        let (dir, up) = project(&room("raiz"), None).unwrap();
        assert_eq!(dir, room("raiz"));
        assert_eq!(up.file_name().unwrap(), "Jogo.uproject");
        assert_eq!(project(&room("raiz"), Some("")).unwrap().0, room("raiz"));

        // Caso do André: Content/Python da sala na raiz (sem .uproject) e o projeto na pasta que o Unreal criou.
        mk("sub", "Content/Python/init_unreal.py");
        mk("sub", "TesteUnreal/TesteUnreal.uproject");
        mk("sub", "TesteUnreal/Saved/X/X.uproject");
        assert_eq!(projects(&room("sub")), vec!["TesteUnreal"]);
        assert_eq!(project(&room("sub"), None).unwrap().0, room("sub").join("TesteUnreal"));
        assert_eq!(project(&room("sub"), Some("testeunreal")).unwrap().0, room("sub").join("TesteUnreal"));
        assert_eq!(project(&room("sub"), Some("TesteUnreal\\")).unwrap().1.file_name().unwrap(), "TesteUnreal.uproject");

        // Até 2 níveis; 3 não.
        mk("fundo", "a/b/P.uproject");
        mk("fundo", "a/b/c/Q.uproject");
        assert_eq!(projects(&room("fundo")), vec!["a/b"]);

        // Pastas ignoradas e com ponto.
        for f in ["Saved/X/X.uproject", ".git/X.uproject", "node_modules/X/X.uproject", "Intermediate/X.uproject", "Content/X/X.uproject", "Binaries/X.uproject"] {
            mk("ign", f);
        }
        assert!(projects(&room("ign")).is_empty());
        assert_eq!(project(&room("ign"), None).unwrap_err(), "SEM_UPROJECT");
        assert!(project(&room("ign"), Some("Saved/X")).is_err());

        // Dois projetos: sem escolha é erro claro; com escolha, o escolhido. Raiz ganha das subpastas.
        mk("dois", "B/B.uproject");
        mk("dois", "A/A.uproject");
        assert_eq!(projects(&room("dois")), vec!["A", "B"]);
        assert!(project(&room("dois"), None).unwrap_err().contains("A, B"));
        assert_eq!(project(&room("dois"), Some("B")).unwrap().0, room("dois").join("B"));
        mk("dois", "Raiz.uproject");
        assert_eq!(projects(&room("dois")), vec!["", "A", "B"]);
        assert_eq!(project(&room("dois"), None).unwrap().0, room("dois"));
        mk("dois", "Raiz2.uproject");
        assert!(project(&room("dois"), Some("")).unwrap_err().contains("mais de um .uproject"));

        // Nada fora da sala: .., absoluto, outra sala.
        mk("fora", "Fora.uproject");
        for bad in ["..", "../fora", "..\\fora", "/fora", &room("fora").to_string_lossy().into_owned(), "sub/../fora"] {
            assert!(project(&room("sub"), Some(bad)).is_err(), "{bad}");
        }

        // Junção (link de pasta do Windows, sem admin) para fora da sala: a busca não segue.
        #[cfg(windows)]
        {
            std::fs::create_dir_all(room("jun")).unwrap();
            let ok = Command::new("cmd").args(["/c", "mklink", "/J"]).arg(room("jun").join("link")).arg(room("fora")).stdout(Stdio::null()).status().is_ok_and(|s| s.success());
            if ok {
                assert!(projects(&room("jun")).is_empty());
                assert!(project(&room("jun"), Some("link")).is_err());
                std::fs::remove_dir(room("jun").join("link")).unwrap(); // tira só a junção, nunca o alvo
            }
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
