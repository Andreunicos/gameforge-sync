import { useEffect, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { addMember, createInvite, listProfiles, updateRoomSettings, type Profile } from "../rooms";
import { ALLOWED_EMAILS } from "../config";
import type { Room } from "../types";

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
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
      <People user={user} room={room} />
      <h4 className="small muted" style={{ margin: "18px 0 6px" }}>
        Ou por código
      </h4>
      <p className="muted small" style={{ marginTop: 0 }}>
        Quem tiver o código entra como <b>editor</b>: no app, “Entrar com código”.
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

/** Pessoas autorizadas: o dono adiciona com um clique e a sala aparece sozinha na lista delas. */
function People({ user, room }: { user: User; room: Room }) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProfiles()
      .then(setProfiles)
      .catch((e: Error) => setError(e.message));
  }, []);

  const add = async (p: Profile) => {
    setBusy(p.uid);
    setError(null);
    try {
      await addMember(user, room.id, p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const known = new Set(profiles?.map((p) => p.email));
  const neverOpened = ALLOWED_EMAILS.filter((e) => !known.has(e));

  return (
    <div className="people-list">
      {profiles === null && !error && <span className="muted small">Carregando…</span>}
      {profiles?.map((p) => {
        const member = room.memberIds.includes(p.uid);
        return (
          <div key={p.uid} className="person">
            <span className="grow">
              <b>{p.name}</b> <span className="muted small">{p.email}</span>
            </span>
            {member ? (
              <span className="muted small">{p.uid === user.uid ? "você" : "✓ na sala"}</span>
            ) : (
              <button className="primary small" disabled={busy === p.uid} onClick={() => void add(p)}>
                {busy === p.uid ? "…" : "Adicionar"}
              </button>
            )}
          </div>
        );
      })}
      {neverOpened.map((e) => (
        <div key={e} className="person">
          <span className="grow muted small">{e}</span>
          <span className="muted small">ainda não abriu o app</span>
        </div>
      ))}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

export function Cmd({ text }: { text: string }) {
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
