// Pastas só visuais para organizar a lista de salas. Cada pessoa tem as suas (localStorage, por conta neste PC):
// não vão para o Firebase nem mudam nada na sala. Apagar uma pasta só solta as salas dela.
export interface RoomFolders {
  folders: { id: string; name: string; open: boolean }[];
  /** salaId → pastaId */
  of: Record<string, string>;
}

const key = (uid: string) => `gfs-folders-${uid}`;
const EMPTY: RoomFolders = { folders: [], of: {} };

export function loadFolders(uid: string): RoomFolders {
  try {
    const raw = JSON.parse(localStorage.getItem(key(uid)) ?? "null");
    if (!raw || !Array.isArray(raw.folders) || typeof raw.of !== "object" || !raw.of) return EMPTY;
    const folders = raw.folders
      .filter((f: { id?: unknown; name?: unknown }) => typeof f?.id === "string" && typeof f?.name === "string")
      .map((f: { id: string; name: string; open?: unknown }) => ({ id: f.id, name: f.name, open: f.open !== false }));
    return { folders, of: raw.of };
  } catch {
    return EMPTY;
  }
}

export function saveFolders(uid: string, f: RoomFolders) {
  try {
    localStorage.setItem(key(uid), JSON.stringify(f));
  } catch {
    /* sem storage: as pastas valem só até fechar a tela */
  }
}

const clean = (name: string) => name.trim().slice(0, 40);

export function addFolder(f: RoomFolders, name: string): RoomFolders {
  const n = clean(name);
  if (!n) return f;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { ...f, folders: [...f.folders, { id, name: n, open: true }] };
}

export function renameFolder(f: RoomFolders, id: string, name: string): RoomFolders {
  const n = clean(name);
  return n ? { ...f, folders: f.folders.map((x) => (x.id === id ? { ...x, name: n } : x)) } : f;
}

export const toggleFolder = (f: RoomFolders, id: string): RoomFolders => ({
  ...f,
  folders: f.folders.map((x) => (x.id === id ? { ...x, open: !x.open } : x)),
});

/** As salas da pasta voltam para a lista solta (nada é apagado). */
export function removeFolder(f: RoomFolders, id: string): RoomFolders {
  return { folders: f.folders.filter((x) => x.id !== id), of: Object.fromEntries(Object.entries(f.of).filter(([, v]) => v !== id)) };
}

/** `folderId` null = sem pasta. */
export function moveRoom(f: RoomFolders, roomId: string, folderId: string | null): RoomFolders {
  const of = { ...f.of };
  if (folderId && f.folders.some((x) => x.id === folderId)) of[roomId] = folderId;
  else delete of[roomId];
  return { ...f, of };
}

export function folderOf(f: RoomFolders, roomId: string): string | null {
  const id = f.of[roomId];
  return id && f.folders.some((x) => x.id === id) ? id : null;
}

/** Pastas na ordem em que foram criadas (mesmo vazias) e, no fim, as salas sem pasta. */
export function groupRooms<R extends { id: string }>(f: RoomFolders, rooms: R[]) {
  return {
    folders: f.folders.map((folder) => ({ folder, rooms: rooms.filter((r) => folderOf(f, r.id) === folder.id) })),
    loose: rooms.filter((r) => folderOf(f, r.id) === null),
  };
}
