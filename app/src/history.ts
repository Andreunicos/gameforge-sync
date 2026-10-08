// Histórico e backups da sala.
//
// - rooms/{id}/history/{arquivo@versão}: cada gravação (pessoa ou Claude) com o conteúdo daquela
//   versão, quantas linhas entraram/saíram e em que funções mexeu. Dá para ver a diferença e
//   restaurar qualquer arquivo.
// - rooms/{id}/checkpoints/{id}: "foto" do jogo inteiro (arquivo → versão). Marcada à mão
//   ou automática (1 por dia, se o jogo mudou). Dá para voltar o jogo todo para ela.
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Timestamp,
  type Transaction,
} from "firebase/firestore";
import { diffStats } from "./diff";
import { db } from "./firebase";
import { countWrite } from "./usage";
import { fileDocId } from "./sync/session";
import type { Author, RemoteFile, Room } from "./types";

export interface HistoryEntry {
  id: string;
  path: string;
  version: number;
  content: string;
  author: Author;
  ts?: Timestamp;
  added: number;
  removed: number;
  where: string[];
  kind: "edit" | "create" | "delete" | "restore";
  note?: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  auto: boolean;
  author: Author;
  ts?: Timestamp;
  files: Record<string, number>;
}

const historyCol = (roomId: string) => collection(db, "rooms", roomId, "history");
export { diffLines, diffStats, type DiffLine } from "./diff";
export const historyId = (path: string, version: number) => `${fileDocId(path)}@${version}`;

// ── gravação (sempre junto com a gravação do arquivo) ─────────────────────

export function historyRecord(
  path: string,
  version: number,
  content: string,
  prev: string | null,
  author: Author,
  kind: HistoryEntry["kind"],
  note?: string,
) {
  return {
    path,
    version,
    content,
    author,
    kind,
    ...diffStats(prev, content),
    ...(note ? { note: note.slice(0, 200) } : {}),
    ts: serverTimestamp(),
  };
}

/** Grava a entrada de histórico dentro da mesma transação que grava o arquivo. */
export function addHistory(
  tx: Transaction,
  roomId: string,
  path: string,
  version: number,
  content: string,
  prev: string | null,
  author: Author,
  kind: HistoryEntry["kind"] = prev === null ? "create" : "edit",
) {
  tx.set(doc(db, "rooms", roomId, "history", historyId(path, version)), historyRecord(path, version, content, prev, author, kind));
}

/** Arquivo apagado: guarda o último conteúdo para poder restaurar. */
export async function addDeleteHistory(roomId: string, path: string, content: string, version: number, author: Author) {
  await setDoc(doc(historyCol(roomId), `${fileDocId(path)}@del-${Date.now()}`), {
    ...historyRecord(path, version, content, content, author, "delete"),
    added: 0,
    removed: content.split("\n").length,
  });
  countWrite();
}

// ── leitura ───────────────────────────────────────────────────────────────

export function watchHistory(roomId: string, max: number, cb: (h: HistoryEntry[]) => void, onError: (e: Error) => void) {
  return onSnapshot(
    query(historyCol(roomId), orderBy("ts", "desc"), limit(max)),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as HistoryEntry)),
    onError,
  );
}

export function watchCheckpoints(roomId: string, cb: (c: Checkpoint[]) => void) {
  return onSnapshot(query(collection(db, "rooms", roomId, "checkpoints"), orderBy("ts", "desc"), limit(50)), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Checkpoint)),
  );
}

export async function getVersion(roomId: string, path: string, version: number): Promise<HistoryEntry | null> {
  if (version < 1) return null;
  const d = await getDoc(doc(db, "rooms", roomId, "history", historyId(path, version)));
  return d.exists() ? ({ id: d.id, ...d.data() } as HistoryEntry) : null;
}

// ── restaurar ─────────────────────────────────────────────────────────────

/** Grava `content` como versão nova do arquivo (não apaga nada: a versão atual continua no histórico). */
export async function restoreFile(roomId: string, path: string, content: string, author: Author, note: string) {
  const ref = doc(db, "rooms", roomId, "files", fileDocId(path));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? (snap.data() as RemoteFile) : null;
    if (cur?.content === content) return;
    const version = (cur?.version ?? 0) + 1;
    tx.set(ref, { path, content, version, author, updatedAt: serverTimestamp() });
    tx.set(doc(db, "rooms", roomId, "history", historyId(path, version)), historyRecord(path, version, content, cur?.content ?? null, author, "restore", note));
  });
  countWrite(2);
}

export async function createCheckpoint(roomId: string, files: RemoteFile[], author: Author, label: string, auto = false) {
  const ref = doc(collection(db, "rooms", roomId, "checkpoints"));
  await setDoc(ref, {
    label: label.slice(0, 80),
    auto,
    author,
    files: Object.fromEntries(files.map((f) => [f.path, f.version])),
    ts: serverTimestamp(),
  });
  countWrite();
  return ref.id;
}

/** Volta o jogo inteiro para uma foto. Antes, tira uma foto do estado atual (dá para desfazer). */
export async function restoreCheckpoint(roomId: string, cp: Checkpoint, current: RemoteFile[], author: Author) {
  await createCheckpoint(roomId, current, author, `Antes de voltar para “${cp.label}”`, true);
  const now = new Map(current.map((f) => [f.path, f]));
  let restored = 0;
  const missing: string[] = [];
  for (const [path, version] of Object.entries(cp.files)) {
    if (now.get(path)?.version === version) continue;
    const old = await getVersion(roomId, path, version);
    if (!old) {
      missing.push(path);
      continue;
    }
    if (now.get(path)?.content === old.content) continue;
    await restoreFile(roomId, path, old.content, author, `voltou para “${cp.label}”`);
    restored++;
  }
  const extra = current.filter((f) => !(f.path in cp.files)).map((f) => f.path);
  return { restored, missing, extra };
}

// ── backup inicial e automático ───────────────────────────────────────────

/**
 * Salas criadas antes do histórico: o dono grava a versão atual de cada arquivo uma vez,
 * para que tudo possa ser restaurado a partir de agora.
 */
export async function ensureBaseline(room: Room & { historySince?: unknown }, files: RemoteFile[], author: Author) {
  if (room.historySince || room.ownerId !== author.uid || !files.length) return;
  for (let i = 0; i < files.length; i += 400) {
    const batch = writeBatch(db);
    for (const f of files.slice(i, i + 400)) {
      batch.set(doc(db, "rooms", room.id, "history", historyId(f.path, f.version)), { ...historyRecord(f.path, f.version, f.content, f.content, author, "edit", `backup inicial (última edição: ${f.author.kind === "claude" ? "Claude de " : ""}${f.author.name})`), added: 0, removed: 0 });
    }
    await batch.commit();
    countWrite(Math.min(400, files.length - i));
  }
  await updateDoc(doc(db, "rooms", room.id), { historySince: serverTimestamp() });
  await createCheckpoint(room.id, files, author, "Backup inicial", true);
}

const DAY = 24 * 60 * 60 * 1000;

/** Uma foto automática por dia, se o jogo mudou desde a última. */
export async function maybeAutoCheckpoint(roomId: string, files: RemoteFile[], last: Checkpoint | undefined, author: Author) {
  if (!files.length) return;
  const lastMs = last?.ts?.toMillis() ?? 0;
  if (last && Date.now() - lastMs < DAY) return;
  if (last && files.every((f) => last.files[f.path] === f.version) && Object.keys(last.files).length === files.length) return;
  const d = new Date();
  await createCheckpoint(roomId, files, author, `Backup automático ${d.toLocaleDateString("pt-BR")}`, true);
}
