// gfs — liga o Claude Code a uma sala do GameForge Sync.
// Regra de ouro: nenhum comando imprime arquivo inteiro, só resumos curtos (economia de token).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { login, logout, session, type Session } from "./auth.ts";
import { commit, data, FsError, getDoc, presence, runQuery } from "./firestore.ts";
import { hasConflictMarkers, merge3 } from "./merge.ts";
import { Workspace, type FileState } from "./workspace.ts";
import { ROOM_CLAUDE_MD, ROOM_GAME_MD } from "./templates.ts";
import { INSTALL_CMD, LATEST_JSON, MAX_FILE_BYTES, VERSION } from "./config.ts";

interface Author {
  uid: string;
  name: string;
  kind: "human" | "claude";
}
interface RemoteFile {
  path: string;
  content: string;
  version: number;
  author: Author;
}
interface RoomData {
  name: string;
  roles: Record<string, string>;
  memberIds: string[];
}

const filePath = (roomId: string, path: string) => `rooms/${roomId}/files/${encodeURIComponent(path)}`;
const me = (s: Session): Author => ({ uid: s.uid, name: s.name, kind: "claude" });
const who = (a?: Author) => (!a ? "?" : a.kind === "claude" ? `Claude de ${a.name}` : a.name);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** Volta uns segundos no lastSync para não perder gravação que estava chegando. */
const since = (iso: string) => new Date(new Date(iso).getTime() - 5000).toISOString();

async function loadRoom(roomId: string, s: Session) {
  const doc = await getDoc(`rooms/${roomId}`);
  if (!doc) throw new Error("sala não encontrada, ou você não é membro dela");
  const room = data<RoomData>(doc);
  const role = room.roles?.[s.uid] ?? "viewer";
  return { room, role };
}

function roleLabel(role: string) {
  return { owner: "dono", editor: "editor", viewer: "espectador" }[role] ?? role;
}

/** Mostra só os trechos em conflito, com número de linha (nunca o arquivo inteiro). */
function conflictHunks(path: string, text: string, max = 40): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (!lines[i].startsWith("<<<<<<< ")) continue;
    let j = i;
    while (j < lines.length && !lines[j].startsWith(">>>>>>> ")) j++;
    out.push(`  ${path}:${i + 1}-${j + 1}`);
    for (let k = i; k <= j && out.length < max; k++) out.push(`  ${String(k + 1).padStart(5)}| ${lines[k]}`);
    i = j;
  }
  return out.join("\n");
}

type WriteResult =
  | { kind: "ok" | "merged"; version: number }
  | { kind: "conflict"; count: number; with: string };

/**
 * Grava um arquivo na sala só se a versão remota ainda for a base local
 * (precondição de updateTime). Se outra pessoa gravou antes, faz merge de 3 vias.
 */
async function writeRemote(ws: Workspace, s: Session, path: string, content: string): Promise<WriteResult> {
  const roomId = ws.state.roomId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const base: FileState | undefined = ws.state.files[path];
    const doc = await getDoc(filePath(roomId, path));
    const remote = doc ? data<RemoteFile>(doc) : null;
    let text = content;
    let merged = false;

    if (remote && remote.version !== (base?.version ?? 0)) {
      const m = merge3(base ? ws.readBase(path) : "", content, remote.content, who(remote.author));
      if (m.conflicts > 0) {
        ws.writeLocal(path, m.text);
        ws.setBase(path, remote.content, { version: remote.version, updateTime: doc!.updateTime! });
        return { kind: "conflict", count: m.conflicts, with: who(remote.author) };
      }
      text = m.text;
      merged = true;
    }

    const version = (remote?.version ?? 0) + 1;
    try {
      const r = await commit([
        {
          path: filePath(roomId, path),
          fields: { path, content: text, version, author: me(s) },
          serverTime: ["updatedAt"],
          precondition: doc ? doc.updateTime : "missing",
        },
      ]);
      ws.setBase(path, text, { version, updateTime: r.writeResults[0]?.updateTime ?? r.commitTime });
      if (merged) ws.writeLocal(path, text);
      return { kind: merged ? "merged" : "ok", version };
    } catch (e) {
      // Alguém gravou entre a leitura e a gravação: tenta de novo com a versão nova.
      if (e instanceof FsError && [400, 404, 409].includes(e.status) && e.code !== "PERMISSION_DENIED") continue;
      throw e;
    }
  }
  throw new Error(`${path}: a sala mudou várias vezes seguidas, tente de novo`);
}

