// Botão BUILD: gera o jogo da sala para Web (.html, na hora, aqui mesmo) e para Android/Windows/Linux
// na fábrica de builds (repositório privado Andreunicos/gameforge-builds, GitHub Actions).
//
// Fluxo da nuvem: grava o jogo num branch build/<jogo>-<hora> → dispara o workflow → acompanha cada
// plataforma → baixa os arquivos da release para <pasta da sala>\builds\<data> → abre a pasta.
// O token (fine-grained, só daquele repositório) fica em secrets/github no Firestore, que as regras
// só deixam as contas autorizadas lerem.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import { buildPreview, findEntry } from "./preview";
import { roomSlug } from "./sync/folderMirror";
import { countWrite } from "./usage";
import type { Author, RemoteFile, Room } from "./types";

const REPO = "Andreunicos/gameforge-builds";
const API = `https://api.github.com/repos/${REPO}`;

export type Target = "web" | "android-apk" | "android-aab" | "windows" | "linux";

export const TARGETS: { id: Target; label: string; hint: string; minutes: string }[] = [
  { id: "web", label: "Web (.html)", hint: "Um arquivo só que abre no navegador + pasta para hospedar", minutes: "na hora" },
  { id: "android-apk", label: "Android (.apk)", hint: "Instala direto no celular", minutes: "~8 min" },
  { id: "android-aab", label: "Android (.aab)", hint: "Para enviar à Play Store", minutes: "~8 min" },
  { id: "windows", label: "Windows (.exe)", hint: "Instalador + versão portátil", minutes: "~6 min" },
  { id: "linux", label: "Linux", hint: ".AppImage + .deb", minutes: "~6 min" },
];

const JOB_OF: Record<Exclude<Target, "web">, string> = {
  "android-apk": "android",
  "android-aab": "android",
  windows: "windows",
  linux: "linux",
};

export interface BuildRecord {
  id: string;
  targets: Target[];
  version: string;
  by: Author;
  ts?: Timestamp;
  status: "running" | "success" | "partial" | "failure";
  tag?: string;
  runId?: number;
  files?: { name: string; size: number }[];
}

export type JobState = "fila" | "compilando" | "pronto" | "erro" | "pulado";

export interface BuildState {
  phase: "idle" | "enviando" | "compilando" | "baixando" | "pronto" | "erro";
  targets: Target[];
  jobs: Partial<Record<"web" | "android" | "windows" | "linux", JobState>>;
  startedAt: number;
  dir?: string;
  files: { name: string; size: number }[];
  error?: string;
  runUrl?: string;
}

// ── estado por sala (o build continua mesmo fechando o painel) ────────────

const states = new Map<string, BuildState>();
const listeners = new Set<() => void>();
const IDLE: BuildState = { phase: "idle", targets: [], jobs: {}, startedAt: 0, files: [] };

export const buildState = (roomId: string) => states.get(roomId) ?? IDLE;
export function onBuild(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function set(roomId: string, patch: Partial<BuildState>) {
  states.set(roomId, { ...buildState(roomId), ...patch });
  listeners.forEach((l) => l());
}

// ── GitHub ────────────────────────────────────────────────────────────────

export async function buildToken(): Promise<string> {
  const d = await getDoc(doc(db, "secrets", "github"));
  const t = d.exists() ? (d.data().token as string) : "";
  if (!t) throw new Error("A fábrica de builds ainda não tem token. O André precisa colar o token em Ajustes → Builds.");
  return t;
}

export async function saveBuildToken(token: string, by: Author) {
  await setDoc(doc(db, "secrets", "github"), { token: token.trim(), by, ts: serverTimestamp() });
  countWrite();
}

async function gh<T = Record<string, unknown>>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 204) return {} as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { message?: string }).message ?? res.statusText;
    if (res.status === 401) throw new Error("Token de build inválido ou vencido. O André precisa gerar outro (Ajustes → Builds).");
    if (res.status === 403 || res.status === 404) throw new Error(`O token de build não tem acesso à fábrica (${msg}).`);
    throw new Error(`GitHub: ${msg}`);
  }
  return data as T;
}

/** Pacote Android do jogo: com.bringmestudio.<nome sem traços>. Trocar depois impede atualizar na Play Store. */
export function appIdFor(room: Room) {
  let id = roomSlug(room.name).replace(/-/g, "");
  if (!/^[a-z]/.test(id)) id = "g" + id;
  return `com.bringmestudio.${id.slice(0, 40)}`;
}

