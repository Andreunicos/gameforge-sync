// Autoatualização pelo GitHub (latest.json da última release). Roda sozinha ao abrir o app
// e também pelo botão "Verificar atualização". Achou versão nova: baixa, instala e reabre.
import { isTauri } from "@tauri-apps/api/core";

export type UpdatePhase = "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "error";
export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  progress?: string;
  error?: string;
}

let state: UpdateState = { phase: "idle" };
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

export const updateState = () => state;
export function onUpdate(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const canUpdate = () => isTauri();

type Update = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;
let pending: Update = null;
let timer: number | undefined;

/**
 * Com o app aberto, confere a cada 30 min. Não reinicia no meio do trabalho:
 * só mostra o aviso "Atualizar agora" (ao abrir o app a instalação é automática).
 */
export function startPeriodicCheck() {
  if (!isTauri() || timer) return;
  timer = window.setInterval(async () => {
    if (state.phase !== "idle" && state.phase !== "latest" && state.phase !== "error") return;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      if (u) {
        pending = u;
        set({ phase: "available", version: u.version });
      }
    } catch {
      /* sem internet etc.: tenta na próxima */
    }
  }, 30 * 60_000);
}

export async function checkAndInstall(): Promise<void> {
  if (!isTauri() || state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") return;
  startPeriodicCheck();
  set({ phase: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = pending ?? (await check());
    pending = null;
    if (!update) {
      set({ phase: "latest" });
      return;
    }
    set({ phase: "downloading", version: update.version, progress: "0%" });
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        set({
          phase: "downloading",
          version: update.version,
          progress: total ? `${Math.round((got / total) * 100)}%` : `${(got / 1e6).toFixed(1)} MB`,
        });
      }
      if (ev.event === "Finished") set({ phase: "installing", version: update.version });
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    console.warn("Atualização falhou:", e);
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

// ── tela publicada no site (atualiza em ~1 min, sem reinstalar) ─────────────

let webUpdate = false;
const webListeners = new Set<() => void>();
export const webUpdateReady = () => webUpdate;
export function onWebUpdate(l: () => void) {
  webListeners.add(l);
  return () => {
    webListeners.delete(l);
  };
}

/**
 * Quando a tela vem do site (/app/), confere a cada 3 min se saiu publicação nova.
 * Fora de uma sala recarrega sozinho; dentro de uma sala só avisa (para não cortar ninguém editando).
 */
export function startWebCheck() {
  if (__BUILD_ID__ === "dev" || !location.pathname.startsWith("/app/") || webUpdate) return;
  const check = async () => {
    try {
      const res = await fetch("/app/version.json", { cache: "no-store" });
      const { build } = (await res.json()) as { build?: string };
      if (!build || build === __BUILD_ID__) return;
      if (!location.hash.startsWith("#/room/")) {
        location.reload();
        return;
      }
      webUpdate = true;
      webListeners.forEach((l) => l());
      window.clearInterval(timerWeb);
    } catch {
      /* sem internet: tenta depois */
    }
  };
  const timerWeb = window.setInterval(check, 3 * 60_000);
  window.addEventListener("focus", () => void check());
  void check();
}
