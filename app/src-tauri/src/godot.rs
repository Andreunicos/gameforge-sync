//! Salas Godot 4.x: achar o executável, importar, abrir o jogo na janela nativa, exportar para Web, servir o export
//! em 127.0.0.1 (preview) e capturar uma tela para o Claude ver. Decide só por código de saída e arquivos no disco,
//! nunca pelo texto da Godot (que sai traduzido conforme o PC).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use crate::launch::check_room_dir;
use crate::rojo::quiet;

/// Jogos abertos e servidores do preview que este app abriu (pasta da sala → processo / porta). Só estes são encerrados.
#[derive(Default)]
pub struct GodotState {
    games: Mutex<HashMap<String, Child>>,
    servers: Mutex<HashMap<String, (u16, Arc<AtomicBool>)>>,
}

impl GodotState {
    /// Ao sair do app: fecha os jogos e os servidores do preview.
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.games.lock() {
            for (_, child) in map.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            map.clear();
        }
        if let Ok(mut map) = self.servers.lock() {
            for (_, (port, stop)) in map.drain() {
                stop_server(port, &stop);
            }
        }
    }
}

fn stop_server(port: u16, stop: &AtomicBool) {
    stop.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect(("127.0.0.1", port)); // acorda o accept() para ele ver o pedido de parar
}

// ── achar a Godot ───────────────────────────────────────────────────────────

/// Só roda executável com cara de Godot (godot*.exe): o caminho vem da tela.
fn godot_name(p: &Path) -> bool {
    p.file_name().is_some_and(|n| {
        let n = n.to_string_lossy().to_lowercase();
        n.starts_with("godot") && (n.ends_with(".exe") || !cfg!(windows))
    })
}

/// godot*.exe de uma pasta e das subpastas diretas (o zip oficial extrai numa pasta com o nome do exe). Sem o _console primeiro.
fn exes_in(dir: &Path, depth: u8) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_file() && godot_name(&p) => out.push(p),
            Ok(t) if t.is_dir() && depth > 0 => out.extend(exes_in(&p, depth - 1)),
            _ => {}
        }
    }
    // Mais nova primeiro (nome com a versão), e o exe da janela antes do _console.
    out.sort_by_key(|p| {
        let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        (n.contains("_console"), std::cmp::Reverse(n))
    });
    out
}

/// Onde o app instala a Godot: %LOCALAPPDATA%\GameForge\godot\<versão>\ (sem precisar de admin).
fn gf_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("GameForge").join("godot"))
}

/// "4.7.2" → [4, 7, 2] para ordenar por número (4.7.10 > 4.7.9).
fn version_key(v: &str) -> Vec<u32> {
    v.split('.').map(|s| s.parse().unwrap_or(0)).collect()
}

/// Pastas de versão instaladas pelo app, mais nova primeiro (sem .download nem .part).
fn installed() -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = gf_root()
        .and_then(|r| std::fs::read_dir(r).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(n, _)| !n.starts_with('.') && !n.ends_with(".part"))
        .collect();
    out.sort_by_key(|(n, _)| std::cmp::Reverse(version_key(n)));
    out
}

/// "4.7.2" serve para quem pede "4.7" (e "4.7" para "4.7").
fn same_line(dir: &str, want: &str) -> bool {
    dir == want || dir.starts_with(&format!("{want}."))
}

/// Ordem: o que a pessoa digitou (arquivo ou pasta), GODOT_BIN, as instaladas pelo app da versão pedida, PATH, winget
/// (Links e Packages), pastas comuns, Program Files, Steam e, por último, as outras versões instaladas pelo app.
fn candidates(typed: Option<&str>, want: Option<&str>) -> Vec<PathBuf> {
    let mut c: Vec<PathBuf> = vec![];
    let add_dir =|c: &mut Vec<PathBuf>, d: PathBuf, depth: u8| c.extend(exes_in(&d, depth));
    if let Some(t) = typed.map(|t| t.trim().trim_matches('"')).filter(|t| !t.is_empty()) {
        let p = PathBuf::from(t);
        if p.is_dir() {
            add_dir(&mut c, p, 1);
        } else {
            c.push(p);
        }
    }
    if let Some(b) = std::env::var_os("GODOT_BIN") {
        c.push(PathBuf::from(b));
    }
    let (ours, others): (Vec<_>, Vec<_>) = installed().into_iter().partition(|(n, _)| want.is_some_and(|w| same_line(n, w)));
    for (_, d) in ours {
        add_dir(&mut c, d, 0);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            for n in ["godot.exe", "godot4.exe", "godot", "godot4"] {
                c.push(d.join(n));
            }
        }
    }
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    if let Some(local) = env("LOCALAPPDATA") {
        let winget = local.join("Microsoft").join("WinGet");
        add_dir(&mut c, winget.join("Links"), 0);
        for e in std::fs::read_dir(winget.join("Packages")).into_iter().flatten().flatten() {
            if e.file_name().to_string_lossy().to_lowercase().starts_with("godotengine") {
                add_dir(&mut c, e.path(), 2);
            }
        }
        add_dir(&mut c, local.join("Programs").join("Godot"), 1);
    }
    if let Some(home) = env("USERPROFILE") {
        for sub in ["Godot", "Desktop", "Downloads", "Documents\\Godot"] {
            add_dir(&mut c, home.join(sub), 1);
        }
    }
    add_dir(&mut c, PathBuf::from(r"C:\Godot"), 1);
    for base in [env("ProgramFiles"), Some(PathBuf::from(r"C:\Program Files"))].into_iter().flatten() {
        for sub in ["Godot", "Godot Engine"] {
            add_dir(&mut c, base.join(sub), 1);
        }
    }
    for steam in [r"C:\Program Files (x86)\Steam", r"D:\Steam", r"D:\SteamLibrary"] {
        add_dir(&mut c, Path::new(steam).join("steamapps").join("common").join("Godot Engine"), 0);
    }
    for (_, d) in others {
        add_dir(&mut c, d, 0);
    }
    c
}

