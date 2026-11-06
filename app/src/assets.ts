// Sons, imagens, fontes e modelos da sala Godot pelo Firestore (plano A da nota 27 do Cofre-GameForge).
//
// rooms/{id}/assets/{sha256(caminho em minúsculas)} = manifesto {path, sha256, size, parts, uid, name, ts}
// rooms/{id}/abin/{sha256}~{i}                         = pedaços imutáveis (tipo Bytes do Firestore, até 900.000 bytes)
//
// Coleções separadas de `files` de propósito: app antigo e gfs tratam `files` como texto e estragariam o binário.
// Bytes e não base64: o Firestore guarda Bytes no tamanho bruto (base64 = +33% de armazenamento) e o SDK web 12 aceita
// `Bytes.fromUint8Array`. Pedaços endereçados pelo sha256 do arquivo: o mesmo som em dois lugares, ou voltar a uma versão
// antiga, não sobe de novo (dedupe); o manifesto só aponta. Quem baixa confere o sha256 antes de gravar no disco.
// Apagar NÃO propaga (fora do mínimo da jam): o arquivo some só no PC de quem apagou.
import {
  Bytes,
  collection,
  doc,
  documentId,
  getCountFromServer,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { mkdir, readDir, readFile, readTextFile, remove, rename, stat, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { db } from "./firebase";
import { countWrite } from "./usage";
import { GODOT_IGNORE_PATH, IGNORE_PATH, SECRET_PATH } from "./sync/fileKinds";
import type { Author, RoomKind } from "./types";

/** Extensões binárias que sincronizam (só na sala Godot). Texto (svg, gltf não, .import...) vai pelo `files`. */
export const ASSET_EXT = new Set("ogg wav mp3 png jpg jpeg webp ttf otf glb gltf".split(" "));
/** Tamanho de cada pedaço (folga para o limite de 1 MiB por documento). Igual à regra de `assets` em firestore.rules. */
export const PART_BYTES = 900_000;
export const MAX_ASSET_BYTES = 25_000_000;
const MB = 1024 * 1024;
/** Teto diário por PC (a saída de 10 GiB/mês do Firestore é dividida com o código: estourou, o Firestore inteiro para). */
export const DAY_LIMIT = { up: 300 * MB, down: 600 * MB };
/** Varredura ao ligar maior que isto espera o botão "Sincronizar agora" (não gasta a cota sem a pessoa saber). */
const FIRST_AUTO = { files: 60, bytes: 50 * MB };
/** Arquivo parado por este tempo = terminou de ser gravado (Audacity/Godot gravam aos poucos). */
const STABLE_MS = 2000;

export interface Manifest {
  path: string;
  sha256: string;
  size: number;
  parts: number;
  uid: string;
  name: string;
  /** ms (serverTimestamp estimado enquanto não confirma). */
  ts: number;
}

/** .gfs/assets.json: o que este PC já tem igual à sala (anti-eco: o que acabou de baixar não sobe de novo). */
export interface LocalEntry {
  sha: string;
  size: number;
  mtime: number;
}

// ── regras puras ─────────────────────────────────────────────────────────

/** Caminho relativo seguro (manifesto vem de outra pessoa: nunca escrever fora da pasta da sala). */
export const safeRel = (rel: string) => !!rel && rel.length <= 300 && !/^\/|[\\:]/.test(rel) && !/(^|\/)\.\.(\/|$)/.test(rel);

/** Arquivo binário de jogo que sincroniza? Só sala Godot; fora .godot/, .gfs/, builds/, export(s)/ e pastas ocultas. */
export function isAssetPath(rel: string, kind: RoomKind | undefined): boolean {
  if (kind !== "godot" || !safeRel(rel)) return false;
  if (IGNORE_PATH.test(rel) || GODOT_IGNORE_PATH.test(rel) || /(^|\/)\./.test(rel) || SECRET_PATH.test(rel)) return false;
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 && ASSET_EXT.has(base.slice(dot + 1));
}

export const partsFor = (size: number) => Math.ceil(size / PART_BYTES);

export function splitBytes(b: Uint8Array, part = PART_BYTES): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += part) out.push(b.subarray(i, i + part));
  return out;
}

