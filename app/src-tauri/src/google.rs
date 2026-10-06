//! Login Google pelo navegador do sistema.
//!
//! O Google bloqueia login dentro de WebViews embutidas, então o app abre a página
//! https://gameforge-sync.web.app/login no navegador normal, escuta em
//! 127.0.0.1:<porta> e recebe de volta o `id_token` do Google. O front entra no
//! Firebase com `signInWithCredential`. O gfs usa a mesma página.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;

const LOGIN_PAGE: &str = "https://gameforge-sync.web.app/login";
const TIMEOUT: Duration = Duration::from_secs(300);

#[tauri::command]
pub async fn google_login(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || login(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn random_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn login(app: &tauri::AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = random_token()?;

    let url = url::Url::parse_with_params(LOGIN_PAGE, &[("port", port.to_string()), ("state", state.clone())])
        .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;

    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if Instant::now() > deadline {
            return Err("Tempo esgotado esperando o login no navegador.".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = handle_request(stream, &state) {
                    return result;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Devolve `None` para requisições que não são o retorno do login (ex.: favicon).
fn handle_request(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let path = line.split_whitespace().nth(1)?;
    let url = url::Url::parse(&format!("http://localhost{path}")).ok()?;

    if url.path() != "/callback" {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return None;
    }

    let mut token = None;
    let mut got_state = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "id_token" => token = Some(v.into_owned()),
            "state" => got_state = Some(v.into_owned()),
            _ => {}
        }
    }

    // O state impede que outra página do navegador injete um login falso.
    let result = match token {
        Some(t) if got_state.as_deref() == Some(state) => Ok(t),
        _ => Err("Resposta de login inválida. Tente de novo.".into()),
    };

    let (title, msg) = if result.is_ok() {
        ("Pronto!", "Login feito. Pode fechar esta aba e voltar para o GameForge Sync.")
    } else {
        ("Ops", "O login não foi concluído. Volte para o GameForge Sync e tente de novo.")
    };
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title>\
         <body style=\"font-family:system-ui;background:#120f19;color:#f1ebf8;display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"text-align:center\"><h1>{title}</h1><p style=\"color:#9a8fb0\">{msg}</p></div>"
    );
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
    Some(result)
}