/// "4.7.2.stable.official.e8f3a1b2c" (primeira linha da saída que começa com número). None = não é uma Godot que responde.
fn version_of(exe: &Path) -> Option<String> {
    let out = quiet(Command::new(exe).arg("--version")).stdin(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().map(str::trim).find(|l| l.starts_with(|c: char| c.is_ascii_digit())).map(str::to_string)
}

fn find(typed: Option<&str>, want: Option<&str>) -> Option<(PathBuf, String)> {
    let mut seen = std::collections::HashSet::new();
    candidates(typed, want)
        .into_iter()
        .filter(|p| p.is_file() && seen.insert(p.to_string_lossy().to_lowercase()))
        .filter(|p| godot_name(p) || std::env::var_os("GODOT_BIN").is_some_and(|b| Path::new(&b) == p.as_path()))
        .find_map(|p| version_of(&p).map(|v| (p, v)))
}

fn exe(bin: Option<&str>) -> Result<(PathBuf, String), String> {
    find(bin, None).ok_or_else(|| "SEM_GODOT: não achei a Godot neste PC. Abra 🎮 Godot → Verificar e digite o caminho do Godot_v4...exe.".into())
}

/// A janela do jogo: o exe sem _console (o _console é só um lançador; matar ele deixaria o jogo aberto).
fn gui(exe: &Path) -> PathBuf {
    let name = exe.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let alt = exe.with_file_name(name.replace("_console", ""));
    if name.contains("_console") && alt.is_file() {
        alt
    } else {
        exe.to_path_buf()
    }
}

/// Pasta dos export templates desta versão: "4.7.2.stable.official.x" → "4.7.2.stable" (".mono" no build .NET).
fn template_name(version: &str) -> String {
    let parts: Vec<&str> = version.split('.').collect();
    let n = parts.iter().take_while(|p| p.chars().all(|c| c.is_ascii_digit())).count();
    let mut name = parts[..(n + 1).min(parts.len())].join(".");
    if parts.contains(&"mono") {
        name.push_str(".mono");
    }
    name
}

fn templates_dir(version: &str) -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Godot").join("export_templates").join(template_name(version)))
}

#[derive(serde::Serialize)]
pub struct GodotInfo {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    /// Pasta onde a Godot procura os export templates desta versão, e quais .zip da Web estão lá.
    templates_dir: Option<String>,
    web_templates: Vec<String>,
}

/// O que há neste PC: a Godot (caminho e versão) e os export templates da Web dessa versão.
/// `want` ("4.7"): sem caminho digitado, prefere a instalada pelo app dessa versão (tela antiga não manda: ignora).
#[tauri::command(async)]
pub fn godot_info(bin: Option<String>, want: Option<String>) -> GodotInfo {
    let Some((path, version)) = find(bin.as_deref(), want.as_deref()) else {
        return GodotInfo { found: false, path: None, version: None, templates_dir: None, web_templates: vec![] };
    };
    let dir = templates_dir(&version);
    let web_templates = dir
        .as_ref()
        .and_then(|d| std::fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("web") && n.ends_with(".zip"))
        .collect();
    GodotInfo {
        found: true,
        path: Some(path.to_string_lossy().into_owned()),
        version: Some(version),
        templates_dir: dir.map(|d| d.to_string_lossy().into_owned()),
        web_templates,
    }
}

// ── projeto da sala ─────────────────────────────────────────────────────────

/// Pastas onde o project.godot nunca está. Igual a GODOT_PROJECT_SKIP (fileKinds.ts).
const SKIP: [&str; 6] = ["node_modules", "build", "builds", "export", "exports", "addons"];

