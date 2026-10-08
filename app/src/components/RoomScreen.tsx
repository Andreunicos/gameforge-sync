import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { User } from "firebase/auth";
import { go } from "../App";
import { colorFor } from "../auth";
import { APP_VERSION, DAILY_WRITE_LIMIT } from "../config";
import { authorOf, versionLess, watchRoom } from "../rooms";
import { RoomSync, type Toast } from "../sync/roomSync";
import { onWrites, writesToday } from "../usage";
import type { Room } from "../types";
import { FileList } from "./FileList";
import { EditorPane } from "./EditorPane";
import { PreviewPane } from "./PreviewPane";
import { ActivityFeed } from "./ActivityFeed";
import { InviteModal, SettingsModal } from "./Modals";
import { ClaudePanel, type OpenTool } from "./ClaudePanel";
import { FolderMirror, type MirrorStatus } from "../sync/folderMirror";
import { Toasts } from "./Toasts";
import { HistoryPanel } from "./HistoryPanel";
import { ensureBaseline, maybeAutoCheckpoint, watchCheckpoints } from "../history";

export function RoomScreen({ user, roomId }: { user: User; roomId: string }) {
  const [room, setRoom] = useState<Room | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => watchRoom(roomId, setRoom, (e) => setError(e.message)), [roomId]);

  if (error || room === null) {
    return (
      <div className="center-screen">
        <div className="card">
          <h3>Não deu para abrir a sala</h3>
          <div className="error-box">{error ?? "Sala não encontrada ou você não é membro dela."}</div>
          <button style={{ marginTop: 14 }} onClick={() => go({ name: "rooms" })}>
            ← Voltar
          </button>
        </div>
      </div>
    );
  }
  if (!room) return <div className="center-screen muted">Abrindo sala…</div>;

  if (versionLess(APP_VERSION, room.minAppVersion)) {
    return (
      <div className="center-screen">
        <div className="card">
          <h3>Atualize o app para entrar</h3>
          <p className="muted">
            Esta sala pede a versão <b>{room.minAppVersion}</b> ou mais nova. Você está na {APP_VERSION}. Feche e abra o app
            para baixar a atualização.
          </p>
          <button onClick={() => go({ name: "rooms" })}>← Voltar</button>
        </div>
      </div>
    );
  }

  return <RoomWorkspace user={user} room={room} />;
}

function RoomWorkspace({ user, room }: { user: User; room: Room }) {
  const readOnly = (room.roles[user.uid] ?? "viewer") === "viewer";
  const [sync, setSync] = useState<RoomSync | null>(null);

  useEffect(() => {
    const s = new RoomSync(room.id, authorOf(user), colorFor(user.uid), readOnly);
    setSync(s);
    // Grava o que estiver pendente se a janela for fechada.
    const before = () => void s.close();
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
      void s.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, user.uid, readOnly]);

  if (!sync) return <div className="center-screen muted">Abrindo sala…</div>;
  return <Workspace key={room.id + readOnly} user={user} room={room} sync={sync} />;
}

