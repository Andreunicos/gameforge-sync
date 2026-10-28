// Multi-User do Unreal por rede virtual (Radmin VPN; Tailscale e ZeroTier também), sem digitar IP:
// quem hospeda usa o IP da VPN deste PC + uma porta fixa da sala e publica em presence.mue; quem entra lê o mue do host.
// O Rust (vpn.rs) lista as placas; o servidor fecha sozinho se a VPN cair (vigia em unreal.rs). Aqui: regras puras
// (testadas em tests/vpn.test.ts) e o vigia da tela (tira o mue da presença e avisa).
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ueStatus } from "./unreal";
import type { RoomSync } from "./sync/roomSync";
import type { Presence } from "./types";

export type VpnKind = "radmin" | "tailscale" | "zerotier" | "";

/** Uma placa de rede ligada deste PC (vpn_addrs, Rust). */
export interface NetAddr {
  name: string;
  ip: string;
  prefix: number;
  kind: VpnKind;
}

export type Mue = NonNullable<Presence["mue"]>;

export const VPN_LABEL: Record<Exclude<VpnKind, "">, string> = { radmin: "Radmin VPN", tailscale: "Tailscale", zerotier: "ZeroTier" };
export const VPN_POLL_MS = 5000;
export const VPN_GRACE_MS = 10_000; // igual ao VPN_GRACE do Rust

export const netAddrs = () => invoke<NetAddr[]>("vpn_addrs");

/** A rede virtual que o Multi-User usa: Radmin primeiro (a da turma), depois ZeroTier e Tailscale. */
export function pickVpn(list: NetAddr[]): NetAddr | undefined {
  for (const k of ["radmin", "zerotier", "tailscale"] as const) {
    const a = list.find((x) => x.kind === k);
    if (a) return a;
  }
  return undefined;
}

/** Porta UDP fixa da sala (50000–59989, a mesma em todo PC e todo dia): FNV-1a do id. Sobra espaço para +10 se estiver ocupada. */
export function stablePort(roomId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < roomId.length; i++) h = Math.imul(h ^ roomId.charCodeAt(i), 0x01000193) >>> 0;
  return 50000 + (h % 9990);
}

/** Endereço do servidor deste PC: o digitado à mão; senão IP da VPN + porta da sala; senão "" (rede local). */
export function hostAddr(manual: string, vpn: NetAddr | undefined, roomId: string, bump = 0): string {
  return manual.trim() || (vpn ? `${vpn.ip}:${stablePort(roomId) + bump}` : "");
}

const ipNum = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.some((x) => x > 255) ? null : ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
};

/** O IP está na mesma rede (sub-rede) desta placa? */
export function sameNet(ip: string, a: NetAddr): boolean {
  const x = ipNum(ip);
  const y = ipNum(a.ip);
  if (x === null || y === null || a.prefix < 1 || a.prefix > 32) return false;
  const mask = a.prefix === 32 ? 0xffffffff : ~(0xffffffff >>> a.prefix) >>> 0;
  return ((x & mask) >>> 0) === ((y & mask) >>> 0);
}

/** Tipo de rede virtual só pela faixa do IP (como o Rust, sem o nome da placa). */
export function rangeKind(ip: string): VpnKind {
  const n = ipNum(ip);
  if (n === null) return "";
  if (n >>> 24 === 26) return "radmin";
  if (n >>> 22 === (100 << 2) + 1) return "tailscale"; // 100.64.0.0/10
  return "";
}

/**
 * Antes de abrir o editor: o endereço do host dá para alcançar daqui? "error" = com certeza não (falta a VPN);
 * "warn" = estranho (a pessoa decide). Não testa a porta: o UDP do Multi-User não responde a teste nenhum.
 */
export function checkHostAddr(addr: string, mine: NetAddr[]): { level: "error" | "warn"; text: string } | null {
  const ip = addr.slice(0, addr.lastIndexOf(":"));
  if (ipNum(ip) === null) return null; // nome de máquina: não dá para conferir
  if (mine.some((a) => sameNet(ip, a))) return null;
  const k = rangeKind(ip);
  const vpn = pickVpn(mine);
  if (k) {
    return {
      level: "error",
      text: vpn
        ? `O host está na rede ${VPN_LABEL[k]} (${ip}), mas este PC está em outra rede virtual (${vpn.ip}). Entrem na MESMA rede do ${VPN_LABEL[k]}.`
        : `O host está no ${VPN_LABEL[k]} (${ip}) e este PC não: abra o ${VPN_LABEL[k]}, ligue e entre na mesma rede do host.`,
    };
  }
  return {
    level: "warn",
    text: vpn
      ? `O IP do host (${ip}) não é da sua rede virtual (${vpn.ip}) nem da sua rede local: o host hospedou fora da VPN? Peça para ele abrir o Radmin VPN antes de clicar em Hospedar.`
      : `O IP do host (${ip}) não é da sua rede local e este PC não tem rede virtual ligada: abra o Radmin VPN e entre na rede do host.`,
  };
}

