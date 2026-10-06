// Pasta do Claude: espelha a sala em ~/GameForge/<sala> enquanto o app está aberto.
// O Claude Code edita os arquivos normalmente; o que ele salva sobe para a sala em segundos
// (como "Claude de <nome>") e o que os outros mudam é escrito na pasta. Sem comandos.
//
// Usa o mesmo formato do gfs (.gfs/state.json + .gfs/base/), então o gfs funciona na mesma pasta
// quando o app estiver fechado.
import { exists, mkdir, readDir, readTextFile, remove, watch, writeTextFile, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { homeDir, join } from "@tauri-apps/api/path";
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { logActivity } from "../rooms";
import { countWrite } from "../usage";
import { MAX_FILE_BYTES } from "../config";
import type { Author, RemoteFile, Room } from "../types";
import type { RoomSync } from "./roomSync";
import { fileDocId } from "./session";
import { hasConflictMarkers, merge3 } from "./merge";
import { ROOM_CLAUDE_MD, ROOM_GAME_MD } from "./templates";

const TEXT_EXT = /\.(html?|js|mjs|cjs|ts|css|json|txt|md|csv|xml|svg|glsl|frag|vert)$/i;
const IGNORE = /(^|\/)(\.gfs|\.git|\.claude|\.vscode|node_modules|dist|android|ios)(\/|$)/;
const LOCAL_DEBOUNCE_MS = 700;
const ACTIVITY_EVERY_MS = 3 * 60_000;

export interface MirrorStatus {
  state: "starting" | "on" | "error";
  dir?: string;
  files?: number;
  last?: string;
  error?: string;
}

interface Base {
  content: string;
  version: number;
}

class Stale extends Error {}

export function roomSlug(name: string) {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "sala"
  );
}

const who = (a: Author) => (a.kind === "claude" ? `Claude de ${a.name}` : a.name);
const norm = (s: string) => s.replace(/\r\n/g, "\n");

export class FolderMirror {
  dir = "";
  private base = new Map<string, Base>();
  private inflight = new Map<string, Base>();
  private timers = new Map<string, number>();
  private queue = new Map<string, Promise<void>>();
  private lastActivity = new Map<string, number>();
  private unwatch?: UnwatchFn;
  private offRemote?: () => void;
  private saveTimer: number | undefined;
  private stopped = false;
  private readonly author: Author;

  constructor(
    private sync: RoomSync,
    private room: Room,
    human: Author,
    private canEdit: boolean,
    private onStatus: (s: MirrorStatus) => void,
  ) {
    this.author = { ...human, kind: "claude" };
  }

  // ── ciclo de vida ──────────────────────────────────────────────────────

