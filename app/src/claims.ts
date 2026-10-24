// Reservas de assets (soft locks) das salas Unreal. Binário não tem merge: quem vai mexer num .uasset/.umap
// (ou numa pasta de Content/) reserva antes, e o app de todo mundo mostra e escreve em .gfs/ASSETS.md.
//
// Todas as reservas da sala ficam num documento só (rooms/{id}/claims/assets, mapa chave → reserva): assim uma
// transação vê a tabela inteira e a checagem de sobreposição (pasta × arquivo dentro dela) é atômica entre 5 pessoas.
// As regras do Firestore garantem que cada gravação mexe numa chave só (`k`, mais uma vencida em `g` para limpar)
// e que ninguém toma uma reserva ativa de outra pessoa.
import { useEffect, useState } from "react";
import { Timestamp, doc, onSnapshot, runTransaction } from "firebase/firestore";
import { join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { db } from "./firebase";
import { countWrite } from "./usage";
import type { Author } from "./types";

export interface Claim {
  key: string;
  path: string;
  uid: string;
  name: string;
  note: string;
  exp: number;
}

interface Entry {
  path: string;
  uid: string;
  name: string;
  note: string;
  exp: Timestamp;
}

export const MAX_HOURS = 12; // as regras aceitam até 13 h (1 h de folga para relógio adiantado)
const GC_AFTER_MS = 60 * 60_000; // reserva vencida há 1 h some na próxima gravação (dá tempo do dono ver o aviso)
const ref = (roomId: string) => doc(db, "rooms", roomId, "claims", "assets");

/**
 * Chave única de um asset ou pasta, igual para todas as formas de escrever o mesmo asset:
 * Content/Maps/Arena.umap, /Game/Maps/Arena, /Game/Maps/Arena.Arena e a referência copiada no editor
 * (World'/Game/Maps/Arena.Arena'). Pasta termina com / (ou /*). Minúsculas: no Windows é o mesmo arquivo.
 */
export function claimKey(input: string): { key: string; path: string } | null {
  let p = input.trim().replace(/\\/g, "/");
  p = /'([^']+)'/.exec(p)?.[1] ?? p.replace(/^"|"$/g, "");
  const folder = /\/\*?$/.test(p);
  p = p.replace(/\/\*?$/, "");
  if (/^\/Game(\/|$)/i.test(p)) p = "Content" + p.slice(5).replace(/\.[^/]*$/, ""); // tira o .NomeDoObjeto
  const parts = p.split("/").filter((s) => s && s !== ".");
  if (!parts.length || parts.includes("..")) return null;
  const path = parts.join("/") + (folder ? "/" : "");
  const key = (folder ? path : path.replace(/\.(uasset|umap)$/i, "")).toLowerCase();
  return key.length <= 300 ? { key, path } : null;
}

/** Uma reserva cobre a outra? (mesma chave, ou uma é pasta e a outra está dentro dela) */
export const overlaps = (a: string, b: string) => a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));

const toClaims = (c: Record<string, Entry>): Claim[] =>
  Object.entries(c).map(([key, e]) => ({ key, path: e.path, uid: e.uid, name: e.name, note: e.note, exp: e.exp.toMillis() }));

export const hhmm = (ms: number) =>
  new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Grava a tabela mexendo só em `k` e, se houver, limpando UMA reserva vencida há tempo (o que as regras aceitam). */
function write(c: Record<string, Entry>, k: string, now: number) {
  const g = Object.keys(c).find((x) => x !== k && c[x].exp.toMillis() < now - GC_AFTER_MS);
  if (g) delete c[g];
  return g ? { c, k, g } : { c, k };
}

/** Transação na tabela: `fn` muda a tabela lida agora e devolve a chave mexida (null = nada a gravar). */
async function update(roomId: string, fn: (c: Record<string, Entry>, now: number) => string | null) {
  for (let i = 0; ; i++) {
    try {
      const wrote = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref(roomId));
        const c = { ...((snap.data()?.c as Record<string, Entry> | undefined) ?? {}) };
        const now = Date.now();
        const k = fn(c, now);
        if (k === null) return false;
        tx.set(ref(roomId), write(c, k, now));
        return true;
      });
      if (wrote) countWrite();
      return;
    } catch (e) {
      // Duas gravações ao mesmo tempo: as regras avaliam a que perdeu contra a tabela que a outra acabou de gravar e
      // recusam (permission-denied) em vez de pedir nova tentativa (visto no emulador). Tentar de novo relê a tabela.
      if (i >= 3 || (e as { code?: string }).code !== "permission-denied") throw e;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
    }
  }
}

/** Reserva (ou renova, se já é sua) um asset ou pasta. Erro se outra pessoa tem algo que se sobrepõe. */
export async function claimAsset(roomId: string, me: Author, input: string, note: string, hours: number) {
  const k = claimKey(input);
  if (!k) throw new Error("Caminho inválido. Ex.: Content/Maps/Arena.umap, /Game/Blueprints/BP_Player ou Content/Maps/ (pasta).");
  const ms = Math.min(Math.max(hours, 0.25), MAX_HOURS) * 3600_000;
  await update(roomId, (c, now) => {
    const other = toClaims(c).find((x) => x.uid !== me.uid && x.exp > now && overlaps(x.key, k.key));
    if (other) throw new Error(`${other.path} está reservado por ${other.name} até ${hhmm(other.exp)}. Fale com ${other.name}.`);
    c[k.key] = { path: k.path, uid: me.uid, name: me.name.slice(0, 80), note: note.trim().slice(0, 200), exp: Timestamp.fromMillis(now + ms) };
    return k.key;
  });
}

/** Libera uma reserva (a sua, uma vencida, ou qualquer uma se você é o dono da sala; as regras conferem). */
export async function releaseAsset(roomId: string, key: string) {
  await update(roomId, (c) => {
    if (!c[key]) return null;
    delete c[key];
    return key;
  });
}

/** Tabela viva de reservas (com as vencidas) e um relógio que anda a cada 30 s para elas vencerem na tela. */
export function useClaims(roomId: string, enabled: boolean) {
  const [list, setList] = useState<Claim[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const off = onSnapshot(
      ref(roomId),
      (s) => setList(toClaims((s.data()?.c as Record<string, Entry> | undefined) ?? {})),
      (e) => console.warn("reservas:", e),
    );
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [roomId, enabled]);
  return { list, now };
}

/** .gfs/ASSETS.md: o que o Claude lê antes de mexer em asset. Sem horário de geração: só muda quando as reservas mudam. */
export function assetsMd(claims: Claim[], meUid: string, now: number): string {
  const act = claims.filter((c) => c.exp > now).sort((a, b) => a.path.localeCompare(b.path));
  const rows = act.map(
    (c) =>
      `- ${c.path} — ${c.uid === meUid ? "VOCÊ (pode mexer)" : `${c.name} (NÃO mexa)`} · até ${hhmm(c.exp)}${c.note ? ` · ${c.note.replace(/\s+/g, " ")}` : ""}`,
  );
  return `# Reservas de assets (Content/)
Gerado pelo app GameForge Sync (não edite; não sincroniza). Caminho terminado em / = pasta: vale para tudo dentro.
Só mexa em asset reservado para VOCÊ. Sem reserva: peça à pessoa para reservar no botão 🔒 Unreal do app.
Se o app estiver fechado, esta lista está velha: não mexa em asset.

${rows.length ? rows.join("\n") : "Nenhuma reserva ativa."}
`;
}

export async function writeAssetsMd(dir: string, md: string) {
  await writeTextFile(await join(dir, ".gfs", "ASSETS.md"), md);
}