async function logActivity(roomId: string, s: Session, file: string, summary: string) {
  await commit([
    {
      path: `rooms/${roomId}/activity/${crypto.randomUUID().replace(/-/g, "")}`,
      fields: { author: me(s), kind: "edit", file, summary: summary.slice(0, 300) },
      serverTime: ["ts"],
      precondition: "missing",
    },
  ]).catch(() => {});
}

// ── comandos ───────────────────────────────────────────────────────────────

async function cmdLogin() {
  const s = await login();
  console.log(`✓ logado como ${s.name} (${s.email}). Suas mudanças aparecem como "Claude de ${s.name}".`);
}

async function cmdWhoami() {
  const s = await session();
  console.log(`${s.name} (${s.email})`);
}

async function cmdRooms() {
  const s = await session();
  const { docs } = await runQuery("", {
    from: [{ collectionId: "rooms" }],
    where: { fieldFilter: { field: { fieldPath: "memberIds" }, op: "ARRAY_CONTAINS", value: { stringValue: s.uid } } },
  });
  if (!docs.length) return console.log("Nenhuma sala. Crie uma no app.");
  for (const d of docs) {
    const r = data<RoomData>(d);
    console.log(`${d.name.split("/").pop()}  ${r.name} (${roleLabel(r.roles?.[s.uid])})`);
  }
  console.log("Para baixar: gfs clone <id>");
}

function slug(name: string) {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "sala"
  );
}

async function cmdClone(roomId: string | undefined, folder: string | undefined) {
  if (!roomId) throw new Error("uso: gfs clone <id-da-sala> [pasta]   (veja os ids com: gfs rooms)");
  const s = await session();
  const { room, role } = await loadRoom(roomId, s);
  const root = resolve(folder ?? slug(room.name));
  if (existsSync(root) && readdirSync(root).length > 0) {
    if (existsSync(join(root, ".gfs", "state.json"))) throw new Error(`${root} já é uma sala. Entre nela e use gfs pull.`);
    throw new Error(`a pasta ${root} já existe e não está vazia`);
  }
  mkdirSync(root, { recursive: true });

  const { docs, readTime } = await runQuery(`rooms/${roomId}`, { from: [{ collectionId: "files" }] });
  const ws = Workspace.create(root, { roomId, roomName: room.name, lastSync: readTime, files: {} });
  for (const d of docs) {
    const f = data<RemoteFile>(d);
    ws.writeLocal(f.path, f.content);
    ws.setBase(f.path, f.content, { version: f.version, updateTime: d.updateTime! });
  }

  // Toda sala ganha as regras do Claude e a visão do jogo.
  const added: string[] = [];
  if (role !== "viewer") {
    for (const [path, text] of [
      ["CLAUDE.md", ROOM_CLAUDE_MD],
      ["GAME.md", ROOM_GAME_MD],
    ] as const) {
      if (ws.state.files[path]) continue;
      ws.writeLocal(path, text);
      const r = await writeRemote(ws, s, path, text);
      if (r.kind !== "conflict") added.push(path);
    }
    if (added.length) await logActivity(roomId, s, added[0], `adicionou ${added.join(" e ")} à sala`);
  }
  ws.save();

  console.log(`✓ "${room.name}" baixada em ${root} (${docs.length} arquivo${docs.length === 1 ? "" : "s"}, você: ${roleLabel(role)})`);
  if (added.length) console.log(`  + criou ${added.join(" e ")} na sala (regras do Claude e visão do jogo)`);
  console.log(`  Próximo: cd "${root}" e abra o Claude Code nessa pasta.`);
}

