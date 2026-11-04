import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { go } from "../App";
import { logout, displayName } from "../auth";
import { createRoom, deleteRoom, joinWithCode, watchMyRooms } from "../rooms";
import type { Room, RoomKind } from "../types";
import { addFolder, folderOf, groupRooms, loadFolders, moveRoom, removeFolder, renameFolder, saveFolders, toggleFolder, type RoomFolders } from "../roomFolders";
import { Brand } from "./Brand";
import { CartIcon, TrashIcon } from "./PixelArt";

const ROLE_LABEL = { owner: "dono", editor: "editor", viewer: "espectador" } as const;

export function RoomsScreen({ user, initialError }: { user: User; initialError: string | null }) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RoomKind>("html5");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [folders, setFolders] = useState<RoomFolders>(() => loadFolders(user.uid));
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null); // id null = pasta nova

  const changeFolders = (fn: (f: RoomFolders) => RoomFolders) => {
    const next = fn(folders);
    setFolders(next);
    saveFolders(user.uid, next);
  };
  const commitFolder = () => {
    if (editing) changeFolders((f) => (editing.id ? renameFolder(f, editing.id, editing.name) : addFolder(f, editing.name)));
    setEditing(null);
  };

  const remove = async (r: Room) => {
    if (!confirm(`Apagar a sala "${r.name}" para TODO MUNDO?

Somem os arquivos de código, a atividade e o convite. Não dá para desfazer.
(A pasta do Claude no seu PC continua lá.)${r.diversion?.repoId ? `\nO repositório ${r.diversion.name} do Diversion também continua: apague lá se quiser.` : ""}${r.git?.repo ? `\nO repositório ${r.git.repo} do GitHub também continua: apague lá se quiser.` : ""}`))
      return;
    setDeleting(r.id);
    setError(null);
    try {
      await deleteRoom(r);
      try {
        localStorage.removeItem(`gfs-mirror-${r.id}`);
      } catch {
        /* ignora */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

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

  const roomRow = (r: Room) => (
    <div key={r.id} className="room-row">
      <button className="room-item" onClick={() => go({ name: "room", id: r.id })} disabled={deleting === r.id}>
        <CartIcon seed={r.id} />
        <span className="grow ellipsis" style={{ fontWeight: 600 }}>
          {deleting === r.id ? `Apagando ${r.name}…` : r.name}
        </span>
        <span className="muted small">{r.memberIds.length} pessoa{r.memberIds.length > 1 ? "s" : ""}</span>
        <span className="role">{ROLE_LABEL[r.roles[user.uid]] ?? "?"}</span>
      </button>
      {folders.folders.length > 0 && (
        <select
          className="room-folder-pick"
          title="Mover para uma pasta (só visual, só para você)"
          value={folderOf(folders, r.id) ?? ""}
          onChange={(e) => changeFolders((f) => moveRoom(f, r.id, e.target.value || null))}
        >
          <option value="">Sem pasta</option>
          {folders.folders.map((f) => (
            <option key={f.id} value={f.id}>
              📁 {f.name}
            </option>
          ))}
        </select>
      )}
      {r.ownerId === user.uid && (
        <button className="ghost danger room-del" title="Apagar sala" disabled={!!deleting} onClick={() => void remove(r)}>
          <TrashIcon />
        </button>
      )}
    </div>
  );

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

        <div className="row">
          <h2 className="grow">Suas salas</h2>
          <button className="ghost small" title="Pastas só para organizar a lista: só você vê, e não mudam nada nas salas" onClick={() => setEditing({ id: null, name: "" })}>
            + pasta
          </button>
        </div>
        {editing?.id === null && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              commitFolder();
            }}
          >
            <input autoFocus placeholder="Nome da pasta" value={editing.name} onChange={(e) => setEditing({ id: null, name: e.target.value })} />
            <button className="primary" disabled={!editing.name.trim()}>
              Criar
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              Cancelar
            </button>
          </form>
        )}
        <div className="room-list">
          {rooms === null && <span className="muted">Carregando…</span>}
          {rooms?.length === 0 && <span className="muted">Nenhuma sala ainda. Crie uma ou entre com um código.</span>}
          {rooms &&
            groupRooms(folders, rooms).folders.map(({ folder, rooms: inside }) => (
              <div key={folder.id} className="room-folder">
                {editing?.id === folder.id ? (
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitFolder();
                    }}
                  >
                    <input autoFocus value={editing.name} onChange={(e) => setEditing({ id: folder.id, name: e.target.value })} />
                    <button className="primary" disabled={!editing.name.trim()}>
                      Salvar
                    </button>
                    <button type="button" className="ghost" onClick={() => setEditing(null)}>
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <div className="folder-head">
                    <button className="ghost grow folder-toggle" onClick={() => changeFolders((f) => toggleFolder(f, folder.id))}>
                      {folder.open ? "▾" : "▸"} 📁 {folder.name} <span className="muted small">({inside.length})</span>
                    </button>
                    <button className="ghost small" title="Renomear pasta" onClick={() => setEditing({ id: folder.id, name: folder.name })}>
                      ✎
                    </button>
                    <button
                      className="ghost small"
                      title="Apagar pasta (as salas voltam para a lista, nada é apagado)"
                      onClick={() => confirm(`Apagar a pasta "${folder.name}"? As salas dela voltam para a lista; nenhuma sala é apagada.`) && changeFolders((f) => removeFolder(f, folder.id))}
                    >
                      ✕
                    </button>
                  </div>
                )}
                {folder.open && (
                  <div className="room-list folder-body">
                    {inside.length === 0 && <span className="muted small">Pasta vazia: use o seletor ao lado de uma sala para movê-la para cá.</span>}
                    {inside.map(roomRow)}
                  </div>
                )}
              </div>
            ))}
          {rooms && groupRooms(folders, rooms).loose.map(roomRow)}
        </div>

        <h2>Nova sala</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void run(() => createRoom(user, name.trim(), kind));
          }}
        >
          <select value={kind} onChange={(e) => setKind(e.target.value as RoomKind)} title="Tipo de jogo da sala">
            <option value="html5">HTML5</option>
            <option value="roblox">Roblox (Rojo)</option>
            <option value="unreal">Unreal 5.8</option>
          </select>
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
