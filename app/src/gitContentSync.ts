// Git do Content/, lado da sala: estado por sala (o painel lê), operações locais (ligar, conferir, baixar, enviar), o
// "chega sozinho" (confere a cada 10 min e baixa se for seguro) e, no app do DONO, criar o repositório e manter os
// convites iguais aos editores. Regras puras e API em gitContent.ts; o git roda no Rust (gitcontent.rs).
import { useEffect, useRef } from "react";
import { updateRoomSettings } from "./rooms";
import { editorAlive, isOldApp } from "./unreal";
import { repoName } from "./diversion";
import { ensureGhRepo, getGhToken, ghApi, gitRun, runAccess, type GhMemberStatus, type GitOp, type GitStatus } from "./gitContent";
import type { Author, Room } from "./types";

export interface GitState {
  /** Operação local em andamento (uma por vez por sala). */
  op?: GitOp;
  local?: GitStatus;
  error?: string;
  msg?: string;
  /** App instalado sem o comando git_content (precisa da versão nova). */
  oldApp?: boolean;
  at?: number;
  /** Só no app do dono: situação de cada membro no repositório. */
  access?: GhMemberStatus[];
  accessBusy?: boolean;
  accessError?: string;
}

const states = new Map<string, GitState>();
const listeners = new Set<() => void>();
const IDLE: GitState = {};
export const gitState = (roomId: string) => states.get(roomId) ?? IDLE;
export function onGitState(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function set(roomId: string, patch: Partial<GitState>) {
  states.set(roomId, { ...gitState(roomId), ...patch });
  listeners.forEach((l) => l());
}

export interface GitCtx {
  room: Room;
  dir: string;
  project: string;
  me: Author;
}

/**
 * Roda uma operação no Content/ deste PC. O token só vai no PC do dono (o repositório é dele); os outros entram pelo
 * Git Credential Manager. `auto` = em segundo plano: não abre janela de login e não mostra erro de rede como falha.
 * Ligar com o repositório já tendo envios e o Content/ limpo: já baixa em seguida.
 */
export async function gitDo(c: GitCtx, op: GitOp, auto = false): Promise<GitStatus | undefined> {
  const g = c.room.git;
  if (!g?.repo || gitState(c.room.id).op) return;
  const token = c.room.ownerId === c.me.uid ? getGhToken() || null : null;
  set(c.room.id, { op, ...(auto ? {} : { error: undefined, msg: undefined }) });
  try {
    let st = await gitRun(c.dir, c.project, op, g, c.me.name, token, !auto);
    if (op === "init" && st.behind > 0 && st.changedTotal === 0 && st.ahead === 0) {
      set(c.room.id, { op: "pull", local: st });
      st = await gitRun(c.dir, c.project, "pull", g, c.me.name, token, !auto);
    }
    const msg = op === "push" ? "Enviado: o Content/ do GitHub está igual ao deste PC." : op === "pull" || op === "init" ? (st.behind === 0 ? "Content/ em dia com o GitHub." : undefined) : undefined;
    set(c.room.id, { local: st, error: undefined, oldApp: false, at: Date.now(), ...(auto ? {} : { msg }) });
    return st;
  } catch (e) {
    if (isOldApp(e)) set(c.room.id, { oldApp: true });
    else if (!auto) set(c.room.id, { error: e instanceof Error ? e.message : String(e) });
    else console.warn("git do Content/:", e);
  } finally {
    set(c.room.id, { op: undefined });
  }
}

const AUTO_MS = 10 * 60_000;

/**
 * Na sala Unreal com repositório e pasta do Claude ligada: lê o estado ao entrar e, se este PC já está ligado, confere o
 * GitHub a cada 10 min e BAIXA sozinho quando é seguro (nada mudado aqui, nada a enviar, editor Unreal fechado).
 * Nunca envia sozinho e nunca liga a pasta sozinho (a 1ª vez é pelo botão: pode pedir login no navegador).
 */
export function useGitContent(room: Room, dir: string | undefined, project: string | null | undefined, me: Author, toast: (text: string) => void) {
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const roomRef = useRef(room);
  roomRef.current = room;
  const repo = room.kind === "unreal" ? room.git?.repo : undefined;

  useEffect(() => {
    if (!repo || !dir || typeof project !== "string") return;
    let alive = true;
    const ctx = () => ({ room: roomRef.current, dir, project, me });
    const tick = async () => {
      const st = await gitDo(ctx(), "status", true);
      if (!alive || !st?.repo || gitState(room.id).oldApp) return;
      const f = await gitDo(ctx(), "fetch", true);
      if (!alive || !f || f.behind === 0 || f.ahead > 0 || f.changedTotal > 0) return;
      if (await editorAlive(dir)) return; // com o editor aberto, trocar .uasset por baixo dele pode estragar o que está aberto
      const p = await gitDo(ctx(), "pull", true);
      if (alive && p && p.behind === 0) toastRef.current(`Content/ atualizado pelo GitHub (${f.behind} envio(s) baixado(s)).`);
    };
    void tick();
    const t = window.setInterval(() => void tick(), AUTO_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, repo, dir, project, me.uid, me.name]);
}

// ── só no app do dono (o token está neste PC) ────────────────────────────

/** Cria o repositório privado da sala e grava `room.git` (sem segredo). */
export async function createGitRepo(room: Room) {
  const api = ghApi(getGhToken());
  const r = await ensureGhRepo(api, repoName(room.name, room.id), `GameForge: ${room.name} (Content/ do Unreal)`);
  await updateRoomSettings(room.id, { git: { ...room.git, ...r } });
}

/** Confere/convida os editores (pelo usuário do GitHub que o dono pôs) e grava quem o app convidou. `force` = convidar de novo. */
export async function syncGitAccess(room: Room, force: string[] = []) {
  const token = getGhToken();
  const g = room.git;
  if (!token || !g?.repo || gitState(room.id).accessBusy) return;
  set(room.id, { accessBusy: true, accessError: undefined });
  try {
    const members = room.memberIds.map((uid) => ({ uid, name: room.names[uid] ?? uid, role: room.roles[uid] ?? "viewer" }));
    const r = await runAccess(ghApi(token), members, g, force);
    if (JSON.stringify(r.invited) !== JSON.stringify(g.invited ?? {})) await updateRoomSettings(room.id, { git: { ...g, invited: r.invited } });
    set(room.id, { access: r.status });
  } catch (e) {
    set(room.id, { accessError: e instanceof Error ? e.message : String(e) });
  } finally {
    set(room.id, { accessBusy: false });
  }
}