  async start(): Promise<string> {
    this.onStatus({ state: "starting" });
    try {
      this.dir = await this.pickDir();
      await mkdir(await join(this.dir, ".gfs", "base"), { recursive: true });
      await this.loadState();
      await this.sync.whenLoaded();
      if (this.stopped) return this.dir;
      await this.reconcile();
      this.offRemote = this.sync.onRemoteFile((path, f) => this.enqueue(path, () => this.onRemote(path, f)));
      const unwatch = await watch(this.dir, (ev) => this.onDiskEvent(ev.paths), { recursive: true, delayMs: 300 });
      if (this.stopped) {
        unwatch();
        this.offRemote();
        return this.dir;
      }
      this.unwatch = unwatch;
      this.status("pasta pronta");
      return this.dir;
    } catch (e) {
      this.onStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  async stop() {
    this.stopped = true;
    this.offRemote?.();
    this.unwatch?.();
    this.timers.forEach((t) => window.clearTimeout(t));
    await Promise.all(this.queue.values()).catch(() => {});
    await this.saveState();
  }

  /** ~/GameForge/<nome-da-sala>; se já existir de outra sala, acrescenta o id. */
  private async pickDir(): Promise<string> {
    const root = await join(await homeDir(), "GameForge");
    const plain = await join(root, roomSlug(this.room.name));
    const stateFile = await join(plain, ".gfs", "state.json");
    if (!(await exists(plain))) return plain;
    if (!(await exists(stateFile))) {
      const entries = await readDir(plain);
      if (entries.length === 0) return plain;
    } else {
      const st = JSON.parse(await readTextFile(stateFile)) as { roomId?: string };
      if (st.roomId === this.room.id) return plain;
    }
    return join(root, `${roomSlug(this.room.name)}-${this.room.id.slice(0, 6).toLowerCase()}`);
  }

  // ── estado em disco (formato do gfs) ───────────────────────────────────

  private async abs(path: string) {
    return join(this.dir, ...path.split("/"));
  }

  private async baseFile(path: string) {
    return join(this.dir, ".gfs", "base", ...path.split("/"));
  }

  private async loadState() {
    const f = await join(this.dir, ".gfs", "state.json");
    if (!(await exists(f))) return;
    const st = JSON.parse(await readTextFile(f)) as { roomId: string; files: Record<string, { version: number }> };
    if (st.roomId !== this.room.id) return;
    for (const [path, { version }] of Object.entries(st.files ?? {})) {
      const bf = await this.baseFile(path);
      const content = (await exists(bf)) ? await readTextFile(bf) : "";
      this.base.set(path, { content, version });
    }
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveState(), 1000);
  }

  private async saveState() {
    if (!this.dir) return;
    const files = Object.fromEntries([...this.base].map(([p, b]) => [p, { version: b.version, updateTime: "" }]));
    const st = { roomId: this.room.id, roomName: this.room.name, lastSync: new Date().toISOString(), files };
    await writeTextFile(await join(this.dir, ".gfs", "state.json"), JSON.stringify(st, null, 2));
  }

  private async setBase(path: string, b: Base) {
    this.base.set(path, b);
    const bf = await this.baseFile(path);
    await mkdir(bf.slice(0, Math.max(bf.lastIndexOf("\\"), bf.lastIndexOf("/"))), { recursive: true });
    await writeTextFile(bf, b.content);
    this.scheduleSave();
  }

  private async readDisk(path: string): Promise<string | null> {
    const f = await this.abs(path);
    try {
      return norm(await readTextFile(f));
    } catch {
      return null;
    }
  }

  private async writeDisk(path: string, content: string) {
    const f = await this.abs(path);
    await mkdir(f.slice(0, Math.max(f.lastIndexOf("\\"), f.lastIndexOf("/"))), { recursive: true });
    await writeTextFile(f, content);
  }

  private async scanDisk(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      for (const e of await readDir(rel ? await this.abs(rel) : this.dir)) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (IGNORE.test(p) || e.name.startsWith(".")) continue;
        if (e.isDirectory) await walk(p);
        else if (e.isFile && TEXT_EXT.test(e.name)) out.push(p);
      }
    };
    await walk("");
    return out;
  }

  // ── sincronização ──────────────────────────────────────────────────────

  /** Uma operação por arquivo de cada vez (disco e Firebase não se atropelam). */
  private enqueue(path: string, fn: () => Promise<void>) {
    const prev = this.queue.get(path) ?? Promise.resolve();
    const next = prev.then(fn).catch((e) => {
      console.error("pasta do Claude:", path, e);
      this.sync.onToast({ kind: "error", text: `Pasta do Claude (${path}): ${e instanceof Error ? e.message : e}` });
    });
    this.queue.set(path, next);
    return next;
  }

  /** Ao ligar: alinha pasta e sala (inclusive o que mudou com o app fechado). */
  private async reconcile() {
    const remote = new Map(this.sync.remoteFiles().map((f) => [f.path, f]));
    for (const f of remote.values()) {
      await this.enqueue(f.path, async () => {
        const b = this.base.get(f.path);
        const disk = await this.readDisk(f.path);
        if (!b) {
          if (disk === null || disk === f.content) {
            await this.setBase(f.path, { content: f.content, version: f.version });
            if (disk === null) await this.writeDisk(f.path, f.content);
          } else {
            // Arquivo já existia na pasta sem histórico: junta sem perder nenhum lado.
            const m = merge3("", disk, f.content, who(f.author));
            await this.setBase(f.path, { content: f.content, version: f.version });
            await this.writeDisk(f.path, m.text);
          }
        } else if (f.version > b.version) {
          await this.onRemote(f.path, f);
        } else if (disk === null) {
          await this.writeDisk(f.path, b.content); // o Claude não apaga arquivo da sala: restaura
        } else if (disk !== b.content) {
          await this.push(f.path);
        }
      });
    }
    // Arquivos novos criados na pasta com o app fechado.
    for (const p of await this.scanDisk()) if (!remote.has(p)) await this.enqueue(p, () => this.push(p));

    // Toda sala ganha as regras do Claude e a visão do jogo.
    if (this.canEdit) {
      for (const [p, text] of [
        ["CLAUDE.md", ROOM_CLAUDE_MD],
        ["GAME.md", ROOM_GAME_MD],
      ] as const) {
        if (remote.has(p) || (await this.readDisk(p)) !== null) continue;
        await this.writeDisk(p, text);
        await this.enqueue(p, () => this.push(p));
      }
    }
  }

  private onDiskEvent(paths: string[]) {
    for (const full of paths) {
      const rel = full.slice(this.dir.length + 1).split("\\").join("/");
      if (!rel || IGNORE.test(rel) || !TEXT_EXT.test(rel)) continue;
      window.clearTimeout(this.timers.get(rel));
      this.timers.set(
        rel,
        window.setTimeout(() => void this.enqueue(rel, () => this.push(rel)), LOCAL_DEBOUNCE_MS),
      );
    }
  }

  /** Chegou versão nova da sala (de outra pessoa, do editor do app ou de outro Claude). */
  private async onRemote(path: string, f: RemoteFile | null) {
    const b = this.base.get(path);
    if (!f) {
      if (!b) return;
      const disk = await this.readDisk(path);
      this.base.delete(path);
      this.scheduleSave();
      if (disk === null || disk === b.content) await remove(await this.abs(path)).catch(() => {});
      return;
    }
    if (b && f.version <= b.version) return;
    const inf = this.inflight.get(path);
    if (inf && inf.version === f.version && inf.content === f.content) return; // eco do meu push

    const disk = await this.readDisk(path);
    const next = { content: f.content, version: f.version };
    if (disk === null || disk === b?.content || disk === f.content) {
      await this.setBase(path, next); // base antes de escrever: o vigia vê disco == base e ignora
      if (disk !== f.content) await this.writeDisk(path, f.content);
      this.status(`↓ ${path} (${who(f.author)})`);
      return;
    }
    const m = merge3(b?.content ?? "", disk, f.content, who(f.author));
    await this.setBase(path, next);
    await this.writeDisk(path, m.text);
    if (m.conflicts) {
      this.sync.onToast({
        kind: "warn",
        text: `Conflito em ${path} na pasta do Claude: ele e ${who(f.author)} mudaram as mesmas linhas. Peça ao Claude para resolver os marcadores <<<<<<< >>>>>>>.`,
      });
    } else {
      await this.push(path);
    }
  }

  /** O arquivo mudou na pasta: grava na sala se partiu da versão atual (senão o listener faz o merge). */
  private async push(path: string) {
    if (!this.canEdit || this.stopped) return;
    const disk = await this.readDisk(path);
    if (disk === null) return; // apagado na pasta: o Claude não apaga arquivo da sala
    const b = this.base.get(path);
    if (b && disk === b.content) return;
    if (hasConflictMarkers(disk)) return;
    if (new Blob([disk]).size > MAX_FILE_BYTES) {
      this.sync.onToast({ kind: "warn", text: `${path} passou de 900 KB e não cabe na sala. Peça ao Claude para dividir o arquivo.` });
      return;
    }

    const baseVersion = b?.version ?? 0;
    const version = baseVersion + 1;
    const ref = doc(db, "rooms", this.room.id, "files", fileDocId(path));
    this.inflight.set(path, { content: disk, version });
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists() ? (snap.data().version as number) : 0;
        if (current !== baseVersion) throw new Stale();
        tx.set(ref, { path, content: disk, version, author: this.author, updatedAt: serverTimestamp() });
      });
      countWrite();
      await this.setBase(path, { content: disk, version });
      this.status(`↑ ${path} v${version}`);
      await this.noteActivity(path, baseVersion === 0);
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      // Alguém gravou antes: o listener traz a versão nova e o onRemote faz o merge.
    } finally {
      this.inflight.delete(path);
    }
  }

  private async noteActivity(path: string, created: boolean) {
    const now = Date.now();
    if (!created && now - (this.lastActivity.get(path) ?? 0) < ACTIVITY_EVERY_MS) return;
    this.lastActivity.set(path, now);
    await logActivity(this.room.id, this.author, {
      kind: created ? "create" : "edit",
      file: path,
      summary: created ? `criou ${path}` : `está mexendo em ${path}`,
    }).catch(() => {});
  }

  private status(last: string) {
    this.onStatus({ state: "on", dir: this.dir, files: this.base.size, last });
  }
}
