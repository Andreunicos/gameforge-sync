import { useState } from "react";
import type { RojoInfo, RojoServer } from "../rojo";
import { placeFolder } from "../sync/templates";
import { Cmd, Modal } from "./Modals";

export function RojoPanel({
  servers,
  info,
  install,
  onInstall,
  onRestart,
  onStop,
  onAddPlace,
  onClose,
}: {
  servers: RojoServer[];
  info: RojoInfo | null;
  install: { busy: boolean; msg?: string; error?: string };
  onInstall: () => void;
  onRestart: () => void;
  onStop: () => Promise<void>;
  onAddPlace: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = servers.filter((s) => s.error).map((s) => s.error!);
  const missing = errors.some((e) => e.includes("ROJO_NAO_ENCONTRADO"));
  const oldApp = errors.some((e) => /not allowed|not found|Command .* not/i.test(e) && !e.includes("ROJO_NAO_ENCONTRADO"));
  const anyOn = servers.some((s) => s.state === "on");

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAddPlace(name);
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="🧩 Rojo: locais desta sala" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.55 }}>
        Cada <b>local</b> (mapa/place) é uma pasta da sala com o próprio Rojo e a própria porta. Eles ligam sozinhos quando você abre a
        sala, no seu PC e no de cada amigo.
      </p>

      {info && (
        <div className="mirror-on" style={{ marginBottom: 8 }}>
          <span className="dot" style={{ background: info.version && info.plugin ? "var(--ok)" : "#e5484d" }} />
          <div className="grow">
            <b>{info.version ? `Rojo ${info.version}` : "Rojo não instalado"}</b>{" "}
            <span className="muted small">· plugin do Studio {info.plugin ? "instalado" : "não instalado"}</span>
          </div>
          <button className={info.version && info.plugin ? "" : "primary"} disabled={install.busy} onClick={onInstall}>
            {install.busy ? "Instalando…" : !info.version ? "Instalar Rojo" : !info.plugin ? "Instalar plugin" : "Verificar atualização"}
          </button>
        </div>
      )}
      {install.busy && <p className="small muted">Isso pode levar um minuto. Não feche o app.</p>}
      {install.msg && <div className="note-box small">{install.msg}</div>}
      {install.error && <div className="error-box">{install.error}</div>}

      {servers.length === 0 && <p className="muted">Nenhum local ligado ainda. Crie o primeiro abaixo.</p>}
      {servers.map((s) => (
        <div key={s.place} className="mirror-on" style={{ marginBottom: 6 }}>
          <span className="dot" style={{ background: s.state === "on" ? "var(--ok)" : s.state === "error" ? "#e5484d" : "#888" }} />
          <div className="grow">
            <b>{s.place}</b>{" "}
            <span className="muted small">{s.state === "on" ? `porta ${s.port}` : s.state === "starting" ? "ligando…" : "não ligou"}</span>
          </div>
        </div>
      ))}

      {missing && (
        <div className="error-box">
          O Rojo não está instalado neste PC: clique em <b>Instalar Rojo</b> acima. Se preferir fazer à mão:
          <div style={{ marginTop: 6 }}>
            <Cmd text="winget install Rojo.Rojo" />
          </div>
        </div>
      )}
      {oldApp && <div className="error-box">Esta versão do app ainda não liga o Rojo. Feche e abra o GameForge para atualizar.</div>}
      {errors.length > 0 && !missing && !oldApp && <div className="error-box">{errors[0]}</div>}

      <h4 style={{ marginBottom: 6 }}>Novo local</h4>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void add();
        }}
      >
        <input placeholder="Nome do mapa (ex.: Arena)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={busy || !name.trim()}>
          Criar
        </button>
      </form>
      {name.trim() && <div className="small muted">Pasta: {placeFolder(name)}/</div>}
      {error && <div className="error-box">{error}</div>}

      <p className="small" style={{ marginBottom: 4 }}>
        <b>No Roblox Studio</b> (plugin uma vez por PC: <code>rojo plugin install</code>): aba <b>Plugins</b> → <b>Rojo</b> →{" "}
        <b>Connect</b>, host <code>localhost</code> e a porta do local que você abriu.
      </p>

      <div className="actions">
        <button onClick={onClose}>Fechar</button>
        {anyOn && <button onClick={() => void onStop()}>Desligar tudo</button>}
        <button className="primary" onClick={onRestart}>
          Ligar tudo
        </button>
      </div>
    </Modal>
  );
}
