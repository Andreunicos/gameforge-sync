// Cliente mínimo da API REST do Firestore (sem SDK: o gfs fica pequeno e abre rápido).
import { DOC_ROOT, FIRESTORE, RTDB_URL } from "./config.ts";
import { session } from "./auth.ts";

type FsValue = Record<string, unknown>;
export interface FsDoc {
  name: string;
  fields?: Record<string, FsValue>;
  updateTime?: string;
}

export class FsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const s = await session();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${s.idToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (Array.isArray(data) ? data[0]?.error : data.error) ?? {};
    const code = String(err.status ?? res.status);
    const msg =
      code === "PERMISSION_DENIED"
        ? "sem permissão (sua conta é da lista e você é membro desta sala?)"
        : String(err.message ?? res.statusText);
    throw new FsError(res.status, code, msg);
  }
  return data as T;
}

// ── valores ──────────────────────────────────────────────────────────────

export function encode(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
}

export function encodeFields(o: Record<string, unknown>): Record<string, FsValue> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encode(v)]));
}

export function decode(v: FsValue): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return ((v.arrayValue as { values?: FsValue[] }).values ?? []).map(decode);
  if ("mapValue" in v) return decodeFields((v.mapValue as { fields?: Record<string, FsValue> }).fields ?? {});
  return undefined;
}

export function decodeFields(f: Record<string, FsValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decode(v)]));
}

export function data<T>(d: FsDoc): T {
  return decodeFields(d.fields ?? {}) as T;
}

/** "rooms/abc/files/js%2Fa.js" → caminho de URL com cada segmento escapado. */
function urlPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ── operações ────────────────────────────────────────────────────────────

export async function getDoc(path: string): Promise<FsDoc | null> {
  try {
    return await call<FsDoc>(`${FIRESTORE}/${urlPath(path)}`);
  } catch (e) {
    if (e instanceof FsError && e.status === 404) return null;
    throw e;
  }
}

export async function listDocs(collection: string): Promise<FsDoc[]> {
  const out: FsDoc[] = [];
  let token = "";
  do {
    const r = await call<{ documents?: FsDoc[]; nextPageToken?: string }>(
      `${FIRESTORE}/${urlPath(collection)}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
    );
    out.push(...(r.documents ?? []));
    token = r.nextPageToken ?? "";
  } while (token);
  return out;
}

export interface QueryResult {
  docs: FsDoc[];
  readTime: string;
}

/** structuredQuery dentro de um documento-pai (ex.: "rooms/abc"); "" = raiz. */
export async function runQuery(parent: string, structuredQuery: unknown): Promise<QueryResult> {
  const url = parent ? `${FIRESTORE}/${urlPath(parent)}:runQuery` : `${FIRESTORE}:runQuery`;
  const rows = await call<{ document?: FsDoc; readTime?: string }[]>(url, {
    method: "POST",
    body: JSON.stringify({ structuredQuery }),
  });
  return {
    docs: rows.filter((r) => r.document).map((r) => r.document!),
    readTime: rows.find((r) => r.readTime)?.readTime ?? new Date().toISOString(),
  };
}

export interface Write {
  path: string;
  fields?: Record<string, unknown>;
  delete?: boolean;
  /** Campos preenchidos com a hora do servidor (as regras exigem == request.time). */
  serverTime?: string[];
  /** updateTime esperado do documento, ou "missing" para exigir que ainda não exista. */
  precondition?: string | "missing";
}

export async function commit(writes: Write[]): Promise<{ commitTime: string; writeResults: { updateTime?: string }[] }> {
  return call(`${FIRESTORE.replace(/\/documents$/, "/documents:commit")}`, {
    method: "POST",
    body: JSON.stringify({
      writes: writes.map((w) => {
        const name = `${DOC_ROOT}/${w.path}`;
        const currentDocument =
          w.precondition === "missing" ? { exists: false } : w.precondition ? { updateTime: w.precondition } : undefined;
        if (w.delete) return { delete: name, currentDocument };
        return {
          update: { name, fields: encodeFields(w.fields ?? {}) },
          updateTransforms: (w.serverTime ?? []).map((f) => ({ fieldPath: f, setToServerValue: "REQUEST_TIME" })),
          currentDocument,
        };
      }),
    }),
  });
}

/** Presença (Realtime Database): quem está com o app aberto e em que arquivo. */
export async function presence(roomId: string): Promise<{ uid: string; name: string; file: string | null }[]> {
  const s = await session();
  try {
    const res = await fetch(`${RTDB_URL}/presence/${encodeURIComponent(roomId)}.json?auth=${s.idToken}`);
    if (!res.ok) return [];
    const val = ((await res.json()) ?? {}) as Record<string, { name: string; file: string | null }>;
    return Object.entries(val).map(([uid, p]) => ({ uid, name: p.name, file: p.file }));
  } catch {
    return [];
  }
}
