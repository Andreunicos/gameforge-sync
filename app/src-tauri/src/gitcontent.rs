//! Sala Unreal: o Content/ do projeto (binários) por um repositório Git PRIVADO no GitHub, com Git LFS.
//! Só roda `git` com uma lista fechada de operações e argumentos montados aqui, dentro de `<sala>/<projeto>/Content`
//! conferida (nada fora da sala: sem `..`, absoluto ou link). Sem janela, sem pergunta no terminal, com prazo.
//! O token do dono (se vier) entra só no processo do git, por variável de ambiente (GIT_CONFIG_*): nunca em .git/config,
//! na URL do remoto ou em mensagem. Sem token, quem autentica é o Git Credential Manager do Git para Windows.
//! Nunca força: mudança local não enviada, histórico divergente ou arquivo em uso = para e avisa.

use base64::Engine as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::launch::check_room_dir;
use crate::rojo::quiet;

const GITHUB: &str = "https://github.com/";
const QUICK: Duration = Duration::from_secs(10 * 60); // status com LFS calcula o hash dos binários mudados
const LONG: Duration = Duration::from_secs(2 * 60 * 60); // baixar/enviar GBs pelo LFS
const EMAIL: &str = "gameforge-sync@invalid"; // e-mail neutro nos commits (não expõe o e-mail de ninguém)

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReq {
    /// status | init | fetch | pull | push
    op: String,
    /// "dono/nome" do repositório no GitHub.
    repo: String,
    branch: String,
    token: Option<String>,
    /// Nome de quem envia (vai no commit).
    name: String,
    /// false = rodando sozinho em segundo plano: o Git Credential Manager não pode abrir janela.
    interactive: bool,
    /// .gitignore e .gitattributes do Content/ (gravados no `init` só se não existirem).
    ignore: String,
    attributes: String,
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Content/ já está ligado (tem .git).
    repo: bool,
    /// Git LFS instalado neste PC.
    lfs: bool,
    /// O ramo já existe no GitHub (alguém já enviou).
    remote: bool,
    /// Envios (commits) daqui que o GitHub não tem / do GitHub que este PC não tem.
    ahead: u32,
    behind: u32,
    /// Arquivos mudados aqui e ainda não enviados: até 20 nomes e o total.
    changed: Vec<String>,
    changed_total: u32,
    path: String,
}

struct Git<'a> {
    content: &'a Path,
    /// Pasta do projeto: o git não sobe acima de Content/ procurando outro repositório.
    ceiling: &'a Path,
    /// Prefixo do remoto: https://github.com/ (nos testes, file:// ou http://127.0.0.1).
    base: &'a str,
    repo: &'a str,
    branch: &'a str,
    token: Option<&'a str>,
    interactive: bool,
    name: String,
    long: Duration,
}

