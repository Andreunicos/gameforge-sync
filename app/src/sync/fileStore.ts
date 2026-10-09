// Gravação e leitura de arquivos da sala, inclusive os grandes (em pedaços, ver bigfile.ts).
// Todo lugar que grava arquivo (editor, pasta do Claude, importar, restaurar) passa por putFile.
import { doc, getDoc, serverTimestamp, type DocumentSnapshot, type Transaction } from "firebase/firestore";
import { db } from "../firebase";
import { historyId, historyRecord, type HistoryEntry } from "../history";
import { blobDocId, splitParts, utf8Bytes, MAX_FILE_BYTES } from "../bigfile";
import type { Author, RemoteFile } from "../types";
import { fileDocId } from "./session";

const blobRef = (roomId: string, path: string, i: number) => doc(db, "rooms", roomId, "blobs", blobDocId(fileDocId(path), i));

/**
 * Grava `content` como versão `version` do arquivo + a entrada de histórico, na transação.
 * `prev` é o snapshot atual do documento (lido na mesma transação). Devolve quantas gravações fez.
 */
export function putFile(
  tx: Transaction,
  roomId: string,
  path: string,
  content: string,
  version: number,
  author: Author,
  prev: DocumentSnapshot,
  kind?: HistoryEntry["kind"],
  note?: string,
): number {
  const old = prev.exists() ? (prev.data() as RemoteFile) : null;
  const oldParts = old?.parts ?? 0;
  const size = utf8Bytes(content);
  const parts = size > MAX_FILE_BYTES ? splitParts(content) : [];

  tx.set(doc(db, "rooms", roomId, "files", fileDocId(path)), {
    path,
    content: parts.length ? "" : content,
    version,
    author,
    updatedAt: serverTimestamp(),
    ...(parts.length ? { parts: parts.length, size } : {}),
  });
  parts.forEach((data, i) => tx.set(blobRef(roomId, path, i), { path, version, i, data }));
  for (let i = parts.length; i < oldParts; i++) tx.delete(blobRef(roomId, path, i));

  // Versão anterior grande não está no documento: o histórico conta como arquivo novo.
  const prevContent = old && !oldParts ? old.content : null;
  tx.set(
    doc(db, "rooms", roomId, "history", historyId(path, version)),
    historyRecord(path, version, content, prevContent, author, kind ?? (old ? "edit" : "create"), note),
  );
  return 2 + parts.length + Math.max(0, oldParts - parts.length);
}

/** Junta os pedaços de um arquivo grande. null = algum pedaço já é de outra versão (vem outra atualização). */
export async function readBig(roomId: string, f: RemoteFile): Promise<string | null> {
  const snaps = await Promise.all(Array.from({ length: f.parts ?? 0 }, (_, i) => getDoc(blobRef(roomId, f.path, i))));
  const out: string[] = [];
  for (const s of snaps) {
    if (!s.exists() || s.data().version !== f.version) return null;
    out.push(s.data().data as string);
  }
  return out.join("");
}
