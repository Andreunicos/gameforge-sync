import { collection, deleteDoc, doc, onSnapshot, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { logActivity } from "../rooms";
import { countWrite } from "../usage";
import { MAX_FILE_BYTES } from "../config";
import type { Author, Presence, RemoteFile } from "../types";
import { FileSession, fileDocId, type SaveStatus } from "./session";
import { PresenceChannel } from "./presence";

const EDIT_ACTIVITY_EVERY_MS = 3 * 60_000;

export interface RoomSyncState {
  files: RemoteFile[];
  loaded: boolean;
  active: string | null;
  statuses: Record<string, SaveStatus>;
  people: Presence[];
  error: string | null;
}

export interface Toast {
  kind: "info" | "warn" | "error";
  text: string;
}

/**
 * Tudo que acontece dentro de uma sala: escuta os arquivos no Firestore,
 * mantém um editor por arquivo aberto, presença/cursores e o feed de atividade.
 */
export class RoomSync {
  private remote = new Map<string, RemoteFile>();
  private sessions = new Map<string, FileSession>();
  private lastEditActivity = new Map<string, number>();
  private unsubFiles: () => void;
  private presence: PresenceChannel;
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(path: string) => void>();
  private remoteListeners = new Set<(path: string, file: RemoteFile | null) => void>();
  private loadedWaiters: (() => void)[] = [];
  state: RoomSyncState = { files: [], loaded: false, active: null, statuses: {}, people: [], error: null };
  onToast: (t: Toast) => void = () => {};

  constructor(
    readonly roomId: string,
    readonly author: Author,
    color: string,
    private readOnly: boolean,
  ) {
    this.unsubFiles = onSnapshot(
      collection(db, "rooms", roomId, "files"),
      (snap) => {
        for (const ch of snap.docChanges()) {
          const f = { id: ch.doc.id, ...ch.doc.data() } as RemoteFile;
          if (ch.type === "removed") {
            this.remote.delete(f.path);
            this.sessions.get(f.path)?.onRemote(null);
            this.remoteListeners.forEach((l) => l(f.path, null));
          } else {
            this.remote.set(f.path, f);
            this.sessions.get(f.path)?.onRemote(f);
            this.remoteListeners.forEach((l) => l(f.path, f));
          }
          this.changeListeners.forEach((l) => l(f.path));
        }
        const files = [...this.remote.values()].sort((a, b) => a.path.localeCompare(b.path));
        let active = this.state.active;
        if (!this.state.loaded && !active) {
          active = files.find((f) => f.path === "index.html")?.path ?? files[0]?.path ?? null;
        }
        this.set({ files, loaded: true, active });
        this.loadedWaiters.splice(0).forEach((w) => w());
      },
      (e) => this.set({ error: e.message }),
    );

    this.presence = new PresenceChannel(
      roomId,
      { uid: author.uid, name: author.name, color },
      (people) => {
        this.set({ people });
        this.refreshCursors();
      },
    );
  }

  // ── assinatura para o React ─────────────────────────────────────────────

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /** Avisa quando o conteúdo de qualquer arquivo muda (local ou remoto) — usado pelo preview. */
  onContentChange(l: (path: string) => void) {
    this.changeListeners.add(l);
    return () => {
      this.changeListeners.delete(l);
    };
  }

  /** Cada versão nova de arquivo que chega do Firebase (null = apagado) — usado pela pasta do Claude. */
  onRemoteFile(l: (path: string, file: RemoteFile | null) => void) {
    this.remoteListeners.add(l);
    return () => {
      this.remoteListeners.delete(l);
    };
  }

  /** Resolve quando a primeira lista de arquivos da sala chegou. */
  whenLoaded(): Promise<void> {
    if (this.state.loaded) return Promise.resolve();
    return new Promise((r) => this.loadedWaiters.push(r));
  }

  remoteFiles(): RemoteFile[] {
    return [...this.remote.values()];
  }

  private set(patch: Partial<RoomSyncState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ── arquivos ────────────────────────────────────────────────────────────

  /** Texto atual de um arquivo: o do editor se estiver aberto, senão o do Firebase. */
  contentOf(path: string): string | undefined {
    return this.sessions.get(path)?.text ?? this.remote.get(path)?.content;
  }

  paths(): string[] {
    return [...this.remote.keys()];
  }

  session(path: string): FileSession {
    let s = this.sessions.get(path);
    if (!s) {
      s = new FileSession(path, this.remote.get(path) ?? null, this.readOnly, {
        roomId: this.roomId,
        author: this.author,
        onStatus: (p, status, detail) => {
          this.set({ statuses: { ...this.state.statuses, [p]: status } });
          if (status === "error" && detail) this.onToast({ kind: "error", text: `Erro ao gravar ${p}: ${detail}` });
          if (status === "too-big" && detail) this.onToast({ kind: "error", text: detail });
        },
        onLocalEdit: (p) => this.changeListeners.forEach((l) => l(p)),
        onCursor: (p, line, col) => {
          if (p === this.state.active) this.presence.move(p, line, col);
        },
        onSaved: (p, created) => void this.noteSaved(p, created),
        onConflict: (p, n, who) =>
          this.onToast({
            kind: "warn",
            text: `Conflito em ${p}: você e ${who} mudaram as mesmas linhas (${n}x). Escolha a versão entre os marcadores <<<<<<< e >>>>>>> e apague os marcadores.`,
          }),
      });
      this.sessions.set(path, s);
      this.refreshCursors();
    }
    return s;
  }

  open(path: string) {
    const prev = this.state.active ? this.sessions.get(this.state.active) : undefined;
    if (prev && prev.path !== path) void prev.flush();
    this.set({ active: path });
    const s = this.session(path);
    const head = s.view.state.selection.main.head;
    const line = s.view.state.doc.lineAt(head);
    this.presence.move(path, line.number, head - line.from);
    this.refreshCursors();
  }

  async createFile(path: string, content = "") {
    path = normalizePath(path);
    if (!path) throw new Error("Nome de arquivo inválido.");
    if (this.remote.has(path)) throw new Error(`${path} já existe.`);
    await this.writeWhole(path, content);
    await logActivity(this.roomId, this.author, { kind: "create", file: path, summary: `criou ${path}` });
    this.open(path);
  }

  async deleteFile(path: string) {
    const s = this.sessions.get(path);
    if (s) {
      s.destroy();
      this.sessions.delete(path);
    }
    await deleteDoc(doc(db, "rooms", this.roomId, "files", fileDocId(path)));
    countWrite();
    await logActivity(this.roomId, this.author, { kind: "delete", file: path, summary: `apagou ${path}` });
    if (this.state.active === path) this.set({ active: null });
  }

  /** Importa vários arquivos de uma vez (pasta do jogo). Sobrescreve os que já existem. */
  async importFiles(files: { path: string; content: string }[], onProgress: (done: number) => void) {
    let done = 0;
    const skipped: string[] = [];
    for (const f of files) {
      const path = normalizePath(f.path);
      if (new Blob([f.content]).size > MAX_FILE_BYTES) {
        skipped.push(path);
        continue;
      }
      const open = this.sessions.get(path);
      if (open) {
        // Arquivo aberto: entra como edição local (passa pelo merge normal).
        open.view.dispatch({ changes: { from: 0, to: open.view.state.doc.length, insert: f.content } });
      } else {
        await this.writeWhole(path, f.content);
      }
      onProgress(++done);
    }
    await logActivity(this.roomId, this.author, {
      kind: "import",
      summary: `importou ${done} arquivo${done === 1 ? "" : "s"}`,
    });
    return skipped;
  }

  /** Grava um arquivo inteiro sem passar pelo editor (criar/importar). */
  private async writeWhole(path: string, content: string) {
    const ref = doc(db, "rooms", this.roomId, "files", fileDocId(path));
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const version = snap.exists() ? (snap.data().version as number) + 1 : 1;
      tx.set(ref, { path, content, version, author: this.author, updatedAt: serverTimestamp() });
    });
    countWrite();
  }

  private async noteSaved(path: string, created: boolean) {
    const now = Date.now();
    if (created) {
      await logActivity(this.roomId, this.author, { kind: "create", file: path, summary: `criou ${path}` });
      return;
    }
    if (now - (this.lastEditActivity.get(path) ?? 0) < EDIT_ACTIVITY_EVERY_MS) return;
    this.lastEditActivity.set(path, now);
    await logActivity(this.roomId, this.author, { kind: "edit", file: path, summary: `está mexendo em ${path}` });
  }

  // ── cursores ────────────────────────────────────────────────────────────

  private refreshCursors() {
    for (const s of this.sessions.values()) {
      s.setRemoteCursors(
        this.state.people
          .filter((p) => p.uid !== this.author.uid && p.file === s.path)
          .map((p) => ({ uid: p.uid, name: p.name, color: p.color, line: p.line, col: p.col })),
      );
    }
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((s) => s.flush().catch(() => {})));
    this.unsubFiles();
    this.presence.leave();
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
    this.listeners.clear();
    this.changeListeners.clear();
    this.remoteListeners.clear();
  }
}

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".")
    .join("/")
    .trim();
}
