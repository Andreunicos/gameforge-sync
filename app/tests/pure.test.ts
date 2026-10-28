// Funções puras do app (npm test). Firebase, Tauri e React não entram: os módulos que os importam recebem mocks.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/firebase", () => ({ db: {}, auth: {}, app: {}, rtdb: () => ({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...a: string[]) => a.join("/") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({}));

import { hasConflictMarkers, merge3 } from "../src/sync/merge";
import { assetsMd, claimKey, overlaps } from "../src/claims";
import { IGNORE_PATH, SECRET_PATH, UNREAL_IGNORE_PATH, isCodePath } from "../src/sync/fileKinds";
import { buildMap } from "../src/sync/mapa";
import { modeFor, planSync, repoName } from "../src/diversion";
import { pickEngine, pickMcpPort, pickProject, projectDirs, ueName } from "../src/unreal";
import { OLD_UE_PRESENCE, mergeClaudeSettings, roomTemplates, textHash, ueProjectRule, ueScripts } from "../src/sync/templates";
import { compactPlan } from "../src/history";
import { FIRST_PORT, wantedPort } from "../src/rojo";
import { consoleMd } from "../src/preview";

describe("merge3", () => {
  it("junta mudanças em linhas diferentes", () => {
    const r = merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "Bia");
    expect(r).toMatchObject({ text: "A\nb\nC\n", conflicts: 0 });
  });
  it("mesma linha = marcadores com o nome de quem mudou", () => {
    const r = merge3("a\n", "x\n", "y\n", "Bia");
    expect(r.conflicts).toBe(1);
    expect(hasConflictMarkers(r.text)).toBe(true);
    expect(r.text).toContain("Bia");
  });
  it("base vazia (arquivo novo dos dois lados) não perde nenhum", () => {
    const r = merge3("", "x\n", "y\n", "Bia");
    expect(r.text).toContain("x");
    expect(r.text).toContain("y");
  });
});

describe("claimKey / overlaps", () => {
  const k = (s: string) => claimKey(s)?.key;
  it("todas as formas do mesmo asset dão a mesma chave", () => {
    for (const s of ["Content/Maps/Arena.umap", "/Game/Maps/Arena", "/Game/Maps/Arena.Arena", "World'/Game/Maps/Arena.Arena'", "content\\maps\\ARENA.uasset"])
      expect(k(s)).toBe("content/maps/arena");
    expect(k("Content/Maps/")).toBe("content/maps/");
    expect(k("/Game/Maps/*")).toBe("content/maps/");
    expect(claimKey("../x")).toBeNull();
    expect(claimKey("   ")).toBeNull();
  });
  it("pasta × arquivo, sem confundir prefixo", () => {
    expect(overlaps("content/maps/", "content/maps/arena")).toBe(true);
    expect(overlaps("content/maps/arena", "content/maps/arena2")).toBe(false);
    expect(overlaps("content/map/", "content/maps/arena")).toBe(false);
  });
  it("mapa cobre __ExternalActors__/__ExternalObjects__ dele (One File Per Actor)", () => {
    const map = k("Content/Maps/Arena.umap")!;
    const actor = k("/Game/__ExternalActors__/Maps/Arena/0/AB/X1")!;
    const obj = k("/Game/__ExternalObjects__/Maps/Arena/3/CD/Y2")!;
    expect(overlaps(map, actor)).toBe(true);
    expect(overlaps(actor, map)).toBe(true);
    expect(overlaps(map, obj)).toBe(true);
    expect(overlaps(k("Content/Maps/")!, actor)).toBe(true); // pasta de mapas cobre os atores dos mapas
    expect(overlaps(k("Content/Maps/Arena2.umap")!, actor)).toBe(false);
    expect(overlaps(map, k("/Game/__ExternalActors__/Maps/Arena2/0/AB/X")!)).toBe(false);
  });
  it("projeto numa subpasta da sala: mesma chave de Content/ e /Game", () => {
    for (const s of ["TesteUnreal/Content/Maps/Arena.umap", "TesteUnreal\\Content\\Maps\\Arena.umap", "a/b/Content/Maps/Arena.uasset"]) expect(k(s), s).toBe("content/maps/arena");
    expect(claimKey("TesteUnreal/Content/Maps/Arena.umap")?.path).toBe("Content/Maps/Arena.umap");
    expect(k("TesteUnreal/Content/Maps/")).toBe("content/maps/");
    expect(overlaps(k("TesteUnreal/Content/Maps/")!, k("/Game/Maps/Arena")!)).toBe(true);
    expect(k("Plugins/P/Content/X.uasset")).toBe("plugins/p/content/x"); // conteúdo de plugin não é /Game
    expect(k("a/b/c/Content/X.uasset")).toBe("a/b/c/content/x"); // mais fundo que a busca do projeto: fica como está
    expect(claimKey("../Content/X")).toBeNull();
  });
  it("pasta comum ao lado do mapa (Maps/Arena/) não vira conflito com o mapa", () => {
    const map = k("Content/Maps/Arena.umap")!;
    expect(overlaps(map, k("Content/Maps/Arena/Texturas/T_x.uasset")!)).toBe(false);
    expect(overlaps(k("Content/Maps/Arena/Texturas/T_x.uasset")!, map)).toBe(false);
  });
});

