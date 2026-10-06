//! Login Google pelo navegador do sistema (fluxo "loopback" para apps desktop).
//!
//! O Google bloqueia login dentro de WebViews embutidas, então o app abre o
//! navegador normal, escuta em 127.0.0.1:<porta> o retorno com o `code`,
//! troca o code por um `id_token` e devolve o token para o front, que entra
//! no Firebase com `signInWithCredential`. O gfs usa o mesmo fluxo.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const TIMEOUT: Duration = Duration::from_secs(180);

#[tauri::command]
pub async fn google_login(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || login(&app, &client_id, &client_secret))
        .await
        .map_err(|e| e.to_string())?
}

fn random_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn login(app: &tauri::AppHandle, client_id: &str, client_secret: &str) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_token()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token()?;

    let auth_url = url::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("prompt", "select_account"),
        ],
    )
    .map_err(|e| e.to_string())?;

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;

    let code = wait_for_code(&listener, &state)?;

    let resp: serde_json::Value = ureq::post(TOKEN_URL)
        .send_form(&[
            ("code", code.as_str()),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .map_err(|e| match e {
            ureq::Error::Status(status, r) => {
                format!("Google recusou o login ({status}): {}", r.into_string().unwrap_or_default())
            }
            other => other.to_string(),
        })?
        .into_json()
        .map_err(|e| e.to_string())?;

    resp["id_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "o Google não devolveu id_token".to_owned())
}

fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if Instant::now() > deadline {
            return Err("tempo esgotado esperando o login no navegador".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = handle_request(stream, state) {
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

    let mut code = None;
    let mut got_state = None;
    let mut error = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => got_state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }

    if code.is_none() && error.is_none() {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return None;
    }

    let result = match (code, error) {
        (_, Some(err)) => Err(format!("login cancelado ({err})")),
        (Some(c), None) if got_state.as_deref() == Some(state) => Ok(c),
        _ => Err("resposta de login inválida".into()),
    };

    let (title, msg) = if result.is_ok() {
        ("Pronto!", "Login feito. Pode fechar esta aba e voltar para o GameForge Sync.")
    } else {
        ("Ops", "O login não foi concluído. Volte para o GameForge Sync e tente de novo.")
    };
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title>\
         <body style=\"font-family:system-ui;background:#16131f;color:#f3eefc;display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"text-align:center\"><h1>{title}</h1><p>{msg}</p></div>"
    );
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
    Some(result)
}
