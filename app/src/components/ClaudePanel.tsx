import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { Room } from "../types";
import type { MirrorStatus } from "../sync/folderMirror";
import { roomSlug } from "../sync/folderMirror";
import { Cmd, Modal } from "./Modals";

const GFS_INSTALL = "npm i -g https://github.com/Andreunicos/gameforge-sync/releases/latest/download/gfs.tgz";

export type OpenTool = "vscode" | "folder" | "claude";

export function ClaudePanel({
  room,
  status,
  onStart,
  onOpen,
  onStop,
  onClose,
}: {
  room: Room;
  status: MirrorStatus | null;
  onStart: () => Promise<void>;
  onOpen: (tool: OpenTool) => Promise<void>;
  onStop: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const on = status?.state === "on";

  return (
    <Modal title="🤖 Claude nesta sala" onClose={onClose}>
      {isTauri() ? (
        on ? (
          <>
            <div className="mirror-on">
              <span className="dot" style={{ background: "var(--ok)" }} />
              <div className="grow">
                <b>Pasta do Claude ligada</b>
                <div className="small muted ellipsis" title={status.dir}>
                  {status.dir}
                </div>
                {status.last && <div className="small muted">último: {status.last}</div>}
              </div>
            </div>
            <p className="small muted" style={{ lineHeight: 1.55 }}>
              Peça qualquer coisa ao Claude no VS Code. Tudo que ele salvar aparece para a sala em segundos, e o que os outros
              mudam chega na pasta dele. <b>Deixe o app aberto nesta sala</b> enquanto o Claude trabalha.
            </p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="primary" disabled={busy} onClick={run(() => onOpen("vscode"))}>
                Abrir VS Code + Claude
              </button>
              <button disabled={busy} onClick={run(() => onOpen("folder"))}>
                Abrir pasta
              </button>
              <button className="ghost" disabled={busy} onClick={run(onStop)}>
                Desligar
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ marginTop: 0, lineHeight: 1.55 }}>
              Um clique e pronto: o app cria uma pasta com o jogo no seu PC, abre o <b>VS Code</b> e a <b>conversa do Claude</b>.
              O que o Claude salvar aparece para todo mundo em segundos.
            </p>
            <button
              className="primary"
              style={{ width: "100%", padding: 12 }}
              disabled={busy || status?.state === "starting"}
              onClick={run(onStart)}
            >
              {busy || status?.state === "starting" ? "Preparando a pasta…" : "⚡ Ligar Claude"}
            </button>
            {status?.state === "error" && <div className="error-box">{status.error}</div>}
          </>
        )
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          No navegador o app não consegue mexer em pastas. Use o app instalado, ou o plano B abaixo.
        </p>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="note-box small">
        <b>Token:</b> o app não gasta nenhum. O Claude só gasta com o trabalho em si (ler e editar código), igual a qualquer
        projeto. Dica: jogo dividido em vários arquivos pequenos (player.js, ui.js…) gasta bem menos do que um index.html gigante.
      </div>

      <details style={{ marginTop: 12 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>
          Plano B: Claude sem o app aberto (linha de comando gfs)
        </summary>
        <ol className="steps small">
          <li>
            Instalar (uma vez): <Cmd text={GFS_INSTALL} />
          </li>
          <li>
            Entrar: <Cmd text="gfs login" />
          </li>
          <li>
            Baixar a sala: <Cmd text={`gfs clone ${room.id}`} />
          </li>
          <li>
            Na pasta <code>{roomSlug(room.name)}</code>: <code>gfs pull</code> antes, <code>gfs push "o que fez"</code> depois.
          </li>
        </ol>
      </details>

      <div className="actions">
        <button onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}