export function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const b = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Id do manifesto: sha256 do caminho em minúsculas (no Windows Som.ogg e som.ogg são o mesmo arquivo). A regra confere. */
export const assetDocId = (path: string) => sha256Hex(path.toLowerCase());

export function validManifest(m: Manifest): boolean {
  return (
    safeRel(m.path) &&
    /^[0-9a-f]{64}$/.test(m.sha256) &&
    Number.isInteger(m.size) &&
    m.size >= 0 &&
    m.size <= MAX_ASSET_BYTES &&
    m.parts === partsFor(m.size)
  );
}

/** Dia da cota do Firestore: zera à meia-noite do Pacífico = 05:00 BRT em novembro (UTC-8 fixo; no horário de verão dos
 * EUA a cota zera às 04:00 BRT e o contador daqui vira uma hora depois, o lado seguro). */
export const quotaDay = (ms: number) => new Date(ms - 8 * 3600_000).toISOString().slice(0, 10);

type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const quotaKey = (dir: "up" | "down", now: number) => `gfs-abytes-${dir}-${quotaDay(now)}`;

export function quotaUsed(dir: "up" | "down", now = Date.now(), s = browserStore()): number {
  try {
    return Number(s?.getItem(quotaKey(dir, now)) ?? 0) || 0;
  } catch {
    return 0;
  }
}
export function addQuota(dir: "up" | "down", bytes: number, now = Date.now(), s = browserStore()) {
  try {
    s?.setItem(quotaKey(dir, now), String(quotaUsed(dir, now, s) + bytes));
  } catch {
    /* sem storage: só não conta */
  }
}
export const canSpend = (dir: "up" | "down", bytes: number, now = Date.now(), s = browserStore()) =>
  quotaUsed(dir, now, s) + bytes <= DAY_LIMIT[dir];

/** Disco igual ao do último sync sem precisar ler (tamanho + data de modificação). */
export const sameStat = (e: LocalEntry | undefined, size: number, mtime: number) => !!e && e.size === size && e.mtime === mtime;

/** Arquivo mudou no disco e já tem o sha: sobe? "anotar" = a sala já tem este conteúdo (só guarda no assets.json). */
export function localAction(e: LocalEntry | undefined, sha: string, m: Manifest | undefined): "nada" | "anotar" | "subir" {
  if (e?.sha === sha) return "nada"; // eco do que acabei de baixar, ou só a data mudou
  if (m?.sha256 === sha) return "anotar";
  return "subir";
}

/**
 * Chegou o manifesto `m` (de outra pessoa, ou ao ligar). `disk` = sha do arquivo aqui: null = não existe; undefined = mudou
 * e este app não consegue ler binário (app antigo). Os dois mudaram = vence o mais novo (data do arquivo × ts da sala);
 * perder nunca apaga: a cópia daqui vai para .gfs/backup.
 */
export function remoteAction(
  m: Manifest,
  e: LocalEntry | undefined,
  disk: string | null | undefined,
  diskMtime: number,
): "nada" | "anotar" | "baixar" | "guardar-e-baixar" | "subir" {
  if (disk === null) return "baixar";
  if (disk === m.sha256) return e?.sha === m.sha256 ? "nada" : "anotar";
  if (disk === undefined) return "nada"; // não sei o que tem aqui: não mexo
  if (e && disk === e.sha) return "baixar"; // não mexi desde o último sync: a da sala é a nova
  if (!e) return "guardar-e-baixar"; // primeiro contato e diferente: vale a da sala (como no texto)
  if (m.sha256 === e.sha) return "subir"; // a sala ainda está onde parei: a mudança daqui é a nova
  return diskMtime > m.ts ? "subir" : "guardar-e-baixar";
}

