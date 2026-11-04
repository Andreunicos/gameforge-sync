// Salas Godot 4.x: regras puras (versão, project.godot, preset Web, conversão de sala HTML5) e as chamadas ao Rust
// (src-tauri/src/godot.rs). O caminho do executável digitado fica só neste PC (localStorage), nunca no Firebase.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { hhmm, type Claim } from "./claims";
import { updateRoomSettings } from "./rooms";
import { GODOT_PROJECT_SKIP } from "./sync/fileKinds";
import { GODOT_RULES, GODOT_VERSION, ROOM_CLAUDE_MD_GODOT, ROOM_GAME_MD_GODOT, ROOM_MODELOS_MD, godotProjectTemplates } from "./sync/templates";
import type { RoomSync } from "./sync/roomSync";
import type { Room } from "./types";

export { isOldApp } from "./unreal";

export interface GodotInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  templates_dir: string | null;
  web_templates: string[];
}
export interface GodotStatus {
  running: boolean;
  port: number | null;
}
export interface ExportResult {
  ms: number;
  threads: boolean;
}

// ── regras puras ─────────────────────────────────────────────────────────

/** "4.7.2.stable.official.e8f3a1b2c" (ou "Godot Engine v4.7.2.stable...") → "4.7"; null se não parece versão. */
export function majorMinor(version: string | null | undefined): string | null {
  return /(\d+)\.(\d+)/.exec(version ?? "")?.slice(1, 3).join(".") ?? null;
}

/** Versão do projeto: o primeiro "X.Y" de config/features no project.godot (ex.: PackedStringArray("4.7", "GL Compatibility")). */
export function projectVersion(projectGodot: string | undefined): string | null {
  const line = /^\s*config\/features\s*=\s*PackedStringArray\(([^)]*)\)/m.exec(projectGodot ?? "")?.[1];
  return line ? (/"(\d+\.\d+)"/.exec(line)?.[1] ?? null) : null;
}

/** Versão que a sala exige: a gravada na sala (dono), senão a do project.godot, senão a padrão. */
export const requiredVersion = (room: Pick<Room, "godotVersion">, projectGodot?: string) =>
  room.godotVersion || projectVersion(projectGodot) || GODOT_VERSION;

/** Aviso em português leigo quando a Godot deste PC não é a da sala (null = tudo certo). */
export function versionAdvice(installed: string | null, required: string): string | null {
  const mm = majorMinor(installed);
  if (!mm) return null;
  if (mm === required) return null;
  const [a, b] = mm.split(".").map(Number);
  const [c, d] = required.split(".").map(Number);
  const older = a < c || (a === c && b < d);
  return older
    ? `Sua Godot é a ${mm}, mais velha que a ${required} da sala: o projeto pode não abrir ou perder coisas. Instale a ${required}.`
    : `Sua Godot é a ${mm}, mais nova que a ${required} da sala: ao salvar, ela pode converter as cenas e quebrar o projeto dos outros. Use a ${required} (ou combine com todos de subir a versão).`;
}

/** Última patch estável conhecida de cada linha (fallback quando a API do GitHub não responde). Conferido em 04/11/2026. */
export const KNOWN_PATCH: Record<string, string> = { "4.3": "4.3", "4.4": "4.4.1", "4.5": "4.5.2", "4.6": "4.6.3", "4.7": "4.7.2" };

/**
 * Versão a instalar para a sala ("4.7" → "4.7.2"): a maior "X.Y[.Z]-stable" entre as tags do godotengine/godot-builds,
 * senão a tabela KNOWN_PATCH, senão a própria "X.Y" (o release "4.7-stable" existe sem ".0"). "X.Y.Z" volta igual.
 */
export function installVersion(required: string, tags: string[] = []): string {
  if (/^\d+\.\d+\.\d+$/.test(required)) return required;
  let best = -1;
  for (const t of tags) {
    const m = /^(\d+\.\d+)(?:\.(\d+))?-stable$/.exec(t);
    if (m && m[1] === required) best = Math.max(best, Number(m[2] ?? 0));
  }
  if (best > 0) return `${required}.${best}`;
  if (best === 0) return required;
  return KNOWN_PATCH[required] ?? required;
}

/** Versão do release de uma Godot instalada, para baixar os templates iguais: "4.7.2.stable.official.x" → "4.7.2". Só a oficial estável sem .NET. */
export function releaseOf(version: string | null | undefined): string | null {
  const m = /^(\d+\.\d+(?:\.\d+)?)\.stable\.official\b/.exec(version ?? "");
  return m && !/\bmono\b/.test(version ?? "") ? m[1] : null;
}

