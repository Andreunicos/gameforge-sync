import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

/**
 * Ao abrir, confere o latest.json da última release no GitHub. Se tiver versão nova,
 * baixa, confere a assinatura, instala e reabre sozinho — sem perguntar.
 */
export function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState("verificando…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update || cancelled) return;
      setVersion(update.version);
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setProgress(total ? `baixando ${Math.round((got / total) * 100)}%` : `baixando ${(got / 1e6).toFixed(1)} MB`);
        }
        if (ev.event === "Finished") setProgress("instalando…");
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    })().catch((e) => {
      console.warn("Atualização automática falhou:", e);
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!version) return null;

  return (
    <div className="update-banner">
      <span>
        🎉 Atualizando para a versão <b>{version}</b>
      </span>
      <span className="grow" />
      {error ? (
        <span style={{ color: "var(--bad)" }}>Não deu para atualizar agora ({error}). Tenta abrir o app de novo.</span>
      ) : (
        <span className="muted">{progress} — o app reabre sozinho</span>
      )}
    </div>
  );
}