function Workspace({ user, room, sync }: { user: User; room: Room; sync: RoomSync }) {
  const role = room.roles[user.uid] ?? "viewer";
  const readOnly = role === "viewer";
  const state = useSyncExternalStore(
    (l) => sync.subscribe(l),
    () => sync.state,
  );
  const [toasts, setToasts] = useState<(Toast & { id: number })[]>([]);
  const [modal, setModal] = useState<"invite" | "settings" | "claude" | "history" | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const writes = useSyncExternalStore(onWrites, writesToday);

  useEffect(() => {
    sync.onToast = (t) => {
      const id = Date.now() + Math.random();
      setToasts((ts) => [...ts, { ...t, id }]);
      window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === "info" ? 5000 : 15000);
    };
  }, [sync]);

  // ── pasta do Claude: ligada por padrão no app de PC (só fica desligada se a pessoa desligar) ──
  const mirrorRef = useRef<FolderMirror | null>(null);
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const mirrorKey = `gfs-mirror-${room.id}`;

  const startMirror = useCallback(async () => {
    if (mirrorRef.current) return;
    const m = new FolderMirror(sync, room, authorOf(user), !readOnly, setMirror);
    mirrorRef.current = m;
    try {
      await m.start();
      try {
        localStorage.setItem(mirrorKey, "1");
      } catch {
        /* sem storage: só não religa sozinho */
      }
    } catch (e) {
      mirrorRef.current = null;
      throw e;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, readOnly]);

  useEffect(() => {
    if (!isTauri() || readOnly) return;
    let turnedOff = false;
    try {
      turnedOff = localStorage.getItem(mirrorKey) === "0";
    } catch {
      /* ignora */
    }
    if (!turnedOff) void startMirror().catch(() => {});
    return () => {
      const m = mirrorRef.current;
      mirrorRef.current = null;
      void m?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  const openMirror = async (tool: OpenTool) => {
    const dir = mirrorRef.current?.dir;
    if (!dir) throw new Error("Ligue a pasta do Claude primeiro.");
    await invoke("open_with", { tool, dir });
  };

  const stopMirror = async () => {
    const m = mirrorRef.current;
    mirrorRef.current = null;
    await m?.stop();
    setMirror(null);
    try {
      localStorage.setItem(mirrorKey, "0");
    } catch {
      /* ignora */
    }
  };

  // Backup: primeira vez numa sala antiga o dono grava a versão atual de tudo; depois, 1 foto automática por dia.
  useEffect(() => {
    if (readOnly) return;
    let alive = true;
    let unsub: (() => void) | undefined;
    void sync.whenLoaded().then(async () => {
      if (!alive) return;
      const me = authorOf(user);
      await ensureBaseline(room, sync.remoteFiles(), me).catch((e) => console.warn("backup inicial:", e));
      unsub = watchCheckpoints(room.id, (cps) => {
        unsub?.();
        if (alive) void maybeAutoCheckpoint(room.id, sync.remoteFiles(), cps[0], me).catch((e) => console.warn("backup automático:", e));
      });
    });
    return () => {
      alive = false;
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  const others = useMemo(() => state.people.filter((p) => p.uid !== user.uid), [state.people, user.uid]);

  return (
    <div className="room">
      <header className="topbar">
        <button className="ghost icon" title="Voltar às salas" onClick={() => go({ name: "rooms" })}>
          ←
        </button>
        <span className="room-name ellipsis">{room.name}</span>
        {readOnly && <span className="writes">só leitura</span>}
        <span className="grow" />
        <div className="people" title="Quem está na sala agora">
          {state.people.map((p) => (
            <span
              key={p.uid}
              className="avatar"
              style={{ background: p.color }}
              title={`${p.name}${p.uid === user.uid ? " (você)" : ""}${p.file ? ` — em ${p.file}` : ""}`}
            >
              {p.name.slice(0, 1).toUpperCase()}
              {p.claudeOn && (
                <span className="claude-badge" title={`Claude de ${p.name} ligado${p.claudeFile ? ` — mexeu em ${p.claudeFile}` : ""}`}>
                  🤖
                </span>
              )}
            </span>
          ))}
        </div>
        {others.length === 0 && <span className="muted small">só você aqui</span>}
        <span
          className={`writes ${writes > DAILY_WRITE_LIMIT * 0.6 ? "warn" : ""}`}
          title="Gravações no Firestore feitas por este app hoje. O plano grátis permite 20 mil por dia no projeto inteiro."
        >
          ✎ {writes.toLocaleString("pt-BR")} / {DAILY_WRITE_LIMIT.toLocaleString("pt-BR")}
        </span>
        <button className="ghost" onClick={() => setShowPreview((v) => !v)} title="Mostrar/esconder o preview">
          {showPreview ? "◧ Preview" : "◻ Preview"}
        </button>
        <button onClick={() => setModal("history")} title="Tudo o que cada pessoa e cada Claude mudou, e os backups do jogo">
          🕘 Histórico
        </button>
        {!readOnly && (
          <button onClick={() => setModal("claude")} title="Ligar o seu Claude nesta sala">
            🤖 Claude{" "}
            {mirror?.state === "on" && <span className="dot" style={{ background: "var(--ok)", display: "inline-block" }} />}
          </button>
        )}
        {role === "owner" && (
          <>
            <button className="ghost" onClick={() => setModal("settings")} title="Configurações da sala">
              Ajustes
            </button>
            <button className="primary" onClick={() => setModal("invite")}>
              Convidar
            </button>
          </>
        )}
      </header>

      <div className={`workspace ${showPreview ? "" : "no-preview"}`}>
        <aside className="sidebar">
          <FileList sync={sync} state={state} readOnly={readOnly} meUid={user.uid} />
          <ActivityFeed roomId={room.id} />
        </aside>
        <EditorPane sync={sync} state={state} />
        {showPreview && <PreviewPane sync={sync} room={room} />}
      </div>

      {modal === "invite" && <InviteModal user={user} room={room} onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal room={room} onClose={() => setModal(null)} />}
      {modal === "history" && (
        <HistoryPanel room={room} sync={sync} me={authorOf(user)} readOnly={readOnly} people={state.people} onClose={() => setModal(null)} />
      )}
      {modal === "claude" && (
        <ClaudePanel
          room={room}
          status={mirror}
          onStart={async () => {
            await startMirror();
            await openMirror("vscode");
          }}
          onOpen={openMirror}
          onStop={stopMirror}
          onClose={() => setModal(null)}
        />
      )}
      <Toasts toasts={toasts} onClose={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />
      {state.error && <Toasts toasts={[{ id: -1, kind: "error", text: state.error }]} onClose={() => {}} />}
    </div>
  );
}
