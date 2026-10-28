import type { Timestamp } from "firebase/firestore";

export type RoomKind = "html5" | "roblox" | "unreal";
export type Role = "owner" | "editor" | "viewer";

export interface Room {
  id: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  roles: Record<string, Role>;
  names: Record<string, string>;
  minAppVersion: string;
  /** Tipo da sala; ausente = html5 (salas antigas). */
  kind?: RoomKind;
  /** URL base dos assets (ex.: GitHub Pages do repo do jogo); o preview usa como <base href>. */
  assetsBase: string;
  inviteCode?: string;
  createdAt?: Timestamp;
}

export interface Author {
  uid: string;
  name: string;
  /** "claude" quando quem gravou foi o gfs (o Claude daquela pessoa). */
  kind: "human" | "claude";
}

/** rooms/{roomId}/files/{fileId} — um arquivo de código. */
export interface RemoteFile {
  id: string;
  path: string;
  content: string;
  version: number;
  author: Author;
  updatedAt?: Timestamp;
  /** Arquivo grande: o conteúdo está em `parts` pedaços em rooms/{id}/blobs (ver bigfile.ts). */
  parts?: number;
  size?: number;
}

/** rooms/{roomId}/activity/{id} */
export interface ActivityEvent {
  id: string;
  author: Author;
  kind: "create" | "edit" | "delete" | "join" | "import";
  file?: string;
  summary: string;
  ts?: Timestamp;
}

/** Realtime Database: presence/{roomId}/{uid} */
export interface Presence {
  uid: string;
  name: string;
  color: string;
  file: string | null;
  line: number;
  col: number;
  at: number;
  /** Pasta do Claude ligada no app desta pessoa, e o último arquivo que o Claude mexeu. */
  claudeOn?: boolean;
  claudeFile?: string | null;
  /** Sala Unreal: mapa aberto (/Game/...) e atores selecionados no editor (rótulo + caminho único do ator). */
  ue?: { map: string; sel?: { l: string; n: string }[] } | null;
  /** Sala Unreal: esta pessoa hospeda o servidor do Multi-User (o que os outros põem no painel Conectar). */
  mue?: { server: string; session: string; addr: string } | null;
}