async function cmdStatus() {
  const ws = Workspace.find();
  const s = await session();
  const roomId = ws.state.roomId;
  const [{ room, role }, people, changed] = await Promise.all([
    loadRoom(roomId, s),
    presence(roomId),
    runQuery(`rooms/${roomId}`, {
      from: [{ collectionId: "files" }],
      select: { fields: [{ fieldPath: "path" }, { fieldPath: "version" }, { fieldPath: "author" }] },
      where: { fieldFilter: { field: { fieldPath: "updatedAt" }, op: "GREATER_THAN", value: { timestampValue: since(ws.state.lastSync) } } },
    }),
  ]);

  console.log(`Sala "${room.name}" · você: Claude de ${s.name} (${roleLabel(role)})`);
  console.log(`No app agora: ${people.length ? people.map((p) => `${p.name}${p.file ? ` (${p.file})` : ""}`).join(", ") : "ninguém"}`);

  const remote = changed.docs
    .map((d) => data<{ path: string; version: number; author: Author }>(d))
    .filter((f) => (ws.state.files[f.path]?.version ?? 0) < f.version);
  if (remote.length) {
    console.log(`Mudou na sala desde seu último pull (${remote.length}):`);
    for (const f of remote.slice(0, 8)) console.log(`  ${f.path} v${f.version} — ${who(f.author)}`);
    if (remote.length > 8) console.log(`  … e mais ${remote.length - 8}`);
    console.log("  → rode: gfs pull");
  } else {
    console.log("Sala: nada novo desde seu último pull.");
  }

  const { changed: mine, added, removed } = ws.changes();
  if (mine.length + added.length + removed.length === 0) console.log("Local: nada alterado.");
  else {
    if (mine.length) console.log(`Local alterado: ${mine.join(", ")}`);
    if (added.length) console.log(`Local novo: ${added.join(", ")}`);
    if (removed.length) console.log(`Apagado aqui (o gfs não apaga na sala): ${removed.join(", ")}`);
  }
}

async function cmdPull() {
  const ws = Workspace.find();
  await session();
  const roomId = ws.state.roomId;
  const [files, activity] = await Promise.all([
    runQuery(`rooms/${roomId}`, {
      from: [{ collectionId: "files" }],
      where: { fieldFilter: { field: { fieldPath: "updatedAt" }, op: "GREATER_THAN", value: { timestampValue: since(ws.state.lastSync) } } },
    }),
    runQuery(`rooms/${roomId}`, {
      from: [{ collectionId: "activity" }],
      where: { fieldFilter: { field: { fieldPath: "ts" }, op: "GREATER_THAN", value: { timestampValue: since(ws.state.lastSync) } } },
      orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }],
      limit: 100,
    }),
  ]);

  const lines: string[] = [];
  const conflicts: string[] = [];
  for (const d of files.docs) {
    const f = data<RemoteFile>(d);
    const known = ws.state.files[f.path];
    if (known && known.version >= f.version) continue; // eco do meu push
    const local = ws.readLocal(f.path);
    const base = known ? ws.readBase(f.path) : null;
    const fs = { version: f.version, updateTime: d.updateTime! };

    if (local === null || local === base || local === f.content) {
      ws.writeLocal(f.path, f.content);
      ws.setBase(f.path, f.content, fs);
      lines.push(`  ${known ? "atualizado" : "novo"}: ${f.path} v${f.version} (${who(f.author)})`);
      continue;
    }
    const m = merge3(base ?? "", local, f.content, who(f.author));
    ws.writeLocal(f.path, m.text);
    ws.setBase(f.path, f.content, fs);
    if (m.conflicts) {
      lines.push(`  CONFLITO: ${f.path} (${m.conflicts}x com ${who(f.author)})`);
      conflicts.push(conflictHunks(f.path, m.text));
    } else lines.push(`  juntado com suas mudanças: ${f.path} v${f.version} (${who(f.author)})`);
  }

  // Arquivos apagados na sala (o feed de atividade avisa).
  for (const d of activity.docs) {
    const ev = data<{ kind: string; file?: string }>(d);
    if (ev.kind !== "delete" || !ev.file || !ws.state.files[ev.file]) continue;
    if (await getDoc(filePath(roomId, ev.file))) continue; // recriado depois
    const local = ws.readLocal(ev.file);
    if (local === null || local === ws.readBase(ev.file)) {
      ws.deleteLocal(ev.file);
      lines.push(`  apagado na sala: ${ev.file}`);
    } else lines.push(`  apagado na sala, mas você tinha mudanças (mantido local, vira arquivo novo no push): ${ev.file}`);
    ws.dropBase(ev.file);
  }

  ws.state.lastSync = files.readTime;
  ws.save();
  console.log(lines.length ? `✓ pull:\n${lines.join("\n")}` : "✓ pull: nada novo.");
  if (conflicts.length) console.log(`Resolva estes trechos e rode gfs push:\n${conflicts.join("\n")}`);
}

