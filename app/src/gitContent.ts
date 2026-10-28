// Sala Unreal + Git (GitHub): o Content/ do projeto (binários pesados, que a sala não sincroniza) num repositório Git
// PRIVADO por sala, com Git LFS. O app do DONO cria o repositório pela API do GitHub e convida os editores pelo usuário
// do GitHub; cada pessoa liga o Content/ do seu PC ao repositório e o app baixa/envia (comando Rust git_content, que só
// roda `git` com uma lista fechada de operações). O token fica SÓ no PC do dono (localStorage), nunca no Firestore.
// Este arquivo não importa o Firebase (os testes rodam em Node); a parte que grava na sala está em gitContentSync.ts.
import { invoke } from "@tauri-apps/api/core";
import type { Role } from "./types";

export const GH_API = "https://api.github.com";
const TOKEN_KEY = "gfs-github-token";

/** Campo `git` do documento da sala (sem segredo: todos os membros leem). */
export interface GitRoom {
  /** "dono/nome" no GitHub. */
  repo?: string;
  branch?: string;
  /** Usuário do GitHub de cada membro (uid → login), digitado pelo dono. */
  users?: Record<string, string>;
  /** Quem o app convidou (uid → login): para não reenviar convite e para tirar só quem o app pôs. */
  invited?: Record<string, string>;
}

// ── token deste PC ───────────────────────────────────────────────────────

const tokenListeners = new Set<() => void>();
export function getGhToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setGhToken(t: string) {
  try {
    if (t.trim()) localStorage.setItem(TOKEN_KEY, t.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    throw new Error("Este navegador não deixa guardar o token (armazenamento bloqueado).");
  }
  tokenListeners.forEach((l) => l());
}
export function onGhToken(l: () => void) {
  tokenListeners.add(l);
  return () => {
    tokenListeners.delete(l);
  };
}
export const looksLikeGhToken = (t: string) => /^(ghp_|github_pat_)[A-Za-z0-9_]{20,250}$/.test(t.trim());

// ── regras do repositório (Content/) ─────────────────────────────────────

/** .gitignore do Content/: Python/ vem pela sala do GameForge; caches e temporários ficam fora. */
export const GIT_IGNORE = `# GameForge Sync: este repositório é só o Content/ do projeto Unreal.
# Python/ (scripts do editor) vem pela sala do GameForge: não entra aqui.
/Python/
__pycache__/
*.pyc
# Temporários e lixo do sistema
*.tmp
*.bak
*.swp
~$*
.DS_Store
Thumbs.db
desktop.ini
`;

/** Binários que vão pelo Git LFS: do Unreal, texturas, áudio, vídeo, 3D, fontes e pacotes. */
export const LFS_EXT = (
  "uasset umap uexp ubulk uptnl upk utoc ucas pak " +
  "png jpg jpeg tga bmp psd exr hdr dds tif tiff " +
  "wav mp3 ogg flac aif aiff " +
  "mp4 mov avi mkv webm bk2 " +
  "fbx obj gltf glb abc blend " +
  "ttf otf zip 7z"
).split(" ");

/** `png` → `*.[pP][nN][gG]`: o .gitattributes diferencia maiúsculas e o Windows não. */
export const anyCase = (ext: string) => "*." + [...ext].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join("");

export const GIT_ATTRIBUTES =
  "# GameForge Sync: binários pelo Git LFS (o Git guarda só um ponteiro pequeno). Sem 'lockable': deixaria os arquivos\n" +
  "# só-leitura e o Unreal não conseguiria salvar.\n" +
  LFS_EXT.map((e) => `${anyCase(e)} filter=lfs diff=lfs merge=lfs -text`).join("\n") +
  "\n";

// ── comando do app (Rust) ────────────────────────────────────────────────

export type GitOp = "status" | "init" | "fetch" | "pull" | "push";

/** O que o Rust devolve (o Content/ deste PC). */
export interface GitStatus {
  repo: boolean;
  lfs: boolean;
  remote: boolean;
  ahead: number;
  behind: number;
  changed: string[];
  changedTotal: number;
  path: string;
}

/** `project` = pasta do projeto relativa à sala ("" = raiz). `token` só no PC do dono; sem ele o Git Credential Manager entra. */
export const gitRun = (dir: string, project: string, op: GitOp, g: GitRoom, name: string, token: string | null, interactive: boolean) =>
  invoke<GitStatus>("git_content", {
    dir,
    project,
    req: { op, repo: g.repo, branch: g.branch || "main", token, name, interactive, ignore: GIT_IGNORE, attributes: GIT_ATTRIBUTES },
  });

// ── quem tem acesso (regras puras) ───────────────────────────────────────

/** Usuário do GitHub válido (letras, números e hífen simples, até 39). */
export const validLogin = (s: string) => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s);