export function nextVersion(last?: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(last ?? "");
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

function stamp(version: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}-v${version}`;
}

// ── histórico de builds da sala ───────────────────────────────────────────

export function watchBuilds(roomId: string, cb: (b: BuildRecord[]) => void) {
  return onSnapshot(query(collection(db, "rooms", roomId, "builds"), orderBy("ts", "desc"), limit(10)), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BuildRecord)),
  );
}

// ── o build ───────────────────────────────────────────────────────────────

export interface BuildParams {
  room: Room;
  files: RemoteFile[];
  targets: Target[];
  version: string;
  entry: string | null;
  by: Author;
}

async function roomBuildDir(room: Room, version: string) {
  const roomDir = await invoke<string>("room_dir", { slug: roomSlug(room.name), roomId: room.id });
  return join(roomDir, "builds", stamp(version));
}

function webExport(p: BuildParams) {
  const byPath = new Map(p.files.map((f) => [f.path, f.content]));
  const entry = p.entry && byPath.has(p.entry) ? p.entry : findEntry([...byPath.keys()]);
  return buildPreview({ paths: [...byPath.keys()], contentOf: (x) => byPath.get(x), assetsBase: p.room.assetsBase, entry, standalone: true });
}

/** Navegador: só o Web, baixado como arquivo. */
function downloadInBrowser(name: string, html: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function runBuild(p: BuildParams) {
  const roomId = p.room.id;
  if (["enviando", "compilando", "baixando"].includes(buildState(roomId).phase)) throw new Error("Já tem um build rodando nesta sala.");
  const slug = roomSlug(p.room.name);
  const cloud = p.targets.filter((t): t is Exclude<Target, "web"> => t !== "web");
  const jobs: BuildState["jobs"] = {};
  if (p.targets.includes("web")) jobs.web = "compilando";
  for (const t of cloud) jobs[JOB_OF[t] as "android" | "windows" | "linux"] = "fila";
  set(roomId, { phase: "enviando", targets: p.targets, jobs, startedAt: Date.now(), files: [], error: undefined, dir: undefined, runUrl: undefined });

  const files: { name: string; size: number }[] = [];
  try {
    // 1) Web: gerado aqui, na hora.
    let dir: string | undefined;
    if (p.targets.includes("web")) {
      const { html } = webExport(p);
      if (!isTauri()) {
        downloadInBrowser(`${slug}-${p.version}.html`, html);
      } else {
        dir = await roomBuildDir(p.room, p.version);
        await invoke("write_build_file", { dir, name: `${slug}-${p.version}-web.html`, content: html });
        for (const f of p.files) await invoke("write_build_file", { dir, name: `web/${f.path}`, content: f.content });
        files.push({ name: `${slug}-${p.version}-web.html`, size: html.length }, { name: "web/ (pasta para hospedar)", size: 0 });
      }
      set(roomId, { jobs: { ...buildState(roomId).jobs, web: "pronto" }, dir, files: [...files] });
    }
    if (!cloud.length) {
      set(roomId, { phase: "pronto" });
      return;
    }
    if (!isTauri()) throw new Error("Android, Windows e Linux só pelo app instalado no PC.");

    // 2) Nuvem: grava o jogo num branch e dispara o workflow.
    const token = await buildToken();
    const branch = `build/${slug}-${Date.now()}`;
    const tag = branch.replace(/\//g, "-");
    const main = await gh<{ object: { sha: string } }>(token, "/git/ref/heads/main");
    const base = await gh<{ tree: { sha: string } }>(token, `/git/commits/${main.object.sha}`);
    const meta = { name: p.room.name, slug, appId: appIdFor(p.room), version: p.version, entry: p.entry ?? "index.html" };
    const tree = await gh<{ sha: string }>(token, "/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: base.tree.sha,
        tree: [
          ...p.files.map((f) => ({ path: `game/${f.path}`, mode: "100644", type: "blob", content: f.content })),
          { path: "build.json", mode: "100644", type: "blob", content: JSON.stringify(meta, null, 2) },
        ],
      }),
    });
    const commit = await gh<{ sha: string }>(token, "/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `Build ${p.room.name} ${p.version} (${p.by.name})`, tree: tree.sha, parents: [main.object.sha] }),
    });
    await gh(token, "/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
    const disp = await gh<{ workflow_run_id?: number }>(token, "/actions/workflows/build.yml/dispatches", {
      method: "POST",
      body: JSON.stringify({ ref: branch, inputs: { targets: cloud.join(",") }, return_run_details: true }),
    });

    let runId = disp.workflow_run_id;
    for (let i = 0; !runId && i < 20; i++) {
      await sleep(3000);
      const runs = await gh<{ workflow_runs: { id: number }[] }>(token, `/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`);
      runId = runs.workflow_runs[0]?.id;
    }
    if (!runId) throw new Error("A fábrica não começou o build. Tente de novo.");
    set(roomId, { phase: "compilando", runUrl: `https://github.com/${REPO}/actions/runs/${runId}` });

    const rec = await addDoc(collection(db, "rooms", roomId, "builds"), {
      targets: p.targets,
      version: p.version,
      by: p.by,
      status: "running",
      tag,
      runId,
      ts: serverTimestamp(),
    });
    countWrite();

    // 3) Acompanha cada plataforma.
    let conclusion = "";
    for (;;) {
      await sleep(10_000);
      const [run, jobList] = await Promise.all([
        gh<{ status: string; conclusion: string | null }>(token, `/actions/runs/${runId}`),
        gh<{ jobs: { name: string; status: string; conclusion: string | null }[] }>(token, `/actions/runs/${runId}/jobs`),
      ]);
      const next = { ...buildState(roomId).jobs };
      for (const j of jobList.jobs) {
        if (!["android", "windows", "linux"].includes(j.name)) continue;
        const k = j.name as "android" | "windows" | "linux";
        if (!(k in next)) continue;
        next[k] =
          j.status !== "completed"
            ? j.status === "in_progress"
              ? "compilando"
              : "fila"
            : j.conclusion === "success"
              ? "pronto"
              : j.conclusion === "skipped"
                ? "pulado"
                : "erro";
      }
      set(roomId, { jobs: next });
      if (run.status === "completed") {
        conclusion = run.conclusion ?? "";
        break;
      }
    }

    // 4) Baixa o que ficou pronto.
    set(roomId, { phase: "baixando" });
    dir ??= await roomBuildDir(p.room, p.version);
    let assets: { name: string; size: number; url: string }[] = [];
    try {
      assets = (await gh<{ assets: { name: string; size: number; url: string }[] }>(token, `/releases/tags/${encodeURIComponent(tag)}`)).assets;
    } catch {
      /* nenhuma plataforma terminou */
    }
    for (const a of assets) {
      await invoke("download_asset", { url: a.url, token, dir, name: a.name });
      files.push({ name: a.name, size: a.size });
      set(roomId, { files: [...files], dir });
    }
    await gh(token, `/git/refs/heads/${branch}`, { method: "DELETE" }).catch(() => {});

    const failed = Object.values(buildState(roomId).jobs).includes("erro");
    const status: BuildRecord["status"] = !assets.length ? "failure" : failed || conclusion !== "success" ? "partial" : "success";
    await updateDoc(rec, { status, files: files.filter((f) => f.size > 0) }).catch(() => {});
    if (status === "failure") throw new Error("Nenhuma plataforma compilou. Veja o motivo no link do GitHub.");
    set(roomId, { phase: "pronto", dir });
    if (dir) void invoke("reveal_build", { dir }).catch(() => {});
  } catch (e) {
    set(roomId, { phase: "erro", error: e instanceof Error ? e.message : String(e), files: [...files] });
  }
}

/** Baixa de novo um build antigo da sala (outra pessoa pode ter feito). */
export async function downloadOld(room: Room, b: BuildRecord) {
  if (!b.tag) throw new Error("Esse build não tem arquivos.");
  const token = await buildToken();
  const dir = await roomBuildDir(room, b.version);
  const rel = await gh<{ assets: { name: string; url: string }[] }>(token, `/releases/tags/${encodeURIComponent(b.tag)}`);
  for (const a of rel.assets) await invoke("download_asset", { url: a.url, token, dir, name: a.name });
  await invoke("reveal_build", { dir });
}

export const revealBuild = (dir: string) => invoke("reveal_build", { dir });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
