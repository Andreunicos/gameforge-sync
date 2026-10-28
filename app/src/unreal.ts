// Salas Unreal, lado do PC: "Conectar Unreal" (engine instalada, .mcp.json, editor com o MCP oficial e o Multi-User,
// servidor do Multi-User de quem hospeda) e a presença do editor: o script Content/Python/gameforge_presence.py do
// projeto (na raiz da sala ou numa subpasta) escreve no .gfs/ue-presence.json da sala o mapa aberto, a seleção e o que foi modificado; o app publica a seleção na
// presença (Realtime Database, não gasta gravação do Firestore) e reserva sozinho, por pouco tempo, o que foi modificado.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { autoClaim, claimKey, hhmm, overlaps, type Claim } from "./claims";
import { UE_PROJECT_SKIP } from "./sync/fileKinds";
import type { RoomSync } from "./sync/roomSync";
import type { Author, Presence } from "./types";

export interface Engine {
  root: string;
  version: string;
}

export interface UeStatus {
  mcp: boolean;
  server: boolean;
}

/** Configuração desta sala NESTE PC (endereços mudam de máquina para máquina: nada disso vai para a sala). */
export interface UeSettings {
  root: string;
  mcpPort: number;
  multi: boolean;
  server: string;
  session: string;
  /** IP:porta do servidor do Multi-User para quem está em outra rede (VPN). Vazio = rede local. */
  addr: string;
  /** Só para quem hospeda em VPN: IP:porta fixa deste PC. Vazio = rede local. */
  unicast: string;
  /** Pasta do projeto escolhida quando a sala tem mais de um .uproject (relativa à sala, "" = raiz). */
  project?: string;
}

/** O que o script do editor escreve em .gfs/ue-presence.json. */
export interface UeSnap {
  map: string;
  sel: { l: string; p: string; n: string }[];
  dirty: string[];
  more: number;
  /** Editor conectado numa sessão do Multi-User (script novo; ausente = script antigo, tratado como fora de sessão). */
  mu: boolean;
}

/** Plugins que a sala precisa no .uproject (nomes dos .uplugin da 5.8). */
export const UE_PLUGINS = ["PythonScriptPlugin", "ModelContextProtocol", "AllToolsets", "MultiUserClient"];
export const DEFAULT_MCP_PORT = 8000; // padrão do Unreal MCP (Editor Preferences > Model Context Protocol)
const STALE_S = 30; // o script dá sinal de vida a cada 10 s
const AUTO_MS = 30 * 60_000; // reserva automática: 30 min, renovada enquanto o asset continua modificado
const AUTO_RENEW_MS = 10 * 60_000;
const AUTO_PER_MIN = 10; // teto de gravações automáticas (a cota do Firestore é de 20 mil/dia para todo mundo)
const AUTO_PER_SESSION = 300;

/** O app instalado é anterior a estes comandos (a tela vem do site; o Rust vem da versão instalada). */
// Mensagens do Tauri 2 (webview/mod.rs, ipc/authority.rs) e do open_with antigo para ferramenta que ele não conhece.
export const isOldApp = (e: unknown) => /command \S+ not (found|allowed)|command not found|not allowed on (window|origin)|ferramenta desconhecida/i.test(String(e));

/** Nome que vai na linha de comando do Unreal: sem acento nem espaço (espaço cortaria o valor). */
export function ueName(s: string, max = 32): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, max) || "GameForge"
  );
}

export const mapName = (pkg: string) => pkg.slice(pkg.lastIndexOf("/") + 1);

// ── configuração local ───────────────────────────────────────────────────

/**
 * Porta do MCP de uma sala neste PC: a que ela já usa; senão a menor a partir da 8000 que nenhuma outra sala Unreal
 * deste PC usa (dois projetos abertos na mesma porta = o .mcp.json de uma sala falaria com o editor da outra).
 * Duas salas gravadas com a mesma porta (versões antigas davam 8000 a todas): fica com a de menor id, a outra muda.
 */
