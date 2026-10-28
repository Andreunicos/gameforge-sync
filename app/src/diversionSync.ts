// Diversion, lado da sala: o app do DONO (o único com o token) cria o repositório das salas Unreal dele e mantém os
// convites iguais aos membros. Roda com o app aberto em qualquer tela: quem entrou com o dono offline é convidado
// quando o app do dono abrir. Regras puras e API em diversion.ts.
import { useEffect, useSyncExternalStore } from "react";
import type { User } from "firebase/auth";
import { ALLOWED_EMAILS } from "./config";
import { listProfiles, updateRoomSettings, watchMyRooms } from "./rooms";
import { dvApi, ensureRepo, getDvToken, onDvToken, repoName, runSync, type DvMemberStatus, type DvRoom } from "./diversion";
import type { Room } from "./types";

export interface DvSyncState {
  busy: boolean;
  error?: string;
  members?: DvMemberStatus[];
  at?: number;
}

const states = new Map<string, DvSyncState>();
const listeners = new Set<() => void>();
const IDLE: DvSyncState = { busy: false };
export const dvState = (roomId: string) => states.get(roomId) ?? IDLE;
export function onDvState(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function set(roomId: string, patch: Partial<DvSyncState>) {
  states.set(roomId, { ...dvState(roomId), ...patch });
  listeners.forEach((l) => l());
}

const lastSig = new Map<string, string>(); // última sala (membros, papéis, diversion) já conferida: não repete à toa
const running = new Set<string>();
const again = new Map<string, Room>(); // sala mudou durante a conferência: roda de novo no fim

/** Confere uma sala. `force` = uids para reenviar convite; `refresh` = conferir mesmo sem mudança (painel aberto, "tentar de novo"). */
export async function syncDiversion(room: Room, opts: { force?: string[]; refresh?: boolean } = {}) {
  const token = getDvToken();
  if (!token || room.kind !== "unreal" || !room.diversion) return;
  const sig = JSON.stringify([room.memberIds, room.roles, room.diversion]);
  if (running.has(room.id)) {
    again.set(room.id, room);
    return;
  }
  if (!opts.refresh && !opts.force?.length && lastSig.get(room.id) === sig) return;
  lastSig.set(room.id, sig); // também no erro: tenta de novo só se a sala mudar ou pelo botão (não martela a API)
  running.add(room.id);
  set(room.id, { busy: true, error: undefined });
  try {
    const api = dvApi(token);
    let d: DvRoom = room.diversion;
    if (!d.repoId) {
      d = { ...d, ...(await ensureRepo(api, repoName(room.name, room.id), `GameForge: ${room.name} (Content/ do Unreal)`)) };
      await updateRoomSettings(room.id, { diversion: d });
    }
    const emails = new Map((await listProfiles()).map((p) => [p.uid, p.email]));
    const members = room.memberIds.map((uid) => ({ uid, name: room.names[uid] ?? uid, email: emails.get(uid) ?? "", role: room.roles[uid] ?? "viewer" }));
    const r = await runSync(api, d.repoId!, members, d.invited, opts.force);
    if (JSON.stringify(r.invited) !== JSON.stringify(d.invited ?? {})) await updateRoomSettings(room.id, { diversion: { ...d, invited: r.invited } });
    set(room.id, { members: r.status, at: Date.now() });
  } catch (e) {
    set(room.id, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    running.delete(room.id);
    set(room.id, { busy: false });
    const next = again.get(room.id);
    again.delete(room.id);
    if (next) void syncDiversion(next);
  }
}

/** No app inteiro (Home): com o token neste PC, confere as salas Unreal das quais esta pessoa é dona. */
export function useDiversionSync(user: User | null | undefined) {
  const token = useSyncExternalStore(onDvToken, getDvToken);
  const uid = user && ALLOWED_EMAILS.includes(user.email ?? "") ? user.uid : null;
  useEffect(() => {
    if (!uid || !token) return;
    lastSig.clear(); // token novo: confere tudo de novo
    return watchMyRooms(
      uid,
      (rooms) => rooms.forEach((r) => r.ownerId === uid && void syncDiversion(r)),
      (e) => console.warn("diversion:", e),
      true,
    );
  }, [uid, token]);
}
