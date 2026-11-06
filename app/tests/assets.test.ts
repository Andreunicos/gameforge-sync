// Sons e imagens da sala Godot (src/assets.ts): pedaços, sha256, cota diária (vira às 05:00 BRT), quais arquivos entram,
// decisões sobe/baixa/conflito, e o AssetMirror inteiro contra um Firestore e um disco de mentira (eco, dedupe, hash
// errado, backup no conflito). As regras de verdade são testadas no emulador (firebase/tests/assets.mjs).
import { beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Data = Record<string, unknown>;
  const store = new Map<string, Data>();
  const subs = new Set<{ col: string; cb: (s: unknown) => void; seen: Map<string, Data> }>();
  const counts = { setDoc: 0, abin: 0 };
  const inCol = (col: string, p: string) => p.startsWith(col + "/") && !p.slice(col.length + 1).includes("/");
  const snap = (path: string) => ({ exists: () => store.has(path), data: () => store.get(path), metadata: { hasPendingWrites: false } });
  const emit = (l: { col: string; cb: (s: unknown) => void; seen: Map<string, Data> }) => {
    const docs = [...store.keys()].filter((p) => inCol(l.col, p));
    const changed = docs.filter((p) => l.seen.get(p) !== store.get(p));
    docs.forEach((p) => l.seen.set(p, store.get(p)!));
    l.cb({
      docs: docs.map((p) => ({ data: () => store.get(p) })),
      docChanges: () => changed.map((p) => ({ type: "modified", doc: { data: () => store.get(p), metadata: { hasPendingWrites: false } } })),
    });
  };
  const put = (path: string, data: Data) => {
    store.set(path, data);
    for (const l of subs) if (inCol(l.col, path)) queueMicrotask(() => emit(l));
  };
  return { store, subs, counts, snap, emit, put, inCol };
});

vi.mock("../src/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  Bytes: { fromUint8Array: (u: Uint8Array) => ({ toUint8Array: () => u }) },
  collection: (_db: unknown, ...s: string[]) => ({ path: s.join("/") }),
  doc: (a: { path?: string }, ...s: string[]) => ({ path: (a.path ? [a.path, ...s] : s).join("/") }),
  documentId: () => "__id__",
  where: (_f: unknown, _op: unknown, ids: string[]) => ids,
  query: (col: { path: string }, ids: string[]) => ({ col, ids }),
  getCountFromServer: async (q: { col: { path: string }; ids: string[] }) => ({
    data: () => ({ count: q.ids.filter((id) => fake.store.has(`${q.col.path}/${id}`)).length }),
  }),
  getDoc: async (r: { path: string }) => fake.snap(r.path),
  setDoc: async (r: { path: string }, d: Record<string, unknown>) => {
    // como a regra: pedaço é imutável
    if (r.path.includes("/abin/") && fake.store.has(r.path)) throw Object.assign(new Error("denied"), { code: "permission-denied" });
    fake.counts.setDoc++;
    if (r.path.includes("/abin/")) fake.counts.abin++;
    fake.put(r.path, d);
  },
  serverTimestamp: () => {
    const t = Date.now();
    return { toMillis: () => t };
  },
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<void>) => {
    const sets: [string, Record<string, unknown>][] = [];
    await fn({ get: async (r: { path: string }) => fake.snap(r.path), set: (r: { path: string }, d: Record<string, unknown>) => sets.push([r.path, d]) });
    for (const [p, d] of sets) fake.put(p, d);
  },
  onSnapshot: (col: { path: string }, cb: (s: unknown) => void) => {
    const l = { col: col.path, cb, seen: new Map() };
    fake.subs.add(l);
    queueMicrotask(() => fake.emit(l));
    return () => fake.subs.delete(l);
  },
}));