/** O que o Verificar oferece: instalar a Godot (falta ou é de outra versão), só os templates, ou nada. */
export function installOffer(info: Pick<GodotInfo, "found" | "version" | "web_templates"> | null, required: string): "engine" | "templates" | null {
  if (!info) return null;
  if (!info.found || majorMinor(info.version) !== required) return "engine";
  return info.web_templates.length === 0 && releaseOf(info.version) ? "templates" : null;
}

/** Tags dos releases da Godot (API pública do GitHub, 60/h sem login). Falhou = [] e vale a tabela. */
export async function godotTags(): Promise<string[]> {
  try {
    const r = await fetch("https://api.github.com/repos/godotengine/godot-builds/releases?per_page=100", { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    return ((await r.json()) as { tag_name?: string }[]).map((x) => x.tag_name ?? "");
  } catch {
    return [];
  }
}

/** Pastas da sala com project.godot (relativas, "" = raiz), até 2 níveis, como a busca do Rust (godot.rs). Raiz primeiro. */
export function godotProjectDirs(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!/(^|\/)project\.godot$/i.test(p)) continue;
    const segs = p.split("/").slice(0, -1);
    if (segs.length <= 2 && !segs.some((s) => !s || s.startsWith(".") || GODOT_PROJECT_SKIP.test(s))) out.add(segs.join("/"));
  }
  return [...out].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

/** Tem o preset chamado exatamente "Web" no export_presets.cfg? */
export const hasWebPreset = (cfg: string | undefined) => /^\s*name\s*=\s*"Web"\s*$/m.test(cfg ?? "");

/** Texto extra do aviso de conflito: cena/recurso com marcador não abre na Godot. */
export const conflictHint = (path: string) =>
  /\.(tscn|tres|godot|cfg)$/i.test(path) ? " Enquanto os marcadores estiverem lá a Godot NÃO abre esse arquivo (a sala continua com a última versão boa)." : "";

/**
 * O que "Converter para Godot" faz numa sala HTML5: cria só o que falta (nunca sobrescreve). Projeto Godot já existente
 * (raiz ou subpasta) = não cria outro. CLAUDE.md existente ganha o bloco Godot no fim (uma vez).
 */
export function convertPlan(paths: string[], roomName: string, claudeMd: string | undefined) {
  const have = new Set(paths.map((p) => p.toLowerCase()));
  const want: [string, string][] = [
    ["CLAUDE.md", ROOM_CLAUDE_MD_GODOT],
    ["GAME.md", ROOM_GAME_MD_GODOT],
    ["MODELOS.md", ROOM_MODELOS_MD],
    ...(godotProjectDirs(paths).length ? [] : godotProjectTemplates(roomName)),
  ];
  return {
    create: want.filter(([p]) => !have.has(p.toLowerCase())),
    appendClaude: claudeMd !== undefined && !claudeMd.includes("## Godot pela linha de comando"),
  };
}

/** .gfs/CENAS.md: reservas de cena (res://...) que o Claude lê antes de mexer em .tscn/.tres. */
export function scenesMd(claims: Claim[], meUid: string, now: number): string {
  const rows = claims
    .filter((c) => c.exp > now)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((c) => `- res://${c.path} — ${c.uid === meUid ? "VOCÊ (pode mexer)" : `${c.name} (NÃO mexa)`} · até ${hhmm(c.exp)}${c.note ? ` · ${c.note.replace(/\s+/g, " ")}` : ""}`);
  return `# Reservas de cenas (Godot)
Gerado pelo app GameForge Sync (não edite; não sincroniza). Caminho terminado em / = pasta inteira. res:// = pasta do projeto.
Só mexa em .tscn/.tres reservado para VOCÊ ou sem reserva de ninguém. Se o app estiver fechado, esta lista está velha.

${rows.length ? rows.join("\n") : "Nenhuma reserva ativa."}
`;
}

// ── preview ao vivo (jogo embutido / janela / Web) ───────────────────────

export type GodotMode = "embed" | "window" | "web";
export const GODOT_MODES: [GodotMode, string][] = [
  ["embed", "Embutido (experimental)"],
  ["window", "Janela solta"],
  ["web", "Web"],
];
/** Modo guardado neste PC; desconhecido/vazio = embutido (testado no Windows com a Godot 4.7.2). */
export const parseMode = (v: string | null | undefined): GodotMode => (v === "window" || v === "web" ? v : "embed");

export interface EmbedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Retângulo da tela (CSS px) → pixels físicos da janela, como o Rust espera (área cliente = página inteira no Tauri). */
export function toPhysical(r: { left: number; top: number; width: number; height: number }, dpr: number): EmbedRect {
  const x = Math.round(r.left * dpr);
  const y = Math.round(r.top * dpr);
  return { x, y, w: Math.max(0, Math.round((r.left + r.width) * dpr) - x), h: Math.max(0, Math.round((r.top + r.height) * dpr) - y) };
}
type Box = { left: number; top: number; right: number; bottom: number };
/** A janela nativa do jogo fica por cima da página: qualquer modal/aviso que cruze a área esconde o jogo. */
export const rectsOverlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
export const COVER_SELECTOR = ".modal-back, .toasts > *";

/** Arquivos que mudam o jogo (o resto, como .md, não reinicia nada). */
const LIVE_EXT = /\.(gd|tscn|tres|gdshader|gdshaderinc|godot|uid|json|csv|cfg|gdextension)$/i;
const classNames = (s: string) => (s.match(/^\s*class_name\s+\w+/gm) ?? []).join("|");

/**
 * O que uma mudança de arquivo pede ao jogo ao vivo: nada, reiniciar, ou importar e reiniciar (arquivo novo/apagado,
 * .uid, project.godot, class_name mudou: a Godot só vê isso no cache do .godot/). Fora do projeto, pastas com ponto
 * (.godot/, .gfs/), saídas de build e export_presets.cfg não contam.
 */
export function liveChange(path: string, before: string | undefined, after: string | undefined, project: string): "none" | "restart" | "import" {
  const pre = project ? `${project}/` : "";
  if (pre && !path.toLowerCase().startsWith(pre.toLowerCase())) return "none";
  const rel = path.slice(pre.length);
  const segs = rel.split("/");
  if (segs.slice(0, -1).some((s) => s.startsWith(".") || /^(builds?|exports?)$/i.test(s))) return "none";
  if (!LIVE_EXT.test(rel) || /(^|\/)export_presets\.cfg$/i.test(rel) || segs[0].startsWith(".")) return "none";
  if (before === after) return "none";
  if (before === undefined || after === undefined || /\.(uid|godot|gdextension)$/i.test(rel)) return "import";
  if (/\.gd$/i.test(rel) && classNames(before) !== classNames(after)) return "import";
  return "restart";
}

/** Junta mudanças seguidas: roda uma vez `delay` ms depois da última, importando se alguma pediu. */
export function liveQueue(delay: number, run: (doImport: boolean) => void) {
  let t: ReturnType<typeof setTimeout> | undefined;
  let imp = false;
  return {
    push(kind: "restart" | "import") {
      if (kind === "import") imp = true;
      clearTimeout(t);
      t = setTimeout(() => {
        const i = imp;
        imp = false;
        t = undefined;
        run(i);
      }, delay);
    },
    cancel() {
      clearTimeout(t);
      t = undefined;
      imp = false;
    },
  };
}

// ── este PC ──────────────────────────────────────────────────────────────

const MODE_KEY = "gfs-godot-mode";
export function loadMode(): GodotMode {
  try {
    return parseMode(localStorage.getItem(MODE_KEY));
  } catch {
    return "embed";
  }
}
export function saveMode(m: GodotMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* sem storage: vale só nesta sessão */
  }
}