impl Git<'_> {
    fn url(&self) -> String {
        format!("{}{}.git", self.base, self.repo)
    }

    fn secret(&self) -> Option<String> {
        self.token.map(|t| base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{t}")))
    }

    /// Texto que vai para a tela: sem o token (nem em base64) e só o fim.
    fn clean(&self, s: &str) -> String {
        let mut s = s.trim().to_string();
        if let Some(t) = self.token {
            s = s.replace(t, "***");
        }
        if let Some(b) = self.secret() {
            s = s.replace(&b, "***");
        }
        let chars: Vec<char> = s.chars().collect();
        chars[chars.len().saturating_sub(1500)..].iter().collect()
    }

    /// `git <args>` em Content/: (código de saída, stdout, stderr). Erro só se o git não abre ou estoura o prazo.
    fn raw(&self, args: &[&str], timeout: Duration) -> Result<(i32, String, String), String> {
        let mut cmd = Command::new("git");
        quiet(&mut cmd)
            .args(args)
            .current_dir(self.content)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CEILING_DIRECTORIES", self.ceiling)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_AUTHOR_NAME", &self.name)
            .env("GIT_COMMITTER_NAME", &self.name)
            .env("GIT_AUTHOR_EMAIL", EMAIL)
            .env("GIT_COMMITTER_EMAIL", EMAIL)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !self.interactive {
            cmd.env("GCM_INTERACTIVE", "never");
        }
        if let Some(b) = self.secret() {
            // Só para este processo (e o git-lfs que ele abre), só para o host do remoto; ajudante de senha desligado
            // para um token errado dar erro em vez de abrir janela.
            cmd.env("GIT_CONFIG_COUNT", "2")
                .env("GIT_CONFIG_KEY_0", format!("http.{}.extraheader", self.base))
                .env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {b}"))
                .env("GIT_CONFIG_KEY_1", "credential.helper")
                .env("GIT_CONFIG_VALUE_1", "");
        }
        let mut child = cmd.spawn().map_err(|_| {
            "O Git não está instalado neste PC (ou o app não o enxerga). Instale o Git para Windows (git-scm.com), que já traz o Git LFS e o Git Credential Manager, e reabra o app.".to_string()
        })?;
        let pipe = |r: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut v = vec![];
                if let Some(mut r) = r {
                    let _ = r.read_to_end(&mut v);
                }
                String::from_utf8_lossy(&v).into_owned()
            })
        };
        let out = pipe(child.stdout.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
        let err = pipe(child.stderr.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if start.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("o git demorou demais ({} min) em \"{}\" e foi parado. Nada foi forçado: tente de novo.", timeout.as_secs() / 60, args[0]));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => return Err(e.to_string()),
            }
        };
        let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
        Ok((status.code().unwrap_or(-1), out, err))
    }

    /// `git <args>` que precisa dar certo: devolve o stdout; senão erro com o fim da mensagem do git (sem o token).
    fn ok(&self, args: &[&str], timeout: Duration) -> Result<String, String> {
        let (code, out, err) = self.raw(args, timeout)?;
        if code == 0 {
            return Ok(out);
        }
        let why = self.clean(if err.trim().is_empty() { &out } else { &err });
        let hint = if matches!(args[0], "fetch" | "push") {
            " Sem acesso? O dono precisa convidar seu usuário do GitHub e você aceitar o convite; na 1ª vez o Git abre o navegador para entrar no GitHub."
        } else {
            ""
        };
        Err(format!("git {} falhou (código {code}): {why}{hint}", args[0]))
    }

    fn rb(&self) -> String {
        format!("refs/remotes/origin/{}", self.branch)
    }

    fn has(&self, rev: &str) -> Result<bool, String> {
        Ok(self.raw(&["rev-parse", "--verify", "-q", rev], QUICK)?.0 == 0)
    }

    fn count(&self, range: &str) -> Result<u32, String> {
        self.ok(&["rev-list", "--count", range], QUICK)?.trim().parse().map_err(|_| "resposta inesperada do git rev-list".to_string())
    }

    fn status(&self) -> Result<GitStatus, String> {
        let mut st = GitStatus { path: self.content.to_string_lossy().into_owned(), ..Default::default() };
        st.lfs = self.raw(&["lfs", "version"], QUICK)?.0 == 0;
        if !dot_git(self.content)? {
            return Ok(st);
        }
        st.repo = true;
        let rb = self.rb();
        st.remote = self.has(&rb)?;
        let head = self.has("HEAD")?;
        if head && st.remote {
            st.ahead = self.count(&format!("{rb}..HEAD"))?;
            st.behind = self.count(&format!("HEAD..{rb}"))?;
        } else if head {
            st.ahead = self.count("HEAD")?;
        } else if st.remote {
            st.behind = self.count(&rb)?;
        }
        let files = parse_porcelain(&self.ok(&["status", "--porcelain=v1", "-z", "--untracked-files=all"], QUICK)?);
        st.changed_total = files.len() as u32;
        st.changed = files.into_iter().take(20).collect();
        Ok(st)
    }

    /// Primeira vez neste PC: repositório, LFS, remoto, ramo e fetch. Não troca um remoto que já aponta para outro lugar.
    fn setup(&self, ignore: &str, attributes: &str) -> Result<(), String> {
        if !dot_git(self.content)? {
            self.ok(&["init", "-q", "-b", self.branch], QUICK)?;
        }
        self.ok(&["lfs", "install", "--local"], QUICK)?;
        self.ok(&["config", "core.longpaths", "true"], QUICK)?; // caminhos longos do Content/ no Windows
        match self.raw(&["remote", "get-url", "origin"], QUICK)? {
            (0, out, _) if out.trim() == self.url() => {}
            (0, _, _) => return Err("o Content/ deste projeto já está ligado a OUTRO repositório Git (remote origin diferente). Nada foi mudado: confira a pasta.".into()),
            _ => {
                self.ok(&["remote", "add", "origin", &self.url()], QUICK)?;
            }
        }
        self.ok(&["config", &format!("branch.{}.remote", self.branch), "origin"], QUICK)?;
        self.ok(&["config", &format!("branch.{}.merge", self.branch), &format!("refs/heads/{}", self.branch)], QUICK)?;
        // As mesmas regras também no exclude local: antes do 1º baixar (sem o .gitignore ainda) Python/ já fica de fora.
        let exclude = self.content.join(".git").join("info").join("exclude");
        let cur = std::fs::read_to_string(&exclude).unwrap_or_default();
        if !cur.contains(ignore.trim()) {
            std::fs::create_dir_all(exclude.parent().unwrap_or(self.content)).map_err(|e| e.to_string())?;
            std::fs::write(&exclude, format!("{cur}\n{ignore}")).map_err(|e| e.to_string())?;
        }
        self.fetch()?;
        // Repositório ainda vazio (primeiro envio): cria as regras. Se já tem envios, elas vêm de lá ao baixar.
        if !self.has(&self.rb())? {
            for (name, text) in [(".gitignore", ignore), (".gitattributes", attributes)] {
                let p = self.content.join(name);
                if !p.exists() {
                    std::fs::write(&p, text).map_err(|e| format!("não deu para criar Content/{name}: {e}"))?;
                }
            }
        }
        Ok(())
    }

    fn fetch(&self) -> Result<(), String> {
        self.ok(&["fetch", "-q", "--prune", "origin"], self.long).map(|_| ())
    }

    /// Baixar = fetch + fast-forward. Para (sem mexer em nada) se houver mudança local, divergência ou arquivo em uso.
    fn pull(&self) -> Result<GitStatus, String> {
        self.fetch()?;
        let st = self.status()?;
        if st.behind == 0 {
            return Ok(st);
        }
        // Antes de olhar as mudanças: arquivo aberto pelo Unreal também aparece como mudado no status.
        let busy = self.in_use()?;
        if !busy.is_empty() {
            return Err(format!("Nada foi baixado: feche o Unreal (arquivos em uso: {}).", busy.join(", ")));
        }
        if st.changed_total > 0 {
            return Err(format!(
                "Nada foi baixado: há {} arquivo(s) no Content/ deste PC que não estão no repositório ou foram mudados e não enviados ({}). Envie o que é seu, ou mova esses arquivos para fora do Content/, e baixe de novo.",
                st.changed_total,
                st.changed.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        if st.ahead > 0 {
            return Err(DIVERGED.into());
        }
        self.ok(&["merge", "--ff-only", "-q", &self.rb()], self.long)?;
        self.status()
    }

    /// Enviar = add + commit + push. Antes confere se há algo do GitHub a baixar: se houver, para antes de criar o commit.
    fn push(&self) -> Result<GitStatus, String> {
        self.fetch()?;
        let st = self.status()?;
        if st.changed_total == 0 && st.ahead == 0 {
            return Ok(st);
        }
        if st.behind > 0 {
            return Err(if st.ahead > 0 {
                DIVERGED.into()
            } else {
                "Nada foi enviado: há envios de outra pessoa que este PC ainda não baixou. Como .uasset/.umap não juntam, guarde uma cópia dos seus arquivos mudados fora do Content/, desfaça-os aqui, baixe, e então copie de volta e envie (se foi o mesmo asset, combine com quem mexeu).".into()
            });
        }
        if st.changed_total > 0 {
            self.ok(&["add", "-A"], self.long)?;
            match self.raw(&["diff", "--cached", "--quiet"], QUICK)?.0 {
                0 => {}
                1 => {
                    self.ok(&["commit", "-q", "-m", &format!("Content enviado por {}", self.name)], QUICK)?;
                }
                c => return Err(format!("git diff falhou (código {c})")),
            }
        }
        if self.has("HEAD")? {
            self.ok(&["push", "-q", "origin", &format!("HEAD:refs/heads/{}", self.branch)], self.long)?;
        }
        self.status()
    }

    /// Arquivos que o fast-forward vai trocar e que estão abertos por outro programa (o Unreal): git falharia no meio.
    fn in_use(&self) -> Result<Vec<String>, String> {
        let rb = self.rb();
        let list = if self.has("HEAD")? {
            self.ok(&["diff", "--name-only", "-z", "HEAD", &rb], QUICK)?
        } else {
            self.ok(&["ls-tree", "-r", "--name-only", "-z", &rb], QUICK)?
        };
        Ok(list
            .split('\0')
            .filter(|p| !p.is_empty() && !p.split('/').any(|s| s == ".." || s.is_empty()) && locked(&self.content.join(p)))
            .take(5)
            .map(String::from)
            .collect())
    }
}

const DIVERGED: &str = "Nada foi mudado: o Content/ deste PC e o do GitHub divergiram (os dois têm envios que o outro não tem). Binários não juntam: combine com quem enviou qual versão fica; a sua continua aqui intacta.";

/// Content/.git existe? Se existir, precisa ser uma pasta comum (não arquivo `gitdir:` nem link para outro lugar).
fn dot_git(content: &Path) -> Result<bool, String> {
    match content.join(".git").symlink_metadata() {
        Err(_) => Ok(false),
        Ok(m) if m.is_dir() => Ok(true),
        Ok(_) => Err("Content/.git não é uma pasta comum (link ou arquivo): o app não usa esse repositório.".into()),
    }
}

#[cfg(windows)]
fn locked(p: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // Abrir sem compartilhar falha (erro 32/33) se outro programa estiver com o arquivo aberto. Não grava nada.
    p.is_file() && matches!(std::fs::OpenOptions::new().write(true).share_mode(0).open(p), Err(e) if matches!(e.raw_os_error(), Some(32 | 33)))
}

#[cfg(not(windows))]
fn locked(_: &Path) -> bool {
    false
}

/// Caminhos de `git status --porcelain=v1 -z` (estável, não traduzido). Renomeado/copiado traz o nome antigo no campo seguinte.
fn parse_porcelain(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut it = s.split('\0');
    while let Some(e) = it.next() {
        if e.len() < 4 || !e.is_char_boundary(3) {
            continue;
        }
        let (xy, path) = e.split_at(3);
        if xy[..2].contains(['R', 'C']) {
            it.next();
        }
        out.push(path.to_string());
    }
    out
}

fn check_req(r: &GitReq) -> Result<(), String> {
    let word = |s: &str, max: usize, extra: &str| !s.is_empty() && s.len() <= max && !s.starts_with(['-', '.']) && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    let repo_ok = r.repo.split_once('/').is_some_and(|(o, n)| word(o, 39, "-") && word(n, 100, "._-") && !n.contains(".."));
    if !repo_ok {
        return Err("repositório inválido (use dono/nome)".into());
    }
    if !word(&r.branch, 100, "._-") || r.branch.contains("..") || r.branch.ends_with(".lock") {
        return Err("ramo inválido".into());
    }
    if let Some(t) = &r.token {
        if t.len() < 20 || t.len() > 255 || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err("token do GitHub em formato inválido (nada foi enviado)".into());
        }
    }
    if r.ignore.len() > 16_000 || r.attributes.len() > 16_000 {
        return Err(".gitignore/.gitattributes grandes demais".into());
    }
    Ok(())
}

/// Content/ do projeto, dentro da sala (com os links resolvidos). `create`: cria a pasta vazia se ainda não existe.
fn content_dir(room: &Path, project: &Path, create: bool) -> Result<PathBuf, String> {
    let c = project.join("Content");
    if create && c.symlink_metadata().is_err() {
        std::fs::create_dir(&c).map_err(|e| e.to_string())?;
    }
    if c.symlink_metadata().is_err() {
        return Err("o projeto ainda não tem a pasta Content/".into());
    }
    match (room.canonicalize(), c.canonicalize()) {
        (Ok(r), Ok(d)) if d.starts_with(&r) && c.symlink_metadata().is_ok_and(|m| m.is_dir()) => Ok(c),
        _ => Err("a pasta Content/ do projeto é um link ou está fora da pasta da sala: o app não mexe nela".into()),
    }
}

fn run(content: &Path, ceiling: &Path, base: &str, req: &GitReq, long: Duration) -> Result<GitStatus, String> {
    check_req(req)?;
    let name: String = req.name.chars().filter(|c| !c.is_control() && *c != '<' && *c != '>').take(60).collect();
    let g = Git {
        content,
        ceiling,
        base,
        repo: &req.repo,
        branch: &req.branch,
        token: req.token.as_deref(),
        interactive: req.interactive,
        name: if name.trim().is_empty() { "GameForge".into() } else { name.trim().to_string() },
        long,
    };
    let need_lfs = || -> Result<(), String> {
        if g.raw(&["lfs", "version"], QUICK)?.0 != 0 {
            return Err("O Git LFS não está instalado neste PC: instale pelo git-lfs.com (ou reinstale o Git para Windows marcando Git LFS) e reabra o app.".into());
        }
        Ok(())
    };
    match req.op.as_str() {
        "status" => g.status(),
        "init" => {
            need_lfs()?;
            g.setup(&req.ignore, &req.attributes)?;
            g.status()
        }
        "fetch" | "pull" | "push" if !dot_git(content)? => Err("o Content/ deste PC ainda não está ligado ao repositório: clique em \"Ligar este PC\".".into()),
        "fetch" => {
            g.fetch()?;
            g.status()
        }
        "pull" => {
            need_lfs()?;
            g.pull()
        }
        "push" => {
            need_lfs()?;
            g.push()
        }
        _ => Err("operação desconhecida".into()),
    }
}

/// Git do Content/ da sala. `project` = pasta do projeto relativa à sala (como em unreal_open: só vale uma que o Rust acha).
#[tauri::command]
pub async fn git_content(app: tauri::AppHandle, dir: String, project: Option<String>, req: GitReq) -> Result<GitStatus, String> {
    // Fora da thread da janela: baixar/enviar pelo LFS pode levar muitos minutos.
    tauri::async_runtime::spawn_blocking(move || {
        let room = check_room_dir(&app, &dir)?;
        let (proj, _) = crate::unreal::project(&room, project.as_deref())?;
        // Projeto sem Content/ ainda (amigo antes do 1º baixar): cria a pasta vazia para poder ligar.
        let content = content_dir(&room, &proj, matches!(req.op.as_str(), "init" | "status"))?;
        run(&content, &proj, GITHUB, &req, LONG)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const TOKEN: &str = "ghp_FAKEfake0123456789abcdefABCDEF012345";

    fn req(op: &str, repo: &str, token: Option<&str>) -> GitReq {
        GitReq {
            op: op.into(),
            repo: repo.into(),
            branch: "main".into(),
            token: token.map(String::from),
            name: "Teste".into(),
            interactive: false,
            ignore: "/Python/\n*.tmp\n".into(),
            attributes: "*.uasset filter=lfs diff=lfs merge=lfs -text\n*.umap filter=lfs diff=lfs merge=lfs -text\n".into(),
        }
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    /// Uma "pessoa": sala/Projeto/Content (com Python/ que vem pela sala).
    fn person(base: &Path, who: &str) -> (PathBuf, PathBuf) {
        let proj = base.join(who).join("Proj");
        std::fs::create_dir_all(proj.join("Content").join("Python")).unwrap();
        std::fs::write(proj.join("Content").join("Python").join("init_unreal.py"), "print(1)\n").unwrap();
        (proj.join("Content"), proj)
    }

    fn op(content: &Path, proj: &Path, base: &str, o: &str) -> Result<GitStatus, String> {
        run(content, proj, base, &req(o, "dono/jogo", None), Duration::from_secs(120))
    }

    #[test]
    fn validacao() {
        assert!(check_req(&req("status", "dono/jogo", Some(TOKEN))).is_ok());
        for bad in ["", "dono", "../x", "dono/..", "dono/../x", "-x/y", "dono/.git", "a b/c", "dono/jogo/extra", "dono/jo;go", "https://x/y"] {
            assert!(check_req(&req("status", bad, None)).is_err(), "{bad}");
        }
        for bad in ["", "-f", ".x", "a..b", "x.lock", "a b", "a/b", "main;rm"] {
            let mut r = req("status", "dono/jogo", None);
            r.branch = bad.into();
            assert!(check_req(&r).is_err(), "{bad}");
        }
        for bad in ["curto", "ghp_com espaço_0123456789abc", "ghp_\nAuthorization:x0123456789"] {
            let e = check_req(&req("status", "dono/jogo", Some(bad))).unwrap_err();
            assert!(!e.contains(bad));
        }
        assert_eq!(parse_porcelain(""), Vec::<String>::new());
        assert_eq!(parse_porcelain("?? Maps/A b.umap\0 M X.uasset\0R  Novo.uasset\0Velho.uasset\0"), vec!["Maps/A b.umap", "X.uasset", "Novo.uasset"]);
    }

    #[test]
    fn content_dentro_da_sala() {
        let base = std::env::temp_dir().join(format!("gfs-git-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let room = base.join("sala");
        let proj = room.join("Proj");
        std::fs::create_dir_all(&proj).unwrap();
        assert!(content_dir(&room, &proj, false).is_err(), "sem Content");
        assert_eq!(content_dir(&room, &proj, true).unwrap(), proj.join("Content"));
        #[cfg(windows)]
        {
            let fora = base.join("fora");
            std::fs::create_dir_all(&fora).unwrap();
            let p2 = room.join("P2");
            std::fs::create_dir_all(&p2).unwrap();
            let ok = Command::new("cmd").args(["/c", "mklink", "/J"]).arg(p2.join("Content")).arg(&fora).stdout(Stdio::null()).status().is_ok_and(|s| s.success());
            if ok {
                assert!(content_dir(&room, &p2, true).is_err());
                std::fs::remove_dir(p2.join("Content")).unwrap(); // só a junção
            }
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Fluxo de verdade com um remoto "bare" local (file://) e Git LFS: enviar, ligar outro PC, baixar, fast-forward,
    /// mudança local não enviada, divergência, arquivo em uso e arquivo velho no caminho. Nada pode ser sobrescrito.
    #[test]
    fn fluxo_com_remoto_local() {
        let lfs = Command::new("git").args(["lfs", "version"]).output().is_ok_and(|o| o.status.success());
        if !lfs {
            eprintln!("git-lfs ausente: teste do fluxo pulado");
            return;
        }
        let base = std::env::temp_dir().join(format!("gfs-git-flow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let remotes = base.join("remotes");
        std::fs::create_dir_all(remotes.join("dono")).unwrap();
        sh(&remotes.join("dono"), &["init", "-q", "--bare", "jogo.git"]);
        let url = format!("file:///{}/", remotes.to_string_lossy().replace('\\', "/").trim_start_matches('/'));

        // Dono: Content com binários falsos.
        let (a, pa) = person(&base, "andre");
        let bin = |n: u8| (0..300_000u32).map(|i| (i as u8) ^ n).collect::<Vec<u8>>();
        std::fs::create_dir_all(a.join("Maps")).unwrap();
        std::fs::write(a.join("BP_Player.uasset"), bin(1)).unwrap();
        std::fs::write(a.join("Maps").join("Arena.umap"), bin(2)).unwrap();
        let st = op(&a, &pa, &url, "status").unwrap();
        assert!(!st.repo && st.lfs);
        assert!(op(&a, &pa, &url, "push").unwrap_err().contains("Ligar"));
        let st = op(&a, &pa, &url, "init").unwrap();
        assert!(st.repo && !st.remote);
        assert_eq!(st.changed_total, 4, "{:?}", st.changed); // 2 binários + .gitignore + .gitattributes (Python/ fora)
        assert!(!st.changed.iter().any(|p| p.starts_with("Python")));
        let st = op(&a, &pa, &url, "push").unwrap();
        assert!(st.remote && st.ahead == 0 && st.behind == 0 && st.changed_total == 0, "{st:?}");
        // Foi pelo LFS (no Git só o ponteiro) e nada de segredo/URL estranha no .git/config.
        assert!(sh(&a, &["show", "HEAD:BP_Player.uasset"]).starts_with("version https://git-lfs"));
        assert!(remotes.join("dono").join("jogo.git").join("lfs").join("objects").is_dir());
        // Mudou de pasta (Content/.git e Content/Python nunca entram no Git).
        assert!(!sh(&a, &["ls-files"]).contains("Python"));

        // Amigo: só tem o Content/Python que veio pela sala. Liga e baixa.
        let (b, pb) = person(&base, "bia");
        let st = op(&b, &pb, &url, "init").unwrap();
        assert_eq!((st.behind, st.changed_total), (1, 0), "{st:?}");
        op(&b, &pb, &url, "pull").unwrap();
        assert_eq!(std::fs::read(b.join("BP_Player.uasset")).unwrap(), bin(1), "LFS baixou o binário de verdade");
        assert_eq!(std::fs::read_to_string(b.join("Python").join("init_unreal.py")).unwrap(), "print(1)\n");

        // Fast-forward: o dono muda, o amigo baixa.
        std::fs::write(a.join("BP_Player.uasset"), bin(3)).unwrap();
        op(&a, &pa, &url, "push").unwrap();
        assert_eq!(op(&b, &pb, &url, "fetch").unwrap().behind, 1);
        op(&b, &pb, &url, "pull").unwrap();
        assert_eq!(std::fs::read(b.join("BP_Player.uasset")).unwrap(), bin(3));

        // Mudança local não enviada + algo novo no GitHub: baixar para e não mexe no arquivo local.
        std::fs::write(b.join("Maps").join("Arena.umap"), bin(9)).unwrap();
        std::fs::write(a.join("BP_Player.uasset"), bin(4)).unwrap();
        op(&a, &pa, &url, "push").unwrap();
        let e = op(&b, &pb, &url, "pull").unwrap_err();
        assert!(e.contains("Nada foi baixado"), "{e}");
        assert_eq!(std::fs::read(b.join("Maps").join("Arena.umap")).unwrap(), bin(9));
        assert_eq!(std::fs::read(b.join("BP_Player.uasset")).unwrap(), bin(3));
        // Enviar também para antes de criar commit.
        let e = op(&b, &pb, &url, "push").unwrap_err();
        assert!(e.contains("Nada foi enviado"), "{e}");
        assert!(!sh(&b, &["status", "--porcelain"]).is_empty(), "nenhum commit foi criado");

        // Divergência (commit local + commit remoto): baixar e enviar param.
        sh(&b, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "local"]);
        let e = op(&b, &pb, &url, "pull").unwrap_err();
        assert!(e.contains("divergiram"), "{e}");
        assert!(op(&b, &pb, &url, "push").unwrap_err().contains("divergiram"));
        assert_eq!(std::fs::read(b.join("Maps").join("Arena.umap")).unwrap(), bin(9));

        // Arquivo velho no caminho (cópia antiga, fora do Git): não sobrescreve.
        let (c, pc) = person(&base, "caio");
        std::fs::write(c.join("BP_Player.uasset"), bin(7)).unwrap();
        op(&c, &pc, &url, "init").unwrap();
        assert!(op(&c, &pc, &url, "pull").unwrap_err().contains("Nada foi baixado"));
        assert_eq!(std::fs::read(c.join("BP_Player.uasset")).unwrap(), bin(7));

        // Arquivo em uso (Unreal aberto): baixar para antes de mexer.
        #[cfg(windows)]
        {
            let (d, pd) = person(&base, "duda");
            op(&d, &pd, &url, "init").unwrap();
            op(&d, &pd, &url, "pull").unwrap();
            std::fs::write(a.join("BP_Player.uasset"), bin(5)).unwrap();
            op(&a, &pa, &url, "push").unwrap();
            {
                use std::os::windows::fs::OpenOptionsExt;
                let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(d.join("BP_Player.uasset")).unwrap();
                let e = op(&d, &pd, &url, "pull").unwrap_err();
                assert!(e.contains("feche o Unreal"), "{e}");
            }
            op(&d, &pd, &url, "pull").unwrap();
            assert_eq!(std::fs::read(d.join("BP_Player.uasset")).unwrap(), bin(5));
        }

        // Repositório com outro remoto: não troca.
        let (e_, pe) = person(&base, "outro");
        sh(&e_, &["init", "-q"]);
        sh(&e_, &["remote", "add", "origin", "https://example.com/x.git"]);
        assert!(op(&e_, &pe, &url, "init").unwrap_err().contains("OUTRO repositório"));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Token errado num "GitHub" falso (HTTP local que responde 401): erro claro, sem o token, e o token nunca fica no disco.
    #[test]
    fn token_errado_nao_vaza() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(String::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for s in listener.incoming().flatten().take(20) {
                let mut s = s;
                let mut buf = [0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                seen2.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
                let _ = s.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"GitHub\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        });
        let base = std::env::temp_dir().join(format!("gfs-git-tok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (c, p) = person(&base, "andre");
        let url = format!("http://127.0.0.1:{port}/");
        let b64 = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{TOKEN}"));
        let e = run(&c, &p, &url, &req("init", "dono/jogo", Some(TOKEN)), Duration::from_secs(60)).unwrap_err();
        assert!(e.contains("git fetch falhou"), "{e}");
        assert!(!e.contains(TOKEN) && !e.contains(&b64), "mensagem vazou o token");
        assert!(seen.lock().unwrap().contains(&format!("Authorization: Basic {b64}")), "o cabeçalho chegou ao servidor");
        let cfg = std::fs::read_to_string(c.join(".git").join("config")).unwrap();
        assert!(!cfg.contains(TOKEN) && !cfg.contains(&b64) && !cfg.contains("extraheader"));
        assert!(cfg.contains(&format!("{url}dono/jogo.git")), "remoto sem credencial na URL");
        // Sem token e em segundo plano: falha sem abrir janela nem ficar esperando.
        let t = Instant::now();
        assert!(run(&c, &p, &url, &req("fetch", "dono/jogo", None), Duration::from_secs(60)).is_err());
        assert!(t.elapsed() < Duration::from_secs(50));
        let _ = std::fs::remove_dir_all(&base);
    }
}