// disco de mentira: caminho com "/" → bytes ou texto + data de modificação
const disk = vi.hoisted(() => {
  const files = new Map<string, { b: Uint8Array | string; mt: number }>();
  let clock = 1_000_000;
  const put = (p: string, b: Uint8Array | string) => files.set(p, { b, mt: ++clock });
  const enoent = (p: string) => Object.assign(new Error(`não existe: ${p}`), { code: "ENOENT" });
  return { files, put, enoent };
});
vi.mock("@tauri-apps/api/path", () => ({ join: async (...a: string[]) => a.join("/") }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: async () => {},
  readDir: async (dir: string) => {
    const kids = new Map<string, boolean>();
    for (const p of disk.files.keys()) {
      if (!p.startsWith(dir + "/")) continue;
      const [name, ...rest] = p.slice(dir.length + 1).split("/");
      kids.set(name, rest.length > 0 || kids.get(name) === true);
    }
    return [...kids].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory }));
  },
  stat: async (p: string) => {
    const f = disk.files.get(p);
    if (!f) throw disk.enoent(p);
    return { isFile: true, size: typeof f.b === "string" ? f.b.length : f.b.length, mtime: new Date(f.mt) };
  },
  readFile: async (p: string) => {
    const f = disk.files.get(p);
    if (!f || typeof f.b === "string") throw disk.enoent(p);
    return f.b;
  },
  readTextFile: async (p: string) => {
    const f = disk.files.get(p);
    if (!f || typeof f.b !== "string") throw disk.enoent(p);
    return f.b;
  },
  writeFile: async (p: string, b: Uint8Array) => void disk.put(p, b.slice()),
  writeTextFile: async (p: string, s: string) => void disk.put(p, s),
  rename: async (a: string, b: string) => {
    const f = disk.files.get(a);
    if (!f) throw disk.enoent(a);
    disk.files.delete(a);
    disk.files.set(b, f); // rename mantém a data
  },
  remove: async (p: string) => void disk.files.delete(p),
}));

import {
  AssetMirror,
  DAY_LIMIT,
  MAX_ASSET_BYTES,
  PART_BYTES,
  addQuota,
  assetDocId,
  assetView,
  canSpend,
  downloadAsset,
  isAssetPath,
  joinBytes,
  localAction,
  partsFor,
  quotaDay,
  quotaUsed,
  remoteAction,
  safeRel,
  sha256Hex,
  splitBytes,
  uploadAsset,
  validManifest,
  withRetry,
  type Manifest,
} from "../src/assets";
import { isCodePath } from "../src/sync/fileKinds";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 255);
const man = (over: Partial<Manifest> = {}): Manifest => ({ path: "project/a.ogg", sha256: "a".repeat(64), size: 10, parts: 1, uid: "u2", name: "P2", ts: 1000, ...over });

beforeAll(() => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("localStorage", mem());
});

describe("pedaços", () => {
  it("corta e junta nas bordas (0, 1, múltiplo exato, +1)", () => {
    for (const n of [0, 1, PART_BYTES - 1, PART_BYTES, PART_BYTES + 1, 2 * PART_BYTES, 3 * PART_BYTES + 7]) {
      const b = bytes(n);
      const parts = splitBytes(b);
      expect(parts.length, String(n)).toBe(partsFor(n));
      expect(parts.every((p) => p.length > 0 && p.length <= PART_BYTES)).toBe(true);
      expect(Buffer.from(joinBytes(parts)).equals(Buffer.from(b))).toBe(true);
    }
    expect(partsFor(MAX_ASSET_BYTES)).toBe(28); // cabe no "in" de até 30 ids da contagem de dedupe
  });
  it("sha256 confere com vetores conhecidos", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await assetDocId("Project/Som.OGG")).toBe(await assetDocId("project/som.ogg"));
  });
  it("manifesto inválido (caminho para fora, parts errado) é ignorado", () => {
    expect(validManifest(man())).toBe(true);
    expect(validManifest(man({ path: "../x.ogg" }))).toBe(false);
    expect(validManifest(man({ path: "C:/x.ogg" }))).toBe(false);
    expect(validManifest(man({ parts: 2 }))).toBe(false);
    expect(validManifest(man({ size: MAX_ASSET_BYTES + 1, parts: 28 }))).toBe(false);
    expect(safeRel("a/b..c/x.png")).toBe(true);
  });
});

