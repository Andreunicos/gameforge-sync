import { useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { createInvite, updateRoomSettings } from "../rooms";
import type { Room } from "../types";

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function InviteModal({ user, room, onClose }: { user: User; room: Room; onClose: () => void }) {
  const [code, setCode] = useState(room.inviteCode ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await createInvite(user, room));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Convidar para a sala" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Quem tiver o código entra como <b>editor</b>. Mande para o seu amigo: ele abre o app, faz login e cola em “Entrar com
        código”.
      </p>
      {code ? (
        <>
          <div className="invite-code">{code}</div>
          <div className="row">
            <button
              className="primary grow"
              onClick={() => {
                void navigator.clipboard.writeText(code);
                setCopied(true);
              }}
            >
              {copied ? "Copiado ✓" : "Copiar código"}
            </button>
            <button onClick={() => void make()} disabled={busy} title="Gera um código novo e invalida o antigo">
              Trocar código
            </button>
          </div>
        </>
      ) : (
        <button className="primary" onClick={() => void make()} disabled={busy}>
          {busy ? "Gerando…" : "Gerar código de convite"}
        </button>
      )}
      {error && <div className="error-box">{error}</div>}
      <div className="actions">
        <button onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}

const GFS_INSTALL = "npm i -g https://github.com/Andreunicos/gameforge-sync/releases/latest/download/gfs.tgz";

/** Mesmo nome de pasta que o `gfs clone` cria. */
function slug(name: string) {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "sala"
  );
}

function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        className="ghost small"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "✓" : "copiar"}
      </button>
    </div>
  );
}

export function ClaudeModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const folder = slug(room.name);
  return (
    <Modal title="🤖 Conectar o seu Claude a esta sala" onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0, lineHeight: 1.55 }}>
        O Claude não mexe aqui dentro do app. Ele trabalha no <b>Claude Code</b>, numa pasta do seu PC que é uma cópia da sala, e
        no fim de cada tarefa manda <b>só o que mudou</b> com <code>gfs push</code>. Aqui no app você vê as mudanças chegarem
        como “Claude de {"<"}seu nome{">"}”.
      </p>
      <ol className="steps">
        <li>
          Instalar o <code>gfs</code> (só uma vez por PC, precisa do Node.js):
          <Cmd text={GFS_INSTALL} />
        </li>
        <li>
          Entrar com a sua conta Google (só uma vez):
          <Cmd text="gfs login" />
        </li>
        <li>
          Baixar esta sala para uma pasta:
          <Cmd text={`gfs clone ${room.id}`} />
        </li>
        <li>
          Abrir o Claude Code nessa pasta:
          <Cmd text={`cd ${folder} && claude`} />
          <span className="small muted">Ou abra a pasta “{folder}” no VS Code e use o Claude de lá.</span>
        </li>
        <li>
          Pedir normalmente, ex.: <i>“deixa o pulo do personagem mais alto”</i>. O <code>CLAUDE.md</code> da sala ensina o Claude a
          rodar <code>gfs status</code> antes e <code>gfs push</code> no fim.
        </li>
      </ol>
      <div className="note-box small">
        <b>Token:</b> o app não gasta token nenhum. Cada pessoa usa o próprio plano do Claude, e os comandos do gfs respondem com
        2 a 10 linhas. O que gasta é o trabalho em si (ler e editar código), igual a usar o Claude Code em qualquer projeto.
      </div>
      <div className="actions">
        <button onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}

export function SettingsModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const [name, setName] = useState(room.name);
  const [assetsBase, setAssetsBase] = useState(room.assetsBase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRoomSettings(room.id, { name: name.trim() || room.name, assetsBase: assetsBase.trim() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Configurações da sala" onClose={onClose}>
      <label className="small muted">Nome</label>
      <input value={name} onChange={(e) => setName(e.target.value)} style={{ margin: "4px 0 14px" }} />
      <label className="small muted">URL dos assets (imagens e sons)</label>
      <input
        value={assetsBase}
        placeholder="https://andreunicos.github.io/meu-jogo/"
        onChange={(e) => setAssetsBase(e.target.value)}
        style={{ marginTop: 4 }}
      />
      <p className="small muted" style={{ lineHeight: 1.5 }}>
        Imagens e sons ficam no repositório do jogo no GitHub (GitHub Pages). O preview busca os caminhos relativos nessa URL,
        ex.: <code>img/capivara.png</code> → <code>{(assetsBase || "https://…/").replace(/\/?$/, "/")}img/capivara.png</code>
      </p>
      {error && <div className="error-box">{error}</div>}
      <div className="actions">
        <button onClick={onClose}>Cancelar</button>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          Salvar
        </button>
      </div>
    </Modal>
  );
}