export interface GhMember {
  uid: string;
  name: string;
  role: Role;
}
/** owner = dono (já é dono do repositório); viewer = espectador (não é convidado: num repositório pessoal todo colaborador
 * pode enviar); nologin = sem usuário do GitHub; ok = tem acesso; pending = convite enviado; sent = convidado e sumiu
 * (recusou ou o convite venceu em 7 dias); todo = a convidar. */
export type GhState = "owner" | "viewer" | "nologin" | "ok" | "pending" | "sent" | "todo";
export interface GhMemberStatus {
  uid: string;
  name: string;
  login?: string;
  state: GhState;
  error?: string;
}
export type GhStep = { do: "invite"; uid: string; login: string } | { do: "remove"; uid: string; login: string; collab: boolean; inviteId?: number };

/**
 * O que fazer no repositório para ele bater com a sala. Convida só editores (num repositório de conta pessoal o GitHub
 * ignora "só leitura": todo colaborador pode enviar). Não reenvia convite sozinho (só com `force`) e só tira acesso de
 * quem o app convidou (saiu da sala, virou espectador ou trocou de usuário); nunca o dono.
 */
export function planAccess(members: GhMember[], g: GitRoom, collabs: string[], invites: { id: number; login: string }[], ownerLogin: string, force: string[] = []) {
  const low = (s: string) => s.trim().toLowerCase();
  const isCollab = (l: string) => collabs.some((c) => low(c) === low(l));
  const inviteOf = (l: string) => invites.find((i) => low(i.login) === low(l));
  const users = g.users ?? {};
  const managed = g.invited ?? {};
  const status: GhMemberStatus[] = [];
  const invitesTodo: GhStep[] = [];
  const want = new Map<string, string>(); // uid → login que deve ter acesso

  for (const m of members) {
    const login = users[m.uid]?.trim() || undefined;
    const st: GhMemberStatus = { uid: m.uid, name: m.name, login, state: "todo" };
    status.push(st);
    if (m.role === "owner" || (login && low(login) === low(ownerLogin))) st.state = "owner";
    else if (!login) st.state = "nologin";
    else if (m.role !== "editor") st.state = "viewer";
    else {
      want.set(m.uid, login);
      if (isCollab(login)) st.state = "ok";
      else if (inviteOf(login)) st.state = "pending";
      else if (managed[m.uid] && low(managed[m.uid]) === low(login) && !force.includes(m.uid)) st.state = "sent";
      else invitesTodo.push({ do: "invite", uid: m.uid, login });
    }
  }

  const wanted = new Set([...want.values()].map(low));
  const removes: GhStep[] = [];
  for (const [uid, login] of Object.entries(managed)) {
    if (wanted.has(low(login)) || low(login) === low(ownerLogin)) continue;
    removes.push({ do: "remove", uid, login, collab: isCollab(login), inviteId: inviteOf(login)?.id });
  }
  return { steps: [...removes, ...invitesTodo], status };
}

// ── API do GitHub ────────────────────────────────────────────────────────

export class GhError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Erro que vale para todas as chamadas (para tudo e mostra): token, rede, limite. */
export const fatalGh = (e: unknown) => e instanceof GhError && (e.status === 0 || e.status === 401 || e.status === 429);

function explain(status: number, detail: string): string {
  if (status === 401) return "Token do GitHub inválido, vencido ou revogado. Gere outro (github.com → Settings → Developer settings) e cole no 🔒 Unreal.";
  if (status === 403)
    return `O GitHub recusou (${detail || "sem permissão"}). O token precisa poder criar repositórios e convidar: clássico com "repo", ou fine-grained com Administration e Contents (leitura e escrita). Também pode ser limite de chamadas: tente mais tarde.`;
  if (status === 404) return `O GitHub não achou (${detail || "404"}): o repositório foi apagado ou este token não o enxerga.`;
  if (status === 422) return `O GitHub recusou os dados (${detail || "422"}).`;
  if (status === 429) return "Muitas chamadas ao GitHub agora. Tente de novo em alguns minutos.";
  return `GitHub ${status}: ${detail || "erro sem detalhe"}`;
}