describe("quais arquivos", () => {
  it("só sala Godot, só binários de jogo, fora pastas geradas/ocultas", () => {
    for (const p of ["project/sfx/pulo.ogg", "project/m/Tema.WAV", "a.mp3", "ui/f.ttf", "ui/f.otf", "x/a.png", "x/a.jpg", "x/a.jpeg", "x/a.webp", "m/a.glb", "m/a.gltf"])
      expect(isAssetPath(p, "godot"), p).toBe(true);
    for (const p of ["project/.godot/imported/a.png", ".gfs/bugs/a.jpg", "builds/godot-web/a.png", "project/export/a.png", "project/exports/a.png", "project/.hidden/a.png", "x/.a.png", "../a.png", "a.gd", "a.ogg.import", "a.svg", "node_modules/a.png"])
      expect(isAssetPath(p, "godot"), p).toBe(false);
    for (const k of ["html5", "unreal", "roblox", undefined] as const) expect(isAssetPath("project/a.ogg", k)).toBe(false);
  });
  it(".import entra como texto só na sala Godot", () => {
    expect(isCodePath("project/sfx/pulo.ogg.import", "godot")).toBe(true);
    expect(isCodePath("project/sfx/pulo.ogg.import")).toBe(false);
    expect(isCodePath("project/sfx/pulo.ogg.import", "html5")).toBe(false);
    expect(isCodePath("project/sfx/pulo.ogg", "godot")).toBe(false);
  });
});

describe("cota diária", () => {
  it("vira às 05:00 BRT (meia-noite do Pacífico)", () => {
    const brt = (s: string) => Date.parse(s + "-03:00");
    expect(quotaDay(brt("2026-11-08T04:59:59"))).toBe("2026-11-07");
    expect(quotaDay(brt("2026-11-08T05:00:00"))).toBe("2026-11-08");
    const s = mem();
    const t = brt("2026-11-07T23:00:00");
    addQuota("up", 200 * 1024 * 1024, t, s);
    expect(canSpend("up", 100 * 1024 * 1024, t, s)).toBe(true);
    expect(canSpend("up", 100 * 1024 * 1024 + 1, t, s)).toBe(false);
    expect(canSpend("down", DAY_LIMIT.down, t, s)).toBe(true); // contadores separados
    const depois = brt("2026-11-08T05:00:01");
    expect(quotaUsed("up", depois, s)).toBe(0);
    expect(canSpend("up", DAY_LIMIT.up, depois, s)).toBe(true);
  });
});

