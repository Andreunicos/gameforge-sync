// Sala Unreal + Diversion (só o Content/ vai para lá): o app do DONO da sala cria um repositório do Diversion por sala
// e convida o e-mail de cada membro. A API aceita chamada direto da tela (CORS libera gameforge-sync.web.app): sem Rust.
// O token (dvk_...) fica SÓ neste PC (localStorage), nunca no Firestore (as contas autorizadas leem tudo lá).
// Este arquivo não importa o Firebase (os testes rodam em Node); a parte que grava na sala está em diversionSync.ts.
import type { Role } from "./types";

export const DV_API = "https://api.diversion.dev/v0";
export const DV_APP = "https://app.diversion.dev";
const TOKEN_KEY = "gfs-diversion-token";

export type DvMode = "READ" | "WRITE" | "ADMIN" | "OWNER";

/** Campo `diversion` do documento da sala (sem segredo: todos os membros leem). */
export interface DvRoom {
  /** Vazio = pedido de criação (a sala nasceu com o token ligado neste PC; o app do dono cria). */
  repoId?: string;
  name?: string;
  /** Quem o app convidou (uid → e-mail e acesso). Serve para não reenviar convite e para tirar só quem o app pôs. */
  invited?: Record<string, { email: string; mode: DvMode }>;
}

// ── token deste PC ───────────────────────────────────────────────────────

const tokenListeners = new Set<() => void>();
export function getDvToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setDvToken(t: string) {
  try {
    if (t.trim()) localStorage.setItem(TOKEN_KEY, t.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    throw new Error("Este navegador não deixa guardar o token (armazenamento bloqueado).");
  }
  tokenListeners.forEach((l) => l());
}
export function onDvToken(l: () => void) {
  tokenListeners.add(l);
  return () => {
    tokenListeners.delete(l);
  };
}

// ── regras puras ─────────────────────────────────────────────────────────

/** Nome do repositório: nome da sala sem acento nem espaço + 6 letras do id da sala (não colide entre salas). */
export function repoName(roomName: string, roomId: string): string {
  const base =
    roomName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "Sala";
  return `${base}-${roomId.slice(0, 6)}`;
}

/** Papel na sala → acesso no Diversion. O dono não é convidado: o token é dele, então ele já é OWNER do repositório. */
export function modeFor(role: Role): DvMode | null {
  return role === "editor" ? "WRITE" : role === "viewer" ? "READ" : null;
}

const RANK: Record<DvMode, number> = { READ: 0, WRITE: 1, ADMIN: 2, OWNER: 3 };

export interface DvMember {
  uid: string;
  name: string;
  email: string;
  role: Role;
}
export interface DvCollabs {
  collaborators: { user_id: string; email?: string; access_mode: DvMode }[];
  invites: { invite_id: number; invited_email: string; access_mode: DvMode }[];
}
export type DvStep =
  | { do: "invite"; uid: string; email: string; mode: DvMode; revoke?: number }
  | { do: "mode"; uid: string; email: string; mode: DvMode; userId: string }
  | { do: "remove"; uid: string; email: string; userId?: string; revoke?: number };
export type DvState = "ok" | "pending" | "sent" | "todo" | "skip";
export interface DvMemberStatus {
  uid: string;
  name: string;
  email: string;
  mode: DvMode | null;
  state: DvState;
  error?: string;
}

/**
 * O que fazer no repositório para ele bater com a sala. Não mexe em quem é ADMIN/OWNER lá, não rebaixa quem o app não
 * convidou, e não reenvia convite sozinho para quem já foi convidado (convite vencido ou aceito com outro e-mail):
 * isso só com `force` (botão "convidar de novo"), para não mandar e-mail repetido a cada abertura do app.
 */
export function planSync(members: DvMember[], invited: DvRoom["invited"], c: DvCollabs, force: string[] = []) {
  const low = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  const steps: DvStep[] = [];
  const status: DvMemberStatus[] = [];
  const managed = invited ?? {};
  const memberUids = new Set(members.map((m) => m.uid));

  for (const m of members) {
    const mode = modeFor(m.role);
    const st: DvMemberStatus = { uid: m.uid, name: m.name, email: m.email, mode, state: "todo" };
    status.push(st);
    if (!mode || !m.email) {
      st.state = "skip"; // dono (já é OWNER) ou membro sem e-mail no perfil
      continue;
    }
    const e = low(m.email);
    const col = c.collaborators.find((x) => low(x.email) === e);
    const inv = c.invites.find((x) => low(x.invited_email) === e);
    if (col) {
      st.state = "ok";
      const fixed = col.access_mode === "ADMIN" || col.access_mode === "OWNER";
      if (!fixed && col.access_mode !== mode && (managed[m.uid] || RANK[col.access_mode] < RANK[mode])) {
        steps.push({ do: "mode", uid: m.uid, email: m.email, mode, userId: col.user_id });
        st.state = "todo";
      }
    } else if (inv && inv.access_mode === mode) {
      st.state = "pending";
    } else if (!inv && managed[m.uid]?.mode === mode && low(managed[m.uid].email) === e && !force.includes(m.uid)) {
      st.state = "sent";
    } else {
      steps.push({ do: "invite", uid: m.uid, email: m.email, mode, revoke: inv?.invite_id });
    }
  }

  // Saiu da sala: tira só quem o app convidou (nunca ADMIN/OWNER do repositório).
  for (const [uid, x] of Object.entries(managed)) {
    if (memberUids.has(uid)) continue;
    const e = low(x.email);
    const col = c.collaborators.find((y) => low(y.email) === e && y.access_mode !== "ADMIN" && y.access_mode !== "OWNER");
    const inv = c.invites.find((y) => low(y.invited_email) === e);
    steps.push({ do: "remove", uid, email: x.email, userId: col?.user_id, revoke: inv?.invite_id });
  }
  return { steps, status };
}

// ── API ──────────────────────────────────────────────────────────────────

export class DvError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Erro que vale para todas as chamadas (para tudo e mostra): token, plano, limite de chamadas, rede. */
export const fatalDv = (e: unknown) => e instanceof DvError && (e.status === 0 || e.status === 401 || e.status === 429);

function explain(status: number, detail: string): string {
  if (status === 401) return "Token do Diversion inválido ou revogado. Gere outro em diversion.dev → Settings → Integrations e cole no 🔒 Unreal.";
  if (status === 403)
    return `O Diversion recusou (${detail || "sem permissão"}). A API do Diversion pode exigir plano pago, ou o plano chegou ao limite de pessoas (Indie grátis: 5).`;
  if (status === 429) return "Muitas chamadas ao Diversion agora. Tente de novo em alguns minutos.";
  if (status === 404) return `O Diversion não achou o repositório (${detail || "404"}). Foi apagado lá? Crie outro ou escolha um existente no 🔒 Unreal.`;
  return `Diversion ${status}: ${detail || "erro sem detalhe"}`;
}

export function dvApi(token: string, base = DV_API) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new DvError("Sem conexão com o Diversion (internet fora ou api.diversion.dev fora do ar). Tente de novo depois.", 0);
    }
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* resposta sem JSON */
    }
    if (!res.ok) {
      const detail = String((data as { detail?: unknown } | undefined)?.detail ?? "").slice(0, 300);
      throw new DvError(explain(res.status, detail), res.status);
    }
    return data as T;
  }
  const r = (id: string) => `/repos/${encodeURIComponent(id)}`;
  return {
    listOwned: () => call<{ items: { repo_id: string; repo_name: string }[] }>("GET", "/repos?owned=true").then((x) => x?.items ?? []),
    create: (name: string, description: string) => call<{ repo_id?: string; id?: string }>("POST", "/repos", { repo_name: name, description }),
    collabs: (id: string) =>
      call<Partial<DvCollabs>>("GET", `${r(id)}/collaborators`).then((x) => ({ collaborators: x?.collaborators ?? [], invites: x?.invites ?? [] })),
    invite: (id: string, email: string, mode: DvMode) => call<void>("PUT", `${r(id)}/invites`, { collaborator_handle: email, mode }),
    revoke: (id: string, inviteId: number) => call<void>("DELETE", `${r(id)}/invites/${inviteId}`),
    setMode: (id: string, userId: string, mode: DvMode) => call<void>("PATCH", `${r(id)}/collaborators/${encodeURIComponent(userId)}`, { mode }),
    remove: (id: string, userId: string) => call<void>("DELETE", `${r(id)}/collaborators/${encodeURIComponent(userId)}`),
  };
}
export type DvApi = ReturnType<typeof dvApi>;