export function pickMcpPort(roomId: string, saved: Record<string, number | undefined>): number {
  const others = Object.entries(saved).filter(([id, p]) => id !== roomId && typeof p === "number") as [string, number][];
  const mine = saved[roomId];
  if (mine && !others.some(([id, p]) => p === mine && id < roomId)) return mine;
  const used = new Set(others.map(([, p]) => p));
  let p = DEFAULT_MCP_PORT;
  while (used.has(p)) p++;
  return p;
}

/** Portas do MCP gravadas por todas as salas Unreal deste PC (localStorage gfs-ue-<sala>). */
function savedMcpPorts(): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("gfs-ue-")) continue;
      try {
        out[k.slice(7)] = Number(JSON.parse(localStorage.getItem(k) ?? "{}").mcpPort) || undefined;
      } catch {
        /* configuração estragada: ignora */
      }
    }
  } catch {
    /* sem storage */
  }
  return out;
}

export function loadSettings(roomId: string, roomSlugName: string): UeSettings {
  const d: UeSettings = { root: "", mcpPort: DEFAULT_MCP_PORT, multi: false, server: "gameforge", session: ueName(roomSlugName, 60), addr: "", unicast: "" };
  let s = d;
  try {
    s = { ...d, ...JSON.parse(localStorage.getItem(`gfs-ue-${roomId}`) ?? "{}") };
  } catch {
    return d;
  }
  const port = pickMcpPort(roomId, savedMcpPorts());
  if (port !== s.mcpPort || !localStorage.getItem(`gfs-ue-${roomId}`)) {
    s = { ...s, mcpPort: port };
    saveSettings(roomId, s); // grava já: a próxima sala que abrir vê esta porta ocupada
  }
  return s;
}

export function saveSettings(roomId: string, s: UeSettings) {
  try {
    localStorage.setItem(`gfs-ue-${roomId}`, JSON.stringify(s));
  } catch {
    /* sem storage: só não lembra */
  }
}

