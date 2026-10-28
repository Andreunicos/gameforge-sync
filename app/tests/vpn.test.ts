// Multi-User por rede virtual (src/vpn.ts): regras puras. O Radmin de verdade não dá para testar aqui.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/firebase", () => ({ db: {}, auth: {}, app: {}, rtdb: () => ({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...a: string[]) => a.join("/") }));
vi.mock("@tauri-apps/plugin-fs", () => ({}));

import { checkHostAddr, hostAddr, joinTarget, pickHost, pickVpn, rangeKind, sameNet, stablePort, vpnLost, type NetAddr } from "../src/vpn";
import type { Presence } from "../src/types";

const radmin: NetAddr = { name: "Radmin VPN", ip: "26.12.34.56", prefix: 8, kind: "radmin" };
const wifi: NetAddr = { name: "Wi-Fi", ip: "192.168.0.10", prefix: 24, kind: "" };
const ts: NetAddr = { name: "Tailscale", ip: "100.101.1.2", prefix: 10, kind: "tailscale" };
const zt: NetAddr = { name: "ZeroTier One [abc]", ip: "10.147.17.5", prefix: 24, kind: "zerotier" };
const person = (uid: string, name: string, mue?: Presence["mue"]): Presence => ({ uid, name, color: "#fff", file: null, line: 1, col: 0, at: 0, mue });

describe("rede virtual", () => {
  it("escolhe Radmin, depois ZeroTier, depois Tailscale; placa comum não conta", () => {
    expect(pickVpn([wifi, ts, radmin])).toBe(radmin);
    expect(pickVpn([wifi, ts, zt])).toBe(zt);
    expect(pickVpn([ts, wifi])).toBe(ts);
    expect(pickVpn([wifi])).toBeUndefined();
  });

  it("faixa do IP igual ao Rust", () => {
    expect(rangeKind("26.0.0.1")).toBe("radmin");
    expect(rangeKind("100.64.0.1")).toBe("tailscale");
    expect(rangeKind("100.127.255.255")).toBe("tailscale");
    expect(rangeKind("100.128.0.1")).toBe("");
    expect(rangeKind("100.63.255.255")).toBe("");
    expect(rangeKind("25.1.1.1")).toBe("");
    expect(rangeKind("pc-do-andre")).toBe("");
    expect(rangeKind("26.300.1.1")).toBe("");
  });

  it("mesma sub-rede pela máscara da placa", () => {
    expect(sameNet("26.99.1.2", radmin)).toBe(true);
    expect(sameNet("27.99.1.2", radmin)).toBe(false);
    expect(sameNet("192.168.0.200", wifi)).toBe(true);
    expect(sameNet("192.168.1.200", wifi)).toBe(false);
    expect(sameNet("100.127.0.9", ts)).toBe(true);
    expect(sameNet("10.147.17.5", { ...zt, prefix: 32 })).toBe(true);
    expect(sameNet("10.147.17.6", { ...zt, prefix: 32 })).toBe(false);
  });

  it("porta da sala: fixa, entre 50000 e 59989, muda com a sala", () => {
    const p = stablePort("AbC123xyz");
    expect(p).toBe(stablePort("AbC123xyz"));
    expect(p).toBeGreaterThanOrEqual(50000);
    expect(p + 9).toBeLessThan(60000);
    const many = new Set(Array.from({ length: 200 }, (_, i) => stablePort(`sala${i}`)));
    expect(many.size).toBeGreaterThan(190);
    for (const x of many) expect(x >= 50000 && x <= 59989).toBe(true);
  });

  it("endereço de quem hospeda: manual ganha; senão VPN + porta da sala; sem VPN = rede local", () => {
    const p = stablePort("sala1");
    expect(hostAddr(" 10.0.0.1:55555 ", radmin, "sala1")).toBe("10.0.0.1:55555");
    expect(hostAddr("", radmin, "sala1")).toBe(`26.12.34.56:${p}`);
    expect(hostAddr("", radmin, "sala1", 2)).toBe(`26.12.34.56:${p + 2}`);
    expect(hostAddr("", undefined, "sala1")).toBe("");
  });
});

describe("antes de conectar", () => {
  it("host na mesma rede virtual: ok", () => {
    expect(checkHostAddr("26.1.2.3:55000", [wifi, radmin])).toBeNull();
    expect(checkHostAddr("192.168.0.50:55000", [wifi])).toBeNull(); // rede local
    expect(checkHostAddr("pc-do-andre:55000", [])).toBeNull(); // nome: não confere
  });
  it("host no Radmin e eu sem Radmin: erro claro", () => {
    const r = checkHostAddr("26.1.2.3:55000", [wifi]);
    expect(r?.level).toBe("error");
    expect(r?.text).toMatch(/abra o Radmin VPN/);
    expect(checkHostAddr("26.1.2.3:55000", [wifi, ts])?.text).toMatch(/MESMA rede/);
  });
  it("IP do host fora da VPN e da rede local: só aviso", () => {
    expect(checkHostAddr("192.168.5.5:55000", [wifi, radmin])?.level).toBe("warn");
    expect(checkHostAddr("192.168.5.5:55000", [wifi])?.level).toBe("warn");
  });
});

describe("quem hospeda", () => {
  const s = { server: "gameforge", session: "MeuJogo", addr: "" };
  const bia = person("b", "Bia", { server: "gameforge", session: "MeuJogo", addr: "26.1.1.1:55000" });
  const caio = person("c", "Caio", { server: "outro", session: "X", addr: "26.2.2.2:55001" });
  const eu = person("me", "Eu");

  it("prefere o host com o mesmo servidor/sessão; senão o primeiro pelo nome; nunca eu", () => {
    expect(pickHost([caio, bia, eu], "me", "gameforge", "MeuJogo")).toBe(bia);
    expect(pickHost([caio, bia], "me", "nada", "nada")).toBe(bia);
    expect(pickHost([person("me", "Eu", bia.mue)], "me", "gameforge", "MeuJogo")).toBeUndefined();
  });

  it("manual > host > eu mesmo > ninguém", () => {
    expect(joinTarget({ ...s, addr: " 1.2.3.4:5 " }, [bia], "me")).toMatchObject({ from: "manual", addr: "1.2.3.4:5", server: "gameforge" });
    expect(joinTarget(s, [caio, eu], "me")).toMatchObject({ from: "host", hostName: "Caio", server: "outro", session: "X", addr: "26.2.2.2:55001" });
    const self = person("me", "Eu", { server: "gameforge", session: "MeuJogo", addr: "26.9.9.9:55000" });
    expect(joinTarget(s, [self], "me")).toMatchObject({ from: "self", addr: "26.9.9.9:55000" });
    expect(joinTarget(s, [eu], "me")).toMatchObject({ from: "none", addr: "" });
  });
});

describe("queda da VPN (relógio simulado)", () => {
  it("só cai depois de 10 s seguidos fora; voltar zera", () => {
    let st = vpnLost(null, true, 0);
    expect(st).toEqual({ since: null, lost: false });
    st = vpnLost(st.since, false, 5000); // sumiu
    expect(st).toEqual({ since: 5000, lost: false });
    st = vpnLost(st.since, false, 14_000);
    expect(st.lost).toBe(false);
    st = vpnLost(st.since, true, 15_000); // voltou
    expect(st).toEqual({ since: null, lost: false });
    st = vpnLost(st.since, false, 20_000);
    st = vpnLost(st.since, false, 29_999);
    expect(st.lost).toBe(false);
    st = vpnLost(st.since, false, 30_000);
    expect(st).toEqual({ since: 20_000, lost: true });
  });
});