/// Pastas da sala com project.godot (relativas, com "/"; "" = raiz), até 2 níveis, sem pasta com ponto, SKIP nem link.
fn projects(room: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut todo = vec![(String::new(), room.to_path_buf(), 0)];
    while let Some((rel, dir, depth)) = todo.pop() {
        if dir.join("project.godot").is_file() {
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

/// A pasta do projeto: `want` (da tela) só vale se for uma das achadas; sem `want`, a raiz, senão a única.
fn project(room: &Path, want: Option<&str>) -> Result<PathBuf, String> {
    let found = projects(room);
    let rel = match want {
        Some(w) => {
            let w = w.replace('\\', "/").trim_matches('/').to_lowercase();
            found.into_iter().find(|f| f.to_lowercase() == w).ok_or("esse projeto Godot não está na pasta da sala (foi movido ou apagado?)")?
        }
        None if found.iter().any(|f| f.is_empty()) => String::new(),
        None if found.len() == 1 => found[0].clone(),
        None if found.is_empty() => return Err("SEM_PROJECT: não achei o project.godot na pasta da sala (nem em subpastas até 2 níveis).".into()),
        None => return Err(format!("há mais de um projeto Godot na sala ({}): escolha qual no 🎮 Godot", found.join(", "))),
    };
    let dir = rel.split('/').filter(|s| !s.is_empty()).fold(room.to_path_buf(), |p, s| p.join(s));
    match (room.canonicalize(), dir.canonicalize()) {
        (Ok(r), Ok(d)) if d.starts_with(&r) => Ok(dir),
        _ => Err("o projeto está fora da pasta da sala".into()),
    }
}

// ── rodar a Godot ───────────────────────────────────────────────────────────

/// Roda até terminar (ou `limit`), com a saída em `log`. Devolve (sucesso, últimas linhas do log).
fn run_logged(exe: &Path, args: &[&std::ffi::OsStr], log: &Path, limit: Duration) -> Result<(bool, String), String> {
    let file = std::fs::File::create(log).map_err(|e| e.to_string())?;
    let mut child = quiet(Command::new(exe).args(args))
        .stdin(Stdio::null())
        .stdout(Stdio::from(file.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(file))
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let ok = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s.success();
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("TIMEOUT: a Godot passou de {} s e foi fechada. {}", limit.as_secs(), tail(log)));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    Ok((ok, tail(log)))
}

fn tail(log: &Path) -> String {
    let text = String::from_utf8_lossy(&std::fs::read(log).unwrap_or_default()).into_owned();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(25)..].join("\n")
}

fn gfs(room: &Path, name: &str) -> PathBuf {
    room.join(".gfs").join(name)
}

fn import(exe: &Path, room: &Path, proj: &Path) -> Result<String, String> {
    let (ok, out) = run_logged(
        exe,
        &["--headless".as_ref(), "--path".as_ref(), proj.as_os_str(), "--import".as_ref()],
        &gfs(room, "godot-import.log"),
        Duration::from_secs(600),
    )?;
    if ok {
        Ok(out)
    } else {
        Err(format!("IMPORT_FAILED: {out}"))
    }
}

/// `godot --headless --path <projeto> --import`: importa imagens/sons/cenas novas (cria .godot/). Saída em .gfs/godot-import.log.
#[tauri::command(async)]
pub fn godot_import(app: tauri::AppHandle, dir: String, bin: Option<String>, project: Option<String>) -> Result<String, String> {
    let room = check_room_dir(&app, &dir)?;
    let proj = self::project(&room, project.as_deref())?;
    let (exe, _) = exe(bin.as_deref())?;
    import(&exe, &room, &proj)
}

/// Abre o jogo na janela nativa (`godot --path <projeto>`, renderizador completo). Saída em .gfs/godot-run.log.
#[tauri::command(async)]
pub fn godot_run(app: tauri::AppHandle, state: tauri::State<GodotState>, dir: String, bin: Option<String>, project: Option<String>) -> Result<(), String> {
    let room = check_room_dir(&app, &dir)?;
    let proj = self::project(&room, project.as_deref())?;
    let mut games = state.games.lock().map_err(|e| e.to_string())?;
    if let Some(child) = games.get_mut(&dir) {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(()); // já está aberto
        }
        games.remove(&dir);
    }
    let (exe, _) = exe(bin.as_deref())?;
    if !proj.join(".godot").is_dir() {
        import(&exe, &room, &proj)?; // projeto nunca importado: sem isto a Godot sai em silêncio
    }
    let log_path = gfs(&room, "godot-run.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = quiet(Command::new(gui(&exe)).arg("--path").arg(&proj))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(800));
    if let Ok(Some(_)) = child.try_wait() {
        return Err(format!("RUN_FAILED: a Godot fechou ao abrir. {}", tail(&log_path)));
    }
    games.insert(dir, child);
    Ok(())
}

/// Fecha o jogo que o app abriu nesta sala.
#[tauri::command(async)]
pub fn godot_stop(state: tauri::State<GodotState>, dir: String) -> Result<(), String> {
    if let Some(mut child) = state.games.lock().map_err(|e| e.to_string())?.remove(&dir) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct GodotStatus {
    running: bool,
    port: Option<u16>,
}

#[tauri::command(async)]
pub fn godot_status(state: tauri::State<GodotState>, dir: String) -> GodotStatus {
    let running = state.games.lock().map(|mut g| g.get_mut(&dir).is_some_and(|c| matches!(c.try_wait(), Ok(None)))).unwrap_or(false);
    let port = state.servers.lock().ok().and_then(|s| s.get(&dir).map(|(p, _)| *p));
    GodotStatus { running, port }
}

// ── export Web ──────────────────────────────────────────────────────────────

/// Preset "Web" do export_presets.cfg: (tem threads?, template próprio do preset). None = não há preset "Web".
fn web_preset(cfg: &str) -> Option<(bool, String)> {
    let mut section = String::new();
    let mut id: Option<String> = None;
    let (mut threads, mut custom) = (false, String::new());
    for line in cfg.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line.trim_matches(['[', ']']).to_string();
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches('"');
        if k.trim() == "name" && v == "Web" && id.is_none() {
            id = Some(section.clone());
        } else if id.as_deref().is_some_and(|i| section == format!("{i}.options")) {
            match k.trim() {
                "variant/thread_support" => threads = v == "true",
                "custom_template/release" => custom = v.to_string(),
                _ => {}
            }
        }
    }
    id.map(|_| (threads, custom))
}

#[derive(serde::Serialize)]
pub struct ExportResult {
    ms: u64,
    threads: bool,
}

/// Exporta o preset "Web" para <sala>/builds/godot-web/index.html (pasta que não sincroniza e o Claude não lê).
/// Erros com código no começo: SEM_GODOT, SEM_PROJECT, NO_PRESET, NO_TEMPLATE, IMPORT_FAILED, EXPORT_FAILED, TIMEOUT.
#[tauri::command(async)]
pub fn godot_export_web(app: tauri::AppHandle, dir: String, bin: Option<String>, project: Option<String>) -> Result<ExportResult, String> {
    let room = check_room_dir(&app, &dir)?;
    let proj = self::project(&room, project.as_deref())?;
    let cfg = std::fs::read_to_string(proj.join("export_presets.cfg")).unwrap_or_default();
    let (threads, custom) = web_preset(&cfg).ok_or("NO_PRESET: o export_presets.cfg do projeto não tem um preset chamado \"Web\".")?;
    let (exe, version) = exe(bin.as_deref())?;
    if custom.is_empty() {
        let zip = if threads { "web_release.zip" } else { "web_nothreads_release.zip" };
        let want = templates_dir(&version).map(|d| d.join(zip));
        if !want.as_ref().is_some_and(|w| w.is_file()) {
            return Err(format!(
                "NO_TEMPLATE: faltam os export templates da Godot {} ({}).",
                template_name(&version),
                want.map(|w| w.to_string_lossy().into_owned()).unwrap_or_default()
            ));
        }
    }
    if !proj.join(".godot").is_dir() {
        import(&exe, &room, &proj)?;
    }
    let out = room.join("builds").join("godot-web");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let html = out.join("index.html");
    let start = Instant::now();
    let since = SystemTime::now() - Duration::from_secs(2);
    let (ok, log) = run_logged(
        &exe,
        &["--headless".as_ref(), "--path".as_ref(), proj.as_os_str(), "--export-release".as_ref(), "Web".as_ref(), html.as_os_str()],
        &gfs(&room, "godot-export.log"),
        Duration::from_secs(600),
    )?;
    // A Godot às vezes sai com 0 sem exportar: vale o que está no disco (index.html e index.pck novos).
    let fresh = |p: PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).is_ok_and(|t| t >= since);
    if !ok || !fresh(html.clone()) || !fresh(out.join("index.pck")) {
        return Err(format!("EXPORT_FAILED: {log}"));
    }
    Ok(ExportResult { ms: start.elapsed().as_millis() as u64, threads })
}

// ── servidor do preview (127.0.0.1) ─────────────────────────────────────────

fn mime(p: &Path) -> &'static str {
    match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        _ => "application/octet-stream", // .pck e o resto
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn serve_one(mut c: TcpStream, root: &Path) -> std::io::Result<()> {
    c.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(c.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? <= 2 {
            break;
        }
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let rel = percent_decode(target.split(['?', '#']).next().unwrap_or("/").trim_start_matches('/'));
    let rel = if rel.is_empty() { "index.html".to_string() } else { rel };
    // Só arquivos de dentro da pasta do export: nada de "..", unidade (C:) ou caminho absoluto.
    let safe = !rel.split(['/', '\\']).any(|s| s == ".." || s.contains(':'));
    let file = Some(root.join(&rel)).filter(|f| safe && f.is_file());
    let (status, body, ctype) = match &file {
        Some(f) => ("200 OK", std::fs::read(f)?, mime(f)),
        None => ("404 Not Found", b"nao encontrado".to_vec(), "text/plain; charset=utf-8"),
    };
    // COOP/COEP: o export com threads exige (só funciona aberto no navegador); o sem threads ignora.
    write!(
        c,
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: cross-origin\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    if method != "HEAD" {
        c.write_all(&body)?;
    }
    c.flush()
}

/// Sobe (ou reaproveita) o servidor estático de <sala>/builds/godot-web em 127.0.0.1. Devolve a porta.
#[tauri::command(async)]
pub fn godot_serve(app: tauri::AppHandle, state: tauri::State<GodotState>, dir: String) -> Result<u16, String> {
    let room = check_room_dir(&app, &dir)?;
    let root = room.join("builds").join("godot-web");
    if !root.join("index.html").is_file() {
        return Err("NO_EXPORT: ainda não há export Web nesta sala (clique em Exportar).".into());
    }
    let mut map = state.servers.lock().map_err(|e| e.to_string())?;
    if let Some((port, _)) = map.get(&dir) {
        return Ok(*port);
    }
    let listener = (47800..48000).find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok()).ok_or("nenhuma porta livre para o preview")?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(c) = conn {
                let root = root.clone();
                std::thread::spawn(move || {
                    let _ = serve_one(c, &root);
                });
            }
        }
    });
    map.insert(dir, (port, stop));
    Ok(port)
}