async function cmdPush(message: string | undefined) {
  const ws = Workspace.find();
  const s = await session();
  const roomId = ws.state.roomId;
  const { role } = await loadRoom(roomId, s);
  if (role === "viewer") throw new Error("você é espectador nesta sala: não pode enviar mudanças");

  const { changed, added, removed } = ws.changes();
  const todo = [...changed, ...added];
  if (!todo.length) {
    console.log("Nada para enviar.");
    if (removed.length) console.log(`Apagado aqui (o gfs não apaga na sala; peça ao dono): ${removed.join(", ")}`);
    return;
  }

  const sent: string[] = [];
  const out: string[] = [];
  const conflicts: string[] = [];
  for (const path of todo) {
    const content = ws.readLocal(path)!;
    if (hasConflictMarkers(content)) {
      out.push(`  ✗ ${path}: ainda tem marcadores de conflito (<<<<<<< >>>>>>>)`);
      conflicts.push(conflictHunks(path, content));
      continue;
    }
    if (bytes(content) > MAX_FILE_BYTES) {
      out.push(`  ✗ ${path}: maior que 900 KB, não cabe na sala (divida o arquivo)`);
      continue;
    }
    const r = await writeRemote(ws, s, path, content);
    if (r.kind === "conflict") {
      out.push(`  CONFLITO: ${path} (${r.count}x com ${r.with}) — não enviado`);
      conflicts.push(conflictHunks(path, ws.readLocal(path) ?? ""));
    } else {
      sent.push(path);
      out.push(`  ✓ ${path} v${r.version}${r.kind === "merged" ? " (juntado com a versão de outra pessoa)" : ""}`);
    }
  }
  ws.save();

  if (sent.length) await logActivity(roomId, s, sent[0], `${message?.trim() || "atualizou o código"} — ${sent.join(", ")}`);
  console.log(`${sent.length ? "✓" : "✗"} push: ${sent.length}/${todo.length} enviado(s). Quem está no app vê em segundos.`);
  console.log(out.join("\n"));
  if (removed.length) console.log(`Apagado aqui (o gfs não apaga na sala; peça ao dono): ${removed.join(", ")}`);
  if (conflicts.length) console.log(`Resolva estes trechos e rode gfs push de novo:\n${conflicts.join("\n")}`);
}

function soon(name: string) {
  console.log(`gfs ${name}: chega na Fase 3 (reservas, chat entre Claudes e checkpoints).`);
}

const HELP = `gfs ${VERSION} — liga o Claude Code a uma sala do GameForge Sync

  gfs login              entra com a conta Google (abre o navegador)
  gfs rooms              lista suas salas e os ids
  gfs clone <id> [pasta] baixa a sala para uma pasta
  gfs status             o que mudou na sala e aqui (resumo curto)
  gfs pull               traz as mudanças da sala (merge automático)
  gfs push "mensagem"    envia só o que você mudou (merge automático)
  gfs whoami | logout

Ciclo: gfs status → gfs pull → editar e testar → gfs push "o que fez"`;

// ── atualização do próprio gfs (no máximo 1 checagem por dia) ─────────────

async function updateHint(): Promise<string | null> {
  if (VERSION === "dev") return null;
  const file = join(homedir(), ".gfs", "update.json");
  let cache: { at: number; latest: string } | null = null;
  try {
    cache = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* primeira vez */
  }
  if (!cache || Date.now() - cache.at > 86_400_000) {
    try {
      const res = await fetch(LATEST_JSON, { signal: AbortSignal.timeout(2000) });
      const latest = String(((await res.json()) as { version?: string }).version ?? VERSION);
      cache = { at: Date.now(), latest };
      mkdirSync(join(homedir(), ".gfs"), { recursive: true });
      writeFileSync(file, JSON.stringify(cache));
    } catch {
      return null;
    }
  }
  const newer = (a: string, b: string) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    return false;
  };
  return newer(cache.latest, VERSION) ? `↑ gfs ${cache.latest} disponível: ${INSTALL_CMD}` : null;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const hint = updateHint();
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "logout":
      logout();
      console.log("✓ saiu.");
      break;
    case "whoami":
      await cmdWhoami();
      break;
    case "rooms":
      await cmdRooms();
      break;
    case "clone":
      await cmdClone(args[0], args[1]);
      break;
    case "status":
      await cmdStatus();
      break;
    case "pull":
      await cmdPull();
      break;
    case "push":
      await cmdPush(args.join(" "));
      break;
    case "claim":
    case "release":
    case "say":
    case "checkpoint":
      soon(cmd);
      break;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      break;
    default:
      console.log(HELP);
  }
  const h = await hint;
  if (h) console.error(h);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