/** Cria o repositório. Nome já existe (409): usa o que já é deste token com esse nome (tentativa anterior que caiu no meio). */
export async function ensureRepo(api: DvApi, name: string, description: string): Promise<{ repoId: string; name: string }> {
  try {
    const x = await api.create(name, description);
    const id = x?.repo_id ?? x?.id;
    if (!id) throw new DvError("O Diversion criou o repositório mas não devolveu o id. Escolha-o na lista do 🔒 Unreal.", 500);
    return { repoId: id, name };
  } catch (e) {
    if (!(e instanceof DvError) || e.status !== 409) throw e;
    const mine = (await api.listOwned()).find((x) => x.repo_name === name);
    if (!mine) throw new DvError(`Já existe um repositório "${name}" no Diversion que não é desta conta.`, 409);
    return { repoId: mine.repo_id, name };
  }
}

/** Aplica o plano. Erro de token/rede/limite para tudo (lança); erro de um e-mail fica só nele. Devolve o `invited` novo. */
export async function runSync(api: DvApi, repoId: string, members: DvMember[], invited: DvRoom["invited"], force: string[] = []) {
  const { steps, status } = planSync(members, invited, await api.collabs(repoId), force);
  const next = { ...(invited ?? {}) };
  for (const s of steps) {
    const st = status.find((x) => x.uid === s.uid);
    try {
      if (s.do === "remove") {
        if (s.revoke !== undefined) await api.revoke(repoId, s.revoke);
        if (s.userId) await api.remove(repoId, s.userId);
        delete next[s.uid];
        continue;
      }
      if (s.do === "mode") await api.setMode(repoId, s.userId, s.mode);
      else {
        if (s.revoke !== undefined) await api.revoke(repoId, s.revoke); // convite pendente com outro acesso: troca
        try {
          await api.invite(repoId, s.email, s.mode);
        } catch (e) {
          if (!(e instanceof DvError) || e.status !== 409) throw e; // 409 = já convidado
        }
      }
      next[s.uid] = { email: s.email, mode: s.mode };
      if (st) st.state = s.do === "mode" ? "ok" : "pending";
    } catch (e) {
      if (fatalDv(e)) throw e;
      if (st) st.error = e instanceof Error ? e.message : String(e);
    }
  }
  return { invited: next, status };
}
