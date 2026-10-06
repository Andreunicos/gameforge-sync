import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";

/** Ao abrir, confere o latest.json da última release no GitHub e oferece atualizar. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/plugin-updater")
      .then(({ check }) => check())
      .then((u) => u && setUpdate(u))
      .catch((e) => console.warn("Não deu para checar atualização:", e));
  }, []);

  if (!update) return null;

  const install = async () => {
    setError(null);
    let total = 0;
    let got = 0;
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setProgress(total ? `${Math.round((got / total) * 100)}%` : `${(got / 1e6).toFixed(1)} MB`);
        }
        if (ev.event === "Finished") setProgress("instalando…");
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="update-banner">
      <span>
        🎉 Versão <b>{update.version}</b> disponível{update.body ? ` — ${update.body}` : ""}
      </span>
      <span className="grow" />
      {error && <span style={{ color: "var(--bad)" }}>{error}</span>}
      {progress ? (
        <span className="muted">Baixando {progress}</span>
      ) : (
        <button className="primary" onClick={install}>
          Atualizar agora
        </button>
      )}
    </div>
  );
}
