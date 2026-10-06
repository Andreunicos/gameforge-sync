// Autoatualização pelo GitHub (latest.json da última release). Roda sozinha ao abrir o app
// e também pelo botão "Verificar atualização". Achou versão nova: baixa, instala e reabre.
import { isTauri } from "@tauri-apps/api/core";

export type UpdatePhase = "idle" | "checking" | "latest" | "downloading" | "installing" | "error";
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

export async function checkAndInstall(): Promise<void> {
  if (!isTauri() || state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") return;
  set({ phase: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
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
