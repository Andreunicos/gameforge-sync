// Mesmo projeto Firebase do app (config pública; quem protege são as regras).
export const API_KEY = "AIzaSyBuFsgekAZdraWUeAx0zpEJQwGi5AGRnks";
export const PROJECT_ID = "gameforge-sync";
export const RTDB_URL = "https://gameforge-sync-default-rtdb.firebaseio.com";
export const LOGIN_PAGE = "https://gameforge-sync.web.app/login";
export const LATEST_JSON = "https://github.com/Andreunicos/gameforge-sync/releases/latest/download/latest.json";
export const INSTALL_CMD = "npm i -g https://github.com/Andreunicos/gameforge-sync/releases/latest/download/gfs.tgz";

export const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
export const DOC_ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;

// Quais arquivos entram na sala: fileKinds.ts (igual ao do app).

declare const __GFS_VERSION__: string;
export const VERSION: string = typeof __GFS_VERSION__ === "string" ? __GFS_VERSION__ : "dev";