const code = (e: unknown) => String((e as { code?: unknown })?.code ?? "");
export const isQuotaError = (e: unknown) => /resource-exhausted/.test(code(e)) || /resource.exhausted|quota exceeded/i.test(String(e));
const notAllowed = (e: unknown) => /not allowed/i.test(String(e));
const RETRY = new Set(["unavailable", "deadline-exceeded", "aborted", "internal", "unknown"]);

/** Tenta de novo só erro de rede (2 s, 4 s, 8 s). Cota estourada, permissão e hash errado: para na hora, sem loop. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (n >= tries - 1 || isQuotaError(e) || !RETRY.has(code(e).replace(/^firestore\//, ""))) throw e;
      await wait(2000 * 2 ** n);
    }
  }
}

export class HashMismatch extends Error {}

// ── Firestore ────────────────────────────────────────────────────────────

const binCol = (roomId: string) => collection(db, "rooms", roomId, "abin");
const binId = (sha: string, i: number) => `${sha}~${i}`;

async function countBins(roomId: string, ids: string[]): Promise<number> {
  // contagem no servidor: não baixa os pedaços (getDoc de um pedaço = ~900 KB de saída à toa)
  return (await getCountFromServer(query(binCol(roomId), where(documentId(), "in", ids)))).data().count;
}

function toManifest(d: Record<string, unknown>): Manifest {
  const ts = d.ts as { toMillis?: () => number } | null;
  return {
    path: String(d.path ?? ""),
    sha256: String(d.sha256 ?? ""),
    size: Number(d.size),
    parts: Number(d.parts),
    uid: String(d.uid ?? ""),
    name: String(d.name ?? ""),
    ts: ts?.toMillis?.() ?? Date.now(),
  };
}

/**
 * Sobe `bytes` como o conteúdo de `path`: pedaços que faltam (em ordem) e, por último, o manifesto numa transação.
 * `baseSha` = o que este PC tinha da sala; se a sala já está noutro sha, o último vence e volta `conflict` (quem era).
 */
export async function uploadAsset(roomId: string, me: Author, path: string, bytes: Uint8Array, baseSha?: string) {
  if (bytes.length > MAX_ASSET_BYTES) throw new Error(`${path} passa de 25 MB.`);
  const sha = await sha256Hex(bytes);
  const parts = splitBytes(bytes);
  const ids = parts.map((_, i) => binId(sha, i));
  let sent = 0;
  let writes = 0;
  if (parts.length && (await countBins(roomId, ids)) < parts.length) {
    for (let i = 0; i < parts.length; i++) {
      const ref = doc(binCol(roomId), ids[i]);
      try {
        await setDoc(ref, { i, data: Bytes.fromUint8Array(parts[i]) });
        sent += parts[i].length;
        writes++;
      } catch (e) {
        // pedaço imutável que já existe (outro PC subiu o mesmo arquivo, ou tentativa anterior): a regra recusa o "update"
        if (code(e).includes("permission-denied") && (await countBins(roomId, [ids[i]])) === 1) continue;
        throw e;
      }
    }
  }
  const ref = doc(db, "rooms", roomId, "assets", await assetDocId(path));
  let conflict: Manifest | undefined;
  let wrote = false;
  await runTransaction(db, async (tx) => {
    conflict = undefined;
    wrote = false;
    const s = await tx.get(ref);
    const prev = s.exists() ? toManifest(s.data()) : null;
    if (prev?.sha256 === sha) return;
    if (prev && prev.sha256 !== baseSha) conflict = prev;
    tx.set(ref, { path, sha256: sha, size: bytes.length, parts: parts.length, uid: me.uid, name: me.name.slice(0, 80), ts: serverTimestamp() });
    wrote = true;
  });
  if (wrote) writes++;
  return { sha, sent, writes, conflict };
}