// ── captura de tela para o Claude ───────────────────────────────────────────

/// Roda o jogo 1 s com o Movie Maker (`--write-movie x.png --quit-after 60`, PNG por quadro) e guarda só o último quadro
/// em .gfs/frames/<hora>.png (mantém os 10 mais novos). Devolve o caminho relativo à sala.
#[tauri::command(async)]
pub fn godot_capture(app: tauri::AppHandle, dir: String, bin: Option<String>, project: Option<String>) -> Result<String, String> {
    let room = check_room_dir(&app, &dir)?;
    let proj = self::project(&room, project.as_deref())?;
    let (exe, _) = exe(bin.as_deref())?;
    if !proj.join(".godot").is_dir() {
        import(&exe, &room, &proj)?;
    }
    let frames = gfs(&room, "frames");
    let tmp = frames.join("tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let movie = tmp.join("f.png");
    let (_, log) = run_logged(
        &gui(&exe),
        &["--path".as_ref(), proj.as_os_str(), "--write-movie".as_ref(), movie.as_os_str(), "--quit-after".as_ref(), "60".as_ref()],
        &gfs(&room, "godot-capture.log"),
        Duration::from_secs(90),
    )?;
    let mut pngs: Vec<PathBuf> = std::fs::read_dir(&tmp)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("png")))
        .collect();
    pngs.sort();
    let last = pngs.pop().ok_or_else(|| format!("CAPTURE_FAILED: a Godot não gravou nenhum quadro. {log}"))?;
    let ms = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let name = format!("{ms}.png");
    std::fs::rename(&last, frames.join(&name)).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&tmp);
    let mut old: Vec<PathBuf> = std::fs::read_dir(&frames).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    old.sort();
    for p in old.iter().take(old.len().saturating_sub(10)) {
        let _ = std::fs::remove_file(p);
    }
    Ok(format!(".gfs/frames/{name}"))
}