/** Engine para o projeto: a escolhida antes; senão a da versão do .uproject (EngineAssociation "5.8"); senão a mais nova. */
export function pickEngine(engines: Engine[], saved: string, association: string): Engine | undefined {
  const num = (v: string) => v.split(".").map(Number);
  const newest = [...engines].sort((a, b) => {
    const [x, y] = [num(a.version), num(b.version)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return (
    engines.find((e) => e.root.toLowerCase() === saved.toLowerCase()) ??
    newest.find((e) => association && (e.version + ".").startsWith(association + ".")) ??
    newest[0]
  );
}

// ── projeto ──────────────────────────────────────────────────────────────

/**
 * Pastas da sala com .uproject (relativas, "" = raiz), a partir dos caminhos dos arquivos da sala: a raiz e subpastas até
 * 2 níveis (o Unreal cria o projeto numa pasta com o nome dele), fora das pastas geradas e das com ponto. Mesmas regras
 * da busca do Rust (projects em unreal.rs), que confere a escolha no disco. Raiz primeiro.
 */
export function projectDirs(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!/\.uproject$/i.test(p)) continue;
    const segs = p.split("/").slice(0, -1);
    if (segs.length <= 2 && !segs.some((s) => !s || s.startsWith(".") || UE_PROJECT_SKIP.test(s))) out.add(segs.join("/"));
  }
  return [...out].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

/** Qual projeto usar: o escolhido neste PC (se ainda existe), senão o da raiz, senão o único. null = nenhum; undefined = vários, a pessoa escolhe. */
export function pickProject(dirs: string[], saved?: string): string | null | undefined {
  if (!dirs.length) return null;
  if (saved !== undefined && dirs.includes(saved)) return saved;
  if (dirs.includes("")) return "";
  return dirs.length === 1 ? dirs[0] : undefined;
}

/** O projeto desta sala neste PC, pelos caminhos dos arquivos da sala (com a escolha salva no 🔌 Conectar Unreal). */
export function roomProject(roomId: string, paths: string[]): string | null | undefined {
  let saved: string | undefined;
  try {
    const p = JSON.parse(localStorage.getItem(`gfs-ue-${roomId}`) ?? "{}").project;
    if (typeof p === "string") saved = p;
  } catch {
    /* sem storage ou configuração estragada */
  }
  return pickProject(projectDirs(paths), saved);
}

export interface Uproject {
  /** Nome do arquivo (TesteUnreal.uproject). */
  file: string;
  /** Caminho relativo à sala (TesteUnreal/TesteUnreal.uproject). */
  path: string;
  association: string;
  missing: string[];
}

/** O .uproject da pasta do projeto (`project` relativa à sala, "" = raiz; null se não tem) e quais plugins da sala faltam nele. */
export async function readUproject(dir: string, project: string): Promise<Uproject | null> {
  const pdir = project ? await join(dir, ...project.split("/")) : dir;
  const files = (await readDir(pdir)).filter((e) => e.isFile && /\.uproject$/i.test(e.name));
  if (files.length === 0) return null;
  if (files.length > 1) throw new Error(`Há mais de um .uproject em ${project || "pasta da sala"}: deixe só um.`);
  const file = files[0].name;
  const path = project ? `${project}/${file}` : file;
  let p: { EngineAssociation?: string; Plugins?: { Name: string; Enabled: boolean }[] };
  try {
    p = JSON.parse(await readTextFile(await join(pdir, file)));
  } catch {
    throw new Error(`${path} não é um JSON válido (marcadores de conflito <<<<<<< dentro dele?).`);
  }
  const on = new Set((p.Plugins ?? []).filter((x) => x.Enabled).map((x) => x.Name));
  return { file, path, association: p.EngineAssociation ?? "", missing: UE_PLUGINS.filter((n) => !on.has(n)) };
}

/** Liga no .uproject (`path` relativo à sala) os plugins que faltam. O .uproject sincroniza: vale para a sala toda. */
export async function enablePlugins(dir: string, path: string) {
  const f = await join(dir, ...path.split("/"));
  const p = JSON.parse(await readTextFile(f)) as { Plugins?: { Name: string; Enabled: boolean }[] };
  const list = (p.Plugins ??= []);
  for (const name of UE_PLUGINS) {
    const it = list.find((x) => x.Name === name);
    if (it) it.Enabled = true;
    else list.push({ Name: name, Enabled: true });
  }
  await writeTextFile(f, JSON.stringify(p, null, "\t") + "\n"); // tabulação, como o editor grava
}

/**
 * .mcp.json na raiz da sala, no formato do `ModelContextProtocol.GenerateClientConfig ClaudeCode` da 5.8
 * (ModelContextProtocolClientConfig.cpp): entrada "unreal-mcp" com type http. Mantém os outros servidores do arquivo.
 * Começa com ponto: não sincroniza (a porta é deste PC).
 */
export async function writeMcpJson(dir: string, port: number) {
  const f = await join(dir, ".mcp.json");
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  if (await exists(f)) {
    try {
      cfg = JSON.parse(await readTextFile(f));
    } catch {
      throw new Error(".mcp.json da pasta da sala não é um JSON válido: conserte ou apague o arquivo e tente de novo.");
    }
  }
  cfg.mcpServers = { ...cfg.mcpServers, "unreal-mcp": { type: "http", url: `http://127.0.0.1:${port}/mcp` } };
  await writeTextFile(f, JSON.stringify(cfg, null, 2) + "\n");
}

// ── comandos do app (Rust) ───────────────────────────────────────────────

export const findEngines = (extra: string) => invoke<Engine[]>("unreal_engines", { extra: extra || null });
export const ueStatus = (dir: string, mcpPort: number) => invoke<UeStatus>("unreal_status", { dir, mcpPort });

// `project` = pasta do projeto relativa à sala: o Rust só aceita se ela for uma das que ele mesmo acha na sala.
export function openEditor(dir: string, s: UeSettings, displayName: string, project: string) {
  const concert = s.multi ? { server: s.server, session: s.session, displayName: ueName(displayName), staticAddr: s.addr.trim() } : null;
  return invoke<string>("unreal_open", { dir, root: s.root, mcpPort: s.mcpPort, concert, project });
}

export const startServer = (dir: string, s: UeSettings, project: string) =>
  invoke<void>("unreal_server_start", { dir, root: s.root, server: s.server, session: s.session, unicast: s.unicast.trim(), project });
export const stopServer = (dir: string) => invoke<void>("unreal_server_stop", { dir });

// ── presença do editor + reserva automática ──────────────────────────────

async function readSnap(dir: string): Promise<UeSnap | null> {
  try {
    const raw = JSON.parse(await readTextFile(await join(dir, ".gfs", "ue-presence.json")));
    if (raw.off || !(Date.now() / 1000 - Number(raw.t) < STALE_S)) return null;
    return {
      map: String(raw.map ?? ""),
      sel: Array.isArray(raw.sel)
        ? raw.sel.filter((x: { l?: unknown; p?: unknown; n?: unknown }) => typeof x?.l === "string" && typeof x?.p === "string" && typeof x?.n === "string")
        : [],
      dirty: Array.isArray(raw.dirty) ? raw.dirty.filter((x: unknown) => typeof x === "string") : [],
      more: Number(raw.more) || 0,
      mu: raw.mu === true,
    };
  } catch {
    return null; // editor fechado, script desligado, ou arquivo sendo trocado
  }
}

/** O editor deste projeto está aberto? (o script de presença deu sinal de vida há menos de 30 s) */
export const editorAlive = async (dir: string) => (await readSnap(dir)) !== null;

/**
 * Lê o que o editor desta pessoa manda (a cada 2 s), publica mapa + seleção na presença e reserva sozinho o que
 * ela modificou (30 min, renovada enquanto continua modificado). Avisa se o modificado está reservado por outra
 * pessoa ou se outra pessoa está com o mesmo ator selecionado.
 */
export function useUnrealLive(roomId: string, sync: RoomSync, me: Author, dir: string | undefined, claims: Claim[], people: Presence[]) {
  const [snap, setSnap] = useState<UeSnap | null>(null);
  const claimsRef = useRef(claims);
  claimsRef.current = claims;
  const peopleRef = useRef(people);
  peopleRef.current = people;

  useEffect(() => {
    if (!dir) return;
    let alive = true;
    let last = "";
    const warned = new Set<string>();
    const skipUntil = new Map<string, number>(); // chave → não tentar de novo antes disso
    const sent: number[] = []; // horários das reservas automáticas do último minuto
    let total = 0;
    let chain: Promise<void> = Promise.resolve();
    const warn = (id: string, kind: "warn" | "error", text: string) => {
      if (warned.has(id)) return;
      warned.add(id);
      sync.onToast({ kind, text });
    };

    const claimDirty = (s: UeSnap) => {
      const now = Date.now();
      const list = claimsRef.current;
      if (s.mu) {
        // Em sessão do Multi-User, o que OUTRA pessoa muda também fica "modificado" neste editor (a transação remota
        // chama Modify()): reservar sozinho tomaria o asset de quem mexeu de verdade. Até o teste com 2 editores, só avisa.
        if (s.dirty.length) {
          warn("mu", "warn", "Você está numa sessão do Multi-User: a reserva automática fica desligada (o que os outros mudam também aparece como modificado aqui). Reserve no 🔒 Unreal o que for mexer.");
        }
        for (const pkg of s.dirty) {
          const k = claimKey(pkg);
          const other = k && list.find((c) => c.uid !== me.uid && c.exp > now && overlaps(c.key, k.key));
          if (k && other) {
            warn(`mu|${k.key}|${other.uid}|${other.exp}`, "warn", `${k.path} está modificado no seu Unreal e reservado por ${other.name} até ${hhmm(other.exp)}. Se a mudança foi sua, fale com ${other.name}; se veio de ${other.name} pela sessão, tudo certo.`);
          }
        }
        return;
      }
      if (s.more > 0) warn("more", "warn", `Há ${s.dirty.length + s.more} assets modificados no Unreal: só ${s.dirty.length} são reservados sozinhos. Reserve a pasta no 🔒 Unreal.`);
      for (const pkg of s.dirty) {
        const k = claimKey(pkg);
        if (!k || (skipUntil.get(k.key) ?? 0) > now) continue;
        const other = list.find((c) => c.uid !== me.uid && c.exp > now && overlaps(c.key, k.key));
        if (other) {
          warn(`${k.key}|${other.uid}|${other.exp}`, "error", `Você modificou ${k.path} no Unreal, mas ${other.name} reservou até ${hhmm(other.exp)}. NÃO salve: desfaça (Ctrl+Z) ou fale com ${other.name}.`);
          continue;
        }
        if (list.some((c) => c.uid === me.uid && c.exp - now > AUTO_RENEW_MS && overlaps(c.key, k.key))) continue;
        while (sent.length && sent[0] < now - 60_000) sent.shift();
        if (sent.length >= AUTO_PER_MIN) return; // volta no próximo ciclo
        if (total >= AUTO_PER_SESSION) {
          warn("budget", "warn", "Muitas reservas automáticas nesta sessão: parei de reservar sozinho. Reserve as pastas no 🔒 Unreal.");
          return;
        }
        sent.push(now);
        total++;
        skipUntil.set(k.key, now + 60_000); // dá tempo da tabela nova chegar pelo listener
        const label = s.sel.find((x) => x.p === pkg)?.l;
        chain = chain
          .then(() => autoClaim(roomId, me, pkg, `auto: ${label ?? "modificado no Unreal"}`, AUTO_MS))
          .then((o) => {
            if (o) warn(`${o.key}|${o.uid}|${o.exp}`, "error", `Você modificou ${k.path} no Unreal, mas ${o.name} reservou até ${hhmm(o.exp)}. NÃO salve: fale com ${o.name}.`);
          })
          .catch((e) => console.warn("reserva automática:", k.path, e));
      }
    };

    const sameSelection = (s: UeSnap) => {
      const mine = new Set(s.sel.map((x) => x.n));
      for (const p of peopleRef.current) {
        if (p.uid === me.uid) continue;
        for (const x of p.ue?.sel ?? []) {
          if (mine.has(x.n)) warn(`sel|${p.uid}|${x.n}`, "warn", `${p.name} também está com ${x.l} selecionado no Unreal. Combinem quem mexe.`);
        }
      }
    };

    const tick = async () => {
      const s = await readSnap(dir);
      if (!alive) return;
      if (s) {
        claimDirty(s);
        sameSelection(s);
      }
      const key = JSON.stringify(s);
      if (key === last) return;
      last = key;
      setSnap(s);
      sync.setUnreal({ ue: s && { map: s.map, sel: s.sel.map((x) => ({ l: x.l.slice(0, 80), n: x.n.slice(0, 300) })) } });
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
      sync.setUnreal({ ue: null });
    };
  }, [roomId, sync, me.uid, me.name, me.kind, dir]); // eslint-disable-line react-hooks/exhaustive-deps

  return snap;
}

/** Seção do .gfs/ASSETS.md: o que cada pessoa tem selecionado no editor agora (vazio = ninguém com o editor ligado). */
export function selectionMd(people: Presence[], meUid: string): string {
  const rows = people
    .filter((p) => p.ue)
    .map((p) => {
      const sel = (p.ue!.sel ?? []).map((x) => x.l).join(", ") || "nada selecionado";
      return p.uid === meUid
        ? `- VOCÊ (sua pessoa) · mapa ${mapName(p.ue!.map) || "?"}: ${sel}`
        : `- ${p.name} · mapa ${mapName(p.ue!.map) || "?"}: ${sel} (NÃO mexa nesses atores sem combinar)`;
    });
  return rows.length ? `\n## Agora no editor Unreal (seleção ao vivo)\n${rows.join("\n")}\n` : "";
}
