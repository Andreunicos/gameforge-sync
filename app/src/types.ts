import type { Timestamp } from "firebase/firestore";

export type Role = "owner" | "editor" | "viewer";

export interface Room {
  id: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  roles: Record<string, Role>;
  names: Record<string, string>;
  minAppVersion: string;
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
}