/** Baixa e junta os pedaços; confere tamanho e sha256 (diferente = HashMismatch, nada é gravado). */
export async function downloadAsset(roomId: string, m: Manifest): Promise<Uint8Array> {
  const snaps = await Promise.all(Array.from({ length: m.parts }, (_, i) => getDoc(doc(binCol(roomId), binId(m.sha256, i)))));
  if (snaps.some((s) => !s.exists())) throw new HashMismatch(`${m.path}: faltam pedaços na sala.`);
  const bytes = joinBytes(snaps.map((s) => (s.data()!.data as Bytes).toUint8Array()));
  if (bytes.length !== m.size || (await sha256Hex(bytes)) !== m.sha256) throw new HashMismatch(`${m.path} chegou diferente do que foi enviado (hash não bate): não gravei.`);
  return bytes;
}

/** Lista viva dos manifestos. `changed` = os que entraram/mudaram neste snapshot (sem os que ainda estão só neste PC). */
export function watchAssets(roomId: string, cb: (all: Manifest[], changed: Manifest[]) => void, onError: (e: unknown) => void) {
  return onSnapshot(
    collection(db, "rooms", roomId, "assets"),
    (s) => {
      const all = s.docs.map((d) => toManifest(d.data({ serverTimestamps: "estimate" })));
      const changed = s
        .docChanges()
        .filter((c) => c.type !== "removed" && !c.doc.metadata.hasPendingWrites)
        .map((c) => toManifest(c.doc.data({ serverTimestamps: "estimate" })));
      cb(all, changed);
    },
    onError,
  );
}

// ── estado para a tela (sem React: useSyncExternalStore(onAssetView, assetView)) ──

export type ItemState = "ok" | "enviando" | "baixando" | "erro" | "grande" | "cota";
export interface AssetItem {
  path: string;
  state: ItemState;
  note?: string;
  at: number;
}
export interface AssetView {
  roomId: string;
  running: boolean;
  on: boolean;
  /** false = este app não lê binário do disco (app antigo): só baixa. null = ainda não sabe. */
  canUpload: boolean | null;
  synced: number;
  missing: number;
  sending: number;
  receiving: number;
  held: number;
  heldBytes: number;
  roomBytes: number;
  up: number;
  down: number;
  paused: string | null;
  recent: AssetItem[];
}
const EMPTY: AssetView = {
  roomId: "",
  running: false,
  on: false,
  canUpload: null,
  synced: 0,
  missing: 0,
  sending: 0,
  receiving: 0,
  held: 0,
  heldBytes: 0,
  roomBytes: 0,
  up: 0,
  down: 0,
  paused: null,
  recent: [],
};
let view = EMPTY;
const subs = new Set<() => void>();
export const assetView = () => view;
export function onAssetView(l: () => void) {
  subs.add(l);
  return () => void subs.delete(l);
}
function setView(v: AssetView) {
  view = v;
  subs.forEach((l) => l());
}

let active: AssetMirror | null = null;
export const assetCommands = {
  syncNow: () => active?.syncNow(),
  downloadMissing: () => active?.downloadMissing(),
};

const enabledKey = (roomId: string) => `gfs-assets-${roomId}`;
/** Ligado por padrão (por PC). */
export function assetsEnabled(roomId: string): boolean {
  try {
    return localStorage.getItem(enabledKey(roomId)) !== "0";
  } catch {
    return true;
  }
}
export function setAssetsEnabled(roomId: string, on: boolean) {
  try {
    localStorage.setItem(enabledKey(roomId), on ? "1" : "0");
  } catch {
    /* sem storage: vale até fechar */
  }
  if (active?.roomId === roomId) active.setEnabled(on);
}

export const mbText = (b: number) => `${(b / MB).toLocaleString("pt-BR", { maximumFractionDigits: b < 10 * MB ? 1 : 0 })} MB`;

// ── a pasta do Claude (sala Godot): vigia → sobe; manifesto novo → baixa ──

export interface AssetMirrorDeps {
  roomId: string;
  dir: string;
  kind: RoomKind | undefined;
  me: Author;
  canEdit: boolean;
  /** Pastas dos projetos Godot da sala ("" = raiz): só o que está dentro delas sincroniza. */
  projects: () => string[];
  toast: (kind: "info" | "warn" | "error", text: string) => void;
  activity: (path: string, created: boolean, size: number) => Promise<void>;
}

