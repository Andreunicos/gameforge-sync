// Git do Content/ (sala Unreal): regras puras, .gitignore/.gitattributes conferidos pelo git de verdade e a API do
// GitHub contra um servidor falso que imita a doc (nada é criado nem convidado na conta real).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));

import { GIT_ATTRIBUTES, GIT_IGNORE, anyCase, ensureGhRepo, ghApi, looksLikeGhToken, planAccess, runAccess, validLogin } from "../src/gitContent";
import { repoName } from "../src/diversion";
import { UNREAL_IGNORE_PATH } from "../src/sync/fileKinds";

const TOKEN = "ghp_FAKEfake0123456789abcdefABCDEF012345";

describe("regras do repositório", () => {
  it("nome, usuário e token", () => {
    expect(repoName("Capivaras TD!", "AbCdEfGh")).toBe("Capivaras_TD-AbCdEf");
    for (const ok of ["andre", "Andre-Luiz", "a1", "x".repeat(39)]) expect(validLogin(ok), ok).toBe(true);
    for (const bad of ["", "-a", "a-", "a--b", "a b", "a/b", "x".repeat(40), "../x"]) expect(validLogin(bad), bad).toBe(false);
    expect(looksLikeGhToken(TOKEN)).toBe(true);
    expect(looksLikeGhToken("dvk_123")).toBe(false);
    expect(anyCase("png")).toBe("*.[pP][nN][gG]");
    expect(anyCase("7z")).toBe("*.7[zZ]");
  });

  it(".gitignore e .gitattributes valem no git de verdade", () => {
    const dir = mkdtempSync(join(tmpdir(), "gfs-attr-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, ".gitignore"), GIT_IGNORE);
      writeFileSync(join(dir, ".gitattributes"), GIT_ATTRIBUTES);
      const attr = (p: string) => execFileSync("git", ["check-attr", "filter", "--", p], { cwd: dir, encoding: "utf8" }).trim();
      for (const p of ["BP_Player.uasset", "Maps/Arena.umap", "__ExternalActors__/Arena/A/B.uasset", "T_Rock.PNG", "Audio/x.wav", "M.uexp", "M.ubulk"])
        expect(attr(p), p).toMatch(/: filter: lfs$/);
      expect(attr("Data/notas.txt")).toMatch(/unspecified$/);
      expect(GIT_ATTRIBUTES).not.toMatch(/-text lockable|\slockable$/m); // deixaria os .uasset só-leitura e o Unreal não salva
      const ignored = (p: string) => {
        try {
          execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: dir });
          return true;
        } catch {
          return false;
        }
      };
      for (const p of ["Python/init_unreal.py", "Python/gameforge_presence.py", "x.tmp", "Thumbs.db"]) expect(ignored(p), p).toBe(true);
      for (const p of ["Maps/Arena.umap", "Blueprints/Python/BP.uasset", ".gitattributes"]) expect(ignored(p), p).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a sala nunca sincroniza Content/.git nem os binários (raiz ou subpasta)", () => {
    for (const p of ["Content/.git/config", "Content/.gitattributes", "Proj/Content/.git/lfs/objects/a", "Proj/Content/Maps/A.umap", "Content/BP.uasset"])
      expect(UNREAL_IGNORE_PATH.test(p), p).toBe(true);
    expect(UNREAL_IGNORE_PATH.test("Proj/Content/Python/init_unreal.py")).toBe(false);
  });
});

describe("planAccess", () => {
  const m = (uid: string, role: "owner" | "editor" | "viewer") => ({ uid, name: uid, role });
  it("convida editores, não espectadores, não repete e tira só quem o app pôs", () => {
    const g = { repo: "andre/jogo", users: { o: "andre", e: "Bia", v: "caio", n: "" }, invited: { gone: "zeca", e: "Bia" } };
    let r = planAccess([m("o", "owner"), m("e", "editor"), m("v", "viewer"), m("n", "editor")], g, ["manual"], [], "andre");
    expect(r.status.map((s) => s.state)).toEqual(["owner", "sent", "viewer", "nologin"]);
    expect(r.steps).toEqual([{ do: "remove", uid: "gone", login: "zeca", collab: false, inviteId: undefined }]);
    // "Convidar de novo"
    r = planAccess([m("e", "editor")], g, [], [], "andre", ["e"]);
    expect(r.steps).toContainEqual({ do: "invite", uid: "e", login: "Bia" });
    // aceitou (maiúsculas não importam) / convite pendente
    expect(planAccess([m("e", "editor")], g, ["bia"], [], "andre").status[0].state).toBe("ok");
    expect(planAccess([m("e", "editor")], { ...g, invited: {} }, [], [{ id: 7, login: "BIA" }], "andre").status[0].state).toBe("pending");
    // virou espectador: tira o acesso que o app deu (colaborador e convite)
    r = planAccess([m("e", "viewer")], g, ["Bia"], [{ id: 9, login: "bia" }], "andre");
    expect(r.steps).toContainEqual({ do: "remove", uid: "e", login: "Bia", collab: true, inviteId: 9 });
    // trocou de usuário: tira o velho e convida o novo; colaborador posto à mão nunca sai
    r = planAccess([m("e", "editor")], { ...g, users: { e: "bia2" } }, ["Bia", "manual"], [], "andre");
    expect(r.steps.map((s) => `${s.do}:${s.login}`)).toEqual(["remove:zeca", "remove:Bia", "invite:bia2"]);
    // o próprio dono nunca é convidado nem tirado
    expect(planAccess([m("e", "editor")], { users: { e: "ANDRE" }, invited: { x: "andre" } }, [], [], "andre").steps).toEqual([]);
  });
});