const BIN_KEY = "gfs-godot-bin";
export function loadBin(): string {
  try {
    return localStorage.getItem(BIN_KEY) ?? "";
  } catch {
    return "";
  }
}
export function saveBin(v: string) {
  try {
    localStorage.setItem(BIN_KEY, v.trim());
  } catch {
    /* sem storage: só não lembra */
  }
}

/** Projeto escolhido neste PC quando a sala tem mais de um (gfs-godot-<sala>). */
export function loadProject(roomId: string): string | undefined {
  try {
    return localStorage.getItem(`gfs-godot-${roomId}`) ?? undefined;
  } catch {
    return undefined;
  }
}
export function saveProject(roomId: string, p: string) {
  try {
    localStorage.setItem(`gfs-godot-${roomId}`, p);
  } catch {
    /* ignora */
  }
}

// ── Rust ─────────────────────────────────────────────────────────────────

const bin = () => loadBin() || null;
export const godotInfo = (want?: string) => invoke<GodotInfo>("godot_info", { bin: bin(), want: want ?? null });

export interface InstallProgress {
  phase: "engine" | "templates" | "extraindo";
  done: number;
  total: number;
}
/** Instala a Godot (e/ou os templates) e guarda o caminho do exe neste PC. Progresso por `onProgress`. */
export async function godotInstall(version: string, withTemplates: boolean, engine: boolean, onProgress: (p: InstallProgress) => void) {
  const stop = await listen<InstallProgress>("godot-install", (e) => onProgress(e.payload));
  try {
    const exe = await invoke<string | null>("godot_install", { version, withTemplates, engine });
    if (exe) saveBin(exe);
    return exe;
  } finally {
    stop();
  }
}
export const godotInstallCancel = () => invoke<void>("godot_install_cancel");
export const godotImport = (dir: string, project: string | null) => invoke<string>("godot_import", { dir, bin: bin(), project });
export const godotRun = (dir: string, project: string | null) => invoke<void>("godot_run", { dir, bin: bin(), project });
export const godotStop = (dir: string) => invoke<void>("godot_stop", { dir });
export const godotStatus = (dir: string) => invoke<GodotStatus>("godot_status", { dir });
export const godotExportWeb = (dir: string, project: string | null) => invoke<ExportResult>("godot_export_web", { dir, bin: bin(), project });
export const godotServe = (dir: string) => invoke<number>("godot_serve", { dir });
export const godotCapture = (dir: string, project: string | null) => invoke<string>("godot_capture", { dir, bin: bin(), project });
export interface EmbedStatus {
  running: boolean;
  code: number | null;
  tail: string | null;
}
export const godotEmbedStart = (dir: string, project: string | null, rect: EmbedRect, visible: boolean) =>
  invoke<void>("godot_embed_start", { dir, bin: bin(), project, rect, visible });