export class AssetMirror {
  readonly roomId: string;
  private local: Record<string, LocalEntry> = {};
  private remote = new Map<string, Manifest>();
  private queue = new Map<string, Promise<void>>();
  private timers = new Map<string, number>();
  private busy = new Map<string, "enviando" | "baixando">();
  private free = 2;
  private waiting: (() => void)[] = [];
  private off?: () => void;
  private first = true;
  private on: boolean;
  private stopped = false;
  private paused: string | null = null;
  private canRead: boolean | null = null;
  private canRename = true;
  private held: { rel: string; size: number }[] = [];
  private recent: AssetItem[] = [];
  private logged = new Set<string>();
  private warned = new Set<string>();
  private saveTimer: number | undefined;

  constructor(private d: AssetMirrorDeps) {
    this.roomId = d.roomId;
    this.on = assetsEnabled(d.roomId);
  }

  async start() {
    active = this;
    try {
      const st = JSON.parse(await readTextFile(await this.gfs("assets.json"))) as { roomId?: string; files?: Record<string, LocalEntry> };
      if (st.roomId === this.roomId) this.local = st.files ?? {};
    } catch {
      /* primeiro uso */
    }
    if (this.on) this.subscribe();
    this.refresh();
  }

  async stop() {
    this.stopped = true;
    this.off?.();
    this.timers.forEach((t) => window.clearTimeout(t));
    await Promise.all(this.queue.values()).catch(() => {});
    await this.save();
    if (active === this) {
      active = null;
      setView(EMPTY);
    }
  }

  async flush() {
    await this.save();
  }

  setEnabled(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    if (on) this.subscribe();
    else {
      this.off?.();
      this.off = undefined;
      this.timers.forEach((t) => window.clearTimeout(t));
    }
    this.refresh();
  }

  /** Evento do vigia da pasta (já filtrado: caminho relativo com "/"). */
  onDisk(rel: string) {
    if (!this.on || this.stopped || !this.accept(rel)) return;
    window.clearTimeout(this.timers.get(rel));
    this.timers.set(rel, window.setTimeout(() => this.enqueue(rel, () => this.localChanged(rel)), STABLE_MS));
  }

  /** Botão: solta o que a varredura segurou, tira a pausa de cota (uma tentativa) e confere tudo de novo. */
  async syncNow() {
    this.paused = null;
    this.warned.clear();
    const held = this.held;
    this.held = [];
    for (const h of held) this.enqueue(h.rel, () => this.localChanged(h.rel, true));
    for (const f of await this.scan()) this.enqueue(f.rel, () => this.localChanged(f.rel));
    this.downloadMissing();
  }

  downloadMissing() {
    this.paused = null;
    for (const m of this.remote.values()) if (this.local[m.path]?.sha !== m.sha256) this.enqueue(m.path, () => this.applyRemote(m));
    this.refresh();
  }

  // ── interno ──

  private accept(rel: string) {
    const r = rel.toLowerCase();
    return isAssetPath(rel, this.d.kind) && this.d.projects().some((p) => p === "" || r.startsWith(p.toLowerCase() + "/"));
  }

  private subscribe() {
    this.first = true;
    this.off = watchAssets(
      this.roomId,
      (all, changed) => {
        const ok = all.filter((m) => validManifest(m) && this.accept(m.path));
        this.remote = new Map(ok.map((m) => [m.path.toLowerCase(), m]));
        const list = this.first ? ok : changed.filter((m) => validManifest(m) && this.accept(m.path));
        for (const m of list) this.enqueue(m.path, () => this.applyRemote(m));
        if (this.first) {
          this.first = false;
          void this.firstScan().catch((e) => this.fail(e));
        }
        this.refresh();
      },
      (e) => this.fail(e),
    );
  }