describe("decisões", () => {
  const e = { sha: "1".repeat(64), size: 10, mtime: 500 };
  it("eco: o que acabei de baixar não sobe de novo", () => {
    expect(localAction(e, e.sha, man({ sha256: e.sha }))).toBe("nada");
    expect(localAction(undefined, "2".repeat(64), man({ sha256: "2".repeat(64) }))).toBe("anotar"); // a sala já tem igual (dedupe)
    expect(localAction(e, "3".repeat(64), man({ sha256: e.sha }))).toBe("subir");
    expect(remoteAction(man({ sha256: e.sha, uid: "u1" }), e, e.sha, 500)).toBe("nada");
  });
  it("baixa, guarda a minha no conflito, ou sobe a minha mais nova", () => {
    const m = man({ sha256: "9".repeat(64), ts: 1000 });
    expect(remoteAction(m, e, null, 0)).toBe("baixar");
    expect(remoteAction(m, e, e.sha, 500)).toBe("baixar"); // não mexi aqui
    expect(remoteAction(m, undefined, "4".repeat(64), 5000)).toBe("guardar-e-baixar"); // primeiro contato: vale a da sala
    expect(remoteAction(m, e, "4".repeat(64), 999)).toBe("guardar-e-baixar"); // os dois mudaram, a da sala é mais nova
    expect(remoteAction(m, e, "4".repeat(64), 1001)).toBe("subir"); // a minha é mais nova
    expect(remoteAction(man({ sha256: e.sha }), e, "4".repeat(64), 1)).toBe("subir"); // sala parada onde parei
    expect(remoteAction(m, e, undefined, 0)).toBe("nada"); // app antigo: não sei o que tem aqui
  });
  it("retry só em erro de rede; cota e permissão param na hora", async () => {
    const wait = vi.fn(async () => {});
    let n = 0;
    expect(await withRetry(async () => (++n < 3 ? Promise.reject({ code: "unavailable" }) : "ok"), 4, wait)).toBe("ok");
    expect(wait).toHaveBeenCalledTimes(2);
    for (const code of ["resource-exhausted", "permission-denied"]) {
      let k = 0;
      await expect(withRetry(async () => (k++, Promise.reject({ code })), 4, wait)).rejects.toEqual({ code });
      expect(k).toBe(1);
    }
  });
});

describe("Firestore (de mentira)", () => {
  const me = (i: number) => ({ uid: `u${i}`, name: `P${i}`, kind: "claude" as const });
  it("dedupe: o mesmo conteúdo noutro caminho não sobe bytes", async () => {
    const b = bytes(PART_BYTES * 2 + 5);
    const a = await uploadAsset("r0", me(1), "project/a.ogg", b);
    expect(a.sent).toBe(b.length);
    const n = fake.counts.abin;
    const c = await uploadAsset("r0", me(2), "project/copia.ogg", b);
    expect(c.sent).toBe(0);
    expect(fake.counts.abin).toBe(n);
  });
  it("hash divergente: recusa e não devolve nada", async () => {
    const b = bytes(1000, 9);
    await uploadAsset("r0", me(1), "project/h.png", b);
    const m = fake.store.get(`rooms/r0/assets/${await assetDocId("project/h.png")}`) as unknown as Manifest;
    expect(Buffer.from(await downloadAsset("r0", { ...m, ts: 0 })).equals(Buffer.from(b))).toBe(true);
    const sha = m.sha256;
    fake.store.set(`rooms/r0/abin/${sha}~0`, { i: 0, data: { toUint8Array: () => bytes(1000, 8) } });
    await expect(downloadAsset("r0", { ...m, ts: 0 })).rejects.toThrow(/hash não bate/);
  });
});

