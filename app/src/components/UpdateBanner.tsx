import { useEffect, useSyncExternalStore } from "react";
import { checkAndInstall, onUpdate, onWebUpdate, startWebCheck, updateState, webUpdateReady } from "../updater";

/** Confere atualização ao abrir; se tiver, mostra o progresso enquanto instala e reabre. */
export function UpdateBanner() {
  const s = useSyncExternalStore(onUpdate, updateState);
  const web = useSyncExternalStore(onWebUpdate, webUpdateReady);

  useEffect(() => {
    void checkAndInstall();
    startWebCheck();
  }, []);

  if (web && s.phase !== "downloading" && s.phase !== "installing") {
    return (
      <div className="update-banner">
        <span>✨ O app ganhou melhorias</span>
        <span className="grow" />
        <span className="muted small">espere 2 s depois de digitar e clique</span>
        <button className="primary" onClick={() => location.reload()}>
          Recarregar
        </button>
      </div>
    );
  }

  if (s.phase === "available") {
    return (
      <div className="update-banner">
        <span>
          🎉 Saiu a versão <b>{s.version}</b>
        </span>
        <span className="grow" />
        <button className="primary" onClick={() => void checkAndInstall()}>
          Atualizar agora
        </button>
      </div>
    );
  }
  if (s.phase !== "downloading" && s.phase !== "installing") return null;
  return (
    <div className="update-banner">
      <span>
        🎉 Atualizando para a versão <b>{s.version}</b>
      </span>
      <span className="grow" />
      <span className="muted">
        {s.phase === "installing" ? "instalando…" : `baixando ${s.progress}`} — o app reabre sozinho
      </span>
    </div>
  );
}
