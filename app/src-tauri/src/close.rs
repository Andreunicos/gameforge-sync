//! Fechar a janela: a tela grava o que está pendente nas salas e, se este PC hospeda o servidor do Multi-User,
//! pergunta antes (fechar derruba a sessão de todo mundo). Só vale quando a tela avisa que sabe fazer isso
//! (`close_guard(true)`): tela antiga num app novo fecha como sempre fechou.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::unreal::UnrealState;

#[derive(Default)]
pub struct CloseGuard {
    on: AtomicBool,
    asked: Mutex<Option<Instant>>,
}

/// A tela liga (ou desliga) o pedido de confirmação ao fechar. Ligar de novo também "esquece" o último pedido
/// (a pessoa respondeu Cancelar e a janela continua aberta).
#[tauri::command]
pub fn close_guard(state: tauri::State<CloseGuard>, on: bool) {
    state.on.store(on, Ordering::SeqCst);
    if let Ok(mut asked) = state.asked.lock() {
        *asked = None;
    }
}

/// A tela terminou (gravou e, se precisava, a pessoa confirmou): fecha de verdade.
#[tauri::command]
pub fn app_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// Chamado no CloseRequested da janela. Segundo clique no X em menos de 10 s fecha de qualquer jeito
/// (uma tela travada nunca prende a janela aberta).
pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let guard = window.state::<CloseGuard>();
    if !guard.on.load(Ordering::SeqCst) {
        return;
    }
    let Ok(mut asked) = guard.asked.lock() else { return };
    if asked.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
        return;
    }
    *asked = Some(Instant::now());
    api.prevent_close();
    let hosting = window.state::<UnrealState>().hosting();
    let _ = window.emit("gfs-close-requested", hosting);
}