describe("AssetMirror (pasta do Claude)", () => {
  const D = "/sala";
  const idle = async (cond: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("tempo esgotado");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const manOf = async (path: string) => fake.store.get(`rooms/r1/assets/${await assetDocId(path)}`) as unknown as Manifest | undefined;
  const fileBytes = (rel: string) => disk.files.get(`${D}/${rel}`)?.b as Uint8Array | undefined;
  const toasts: string[] = [];
  let mirror: AssetMirror;

  it("baixa o da sala, sobe o que é só daqui, ignora fora do projeto, sem eco", { timeout: 20_000 }, async () => {
    const them = { uid: "u2", name: "P2", kind: "claude" as const };
    const som = bytes(PART_BYTES + 10, 3);
    await uploadAsset("r1", them, "project/sfx/a.ogg", som);
    const conflito = bytes(500, 4);
    await uploadAsset("r1", them, "project/sfx/c.ogg", conflito);
    disk.put(`${D}/project/sfx/c.ogg`, bytes(500, 5)); // versão diferente aqui, nunca sincronizada
    disk.put(`${D}/project/img/b.png`, bytes(2000, 6)); // só neste PC
    disk.put(`${D}/docs/ref.png`, bytes(100, 7)); // fora do projeto
    disk.put(`${D}/project/.godot/imported/b.png-123.ctex`, bytes(10));

    mirror = new AssetMirror({
      roomId: "r1",
      dir: D,
      kind: "godot",
      me: { uid: "u1", name: "P1", kind: "claude" },
      canEdit: true,
      projects: () => ["project"],
      toast: (_k, t) => void toasts.push(t),
      activity: async () => {},
    });
    await mirror.start();
    await idle(() => assetView().synced >= 3 && !!fileBytes("project/sfx/a.ogg"));
    expect(Buffer.from(fileBytes("project/sfx/a.ogg")!).equals(Buffer.from(som))).toBe(true);
    // conflito no primeiro contato: vale a da sala, a daqui foi para .gfs/backup
    expect(Buffer.from(fileBytes("project/sfx/c.ogg")!).equals(Buffer.from(conflito))).toBe(true);
    expect(Buffer.from(disk.files.get(`${D}/.gfs/backup/project/sfx/c.ogg`)!.b as Uint8Array).equals(Buffer.from(bytes(500, 5)))).toBe(true);
    expect(toasts.some((t) => t.includes(".gfs/backup/project/sfx/c.ogg"))).toBe(true);
    expect((await manOf("project/img/b.png"))?.uid).toBe("u1");
    expect(await manOf("docs/ref.png")).toBeUndefined();
    expect([...fake.store.keys()].some((k) => k.includes("ctex"))).toBe(false);
    expect([...disk.files.keys()].some((k) => k.includes(".gfs/tmp/"))).toBe(false); // .part renomeado

    // eco: o vigia avisa do arquivo que acabou de chegar → nada sobe
    const writes = fake.counts.setDoc;
    mirror.onDisk("project/sfx/a.ogg");
    await new Promise((r) => setTimeout(r, 2300));
    expect(fake.counts.setDoc).toBe(writes);
    expect((await manOf("project/sfx/a.ogg"))?.uid).toBe("u2");
  });

  it("mudou aqui → sobe; mudou lá → baixa; pedaço adulterado → não grava", { timeout: 20_000 }, async () => {
    const novo = bytes(700, 11);
    disk.put(`${D}/project/sfx/a.ogg`, novo);
    mirror.onDisk("project/sfx/a.ogg");
    await idle(() => assetView().recent.some((i) => i.path === "project/sfx/a.ogg" && i.state === "ok" && !!i.note?.startsWith("enviado")));
    const m = await manOf("project/sfx/a.ogg");
    expect(m?.uid).toBe("u1");
    expect(m?.sha256).toBe(await sha256Hex(novo));

    const them = { uid: "u2", name: "P2", kind: "claude" as const };
    const dela = bytes(3000, 12);
    await uploadAsset("r1", them, "project/img/b.png", dela, (await manOf("project/img/b.png"))!.sha256);
    await idle(() => Buffer.from(fileBytes("project/img/b.png") ?? []).equals(Buffer.from(dela)));

    // manifesto novo cujo pedaço foi adulterado: o arquivo daqui fica como estava
    const ruim = bytes(400, 13);
    const sha = await sha256Hex(ruim);
    fake.store.set(`rooms/r1/abin/${sha}~0`, { i: 0, data: { toUint8Array: () => bytes(400, 14) } });
    const antes = fileBytes("project/img/b.png");
    fake.put(`rooms/r1/assets/${await assetDocId("project/img/b.png")}`, { path: "project/img/b.png", sha256: sha, size: 400, parts: 1, uid: "u2", name: "P2", ts: { toMillis: () => Date.now() } });
    await idle(() => assetView().recent.some((i) => i.path === "project/img/b.png" && i.state === "erro"));
    expect(fileBytes("project/img/b.png")).toBe(antes);

    await mirror.stop();
    const st = JSON.parse(disk.files.get(`${D}/.gfs/assets.json`)!.b as string);
    expect(st.roomId).toBe("r1");
    expect(st.files["project/sfx/a.ogg"].sha).toBe(await sha256Hex(novo));
  });
});