/** Quem hospeda, entre os outros: o que usa o mesmo servidor/sessão configurados aqui; senão o primeiro pelo nome. */
export function pickHost(people: Presence[], meUid: string, server: string, session: string): Presence | undefined {
  const hosts = people.filter((p) => p.mue && p.uid !== meUid).sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
  return hosts.find((p) => p.mue!.server === server && p.mue!.session === session) ?? hosts[0];
}

export interface JoinTarget extends Mue {
  /** manual = campo IP:porta preenchido; host = mue de outra pessoa; self = este PC hospeda; none = ninguém hospeda. */
  from: "manual" | "host" | "self" | "none";
  hostName?: string;
}

/** Para onde o editor vai: o digitado à mão ganha; senão o host da sala (servidor, sessão e endereço dele); senão eu mesmo. */
export function joinTarget(s: { server: string; session: string; addr: string }, people: Presence[], meUid: string): JoinTarget {
  if (s.addr.trim()) return { server: s.server, session: s.session, addr: s.addr.trim(), from: "manual" };
  const h = pickHost(people, meUid, s.server, s.session);
  if (h) return { ...h.mue!, from: "host", hostName: h.name };
  const mine = people.find((p) => p.uid === meUid)?.mue;
  if (mine) return { ...mine, from: "self" };
  return { server: s.server, session: s.session, addr: "", from: "none" };
}

/** Histerese da queda da VPN (igual a vpn::lost do Rust): desde quando sumiu e se já passou do prazo. */
export function vpnLost(since: number | null, present: boolean, now: number, graceMs = VPN_GRACE_MS): { since: number | null; lost: boolean } {
  if (present) return { since: null, lost: false };
  const s = since ?? now;
  return { since: s, lost: now - s >= graceMs };
}

// ── endereço que este PC hospedou (para republicar o mue depois de recarregar a tela) ──

export function saveHosted(roomId: string, addr: string | null) {
  try {
    if (addr === null) localStorage.removeItem(`gfs-mue-${roomId}`);
    else localStorage.setItem(`gfs-mue-${roomId}`, addr);
  } catch {
    /* sem storage */
  }
}

export function loadHosted(roomId: string): string | null {
  try {
    return localStorage.getItem(`gfs-mue-${roomId}`);
  } catch {
    return null;
  }
}

/**
 * Vigia da tela, numa sala Unreal com a pasta ligada:
 * - este PC hospeda (mue publicado): servidor parou (VPN caiu e o Rust derrubou, ou fechou sozinho) → tira o mue e avisa;
 * - este editor está numa sessão do Multi-User como convidado: a VPN que estava ligada sumiu por 10 s → avisa (não fecha nada).
 * App antigo (sem vpn_addrs): só o primeiro, com aviso genérico.
 */
export function useMueWatch(roomId: string, sync: RoomSync, dir: string | undefined, myMue: Mue | null | undefined, inSession: boolean) {
  const mueRef = useRef(myMue);
  mueRef.current = myMue;
  const hosting = !!myMue;

  useEffect(() => {
    if (!dir || !hosting) return;
    let alive = true;
    const t = window.setInterval(async () => {
      const mue = mueRef.current;
      if (!mue) return;
      const st = await ueStatus(dir, 0).catch(() => null); // só o servidor importa aqui (porta 0 = não testa MCP)
      if (!alive || !st || st.server || !mueRef.current) return;
      const ip = mue.addr.slice(0, mue.addr.lastIndexOf(":"));
      const nets = ip ? await netAddrs().catch(() => null) : null;
      if (!alive || !mueRef.current) return;
      sync.setUnreal({ mue: null });
      saveHosted(roomId, null);
      const vpnGone = nets && !nets.some((a) => a.ip === ip);
      sync.onToast({
        kind: "warn",
        text: vpnGone
          ? `${VPN_LABEL[rangeKind(ip) || "radmin"]} desconectado neste PC: o servidor do Multi-User foi desligado e a sessão parou para todos. Ligue a VPN e clique em Hospedar de novo.`
          : "O servidor do Multi-User deste PC fechou (veja .gfs/mue-server.log na pasta da sala). Clique em Hospedar de novo no 🔌 Conectar Unreal.",
      });
    }, VPN_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [roomId, sync, dir, hosting]);

  useEffect(() => {
    if (!dir || hosting || !inSession) return;
    let alive = true;
    let since: number | null = null;
    let had = false; // só avisa quem estava numa VPN (rede local não tem o que cair)
    let warned = false;
    const t = window.setInterval(async () => {
      const nets = await netAddrs().catch(() => null);
      if (!alive || !nets) return; // app antigo: sem aviso
      const v = pickVpn(nets);
      if (v) had = true;
      if (!had) return;
      const r = vpnLost(since, !!v, Date.now());
      since = r.since;
      if (!r.lost) warned = false;
      else if (!warned) {
        warned = true;
        sync.onToast({
          kind: "warn",
          text: "Rede virtual (Radmin VPN) desconectada: o Multi-User vai parar de sincronizar. O seu Unreal continua aberto: salve o seu trabalho e ligue a VPN de novo.",
        });
      }
    }, VPN_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [sync, dir, hosting, inSession]);
}
