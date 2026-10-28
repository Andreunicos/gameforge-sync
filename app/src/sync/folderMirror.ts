// Pasta do Claude: espelha a sala em ~/<sala> (pasta do usuário) enquanto o app está aberto.
// O Claude Code edita os arquivos normalmente; o que ele salva sobe para a sala em segundos
// (como "Claude de <nome>") e o que os outros mudam é escrito na pasta. Sem comandos.
//
// Usa o mesmo formato do gfs (.gfs/state.json + .gfs/base/), então o gfs funciona na mesma pasta
// quando o app estiver fechado.
import { exists, mkdir, readDir, readTextFile, remove, watch, writeFile, writeTextFile, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { doc, runTransaction } from "firebase/firestore";
import { db } from "../firebase";
import { watchBugImgs } from "../bugimgs";
import { onAppClose } from "../closeGuard";
import { logActivity } from "../rooms";
import { countWrite } from "../usage";
import { MAX_BIG_BYTES, kb, utf8Bytes } from "../bigfile";
import { putFile } from "./fileStore";
import { buildMap } from "./mapa";
import type { Author, RemoteFile, Room } from "../types";
import type { RoomSync } from "./roomSync";
import { fileDocId } from "./session";
import { hasConflictMarkers, merge3 } from "./merge";
import { CONSOLE_RULE, MODELOS_RULE, OLD_UE_PRESENCE, UNREAL_MCP_RULE, mergeClaudeSettings, roomTemplates, textHash, ueProjectRule, ueScripts } from "./templates";
import { roomProject } from "../unreal";
import { IGNORE_PATH, UNREAL_IGNORE_PATH, isCodePath } from "./fileKinds";

const IGNORE = IGNORE_PATH; // inclui builds/ = saída do botão BUILD
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
  /** Arquivos em que a sala voltou para uma versão MENOR que a base (apagado e criado de novo): aceita a partir desta. */
  private lower = new Map<string, number>();
  private timers = new Map<string, number>();
  private queue = new Map<string, Promise<void>>();
  private lastActivity = new Map<string, number>();
  private unwatch?: UnwatchFn;
  private offRemote?: () => void;
  private offImgs?: () => void;
  private offClose?: () => void;
  private imgsBusy: Promise<void> = Promise.resolve();
  private ueBusy: Promise<void> = Promise.resolve();
  private saveTimer: number | undefined;
  private stopped = false;
  private backups = 0;
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

  private ignored(rel: string) {
    // Ponto no começo (.mcp.json, .vs/…) fica fora também no vigia, como já ficava na varredura (scanDisk).
    return IGNORE.test(rel) || /(^|\/)\./.test(rel) || (this.room.kind === "unreal" && UNREAL_IGNORE_PATH.test(rel));
  }

  // ── ciclo de vida ──────────────────────────────────────────────────────

  async start(): Promise<string> {
    this.onStatus({ state: "starting" });
    try {
      this.dir = await this.pickDir();
      await mkdir(await join(this.dir, ".gfs", "base"), { recursive: true });
      await this.writeClaudeSettings().catch((e) => console.warn(".claude/settings.json:", e));
      await this.loadState();
      await this.sync.whenLoaded();
      if (this.stopped) return this.dir;
      await this.reconcile();
      this.writeMap();
      this.offRemote = this.sync.onRemoteFile((path, f) => {
        this.scheduleMap();
        // Projeto Unreal criado (ou movido) com a pasta ligada: os scripts de presença vão para dentro dele.
        if (f && /\.uproject$/i.test(path)) this.ueBusy = this.ueBusy.then(() => this.ensureUeScripts()).catch((e) => console.warn("scripts do Unreal:", e));
        return this.enqueue(path, () => this.onRemote(path, f));
      });
      this.offImgs = watchBugImgs(this.room.id, (imgs) => {
        this.imgsBusy = this.imgsBusy.then(() => this.syncImgs(imgs)).catch((e) => console.warn("imagens dos bugs na pasta:", e));
      });
      const unwatch = await watch(this.dir, (ev) => this.onDiskEvent(ev.paths), { recursive: true, delayMs: 300 });
      if (this.stopped) {
        unwatch();
        this.offRemote();
        this.offImgs?.();
        return this.dir;
      }
      this.unwatch = unwatch;
      this.offClose = onAppClose(() => this.flush());
      this.sync.setClaude(true);
      this.status("pasta pronta");
      return this.dir;
    } catch (e) {
      this.onStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.unwatch) this.sync.setClaude(false);
    this.offRemote?.();
    this.offImgs?.();
    this.offClose?.();
    this.unwatch?.();
    this.timers.forEach((t) => window.clearTimeout(t));
    window.clearTimeout(this.mapTimer);
    await Promise.all(this.queue.values()).catch(() => {});
    await this.saveState();
  }

  /** Janela fechando: termina o que está na fila e grava o .gfs/state.json agora (ele espera 1 s para juntar gravações). */
  async flush() {
    await Promise.all(this.queue.values()).catch(() => {});
    window.clearTimeout(this.saveTimer);
    await this.saveState();
  }

  /**
   * .claude/settings.json da pasta (só neste PC: começa com ponto, não sincroniza): o Claude não lê nem edita a base
   * do merge, os backups e os builds, e numa sala Unreal o servidor unreal-mcp do .mcp.json já vem aprovado.
   * Mescla com o que já existe (nunca apaga chave de ninguém); JSON estragado = não mexe.
   */
  private async writeClaudeSettings() {
    const f = await join(this.dir, ".claude", "settings.json");
    const cur = (await exists(f)) ? await readTextFile(f) : null;
    const next = mergeClaudeSettings(cur, this.room.kind);
    if (next === null) return;
    await mkdir(await join(this.dir, ".claude"), { recursive: true });
    await writeTextFile(f, next);
  }

  /**
   * Pasta da sala direto na pasta do usuário (ex.: C:UsersAndrégames). Quem escolhe é o
   * Rust: se o nome já existir com outra coisa dentro (ex.: "documents"), usa nome-<id>.
   */
  private pickDir(): Promise<string> {
    return invoke<string>("room_dir", { slug: roomSlug(this.room.name), roomId: this.room.id });
  }

  // ── mapa da sala (.gfs/MAPA.md): índice nome@linha para o Claude ler pouco ──

  private mapTimer: number | undefined;

  private scheduleMap() {
    window.clearTimeout(this.mapTimer);
    this.mapTimer = window.setTimeout(() => this.writeMap(), 5000);
  }

  private writeMap() {
    if (this.stopped) return;
    const files = this.sync.remoteFiles().map((f): [string, string] => [f.path, f.content]);
    void (async () => writeTextFile(await join(this.dir, ".gfs", "MAPA.md"), buildMap(files, this.room.name)))().catch((e) =>
      console.warn("mapa da sala:", e),
    );
  }

  // ── imagens da lista de bugs: .gfs/bugs/<id>.jpg (nunca sobem; somem quando o item é resolvido) ──

  private async syncImgs(imgs: { id: string; data: string }[]) {
    if (this.stopped) return;
    const d = await join(this.dir, ".gfs", "bugs");
    await mkdir(d, { recursive: true });
    const have = new Set((await readDir(d)).map((e) => e.name));
    const want = new Set(imgs.map((i) => `${i.id}.jpg`));
    for (const i of imgs) {
      if (!have.has(`${i.id}.jpg`)) await writeFile(await join(d, `${i.id}.jpg`), Uint8Array.from(atob(i.data), (c) => c.charCodeAt(0)));
    }
    for (const n of have) if (n.endsWith(".jpg") && !want.has(n)) await remove(await join(d, n));
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

  private async writeBackup(path: string, content: string) {
    const f = await join(this.dir, ".gfs", "backup", ...path.split("/"));
    await mkdir(f.slice(0, Math.max(f.lastIndexOf("\\"), f.lastIndexOf("/"))), { recursive: true });
    await writeTextFile(f, content);
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
        if (this.ignored(p) || e.name.startsWith(".")) continue;
        if (e.isDirectory) await walk(p);
        else if (e.isFile && isCodePath(p)) out.push(p);
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
            // Pasta já tinha uma versão diferente, sem histórico: a da sala vale e a antiga
            // vai para .gfs/backup (nada se perde, e o Claude não vê dois arquivos iguais).
            await this.writeBackup(f.path, disk);
            await this.setBase(f.path, { content: f.content, version: f.version });
            await this.writeDisk(f.path, f.content);
            this.backups++;
          }
        } else if (f.version > b.version) {
          await this.onRemote(f.path, f);
        } else if (f.version < b.version) {
          // A sala tem versão MENOR que a base: o arquivo foi apagado e criado de novo com o app fechado.
          if (disk === null) {
            await this.setBase(f.path, { content: f.content, version: f.version });
            await this.writeDisk(f.path, f.content);
          } else {
            await this.push(f.path, true); // confere no servidor e, se for isso mesmo, faz backup + merge
          }
        } else if (disk === null) {
          await this.writeDisk(f.path, b.content); // o Claude não apaga arquivo da sala: restaura
        } else if (disk !== b.content) {
          await this.push(f.path);
        }
      });
    }
    if (this.backups > 0) {
      this.sync.onToast({
        kind: "info",
        text: `${this.backups} arquivo(s) da pasta eram diferentes da sala: ficou a versão da sala e a sua antiga foi guardada em .gfs/backup.`,
      });
    }
    // Arquivos novos criados na pasta com o app fechado.
    for (const p of await this.scanDisk()) if (!remote.has(p)) await this.enqueue(p, () => this.push(p));

    // Toda sala ganha as regras do Claude e a visão do jogo.
    if (this.canEdit) {
      for (const [p, text] of roomTemplates(this.room.kind, this.room.name)) {
        if (remote.has(p) || (await this.readDisk(p)) !== null) continue;
        await this.writeDisk(p, text);
        await this.enqueue(p, () => this.push(p));
      }
      // Salas antigas: o CLAUDE.md delas ainda não manda ler o MODELOS.md.
      if (remote.get("CLAUDE.md") && !remote.get("CLAUDE.md")!.content.includes("MODELOS.md")) {
        await this.sync.appendToFile("CLAUDE.md", "\n" + MODELOS_RULE, "", "MODELOS.md").catch((e) => console.warn("regra MODELOS.md:", e));
      }
      // Salas Unreal antigas: o CLAUDE.md delas ainda não explica o MCP do editor.
      if (this.room.kind === "unreal" && remote.get("CLAUDE.md") && !remote.get("CLAUDE.md")!.content.includes("unreal-mcp")) {
        await this.sync.appendToFile("CLAUDE.md", "\n" + UNREAL_MCP_RULE, "", "unreal-mcp").catch((e) => console.warn("regra do MCP:", e));
      }
      // Salas HTML5 antigas: o CLAUDE.md delas ainda não manda ler os erros do preview.
      if ((this.room.kind ?? "html5") === "html5" && remote.get("CLAUDE.md") && !remote.get("CLAUDE.md")!.content.includes("CONSOLE.md")) {
        await this.sync.appendToFile("CLAUDE.md", "\n## Erros do jogo\n" + CONSOLE_RULE, "", "CONSOLE.md").catch((e) => console.warn("regra do CONSOLE.md:", e));
      }
    }
    await this.ensureUeScripts();
  }

  /**
   * Sala Unreal: os scripts de presença do editor vão para o Content/Python do PROJETO (pasta do .uproject: raiz da sala
   * ou subpasta), que é de onde o editor os roda. Cria só o que falta (nunca escreve por cima de arquivo de ninguém) e
   * troca o gameforge_presence.py antigo intacto pelo novo. Roda ao ligar e quando chega um .uproject (projeto criado
   * depois). Sem projeto, ou com vários sem escolha neste PC, não faz nada (o 🔌 Conectar Unreal pede qual e cria).
   */
  private async ensureUeScripts() {
    if (this.room.kind !== "unreal" || !this.canEdit || this.stopped) return;
    const remote = new Map(this.sync.remoteFiles().map((f) => [f.path, f]));
    const project = roomProject(this.room.id, [...remote.keys()]);
    if (typeof project !== "string") return;
    const scripts = ueScripts(project);
    for (const [p, text] of scripts) {
      if (remote.has(p) || (await this.readDisk(p)) !== null) continue;
      await this.writeDisk(p, text);
      await this.enqueue(p, () => this.push(p));
    }
    // Script de presença de versão antiga, intacto: vira o novo (que informa a sessão do Multi-User e acha a sala acima do projeto).
    const [pyPath, newPy] = scripts[1];
    const py = remote.get(pyPath);
    if (py && !py.parts && OLD_UE_PRESENCE.includes(textHash(norm(py.content)))) {
      await this.writeDisk(pyPath, newPy);
      await this.enqueue(pyPath, () => this.push(pyPath));
    }
    // Projeto numa subpasta: o CLAUDE.md da sala diz onde ele está (uma vez).
    const md = remote.get("CLAUDE.md");
    if (project && md && !md.content.includes("## Pasta do projeto")) {
      await this.sync.appendToFile("CLAUDE.md", "\n" + ueProjectRule(project), "", "## Pasta do projeto").catch((e) => console.warn("regra da pasta do projeto:", e));
    }
  }

  private onDiskEvent(paths: string[]) {
    for (const full of paths) {
      const rel = full.slice(this.dir.length + 1).split("\\").join("/");
      if (!rel || this.ignored(rel) || !isCodePath(rel)) continue;
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
      this.lower.delete(path);
      if (!b) return;
      const disk = await this.readDisk(path);
      this.base.delete(path);
      this.scheduleSave();
      if (disk === null || disk === b.content) await remove(await this.abs(path)).catch(() => {});
      return;
    }
    const low = this.lower.get(path);
    const recreated = !!b && low !== undefined && f.version >= low && f.version <= b.version;
    if (b && f.version <= b.version && !recreated) return;
    this.lower.delete(path);
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
    if (recreated) {
      await this.writeBackup(path, disk);
      this.sync.onToast({ kind: "info", text: `${path} foi apagado e criado de novo na sala: a pasta do Claude juntou com a versão nova (a cópia antiga está em .gfs/backup).` });
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

  /**
   * O arquivo mudou na pasta: grava na sala se partiu da versão atual (senão o listener faz o merge).
   * `verify`: confere a versão no servidor mesmo sem mudança local (versão da sala menor que a base).
   */
  private async push(path: string, verify = false) {
    if (!this.canEdit || this.stopped) return;
    const disk = await this.readDisk(path);
    const b = this.base.get(path);
    if (disk === null) {
      // Apagado na pasta: o Claude não apaga arquivo da sala, então volta na hora.
      if (b && this.sync.remoteFiles().some((f) => f.path === path)) {
        await this.writeDisk(path, b.content);
        this.sync.onToast({ kind: "info", text: `${path} foi apagado na pasta do Claude e voltou: só o dono apaga arquivos da sala (✕ na lista).` });
      }
      return;
    }
    if (b && disk === b.content && !verify) return;
    if (hasConflictMarkers(disk)) return;
    if (utf8Bytes(disk) > MAX_BIG_BYTES) {
      this.sync.onToast({
        kind: "warn",
        text: `${path} tem ${kb(utf8Bytes(disk))} e o limite da sala é ${kb(MAX_BIG_BYTES)} por arquivo. Peça ao Claude para dividir o arquivo ou diminuir o som/imagem.`,
      });
      return;
    }

    const baseVersion = b?.version ?? 0;
    const version = baseVersion + 1;
    const ref = doc(db, "rooms", this.room.id, "files", fileDocId(path));
    this.inflight.set(path, { content: disk, version });
    let low: number | undefined;
    try {
      let writes = 0;
      await runTransaction(db, async (tx) => {
        low = undefined;
        writes = 0;
        const snap = await tx.get(ref);
        const current = snap.exists() ? (snap.data().version as number) : 0;
        if (current !== baseVersion) {
          // Versão da sala MENOR que a base: o arquivo foi apagado e criado de novo (a versão recomeçou do 1).
          // Sem isto a pasta tentaria gravar para sempre em cima de uma versão que não existe mais, em silêncio.
          if (snap.exists() && current < baseVersion) low = current;
          throw new Stale();
        }
        if (disk === b?.content) return; // só conferindo (verify): nada mudou aqui
        writes = putFile(tx, this.room.id, path, disk, version, this.author, snap);
      });
      if (!writes) return;
      countWrite(writes);
      await this.setBase(path, { content: disk, version });
      this.status(`↑ ${path} v${version}`);
      this.sync.setClaude(true, path);
      await this.noteActivity(path, baseVersion === 0);
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      // Alguém gravou antes: o listener traz a versão nova e o onRemote faz o merge.
    } finally {
      this.inflight.delete(path);
    }
    if (low !== undefined) {
      this.lower.set(path, low);
      const r = this.sync.remoteFiles().find((x) => x.path === path);
      if (r && r.version >= low) await this.onRemote(path, r); // senão o listener ainda vai trazer (e o onRemote aceita)
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