describe("API do GitHub (servidor falso)", () => {
  let server: Server;
  let base = "";
  const calls: string[] = [];
  const repos = new Map<string, { private: boolean }>([["andre/Publico-123456", { private: false }]]);
  const collabs = new Set<string>(["velho"]);
  const invites: { id: number; login: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const auth = req.headers.authorization;
      calls.push(`${req.method} ${req.url}`);
      const send = (code: number, body?: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (auth !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const url = req.url ?? "";
        if (req.method === "GET" && url === "/user") return send(200, { login: "andre" });
        if (req.method === "POST" && url === "/user/repos") {
          const b = JSON.parse(raw);
          if (b.private !== true) return send(400, { message: "teste: tem que ser privado" });
          const full = `andre/${b.name}`;
          if (repos.has(full)) return send(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
          repos.set(full, { private: true });
          return send(201, { full_name: full, private: true, default_branch: "main" });
        }
        const rm = url.match(/^\/repos\/([^/]+)\/([^/?]+)(.*)$/);
        if (!rm) return send(404, { message: "Not Found" });
        const full = `${rm[1]}/${rm[2]}`;
        const rest = rm[3];
        if (!repos.has(full)) return send(404, { message: "Not Found" });
        if (req.method === "GET" && rest === "") return send(200, { full_name: full, private: repos.get(full)!.private, default_branch: "main" });
        if (req.method === "GET" && rest.startsWith("/collaborators")) return send(200, [{ login: "andre" }, ...[...collabs].map((login) => ({ login }))]);
        if (req.method === "GET" && rest.startsWith("/invitations")) return send(200, invites.map((i) => ({ id: i.id, invitee: { login: i.login } })));
        let c = rest.match(/^\/collaborators\/([^/]+)$/);
        if (c && req.method === "PUT") {
          if (collabs.has(c[1])) return send(204);
          if (c[1] === "naoexiste") return send(422, { message: "Validation Failed" });
          invites.push({ id: invites.length + 1, login: c[1] });
          return send(201, { id: invites.length });
        }
        if (c && req.method === "DELETE") return collabs.delete(c[1]) ? send(204) : send(404, { message: "Not Found" });
        c = rest.match(/^\/invitations\/(\d+)$/);
        if (c && req.method === "DELETE") {
          const i = invites.findIndex((x) => x.id === Number(c![1]));
          if (i >= 0) invites.splice(i, 1);
          return send(204);
        }
        send(404, { message: "Not Found" });
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it("cria privado, reaproveita o mesmo nome e recusa público", async () => {
    const api = ghApi(TOKEN, base);
    expect(await ensureGhRepo(api, "Jogo-123456", "x")).toEqual({ repo: "andre/Jogo-123456", branch: "main" });
    expect(await ensureGhRepo(api, "Jogo-123456", "x")).toEqual({ repo: "andre/Jogo-123456", branch: "main" }); // 422 → o que já é desta conta
    await expect(ensureGhRepo(api, "Publico-123456", "x")).rejects.toThrow(/PÚBLICO/);
  });

  it("convida, guarda quem convidou, mostra erro de uma pessoa e tira quem saiu", async () => {
    const api = ghApi(TOKEN, base);
    const g = { repo: "andre/Jogo-123456", users: { e: "bia", x: "naoexiste", v: "velho" }, invited: { saiu: "velho" } };
    const members = [
      { uid: "o", name: "André", role: "owner" as const },
      { uid: "e", name: "Bia", role: "editor" as const },
      { uid: "x", name: "X", role: "editor" as const },
    ];
    const r = await runAccess(api, members, g);
    expect(r.ownerLogin).toBe("andre");
    expect(r.invited).toEqual({ e: "bia" });
    expect(r.status.find((s) => s.uid === "e")?.state).toBe("pending");
    expect(r.status.find((s) => s.uid === "x")?.error).toMatch(/recusou os dados/);
    expect(collabs.has("velho")).toBe(false);
    expect(invites.map((i) => i.login)).toEqual(["bia"]);
    // de novo: nada repetido
    const before = calls.length;
    const again = await runAccess(api, members, { ...g, invited: r.invited });
    expect(again.status.find((s) => s.uid === "e")?.state).toBe("pending");
    expect(calls.slice(before).filter((c) => c.startsWith("PUT"))).toEqual(["PUT /repos/andre/Jogo-123456/collaborators/naoexiste"]);
  });

  it("token errado: mensagem clara, sem o token", async () => {
    const bad = "ghp_ERRADOerrado0123456789abcdefABCDEF01";
    const e = await ensureGhRepo(ghApi(bad, base), "Y-123456", "x").catch((x) => x as Error);
    expect(e.message).toMatch(/Token do GitHub inválido/);
    expect(e.message).not.toContain(bad);
    const off = await ghApi(TOKEN, "http://127.0.0.1:1").me().catch((x) => x as Error);
    expect(off.message).toMatch(/Sem conexão/);
  });
});
