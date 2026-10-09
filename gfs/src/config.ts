// Mesmo projeto Firebase do app (config pública; quem protege são as regras).
export const API_KEY = "AIzaSyBuFsgekAZdraWUeAx0zpEJQwGi5AGRnks";
export const PROJECT_ID = "gameforge-sync";
export const RTDB_URL = "https://gameforge-sync-default-rtdb.firebaseio.com";
export const LOGIN_PAGE = "https://gameforge-sync.web.app/login";
export const LATEST_JSON = "https://github.com/Andreunicos/gameforge-sync/releases/latest/download/latest.json";
export const INSTALL_CMD = "npm i -g https://github.com/Andreunicos/gameforge-sync/releases/latest/download/gfs.tgz";

export const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
export const DOC_ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;

/** Só arquivos de texto/código vão para a sala; imagens e sons ficam no repo do jogo. */
export const TEXT_EXT = /\.(html?|js|mjs|cjs|ts|css|json|txt|md|csv|xml|svg|glsl|frag|vert)$/i;
export const IGNORE_DIRS = new Set([".gfs", ".git", "node_modules", "dist", "android", "ios", ".claude", "builds"]);

declare const __GFS_VERSION__: string;
export const VERSION: string = typeof __GFS_VERSION__ === "string" ? __GFS_VERSION__ : "dev";