// ── instalar a Godot e os export templates (godot-builds no GitHub) ──────────

static CANCEL: AtomicBool = AtomicBool::new(false);
static INSTALLING: AtomicBool = AtomicBool::new(false);

const RELEASES: &str = "https://github.com/godotengine/godot-builds/releases/download";

/// "4.7" ou "4.7.2": só números, porque vira URL e nome de pasta.
fn valid_version(v: &str) -> bool {
    let p: Vec<&str> = v.split('.').collect();
    (2..=3).contains(&p.len()) && p.iter().all(|s| (1..=3).contains(&s.len()) && s.chars().all(|c| c.is_ascii_digit()))
}

/// GET seguindo até 5 redirecionamentos à mão (como o download_asset), com tempo limite para não travar numa conexão parada.
fn http(url: &str) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(30)).timeout_read(Duration::from_secs(60)).build();
    let mut url = url.to_string();
    for _ in 0..5 {
        match agent.get(&url).set("User-Agent", "GameForge-Sync").call() {
            Ok(r) if (300..400).contains(&r.status()) => url = r.header("location").ok_or("redirecionamento sem destino")?.to_string(),
            Ok(r) => return Ok(r),
            Err(ureq::Error::Status(404, _)) => return Err(format!("NOT_FOUND: {url}")),
            Err(ureq::Error::Status(code, _)) => return Err(format!("NET: o GitHub respondeu {code}")),
            Err(e) => return Err(format!("NET: {e}")),
        }
    }
    Err("NET: redirecionamentos demais".into())
}