describe("fileKinds", () => {
  it("código entra; binário, segredo e lixo de ferramenta não", () => {
    for (const p of ["index.html", "src/App.tsx", "a/b.py", "Main.server.luau", "Source/X/X.cpp", "Config/DefaultEngine.ini", "Dockerfile"])
      expect(isCodePath(p), p).toBe(true);
    for (const p of ["img.png", "a.uasset", ".env", "x/.env.local", "id_rsa", "key.pem", "package-lock.json", "a.min.js", "a.js.map", "my-secret.json"])
      expect(isCodePath(p), p).toBe(false);
    expect(SECRET_PATH.test(".env.example")).toBe(false);
  });
  it("pastas ignoradas", () => {
    for (const p of ["node_modules/x.js", "a/node_modules/x.js", ".gfs/state.json", "builds/x.html", "build/x.js", "dist/a.js"]) expect(IGNORE_PATH.test(p), p).toBe(true);
    expect(IGNORE_PATH.test("src/build/x.js")).toBe(false);
    expect(UNREAL_IGNORE_PATH.test("Content/Maps/a.json")).toBe(true);
    expect(UNREAL_IGNORE_PATH.test("Content/Python/a.py")).toBe(false);
    expect(UNREAL_IGNORE_PATH.test("Plugins/P/Binaries/x.json")).toBe(true);
  });
  it("filtro Unreal vale com o projeto numa subpasta", () => {
    for (const p of [
      "TesteUnreal/Content/Maps/a.json",
      "TesteUnreal/Saved/Config/WindowsEditor/Game.ini",
      "TesteUnreal/Intermediate/x.json",
      "TesteUnreal/DerivedDataCache/a.txt",
      "TesteUnreal/Binaries/Win64/x.json",
      "TesteUnreal/Build/x.cs",
      "TesteUnreal/.vs/x.json",
      "a/b/Content/x.ini",
    ])
      expect(UNREAL_IGNORE_PATH.test(p), p).toBe(true);
    for (const p of ["TesteUnreal/Content/Python/init_unreal.py", "TesteUnreal/Source/X/X.cpp", "TesteUnreal/Config/DefaultEngine.ini", "TesteUnreal/TesteUnreal.uproject", "Content/Python/gameforge_presence.py"])
      expect(UNREAL_IGNORE_PATH.test(p), p).toBe(false);
  });
  it("gfs usa o MESMO arquivo", () => {
    const app = readFileSync(new URL("../src/sync/fileKinds.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const gfs = readFileSync(new URL("../../gfs/src/fileKinds.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(gfs).toBe(app);
  });
});

describe("buildMap", () => {
  it("lista funções com linha", () => {
    const md = buildMap([["game.js", "const N = 600;\nfunction jump() {}\nconst move = () => 1;\n"], ["a.py", "def go():\n  pass\n"]], "Sala");
    expect(md).toContain("jump@2");
    expect(md).toContain("move@3");
    expect(md).not.toContain("N@1");
    expect(md).toContain("go@1");
  });
});

describe("diversion", () => {
  it("repoName e modeFor", () => {
    expect(repoName("Capivaras TD!", "AbCdEfGh")).toBe("Capivaras_TD-AbCdEf");
    expect(repoName("ção", "123456")).toBe("cao-123456");
    expect(modeFor("editor")).toBe("WRITE");
    expect(modeFor("viewer")).toBe("READ");
    expect(modeFor("owner")).toBeNull();
  });
  it("planSync convida, não repete convite e tira só quem o app pôs", () => {
    const m = (uid: string, email: string, role: "owner" | "editor" | "viewer") => ({ uid, name: uid, email, role });
    const c = { collaborators: [{ user_id: "x", email: "adm@x.com", access_mode: "ADMIN" as const }], invites: [] };
    const r = planSync([m("o", "o@x.com", "owner"), m("e", "E@x.com", "editor"), m("v", "", "viewer")], { gone: { email: "g@x.com", mode: "WRITE" } }, c);
    expect(r.steps).toEqual([
      { do: "invite", uid: "e", email: "E@x.com", mode: "WRITE", revoke: undefined },
      { do: "remove", uid: "gone", email: "g@x.com", userId: undefined, revoke: undefined },
    ]);
    expect(r.status.map((s) => s.state)).toEqual(["skip", "todo", "skip"]);
    const again = planSync([m("e", "e@x.com", "editor")], { e: { email: "e@x.com", mode: "WRITE" } }, { collaborators: [], invites: [] });
    expect(again.steps).toEqual([]);
    expect(again.status[0].state).toBe("sent");
    expect(planSync([m("e", "e@x.com", "editor")], { e: { email: "e@x.com", mode: "WRITE" } }, { collaborators: [], invites: [] }, ["e"]).steps).toHaveLength(1);
  });
});

describe("unreal", () => {
  it("ueName tira acento e espaço", () => {
    expect(ueName("André Luiz")).toBe("Andre_Luiz");
    expect(ueName("   ")).toBe("GameForge");
  });
  it("pickEngine: salva > versão do .uproject > mais nova", () => {
    const e = [{ root: "C:/UE_5.2", version: "5.2.1" }, { root: "C:/UE_5.8", version: "5.8.1" }, { root: "C:/UE_5.10", version: "5.10.0" }];
    expect(pickEngine(e, "c:/ue_5.2", "5.8")?.root).toBe("C:/UE_5.2");
    expect(pickEngine(e, "", "5.8")?.root).toBe("C:/UE_5.8");
    expect(pickEngine(e, "", "5.1")?.root).toBe("C:/UE_5.10");
    expect(pickEngine(e, "", "")?.root).toBe("C:/UE_5.10");
  });
  it("projectDirs: raiz e subpastas até 2 níveis, fora das geradas; raiz primeiro", () => {
    // Sala do André: Content/Python da sala na raiz (sem .uproject) e o projeto na pasta que o Unreal criou.
    const andre = ["CLAUDE.md", "Content/Python/init_unreal.py", "TesteUnreal/TesteUnreal.uproject", "TesteUnreal/Config/DefaultGame.ini"];
    expect(projectDirs(andre)).toEqual(["TesteUnreal"]);
    expect(pickProject(projectDirs(andre))).toBe("TesteUnreal");
    expect(projectDirs(["Jogo.uproject", "Source/Jogo/Jogo.cpp"])).toEqual([""]);
    expect(projectDirs(["a/b/P.uproject", "a/b/c/Q.uproject"])).toEqual(["a/b"]);
    expect(projectDirs(["Saved/X/X.uproject", ".git/X.uproject", "node_modules/X/X.uproject", "x/Intermediate/X.uproject", "Content/Python/X.uproject", "builds/X.uproject"])).toEqual([]);
    expect(projectDirs(["B/B.uproject", "A/A.uproject", "Raiz.uproject"])).toEqual(["", "A", "B"]);
  });
  it("pickProject: escolha salva > raiz > único; vários = a pessoa escolhe", () => {
    expect(pickProject([])).toBeNull();
    expect(pickProject(["TesteUnreal"])).toBe("TesteUnreal");
    expect(pickProject(["", "A"])).toBe("");
    expect(pickProject(["A", "B"])).toBeUndefined();
    expect(pickProject(["A", "B"], "B")).toBe("B");
    expect(pickProject(["A", "B"], "Sumiu")).toBeUndefined();
    expect(pickProject(["", "A"], "A")).toBe("A");
    expect(pickProject(["TesteUnreal"], "Sumiu")).toBe("TesteUnreal");
  });
  it("pickMcpPort: uma porta por sala, estável, a partir de 8000", () => {
    expect(pickMcpPort("a", {})).toBe(8000);
    expect(pickMcpPort("b", { a: 8000 })).toBe(8001);
    expect(pickMcpPort("b", { a: 8000, b: 8001 })).toBe(8001);
    expect(pickMcpPort("a", { a: 8000, b: 8001 })).toBe(8000);
    expect(pickMcpPort("b", { a: 8000, b: 9123 })).toBe(9123); // porta escolhida à mão continua
    // versões antigas gravavam 8000 em todas: a de menor id fica, a outra muda
    expect(pickMcpPort("a", { a: 8000, b: 8000 })).toBe(8000);
    expect(pickMcpPort("b", { a: 8000, b: 8000 })).toBe(8001);
  });
});

describe("templates", () => {
  it("script de presença atual não está na lista dos antigos (a migração para)", () => {
    const py = ueScripts("").find(([p]) => p === "Content/Python/gameforge_presence.py")![1];
    expect(OLD_UE_PRESENCE).not.toContain(textHash(py.replace(/\r\n/g, "\n")));
    expect(py).toContain("get_multi_user_connection_status_detail");
    expect(py).toContain('"state.json"'); // acha a .gfs da sala subindo a partir da pasta do projeto
    expect(textHash("abc")).toBe(0x1a47e90b); // FNV-1a de referência
  });
  it("scripts do editor vão para o Content/Python do projeto; sala nova sem projeto não ganha Content/", () => {
    expect(ueScripts("").map(([p]) => p)).toEqual(["Content/Python/init_unreal.py", "Content/Python/gameforge_presence.py"]);
    expect(ueScripts("TesteUnreal").map(([p]) => p)).toEqual(["TesteUnreal/Content/Python/init_unreal.py", "TesteUnreal/Content/Python/gameforge_presence.py"]);
    expect(ueScripts("TesteUnreal")[0][1]).toContain("import gameforge_presence");
    expect(roomTemplates("unreal", "X").map(([p]) => p)).toEqual(["CLAUDE.md", "GAME.md", "MODELOS.md"]);
    expect(roomTemplates("unreal", "X")[0][1]).toContain("pasta do projeto");
    expect(ueProjectRule("TesteUnreal")).toContain("TesteUnreal/Content/");
    expect(assetsMd([], "u", 0, "", "TesteUnreal")).toContain("TesteUnreal/Content/");
    expect(assetsMd([], "u", 0)).not.toContain("O projeto está em");
  });
  it("CLAUDE.md HTML5 manda ler o CONSOLE.md", () => {
    expect(roomTemplates(undefined, "X").find(([p]) => p === "CLAUDE.md")![1]).toContain(".gfs/CONSOLE.md");
  });
  it("mergeClaudeSettings: cria, mescla sem apagar, não estraga JSON alheio", () => {
    const novo = JSON.parse(mergeClaudeSettings(null, "unreal")!);
    expect(novo.permissions.deny).toContain("Read(/.gfs/base/**)");
    expect(novo.permissions.deny).toContain("Edit(/builds/**)");
    expect(novo.enabledMcpjsonServers).toEqual(["unreal-mcp"]);
    expect(JSON.parse(mergeClaudeSettings(null, "html5")!).enabledMcpjsonServers).toBeUndefined();
    const user = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "x" }] }] }, permissions: { allow: ["Bash(ls)"], deny: ["Read(./.env)"] }, enabledMcpjsonServers: ["outro"] });
    const m = JSON.parse(mergeClaudeSettings(user, "unreal")!);
    expect(m.hooks.UserPromptSubmit[0].hooks[0].command).toBe("x");
    expect(m.permissions.allow).toEqual(["Bash(ls)"]);
    expect(m.permissions.deny[0]).toBe("Read(./.env)");
    expect(m.enabledMcpjsonServers).toEqual(["outro", "unreal-mcp"]);
    expect(mergeClaudeSettings(JSON.stringify(m), "unreal")).toBeNull(); // já está certo: não regrava
    expect(mergeClaudeSettings("{ estragado", "unreal")).toBeNull();
    expect(mergeClaudeSettings('{"permissions": {"deny": "x"}}', "unreal")).toBeNull();
    const off = JSON.parse(mergeClaudeSettings('{"disabledMcpjsonServers": ["unreal-mcp"]}', "unreal")!);
    expect(off.enabledMcpjsonServers).toBeUndefined(); // quem recusou continua recusando
  });
});