export function ghApi(token: string, base = GH_API) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GhError("Sem conexão com o GitHub (internet fora?). Tente de novo depois.", 0);
    }
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* resposta sem JSON */
    }
    if (!res.ok) {
      const x = data as { message?: unknown; errors?: { message?: unknown }[] } | undefined;
      const detail = [x?.message, x?.errors?.[0]?.message].filter(Boolean).map(String).join(": ").slice(0, 300);
      throw new GhError(explain(res.status, detail), res.status);
    }
    return { status: res.status, data: data as T };
  }
  const r = (full: string) => "/repos/" + full.split("/").map(encodeURIComponent).join("/");
  type Repo = { full_name: string; private: boolean; default_branch?: string };
  return {
    me: () => call<{ login: string }>("GET", "/user").then((x) => x.data.login),
    create: (name: string, description: string) =>
      call<Repo>("POST", "/user/repos", { name, description, private: true, auto_init: false, has_issues: false, has_projects: false, has_wiki: false }).then((x) => x.data),
    repo: (full: string) => call<Repo>("GET", r(full)).then((x) => x.data),
    collaborators: (full: string) => call<{ login: string }[]>("GET", `${r(full)}/collaborators?affiliation=direct&per_page=100`).then((x) => (x.data ?? []).map((c) => c.login)),
    invitations: (full: string) =>
      call<{ id: number; invitee?: { login: string } }[]>("GET", `${r(full)}/invitations?per_page=100`).then((x) =>
        (x.data ?? []).filter((i) => i.invitee?.login).map((i) => ({ id: i.id, login: i.invitee!.login })),
      ),
    /** 201 = convite criado (a pessoa aceita); 204 = já era colaborador. */
    invite: (full: string, login: string) => call<unknown>("PUT", `${r(full)}/collaborators/${encodeURIComponent(login)}`).then((x) => x.status),
    remove: (full: string, login: string) => call<void>("DELETE", `${r(full)}/collaborators/${encodeURIComponent(login)}`),
    cancel: (full: string, id: number) => call<void>("DELETE", `${r(full)}/invitations/${id}`),
  };
}
export type GhApi = ReturnType<typeof ghApi>;

/** Cria o repositório PRIVADO. Nome já existe nesta conta (422, tentativa anterior que caiu no meio): reaproveita se for privado. */
export async function ensureGhRepo(api: GhApi, name: string, description: string): Promise<{ repo: string; branch: string }> {
  try {
    const x = await api.create(name, description);
    if (!x.private) throw new GhError(`O GitHub criou ${x.full_name} como PÚBLICO: torne-o privado lá antes de usar.`, 500);
    return { repo: x.full_name, branch: "main" };
  } catch (e) {
    if (!(e instanceof GhError) || e.status !== 422) throw e;
    const full = `${await api.me()}/${name}`;
    const x = await api.repo(full).catch(() => {
      throw e;
    });
    if (!x.private) throw new GhError(`Já existe o repositório PÚBLICO ${full} no GitHub: o app só usa repositório privado para o Content/. Renomeie ou apague o de lá.`, 422);
    return { repo: x.full_name, branch: x.default_branch || "main" };
  }
}

/** Aplica o plano. Erro de token/rede/limite para tudo (lança); erro de uma pessoa fica só nela. Devolve o `invited` novo. */
export async function runAccess(api: GhApi, members: GhMember[], g: GitRoom, force: string[] = []) {
  const repo = g.repo!;
  const [ownerLogin, collabs, invites] = await Promise.all([api.me(), api.collaborators(repo), api.invitations(repo)]);
  const { steps, status } = planAccess(members, g, collabs, invites, ownerLogin, force);
  const next = { ...(g.invited ?? {}) };
  for (const s of steps) {
    const st = status.find((x) => x.uid === s.uid);
    try {
      if (s.do === "remove") {
        if (s.inviteId !== undefined) await api.cancel(repo, s.inviteId);
        if (s.collab) await api.remove(repo, s.login);
        delete next[s.uid];
        continue;
      }
      const code = await api.invite(repo, s.login);
      next[s.uid] = s.login;
      if (st) st.state = code === 204 ? "ok" : "pending";
    } catch (e) {
      if (fatalGh(e)) throw e;
      if (st) st.error = e instanceof Error ? e.message : String(e);
    }
  }
  return { invited: next, status, ownerLogin };
}