/// SHA512-SUMS.txt: "hash  nome" por linha → nome → hash.
fn parse_sums(text: &str) -> HashMap<String, String> {
    text.lines().filter_map(|l| l.split_once(char::is_whitespace)).map(|(h, n)| (n.trim().to_string(), h.to_lowercase())).collect()
}

fn with_suffix(p: &Path, s: &str) -> PathBuf {
    let mut o = p.as_os_str().to_owned();
    o.push(s);
    PathBuf::from(o)
}

type Progress<'a> = &'a mut dyn FnMut(&'static str, u64, u64);

/// Baixa em <dest>.part conferindo o tamanho e o SHA-512 (quando o release publica) e só então renomeia para <dest>.
fn download(url: &str, dest: &Path, sha512: Option<&str>, phase: &'static str, progress: Progress) -> Result<(), String> {
    use sha2::{Digest, Sha512};
    use std::io::Read;
    let resp = http(url)?;
    let total: u64 = resp.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let part = with_suffix(dest, ".part");
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let (mut reader, mut buf, mut hash, mut done) = (resp.into_reader(), vec![0u8; 1 << 18], Sha512::new(), 0u64);
    let res = loop {
        if CANCEL.load(Ordering::SeqCst) {
            break Err("CANCELADO".to_string());
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => n,
            Err(e) => break Err(format!("NET: a conexão caiu ({e})")),
        };
        if let Err(e) = file.write_all(&buf[..n]) {
            break Err(format!("não consegui gravar o download ({e})"));
        }
        hash.update(&buf[..n]);
        done += n as u64;
        progress(phase, done, total);
    };
    drop(file);
    let res = res.and_then(|_| {
        if total > 0 && done != total {
            return Err(format!("DOWNLOAD_RUIM: chegaram {done} de {total} bytes"));
        }
        match sha512 {
            Some(want) if !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(want) => Err("DOWNLOAD_RUIM: o arquivo baixado não confere com o SHA512-SUMS.txt".into()),
            _ => Ok(()),
        }
    });
    match res {
        Ok(()) => std::fs::rename(&part, dest).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Extrai o zip em <dest>.part (tirando `strip` do começo dos caminhos; só caminhos de dentro) e troca pela pasta <dest>.
fn extract(zip_path: &Path, dest: &Path, strip: &str, progress: Progress) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(zip_path).map_err(|e| e.to_string())?).map_err(|e| format!("DOWNLOAD_RUIM: zip ilegível ({e})"))?;
    let total: u64 = (0..zip.len()).filter_map(|i| zip.by_index_raw(i).ok().map(|f| f.size())).sum();
    let tmp = with_suffix(dest, ".part");
    let _ = std::fs::remove_dir_all(&tmp);
    let mut done = 0u64;
    let mut each = || -> Result<(), String> {
        for i in 0..zip.len() {
            if CANCEL.load(Ordering::SeqCst) {
                return Err("CANCELADO".into());
            }
            let mut f = zip.by_index(i).map_err(|e| format!("DOWNLOAD_RUIM: {e}"))?;
            let Some(name) = f.enclosed_name() else { continue };
            let Ok(rel) = name.strip_prefix(strip) else { continue };
            if rel.as_os_str().is_empty() {
                continue;
            }
            let out = tmp.join(rel);
            if f.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            std::fs::create_dir_all(out.parent().unwrap_or(&tmp)).map_err(|e| e.to_string())?;
            let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut w).map_err(|e| format!("não consegui extrair {} ({e})", rel.display()))?; // o zip confere o CRC
            done += f.size();
            progress("extraindo", done, total);
        }
        Ok(())
    };
    let res = each();
    if res.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
        return res;
    }
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| format!("não consegui trocar {} (a Godot dessa versão está aberta?) ({e})", dest.display()))?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// Nome da pasta dos templates = templates/version.txt do .tpz (ex.: "4.7.2.stable"), como a própria Godot faz.
fn tpz_version(tpz: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(tpz).map_err(|e| e.to_string())?).map_err(|e| format!("DOWNLOAD_RUIM: {e}"))?;
    let mut s = String::new();
    zip.by_name("templates/version.txt").map_err(|e| format!("DOWNLOAD_RUIM: {e}"))?.read_to_string(&mut s).map_err(|e| e.to_string())?;
    let v = s.trim().to_string();
    let ok = !v.is_empty() && v.len() < 40 && v.starts_with(|c: char| c.is_ascii_digit()) && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.');
    ok.then_some(v).ok_or_else(|| "DOWNLOAD_RUIM: version.txt estranho nos templates".into())
}

#[cfg(windows)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let w: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
    let mut avail = 0u64;
    // SAFETY: string terminada em 0 e ponteiro válido; os outros dois podem ser nulos (documentado).
    (unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) } != 0).then_some(avail)
}
#[cfg(not(windows))]
fn free_bytes(_: &Path) -> Option<u64> {
    None
}

