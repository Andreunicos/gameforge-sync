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
import { BuildPanel } from "./BuildPanel";
import { BugsPanel } from "./BugsPanel";
import { RojoPanel } from "./RojoPanel";
import { UnrealPanel } from "./UnrealPanel";
import { UnrealConnectPanel } from "./UnrealConnectPanel";
import { useRojo } from "../rojo";
import { assetsMd, hhmm, useClaims, writeAssetsMd } from "../claims";
import { loadSettings, selectionMd, ueStatus, useUnrealLive } from "../unreal";
import { roomSlug } from "../sync/folderMirror";
import { BUGS_FILE, cleanBugImgs } from "../bugimgs";
import { buildState, onBuild } from "../builds";
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
  const [modal, setModal] = useState<"invite" | "settings" | "claude" | "history" | "build" | "bugs" | "rojo" | "unreal" | "ue" | null>(null);
  const build = useSyncExternalStore(onBuild, () => buildState(room.id));
  const building = build.phase === "enviando" || build.phase === "compilando" || build.phase === "baixando";
  const isRoblox = room.kind === "roblox";
  const isUnreal = room.kind === "unreal";
  const isHtml5 = !isRoblox && !isUnreal; // kind ausente = html5 (salas antigas)
  const [showPreview, setShowPreview] = useState(isHtml5);
  const claims = useClaims(room.id, isUnreal);
  const rojo = useRojo(sync, isRoblox && isTauri());
  // Sala de Roblox em PC sem Rojo: abre o painel com o botão de instalar (uma vez).
  const askedRojo = useRef(false);
  useEffect(() => {
    if (rojo.info?.version === null && !readOnly && !askedRojo.current) {
      askedRojo.current = true;
      setModal("rojo");
    }
  }, [rojo.info, readOnly]);
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
      if (isRoblox) rojo.start(m.dir);
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
      if (isRoblox && m?.dir) void invoke("rojo_stop", { dir: m.dir }).catch(() => {});
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
    await rojo.stop();
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

  // Imagens da lista de bugs: quando o Claude apaga o item do IDEIAS_E_BUGS.md, a imagem dele é apagada.
  useEffect(() => {
    if (readOnly) return;
    let t: number | undefined;
    const off = sync.onRemoteFile((path, f) => {
      if (path !== BUGS_FILE || f?.parts) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => void cleanBugImgs(room.id, f?.content ?? "").catch((e) => console.warn("limpar imagens:", e)), 4000);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  // Sala Unreal: reservas de assets em .gfs/ASSETS.md (só reescreve quando a lista muda) e avisos para quem reservou.
  const mirrorDir = mirror?.state === "on" ? mirror.dir : undefined;
  // Presença do editor Unreal (seleção/modificados, de .gfs/ue-presence.json) e reserva automática do que foi modificado.
  const ueSnap = useUnrealLive(room.id, sync, authorOf(user), isUnreal ? mirrorDir : undefined, claims.list, state.people);
  const md = useMemo(
    () => (isUnreal ? assetsMd(claims.list, user.uid, claims.now, selectionMd(state.people, user.uid)) : ""),
    [isUnreal, claims.list, claims.now, user.uid, state.people],
  );
  // App recarregado com o servidor do Multi-User ainda ligado neste PC: volta a avisar a sala quem hospeda.
  useEffect(() => {
    if (!isUnreal || !mirrorDir) return;
    const s = loadSettings(room.id, roomSlug(room.name));
    ueStatus(mirrorDir, s.mcpPort).then(
      (st) => st.server && sync.setUnreal({ mue: { server: s.server, session: s.session, addr: s.unicast.trim() } }),
      () => {}, // app antigo, sem o comando
    );
  }, [isUnreal, mirrorDir, sync, room.id, room.name]);
  useEffect(() => {
    if (md && mirrorDir) void writeAssetsMd(mirrorDir, md).catch((e) => console.warn("ASSETS.md:", e));
  }, [md, mirrorDir]);
  const warned = useRef(new Set<string>());
  const mineBefore = useRef(new Map<string, number>()); // minhas reservas na última lista: chave → vencimento
  useEffect(() => {
    if (!isUnreal) return;
    const toast = (kind: Toast["kind"], text: string, id: string) => {
      if (warned.current.has(id)) return;
      warned.current.add(id);
      sync.onToast({ kind, text });
    };
    const { list, now } = claims;
    for (const c of list) {
      if (c.uid === user.uid) {
        const left = c.exp - now;
        if (left > 0 && left < 10 * 60_000) toast("warn", `Sua reserva de ${c.path} vence às ${hhmm(c.exp)}. Ainda mexendo? Renove no 🔒 Unreal.`, `${c.key}@${c.exp}:soon`);
        if (left <= 0 && left > -10 * 60_000) toast("warn", `Sua reserva de ${c.path} venceu: outra pessoa já pode reservar. Salve e libere, ou reserve de novo.`, `${c.key}@${c.exp}:gone`);
      } else if ((mineBefore.current.get(c.key) ?? Infinity) <= now && c.exp > now) {
        toast("error", `${c.path} agora está reservado por ${c.name} (a sua reserva tinha vencido). NÃO salve por cima: fale com ${c.name}.`, `${c.key}@${c.exp}:lost`);
      }
    }
    mineBefore.current = new Map(list.filter((c) => c.uid === user.uid).map((c) => [c.key, c.exp]));
  }, [isUnreal, claims.list, claims.now, sync, user.uid]);

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
        {isHtml5 && (
          <button className="ghost" onClick={() => setShowPreview((v) => !v)} title="Mostrar/esconder o preview">
            {showPreview ? "◧ Preview" : "◻ Preview"}
          </button>
        )}
        {isRoblox && !readOnly && isTauri() && (
          <button onClick={() => setModal("rojo")} title="Servidor do Rojo desta sala (conecta o Roblox Studio)">
            🧩 Rojo{" "}
            <span className="dot" style={{ background: rojo.servers.some((x) => x.state === "error") ? "#e5484d" : rojo.servers.some((x) => x.state === "on") ? "var(--ok)" : "#888", display: "inline-block" }} />
          </button>
        )}
        {isRoblox && !readOnly && rojo.info?.version === null && (
          <button className="primary" onClick={() => setModal("rojo")} title="O Rojo não está instalado neste PC">
            ⬇️ Instalar Rojo
          </button>
        )}
        {isUnreal && !readOnly && isTauri() && (
          <button onClick={() => setModal("ue")} title="Abrir o Unreal com o MCP (e o Multi-User) e o Claude Code nesta pasta">
            🔌 Conectar Unreal{ueSnap && <span className="dot" style={{ background: "var(--ok)", display: "inline-block", marginLeft: 6 }} />}
          </button>
        )}
        {isUnreal && (
          <button onClick={() => setModal("unreal")} title="Reservas de assets (.uasset/.umap) e como a sala Unreal funciona">
            🔒 Unreal{claims.list.some((c) => c.exp > claims.now) ? ` (${claims.list.filter((c) => c.exp > claims.now).length})` : ""}
          </button>
        )}
        {isHtml5 && !readOnly && (
          <button className={building ? "building" : ""} onClick={() => setModal("build")} title="Gerar o jogo para Web, Android, Windows e Linux">
            {building ? "⚙️ Build…" : build.phase === "pronto" ? "🔨 Build ✅" : "🔨 Build"}
          </button>
        )}
        {!readOnly && (
          <button onClick={() => setModal("bugs")} title="Anotar bugs e ideias do teste: o Claude lê e resolve">
            🐞 Bugs
          </button>
        )}
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
      {modal === "build" && (
        <BuildPanel
          room={room}
          sync={sync}
          me={authorOf(user)}
          isAdmin={user.email === "andreluizvillanova123@gmail.com"}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "rojo" && (
        <RojoPanel
          servers={rojo.servers}
          info={rojo.info}
          install={rojo.install}
          onInstall={() => void rojo.installRojo()}
          onRestart={() => {
            const dir = mirrorRef.current?.dir;
            if (dir) rojo.start(dir);
            else void startMirror().catch(() => {});
          }}
          onStop={rojo.stop}
          onAddPlace={rojo.addPlace}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "unreal" && (
        <UnrealPanel
          roomId={room.id}
          me={authorOf(user)}
          claims={claims.list}
          now={claims.now}
          readOnly={readOnly}
          isOwner={role === "owner"}
          dir={mirrorDir}
          people={state.people}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "ue" && (
        <UnrealConnectPanel
          room={room}
          sync={sync}
          me={authorOf(user)}
          dir={mirrorDir}
          people={state.people}
          snap={ueSnap}
          onStartMirror={startMirror}
          onOpen={openMirror}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "bugs" && <BugsPanel roomId={room.id} sync={sync} me={authorOf(user)} onClose={() => setModal(null)} />}
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