  /** Ao ligar: o que só existe neste PC sobe (muito de uma vez espera o botão). O resto é com applyRemote. */
  private async firstScan() {
    if (!this.d.canEdit) return;
    const only = (await this.scan()).filter((f) => !this.remote.has(f.rel.toLowerCase()) && !sameStat(this.local[f.rel], f.size, f.mtime));
    const bytes = only.reduce((n, f) => n + f.size, 0);
    if (only.length > FIRST_AUTO.files || bytes > FIRST_AUTO.bytes) {
      this.held = only.map((f) => ({ rel: f.rel, size: f.size }));
      this.d.toast(
        "info",
        `${only.length} sons/imagens (${mbText(bytes)}) existem só neste PC e esperam você: 🎮 Godot → Sons e imagens → Sincronizar agora.`,
      );
    } else for (const f of only) this.enqueue(f.rel, () => this.localChanged(f.rel));
    this.refresh();
  }

  private async scan(): Promise<{ rel: string; size: number; mtime: number }[]> {
    const out: { rel: string; size: number; mtime: number }[] = [];
    const walk = async (rel: string) => {
      for (const e of await readDir(rel ? await this.abs(rel) : this.d.dir)) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.name.startsWith(".") || IGNORE_PATH.test(p) || GODOT_IGNORE_PATH.test(p)) continue;
        if (e.isDirectory) await walk(p);
        else if (e.isFile && this.accept(p)) {
          const st = await this.statOf(p);
          if (st) out.push({ rel: p, ...st });
        }
      }
    };
    await walk("");
    return out;
  }

  private enqueue(rel: string, fn: () => Promise<void>) {
    const prev = this.queue.get(rel) ?? Promise.resolve();
    const next = prev
      .then(() => (this.stopped || !this.on ? undefined : fn()))
      .catch((e) => this.fail(e, rel))
      .finally(() => {
        if (this.queue.get(rel) === next) this.queue.delete(rel);
      });
    this.queue.set(rel, next);
  }

  private async slot<T>(rel: string, kind: "enviando" | "baixando", fn: () => Promise<T>): Promise<T> {
    if (this.free === 0) await new Promise<void>((r) => this.waiting.push(r));
    else this.free--;
    this.busy.set(rel, kind);
    this.item(rel, kind);
    try {
      return await fn();
    } finally {
      this.busy.delete(rel);
      const w = this.waiting.shift();
      if (w) w();
      else this.free++;
      this.refresh();
    }
  }

  private async localChanged(rel: string, force = false) {
    if (!this.d.canEdit) return;
    const st = await this.statOf(rel);
    if (!st) return; // apagado aqui: não propaga (só o PC de quem apagou fica sem)
    const e = this.local[rel];
    if (!force && sameStat(e, st.size, st.mtime)) return;
    if (st.size > MAX_ASSET_BYTES) {
      this.item(rel, "grande", `${mbText(st.size)}: o limite é 25 MB (exporte em .ogg)`);
      this.warnOnce(`big:${rel}`, "warn", `${rel} tem ${mbText(st.size)} e não sobe (limite 25 MB por arquivo). Música longa: exporte em .ogg.`);
      return;
    }
    const bytes = await this.read(rel);
    if (!bytes) return;
    if (bytes.length !== st.size) return this.onDisk(rel); // ainda gravando: espera parar
    const sha = await sha256Hex(bytes);
    const m = this.remote.get(rel.toLowerCase());
    if (localAction(e, sha, m) !== "subir") return this.setLocal(rel, { sha, size: st.size, mtime: st.mtime });
    if (this.paused) return this.item(rel, "cota", this.paused);
    if (!canSpend("up", bytes.length)) {
      this.item(rel, "cota", "cota de envio de hoje acabou");
      this.warnOnce("quota-up", "warn", `Sons e imagens: este PC já enviou ${mbText(quotaUsed("up"))} hoje (limite ${mbText(DAY_LIMIT.up)}). O resto sobe depois das 05:00.`);
      return;
    }
    const r = await this.slot(rel, "enviando", () => withRetry(() => uploadAsset(this.roomId, this.d.me, rel, bytes, e?.sha)));
    addQuota("up", r.sent);
    countWrite(r.writes);
    this.setLocal(rel, { sha, size: st.size, mtime: st.mtime });
    this.item(rel, "ok", r.sent ? `enviado (${mbText(r.sent)})` : "enviado (a sala já tinha os bytes)");
    if (r.conflict) this.d.toast("warn", `${r.conflict.name} também mudou ${rel}: ficou a sua versão, a mais nova (a dele continua guardada na sala).`);
    if (!this.logged.has(rel)) {
      this.logged.add(rel);
      await this.d.activity(rel, !m, st.size).catch(() => {});
    }
  }

  private async applyRemote(m: Manifest) {
    const rel = m.path;
    const e = this.local[rel];
    const st = await this.statOf(rel);
    let disk: string | null | undefined;
    if (!st) disk = null;
    else if (e && sameStat(e, st.size, st.mtime)) disk = e.sha;
    else if (this.canRead === false) disk = undefined;
    else {
      const b = await this.read(rel);
      disk = b ? await sha256Hex(b) : undefined;
    }
    const act = remoteAction(m, e, disk, st?.mtime ?? 0);
    if (act === "nada") {
      if (disk === undefined) this.item(rel, "erro", "mudou neste PC e este app não envia: atualize o app");
      return;
    }
    if (act === "anotar") return this.setLocal(rel, { sha: m.sha256, size: st!.size, mtime: st!.mtime });
    if (act === "subir") return this.localChanged(rel, true);
    if (this.paused) return this.item(rel, "cota", this.paused);
    if (!canSpend("down", m.size)) {
      this.item(rel, "cota", "cota de download de hoje acabou");
      this.warnOnce("quota-down", "warn", `Sons e imagens: este PC já baixou ${mbText(quotaUsed("down"))} hoje (limite ${mbText(DAY_LIMIT.down)}). O resto baixa depois das 05:00.`);
      return;
    }
    const bytes = await this.slot(rel, "baixando", () => withRetry(() => downloadAsset(this.roomId, m)));
    addQuota("down", bytes.length);
    if (act === "guardar-e-baixar" && !(await this.backup(rel))) {
      this.item(rel, "erro", `${m.name} mandou outra versão e este app não consegue guardar a sua: atualize o app`);
      return;
    }
    await this.writeAtomic(rel, bytes);
    const now = await this.statOf(rel);
    this.setLocal(rel, { sha: m.sha256, size: bytes.length, mtime: now?.mtime ?? 0 });
    this.item(rel, "ok", `recebido de ${m.name}`);
    if (act === "guardar-e-baixar") this.d.toast("info", `${rel}: ficou a versão de ${m.name} (a sua foi guardada em .gfs/backup/${rel}).`);
  }

  private async abs(rel: string) {
    return join(this.d.dir, ...rel.split("/"));
  }
  private async gfs(...p: string[]) {
    return join(this.d.dir, ".gfs", ...p);
  }
  private parent = (f: string) => f.slice(0, Math.max(f.lastIndexOf("\\"), f.lastIndexOf("/")));

  private async statOf(rel: string): Promise<{ size: number; mtime: number } | null> {
    try {
      const s = await stat(await this.abs(rel));
      return s.isFile ? { size: s.size, mtime: s.mtime?.getTime() ?? 0 } : null;
    } catch {
      return null;
    }
  }

  private async read(rel: string): Promise<Uint8Array | null> {
    try {
      const b = await readFile(await this.abs(rel));
      if (this.canRead !== true) {
        this.canRead = true;
        this.refresh();
      }
      return b;
    } catch (e) {
      if (!notAllowed(e)) throw e;
      this.canRead = false; // app antigo (sem fs:allow-read-file): só baixa
      this.item(rel, "erro", "atualize o app para enviar sons");
      this.warnOnce("old-app", "warn", "Este app ainda não ENVIA sons e imagens (só baixa). Feche e abra o GameForge para atualizar.");
      this.refresh();
      return null;
    }
  }

  /** Grava em .gfs/tmp e renomeia por cima (a Godot nunca vê arquivo pela metade). App antigo sem rename: grava direto. */
  private async writeAtomic(rel: string, bytes: Uint8Array) {
    const target = await this.abs(rel);
    await mkdir(this.parent(target), { recursive: true });
    if (this.canRename) {
      const tmp = await this.gfs("tmp", `${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
      await mkdir(this.parent(tmp), { recursive: true });
      await writeFile(tmp, bytes);
      try {
        await rename(tmp, target);
        return;
      } catch (e) {
        await remove(tmp).catch(() => {});
        if (!notAllowed(e)) throw e;
        this.canRename = false;
      }
    }
    await writeFile(target, bytes);
  }

  /** Tira a cópia daqui do caminho antes de gravar a da sala: .gfs/backup/<caminho>. */
  private async backup(rel: string): Promise<boolean> {
    const from = await this.abs(rel);
    const to = await this.gfs("backup", ...rel.split("/"));
    await mkdir(this.parent(to), { recursive: true });
    if (this.canRename) {
      try {
        await rename(from, to);
        return true;
      } catch (e) {
        if (!notAllowed(e)) throw e;
        this.canRename = false;
      }
    }
    const b = this.canRead === false ? null : await this.read(rel);
    if (!b) return false;
    await writeFile(to, b);
    return true;
  }

  private setLocal(rel: string, e: LocalEntry) {
    this.local[rel] = e;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save().catch((x) => console.warn(".gfs/assets.json:", x)), 1000);
    this.refresh();
  }

  private async save() {
    window.clearTimeout(this.saveTimer);
    if (!this.d.dir) return;
    await writeTextFile(await this.gfs("assets.json"), JSON.stringify({ roomId: this.roomId, files: this.local }, null, 1));
  }

  private warnOnce(key: string, kind: "info" | "warn" | "error", text: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.d.toast(kind, text);
  }

  private fail(e: unknown, rel?: string) {
    console.warn("sons e imagens:", rel ?? "", e);
    if (!rel && code(e).includes("permission-denied")) {
      this.warnOnce("perm", "error", "Sons e imagens: o Firebase recusou (as regras novas de assets/abin ainda não foram publicadas pelo dono, ou você é espectador).");
    } else if (isQuotaError(e)) {
      this.paused = "A cota do Firebase de hoje acabou: sons e imagens param até 05:00 (o código continua tentando).";
      this.warnOnce("quota-fb", "error", this.paused);
    } else if (rel) {
      this.item(rel, "erro", e instanceof Error ? e.message : String(e));
    } else {
      this.warnOnce(`err:${String(e)}`, "error", `Sons e imagens: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.refresh();
  }

  private item(path: string, state: ItemState, note?: string) {
    this.recent = [{ path, state, note, at: Date.now() }, ...this.recent.filter((i) => i.path !== path)].slice(0, 10);
    this.refresh();
  }

  private refresh() {
    if (active !== this) return;
    const ms = [...this.remote.values()];
    const synced = ms.filter((m) => this.local[m.path]?.sha === m.sha256).length;
    const busy = [...this.busy.values()];
    setView({
      roomId: this.roomId,
      running: !this.stopped,
      on: this.on,
      canUpload: this.d.canEdit ? this.canRead : false,
      synced,
      missing: ms.length - synced,
      sending: busy.filter((b) => b === "enviando").length,
      receiving: busy.filter((b) => b === "baixando").length,
      held: this.held.length,
      heldBytes: this.held.reduce((n, h) => n + h.size, 0),
      roomBytes: ms.reduce((n, m) => n + m.size, 0),
      up: quotaUsed("up"),
      down: quotaUsed("down"),
      paused: this.paused,
      recent: this.recent,
    });
  }
}