/// Baixa a engine (zip, ~85 MB → ~180 MB) e/ou os export templates (.tpz, ~1,3 GB → ~1,3 GB) do release `<version>-stable`.
fn install(version: &str, engine: bool, templates: bool, progress: Progress) -> Result<Option<PathBuf>, String> {
    let root = gf_root().ok_or("sem LOCALAPPDATA")?;
    let tmp = root.join(".download");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let tpl_root = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Godot").join("export_templates")).ok_or("sem APPDATA")?;
    std::fs::create_dir_all(&tpl_root).map_err(|e| e.to_string())?;
    // shortcut: estimativa fixa (download + extraído) e um disco só; conferir pelo Content-Length se mudar muito de tamanho.
    let need = if engine { 300u64 << 20 } else { 0 } + if templates { 2_700u64 << 20 } else { 0 };
    let gb = |b: u64| b as f64 / (1u64 << 30) as f64;
    for d in [&tmp, &tpl_root] {
        if let Some(free) = free_bytes(d).filter(|f| *f < need) {
            return Err(format!("SEM_ESPACO: a instalação precisa de uns {:.1} GB livres e o disco de {} só tem {:.1} GB. Libere espaço e tente de novo.", gb(need), d.display(), gb(free)));
        }
    }
    let base = format!("{RELEASES}/{version}-stable/");
    let sums = match http(&format!("{base}SHA512-SUMS.txt")) {
        Ok(r) => parse_sums(&r.into_string().unwrap_or_default()),
        Err(e) if e.starts_with("NOT_FOUND") => HashMap::new(), // release sem SHA: confere só o tamanho
        Err(e) => return Err(e),
    };
    let mut exe = None;
    if engine {
        let name = format!("Godot_v{version}-stable_win64.exe.zip");
        let file = tmp.join(&name);
        download(&format!("{base}{name}"), &file, sums.get(&name).map(String::as_str), "engine", progress)?;
        let dir = root.join(version);
        let res = extract(&file, &dir, "", progress);
        let _ = std::fs::remove_file(&file);
        res?;
        exe = Some(exes_in(&dir, 0).into_iter().next().ok_or("DOWNLOAD_RUIM: o zip da Godot não tinha o executável")?);
    }
    if templates {
        let name = format!("Godot_v{version}-stable_export_templates.tpz");
        let file = tmp.join(&name);
        download(&format!("{base}{name}"), &file, sums.get(&name).map(String::as_str), "templates", progress)?;
        let res = tpz_version(&file).and_then(|v| extract(&file, &tpl_root.join(v), "templates", progress));
        let _ = std::fs::remove_file(&file);
        res?;
    }
    Ok(exe)
}

#[derive(Clone, serde::Serialize)]
struct InstallProgress {
    phase: &'static str,
    done: u64,
    total: u64,
}

/// Instala a Godot `<version>` (ex.: "4.7.2") em %LOCALAPPDATA%\GameForge\godot\<version>\ e, com `with_templates`, os export
/// templates em %APPDATA%\Godot\export_templates\<version>.stable\. `engine: false` = só os templates. Progresso no evento
/// "godot-install" ({phase: engine|templates|extraindo, done, total}). Devolve o caminho do exe (null sem engine).
/// Erros: BUSY, CANCELADO, SEM_ESPACO, NOT_FOUND, NET, DOWNLOAD_RUIM.
#[tauri::command(async)]
pub fn godot_install(app: tauri::AppHandle, version: String, with_templates: bool, engine: Option<bool>) -> Result<Option<String>, String> {
    use tauri::Emitter;
    if !cfg!(windows) {
        return Err("instalar a Godot pelo app só funciona no Windows".into());
    }
    if !valid_version(&version) {
        return Err(format!("versão inválida: {version}"));
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("BUSY: já há uma instalação da Godot em andamento.".into());
    }
    struct Free;
    impl Drop for Free {
        fn drop(&mut self) {
            INSTALLING.store(false, Ordering::SeqCst);
        }
    }
    let _free = Free;
    CANCEL.store(false, Ordering::SeqCst);
    let mut last = Instant::now();
    let mut emit = |phase: &'static str, done: u64, total: u64| {
        if done == total || last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            let _ = app.emit("godot-install", InstallProgress { phase, done, total });
        }
    };
    install(&version, engine.unwrap_or(true), with_templates, &mut emit).map(|p| p.map(|p| p.to_string_lossy().into_owned()))
}

