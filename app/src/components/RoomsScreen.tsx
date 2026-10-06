import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { go } from "../App";
import { logout, displayName } from "../auth";
import { createRoom, joinWithCode, watchMyRooms } from "../rooms";
import type { Room } from "../types";
import { Brand } from "./Brand";

const ROLE_LABEL = { owner: "dono", editor: "editor", viewer: "espectador" } as const;

export function RoomsScreen({ user, initialError }: { user: User; initialError: string | null }) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => watchMyRooms(user.uid, setRooms, (e) => setError(e.message)), [user.uid]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      go({ name: "room", id: await fn() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card">
        <Brand />
        <div className="row">
          <span className="grow muted">
            Logado como <b style={{ color: "var(--text)" }}>{displayName(user)}</b>
          </span>
          <button className="ghost small" onClick={() => void logout()}>
            Sair
          </button>
        </div>

        <h2>Suas salas</h2>
        <div className="room-list">
          {rooms === null && <span className="muted">Carregando…</span>}
          {rooms?.length === 0 && <span className="muted">Nenhuma sala ainda. Crie uma ou entre com um código.</span>}
          {rooms?.map((r) => (
            <button key={r.id} className="room-item" onClick={() => go({ name: "room", id: r.id })}>
              <span className="grow ellipsis" style={{ fontWeight: 600 }}>
                {r.name}
              </span>
              <span className="muted small">{r.memberIds.length} pessoa{r.memberIds.length > 1 ? "s" : ""}</span>
              <span className="role">{ROLE_LABEL[r.roles[user.uid]] ?? "?"}</span>
            </button>
          ))}
        </div>

        <h2>Nova sala</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void run(() => createRoom(user, name.trim()));
          }}
        >
          <input placeholder="Nome do jogo (ex.: Capivaras TD)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={busy || !name.trim()}>
            Criar
          </button>
        </form>

        <h2>Entrar com código</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) void run(() => joinWithCode(user, code));
          }}
        >
          <input
            placeholder="Código de convite"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            style={{ fontFamily: "monospace", letterSpacing: "0.1em" }}
          />
          <button disabled={busy || !code.trim()}>Entrar</button>
        </form>

        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}
