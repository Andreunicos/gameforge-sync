import { useEffect, useSyncExternalStore } from "react";
import { checkAndInstall, onUpdate, updateState } from "../updater";

/** Confere atualização ao abrir; se tiver, mostra o progresso enquanto instala e reabre. */
export function UpdateBanner() {
  const s = useSyncExternalStore(onUpdate, updateState);

  useEffect(() => {
    void checkAndInstall();
  }, []);

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
