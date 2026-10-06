import {
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "./firebase";
import { displayName } from "./auth";
import { countWrite } from "./usage";
import { APP_VERSION } from "./config";
import type { ActivityEvent, Author, Role, Room } from "./types";

export function authorOf(user: User): Author {
  return { uid: user.uid, name: displayName(user), kind: "human" };
}

/** Grava o perfil (nome/e-mail) para o dono da sala conseguir adicionar a pessoa sem código. */
export async function saveProfile(user: User) {
  await setDoc(
    doc(db, "users", user.uid),
    { name: displayName(user), email: user.email ?? "", lastSeen: serverTimestamp() },
    { merge: true },
  );
  countWrite();
}

export interface Profile {
  uid: string;
  name: string;
  email: string;
}

export async function listProfiles(): Promise<Profile[]> {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => ({ uid: d.id, ...(d.data() as { name: string; email: string }) }));
}

/** Dono adiciona alguém direto (a sala aparece sozinha na lista da pessoa). */
export async function addMember(owner: User, roomId: string, p: Profile, role: Role = "editor") {
  await updateDoc(doc(db, "rooms", roomId), {
    memberIds: arrayUnion(p.uid),
    [`roles.${p.uid}`]: role,
    [`names.${p.uid}`]: p.name,
  });
  countWrite();
  await logActivity(roomId, authorOf(owner), { kind: "join", summary: `adicionou ${p.name} à sala` });
}

export function watchMyRooms(uid: string, cb: (rooms: Room[]) => void, onError: (e: Error) => void) {
  const q = query(collection(db, "rooms"), where("memberIds", "array-contains", uid));
  return onSnapshot(
    q,
    (snap) => {
      const rooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Room);
      rooms.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
      cb(rooms);
    },
    onError,
  );
}

export function watchRoom(roomId: string, cb: (room: Room | null) => void, onError: (e: Error) => void) {
  return onSnapshot(
    doc(db, "rooms", roomId),
    (snap) => cb(snap.exists() ? ({ id: snap.id, ...snap.data() } as Room) : null),
    onError,
  );
}

export async function createRoom(user: User, name: string): Promise<string> {
  const ref = doc(collection(db, "rooms"));
  await setDoc(ref, {
    name,
    ownerId: user.uid,
    memberIds: [user.uid],
    roles: { [user.uid]: "owner" },
    names: { [user.uid]: displayName(user) },
    minAppVersion: APP_VERSION,
    assetsBase: "",
    createdAt: serverTimestamp(),
  });
  countWrite();
  return ref.id;
}

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/** Cria (ou troca) o código de convite da sala. Só o dono. */
export async function createInvite(user: User, room: Room, role: Role = "editor"): Promise<string> {
  const code = randomCode();
  await setDoc(doc(db, "invites", code), { roomId: room.id, role, createdBy: user.uid, createdAt: serverTimestamp() });
  if (room.inviteCode) await deleteDoc(doc(db, "invites", room.inviteCode)).catch(() => {});
  await updateDoc(doc(db, "rooms", room.id), { inviteCode: code });
  countWrite(3);
  return code;
}

/** Entra numa sala com o código de convite. Devolve o id da sala. */
export async function joinWithCode(user: User, rawCode: string): Promise<string> {
  const code = rawCode.trim().toUpperCase();
  const inv = await getDoc(doc(db, "invites", code));
  if (!inv.exists()) throw new Error("Código de convite não encontrado.");
  const { roomId, role } = inv.data() as { roomId: string; role: Role };
  try {
    await updateDoc(doc(db, "rooms", roomId), {
      memberIds: arrayUnion(user.uid),
      [`roles.${user.uid}`]: role,
      [`names.${user.uid}`]: displayName(user),
      lastJoinCode: code,
    });
    countWrite();
    await logActivity(roomId, authorOf(user), { kind: "join", summary: "entrou na sala" });
  } catch (e) {
    // Já é membro: as regras recusam o "entrar de novo", mas a sala abre normalmente.
    const room = await getDoc(doc(db, "rooms", roomId)).catch(() => null);
    if (!room?.exists()) throw e;
  }
  return roomId;
}

export async function updateRoomSettings(roomId: string, data: Partial<Pick<Room, "name" | "assetsBase" | "minAppVersion">>) {
  await updateDoc(doc(db, "rooms", roomId), data);
  countWrite();
}

export async function logActivity(
  roomId: string,
  author: Author,
  ev: Omit<ActivityEvent, "id" | "author" | "ts">,
): Promise<void> {
  await addDoc(collection(db, "rooms", roomId, "activity"), { ...ev, author, ts: serverTimestamp() });
  countWrite();
}

/** Compara versões "1.2.3". */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}