/// Pede para a instalação em andamento parar (apaga o .part).
#[tauri::command]
pub fn godot_install_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(valid_version("4.7") && valid_version("4.7.2") && valid_version("4.10.12"));
        assert!(!valid_version("4") && !valid_version("4.7.2.1") && !valid_version("4.7/../x") && !valid_version("4..7") && !valid_version("4.7-rc1"));
        assert!(same_line("4.7.2", "4.7") && same_line("4.7", "4.7") && !same_line("4.70", "4.7") && !same_line("4.6.3", "4.7"));
        assert!(version_key("4.7.10") > version_key("4.7.9"));
    }

    #[test]
    fn sums() {
        let s = parse_sums("ABC  Godot_v4.7.2-stable_win64.exe.zip\ndef  SHA.txt\n\n");
        assert_eq!(s.get("Godot_v4.7.2-stable_win64.exe.zip").map(String::as_str), Some("abc"));
        assert_eq!(s.len(), 2);
    }

    /// .tpz de mentira com o mesmo formato do oficial (templates/version.txt + zips): pasta pelo version.txt, sem o "templates/".
    #[test]
    fn tpz_layout() {
        let dir = std::env::temp_dir().join(format!("gfs-tpz-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tpz = dir.join("t.tpz");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&tpz).unwrap());
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (n, body) in [("templates/version.txt", "4.7.2.stable\n"), ("templates/web_nothreads_release.zip", "x"), ("../fora.txt", "mal")] {
            w.start_file(n, opt).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        let v = tpz_version(&tpz).unwrap();
        assert_eq!(v, "4.7.2.stable");
        let mut p = |_: &'static str, _: u64, _: u64| {};
        extract(&tpz, &dir.join(&v), "templates", &mut p).unwrap();
        assert!(dir.join("4.7.2.stable").join("web_nothreads_release.zip").is_file());
        assert!(dir.join("4.7.2.stable").join("version.txt").is_file());
        assert!(!dir.join("fora.txt").exists() && !dir.join("4.7.2.stable.part").exists());
        CANCEL.store(true, Ordering::SeqCst);
        assert_eq!(extract(&tpz, &dir.join("x"), "templates", &mut p).unwrap_err(), "CANCELADO");
        CANCEL.store(false, Ordering::SeqCst);
        assert!(!dir.join("x").exists() && !dir.join("x.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Download de verdade (~85 MB) + SHA + extração para uma pasta de teste. Rodar com
    /// GFS_GODOT_TEST_DIR=<pasta vazia> cargo test --lib godot -- --ignored  (não executa o exe).
    #[test]
    #[ignore]
    fn real_engine_download() {
        let dir = PathBuf::from(std::env::var("GFS_GODOT_TEST_DIR").expect("GFS_GODOT_TEST_DIR"));
        std::fs::create_dir_all(&dir).unwrap();
        let base = format!("{RELEASES}/4.7.2-stable/");
        let sums = parse_sums(&http(&format!("{base}SHA512-SUMS.txt")).unwrap().into_string().unwrap());
        let name = "Godot_v4.7.2-stable_win64.exe.zip";
        let file = dir.join(name);
        let mut calls = 0;
        let mut p = |_: &'static str, _: u64, _: u64| calls += 1;
        // SHA errado: falha e não deixa .part nem o arquivo
        assert!(download(&format!("{base}{name}"), &file, Some("00"), "engine", &mut p).unwrap_err().starts_with("DOWNLOAD_RUIM"));
        assert!(!file.exists() && !with_suffix(&file, ".part").exists());
        download(&format!("{base}{name}"), &file, sums.get(name).map(String::as_str), "engine", &mut p).unwrap();
        extract(&file, &dir.join("4.7.2"), "", &mut p).unwrap();
        let exes = exes_in(&dir.join("4.7.2"), 0);
        assert_eq!(exes.first().and_then(|e| e.file_name()).unwrap(), "Godot_v4.7.2-stable_win64.exe");
        assert_eq!(exes.len(), 2);
        assert!(calls > 10);
        assert!(http(&format!("{RELEASES}/4.7.99-stable/SHA512-SUMS.txt")).unwrap_err().starts_with("NOT_FOUND"));
    }

    #[test]
    fn template_names() {
        assert_eq!(template_name("4.7.2.stable.official.e8f3a1b2c"), "4.7.2.stable");
        assert_eq!(template_name("4.7.2.stable.mono.official.e8f3a1b2c"), "4.7.2.stable.mono");
        assert_eq!(template_name("4.8.rc1.official.abc"), "4.8.rc1");
    }

    #[test]
    fn presets() {
        let cfg = "[preset.0]\n\nname=\"Windows Desktop\"\n\n[preset.0.options]\n\nvariant/thread_support=true\n\n[preset.1]\n\nname=\"Web\"\nplatform=\"Web\"\n\n[preset.1.options]\n\ncustom_template/release=\"\"\nvariant/thread_support=false\n";
        assert_eq!(web_preset(cfg), Some((false, String::new())));
        assert_eq!(web_preset("[preset.0]\nname=\"Android\"\n"), None);
    }

    #[test]
    fn decode() {
        assert_eq!(percent_decode("a%20b.pck"), "a b.pck");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
