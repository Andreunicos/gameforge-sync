import { createServer } from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API_KEY, LOGIN_PAGE } from "./config.ts";

export interface Session {
  uid: string;
  email: string;
  name: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
}

const DIR = join(homedir(), ".gfs");
const FILE = join(DIR, "auth.json");

function load(): Session | null {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Session;
  } catch {
    return null;
  }
}

function save(s: Session) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function logout() {
  rmSync(FILE, { force: true });
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32"
      ? `rundll32 url.dll,FileProtocolHandler "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/** Abre a página de login no navegador e espera o id_token do Google voltar em 127.0.0.1. */
function waitForGoogleToken(): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get("state") === state && url.searchParams.get("id_token");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
      res.end(
        `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#120f19;color:#f1ebf8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>${ok ? "Pronto!" : "Ops"}</h1><p style="color:#9a8fb0">${ok ? "O gfs está logado. Pode fechar esta aba." : "Login inválido. Rode gfs login de novo."}</p></div>`,
      );
      clearTimeout(timer);
      server.close();
      if (ok) resolve(url.searchParams.get("id_token")!);
      else reject(new Error("resposta de login inválida"));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("tempo esgotado (5 min) esperando o login no navegador"));
    }, 300_000);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const url = `${LOGIN_PAGE}?port=${port}&state=${state}`;
      console.log("Abrindo o navegador para entrar com o Google…");
      console.log(`Se não abrir, acesse: ${url}`);
      openBrowser(url);
    });
  });
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`login recusado: ${data.error?.message ?? res.status}`);
  return data;
}

export async function login(): Promise<Session> {
  const token = await waitForGoogleToken();
  // Login por e-mail (Hotmail etc.): a página devolve "emaillink:" + {email, link}.
  const r = token.startsWith("emaillink:")
    ? await (async () => {
        const { email, link } = JSON.parse(token.slice("emaillink:".length)) as { email: string; link: string };
        const oobCode = new URL(link).searchParams.get("oobCode");
        if (!oobCode) throw new Error("link de e-mail inválido");
        return postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=${API_KEY}`, { email, oobCode });
      })()
    : await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${API_KEY}`, {
        postBody: `id_token=${token}&providerId=google.com`,
        requestUri: "http://localhost",
        returnSecureToken: true,
      });
  const s: Session = {
    uid: String(r.localId),
    email: String(r.email ?? ""),
    name: String(r.displayName || String(r.email ?? "").split("@")[0] || "Anônimo"),
    refreshToken: String(r.refreshToken),
    idToken: String(r.idToken),
    expiresAt: Date.now() + Number(r.expiresIn ?? 3600) * 1000,
  };
  save(s);
  return s;
}

/** Sessão válida (renova o token sozinho). Sem login → erro com instrução. */
export async function session(): Promise<Session> {
  const s = load();
  if (!s) throw new Error("não logado. Rode: gfs login");
  if (Date.now() < s.expiresAt - 120_000) return s;
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refreshToken }),
  });
  const d = (await res.json()) as { id_token?: string; refresh_token?: string; expires_in?: string };
  if (!res.ok || !d.id_token) throw new Error("sessão expirou. Rode: gfs login");
  const next = { ...s, idToken: d.id_token, refreshToken: d.refresh_token ?? s.refreshToken, expiresAt: Date.now() + Number(d.expires_in ?? 3600) * 1000 };
  save(next);
  return next;
}
