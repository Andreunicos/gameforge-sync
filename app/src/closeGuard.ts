// Fechar a janela do app (Rust: close.rs): antes, grava o que está pendente (editor e pasta do Claude) e, se este PC
// hospeda o servidor do Multi-User, pergunta (fechar derruba a sessão de todo mundo). App antigo, sem os comandos:
// a janela fecha como sempre fechou.
import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const FLUSH_MAX_MS = 5000;
const flushers = new Set<() => Promise<unknown>>();

/** Registra o que gravar quando a janela fechar. Devolve a função que tira o registro. */
export function onAppClose(f: () => Promise<unknown>) {
  flushers.add(f);
  return () => {
    flushers.delete(f);
  };
}

async function closing(hosting: boolean) {
  const all = Promise.all([...flushers].map((f) => f().catch(() => {})));
  await Promise.race([all, new Promise((r) => setTimeout(r, FLUSH_MAX_MS))]);
  if (
    hosting &&
    !confirm(
      "Este PC hospeda a sessão do Multi-User: fechar o app derruba a sessão para todo mundo.\n\nAntes, alguém deve salvar a sessão no Unreal (Persist Session Changes). Fechar mesmo assim?",
    )
  ) {
    await invoke("close_guard", { on: true }); // fica aberta; o próximo X pergunta de novo
    return;
  }
  await invoke("app_close");
}

/** Uma vez, na raiz do app. */
export function useCloseGuard() {
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void listen<boolean>("gfs-close-requested", (e) => {
      void closing(e.payload === true).catch(() => invoke("app_close").catch(() => {}));
    }).then((u) => {
      if (!alive) return u();
      off = u;
      // Só depois de ouvir o evento: liga a confirmação no Rust. App antigo recusa o comando e nada muda.
      invoke("close_guard", { on: true }).catch(() => {});
    });
    return () => {
      alive = false;
      off?.();
      invoke("close_guard", { on: false }).catch(() => {});
    };
  }, []);
}
