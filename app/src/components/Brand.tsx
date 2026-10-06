import { useSyncExternalStore } from "react";
import { APP_VERSION } from "../config";
import { canUpdate, checkAndInstall, onUpdate, updateState } from "../updater";

const LABEL = {
  idle: "Verificar atualização",
  checking: "Verificando…",
  latest: "✓ Você está na versão mais nova",
  available: "Atualizar agora",
  downloading: "Baixando…",
  installing: "Instalando…",
  error: "Tentar de novo",
} as const;

export function Brand({ subtitle }: { subtitle?: string }) {
  const u = useSyncExternalStore(onUpdate, updateState);
  return (
    <div className="brand">
      <div className="brand-logo">GF</div>
      <div className="grow">
        <h1>GameForge Sync</h1>
        <p>{subtitle ?? `Jogos HTML5 feitos a várias mãos (e vários Claudes) · v${APP_VERSION}`}</p>
        {canUpdate() && (
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className="ghost small update-btn"
              onClick={() => void checkAndInstall()}
              disabled={u.phase === "checking" || u.phase === "downloading" || u.phase === "installing"}
            >
              ⟳ {LABEL[u.phase]}
            </button>
            {u.phase === "error" && <span className="small" style={{ color: "var(--bad)" }}>{u.error}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