export const godotEmbedRect = (dir: string, rect: EmbedRect, visible: boolean) => invoke<EmbedStatus>("godot_embed_rect", { dir, rect, visible });
export const godotEmbedStop = () => invoke<void>("godot_embed_stop");

/** Erro do Rust em português claro (os códigos vêm no começo da mensagem). */
export function explain(e: unknown): string {
  const s = String(e);
  if (s.startsWith("NO_TEMPLATE")) return `Faltam os "export templates" desta versão da Godot (sem eles não dá para exportar para Web). Use o botão "Instalar templates" acima (ou, na Godot: Editor → Gerenciar Modelos de Exportação → Baixar). ${s.slice(13)}`;
  if (s.startsWith("NO_PRESET")) return `O projeto não tem o preset de exportação "Web". Na Godot: Projeto → Exportar → Adicionar → Web, com o nome exato "Web" (ou peça ao Claude para criar no export_presets.cfg).`;
  if (s.startsWith("CANCELADO")) return "Instalação cancelada. Nada ficou pela metade.";
  if (s.startsWith("NOT_FOUND")) return "Essa versão da Godot não existe no site oficial (godot-builds). Confira a versão da sala.";
  if (s.startsWith("NET")) return `Falhou a conexão com o GitHub. Confira a internet e tente de novo. (${s.slice(5)})`;
  if (s.startsWith("DOWNLOAD_RUIM")) return `O arquivo baixado veio estragado e foi apagado. Tente de novo. (${s.slice(15)})`;
  if (s.startsWith("SEM_PROJECT")) return "Não achei o project.godot na pasta da sala (nem em subpastas até 2 níveis). A pasta do Claude está ligada?";
  return s.replace(/^[A-Z_]+: /, "");
}

export async function writeScenesMd(dir: string, md: string) {
  await writeTextFile(await join(dir, ".gfs", "CENAS.md"), md);
}

/** Converte uma sala HTML5 em Godot: cria o que falta, acrescenta as regras no CLAUDE.md e troca o tipo (só o dono grava). */
export async function convertToGodot(room: Room, sync: RoomSync) {
  const files = sync.remoteFiles();
  const plan = convertPlan(
    files.map((f) => f.path),
    room.name,
    files.find((f) => f.path === "CLAUDE.md")?.content,
  );
  for (const [p, text] of plan.create) await sync.appendToFile(p, "", text);
  if (plan.appendClaude) await sync.appendToFile("CLAUDE.md", "\n" + GODOT_RULES, "", "## Godot pela linha de comando");
  await updateRoomSettings(room.id, { kind: "godot" });
}