describe("compactar histórico", () => {
  it("guarda as últimas N e as dos backups, continua de onde parou", () => {
    const files = [{ path: "a.js", version: 10 }, { path: "b.js", version: 3 }];
    const r = compactPlan(files, [{ files: { "a.js": 2 } }], {}, 5);
    expect(r.ids).toEqual(["a.js@1", "a.js@3", "a.js@4", "a.js@5"]);
    expect(r.upTo).toEqual({ "a.js": 5 });
    expect(compactPlan(files, [], r.upTo, 5).ids).toEqual([]);
    expect(compactPlan([{ path: "a.js", version: 12 }], [], r.upTo, 5).ids).toEqual(["a.js@6", "a.js@7"]);
    const big = compactPlan([{ path: "x", version: 100 }, { path: "y", version: 100 }], [], {}, 0, 150);
    expect(big.ids).toHaveLength(150);
    expect(big.upTo).toEqual({ x: 100, y: 50 });
  });
});

describe("rojo e console", () => {
  it("porta gravada continua; local novo a partir de 35000", () => {
    expect(FIRST_PORT).toBe(35000);
    expect(wantedPort({ Lobby: 34873 }, "Lobby")).toBe(34873);
    expect(wantedPort({ Lobby: 34873 }, "Arena")).toBe(35000);
    expect(wantedPort({ Lobby: 34873, Arena: 35000 }, "Boss")).toBe(35001);
  });
  it("CONSOLE.md só muda com erro novo", () => {
    const e = { text: "TypeError: x is undefined", at: 1_700_000_000_000, again: false };
    expect(consoleMd([])).toContain("Nenhum erro");
    const a = consoleMd([e]);
    expect(a).toContain("TypeError");
    expect(consoleMd([{ ...e }])).toBe(a);
    expect(consoleMd([{ ...e, again: true }])).toContain("(repetiu)");
    expect(consoleMd([e], true)).toContain("e mais erros");
  });
});
