// Sala Godot: regras puras (versão, project.godot, arquivos aceitos, reservas de cena, conversão) e a sincronização
// de 3 pessoas (cada uma com o seu Claude) mexendo na mesma cena .tscn e no mesmo script .gd.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/firebase", () => ({ db: {}, auth: {}, app: {}, rtdb: () => ({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...a: string[]) => a.join("/") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({}));

import { convertPlan, conflictHint, godotProjectDirs, hasWebPreset, majorMinor, projectVersion, requiredVersion, scenesMd, versionAdvice } from "../src/godot";
import { GODOT_IGNORE_PATH, IGNORE_PATH, hasSecretContent, isCodePath } from "../src/sync/fileKinds";
import { GODOT_VERSION, godotProjectTemplates, roomTemplates } from "../src/sync/templates";
import { claimKey, overlaps } from "../src/claims";
import { hasConflictMarkers, merge3 } from "../src/sync/merge";

const tpl = Object.fromEntries(godotProjectTemplates("Meu Jogo"));

describe("versão da Godot", () => {
  it("lê major.minor do --version e do texto com prefixo", () => {
    expect(majorMinor("4.7.2.stable.official.e8f3a1b2c")).toBe("4.7");
    expect(majorMinor("Godot Engine v4.7.2.stable.official.e8f3a1b2c")).toBe("4.7");
    expect(majorMinor("4.10.rc1.official.abc")).toBe("4.10");
    expect(majorMinor("erro")).toBeNull();
    expect(majorMinor(null)).toBeNull();
  });
  it("lê config/features do project.godot", () => {
    expect(projectVersion(tpl["project.godot"])).toBe(GODOT_VERSION);
    expect(projectVersion('[application]\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n')).toBe("4.3");
    expect(projectVersion('config/features=PackedStringArray("C#", "4.6")')).toBe("4.6");
    expect(projectVersion("config_version=5\n")).toBeNull();
  });
  it("versão exigida: a da sala, senão a do projeto, senão a padrão", () => {
    expect(requiredVersion({ godotVersion: "4.6" }, tpl["project.godot"])).toBe("4.6");
    expect(requiredVersion({}, 'config/features=PackedStringArray("4.5")')).toBe("4.5");
    expect(requiredVersion({})).toBe(GODOT_VERSION);
  });
  it("compara major.minor e explica em português", () => {
    expect(versionAdvice("4.7.2.stable.official.x", "4.7")).toBeNull();
    expect(versionAdvice("4.6.1.stable.official.x", "4.7")).toContain("mais velha");
    expect(versionAdvice("4.10.stable.official.x", "4.7")).toContain("mais nova"); // 10 > 7 como número, não texto
    expect(versionAdvice(null, "4.7")).toBeNull();
  });
});

describe("projeto na sala", () => {
  it("acha project.godot na raiz e até 2 níveis, fora de pastas geradas", () => {
    expect(
      godotProjectDirs(["project.godot", "game/project.godot", "a/b/project.godot", "a/b/c/project.godot", ".godot/x/project.godot", "addons/p/project.godot", "builds/project.godot"]),
    ).toEqual(["", "a/b", "game"]);
    expect(godotProjectDirs(["index.html"])).toEqual([]);
  });
  it("preset Web e template mínimo", () => {
    expect(hasWebPreset(tpl["export_presets.cfg"])).toBe(true);
    expect(hasWebPreset('[preset.0]\nname="Windows Desktop"\n')).toBe(false);
    expect(hasWebPreset(undefined)).toBe(false);
    expect(roomTemplates("godot", "X").map(([p]) => p)).toEqual([
      "CLAUDE.md",
      "GAME.md",
      "MODELOS.md",
      "project.godot",
      "scenes/main.tscn",
      "scripts/main.gd",
      "export_presets.cfg",
    ]);
    for (const [, text] of roomTemplates("godot", "X")) {
      expect(text.charCodeAt(0)).not.toBe(0xfeff); // UTF-8 sem BOM (com BOM a Godot não carrega)
      expect(text).not.toContain("\r");
    }
    expect(roomTemplates("godot", "X")[0][1]).toContain("--headless");
  });
});

describe("arquivos que sincronizam numa sala Godot", () => {
  const room = (p: string) => !IGNORE_PATH.test(p) && !GODOT_IGNORE_PATH.test(p) && isCodePath(p);
  it("texto da Godot entra", () => {
    for (const p of ["project.godot", "export_presets.cfg", "scripts/player.gd", "scripts/player.gd.uid", "scenes/fase1.tscn", "res/tema.tres", "fx/agua.gdshader", "fx/comum.gdshaderinc", "lang/pt.po", "game/project.godot"])
      expect(room(p), p).toBe(true);
  });
  it("binário, .import, cache e saídas de export ficam fora", () => {
    for (const p of ["art/hero.png", "art/hero.png.import", "audio/tema.ogg", "lang/pt.translation", "fonts/a.ttf", "models/a.glb", ".godot/global_script_class_cache.cfg", ".godot/editor/x.cfg", "builds/godot-web/index.js", "export/web/index.js", "game/exports/index.html", "build/index.html", "export_credentials.cfg"])
      expect(room(p), p).toBe(false);
    expect(GODOT_IGNORE_PATH.test("scripts/exporter.gd")).toBe(false);
  });
  it("export_presets.cfg com senha não sobe", () => {
    expect(hasSecretContent("export_presets.cfg", 'keystore/release_password="segredo"\n')).toBe(true);
    expect(hasSecretContent("game/export_presets.cfg", 'script_encryption_key="abc123"')).toBe(true);
    expect(hasSecretContent("export_presets.cfg", 'keystore/release_password=""\nname="Web"')).toBe(false);
    expect(hasSecretContent("export_presets.cfg", tpl["export_presets.cfg"])).toBe(false);
    expect(hasSecretContent("notes.md", 'password="x"')).toBe(false);
  });
});

describe("reservas de cena (claimKey com res://)", () => {
  it("res://, caminho relativo e maiúsculas dão a mesma chave", () => {
    expect(claimKey("res://scenes/Fase1.tscn")).toEqual({ key: "scenes/fase1.tscn", path: "scenes/Fase1.tscn" });
    expect(claimKey("scenes/Fase1.tscn")!.key).toBe("scenes/fase1.tscn");
    expect(claimKey("res://scenes/")).toEqual({ key: "scenes/", path: "scenes/" });
    // pasta "content" num projeto Godot não vira a regra do Unreal
    expect(claimKey("res://levels/content/a.tscn")!.key).toBe("levels/content/a.tscn");
    expect(overlaps(claimKey("res://scenes/")!.key, claimKey("res://scenes/fase1.tscn")!.key)).toBe(true);
    expect(claimKey("res://../fora.tscn")).toBeNull();
  });
  it(".gfs/CENAS.md mostra res:// e quem pode mexer", () => {
    const md = scenesMd(
      [
        { key: "scenes/a.tscn", path: "scenes/a.tscn", uid: "u1", name: "Bia", note: "", exp: 2000 },
        { key: "scenes/b.tscn", path: "scenes/b.tscn", uid: "me", name: "Eu", note: "luz", exp: 2000 },
        { key: "scenes/old.tscn", path: "scenes/old.tscn", uid: "u1", name: "Bia", note: "", exp: 10 },
      ],
      "me",
      1000,
    );
    expect(md).toContain("res://scenes/a.tscn — Bia (NÃO mexa)");
    expect(md).toContain("res://scenes/b.tscn — VOCÊ (pode mexer)");
    expect(md).not.toContain("old.tscn");
  });
});

describe("converter sala HTML5 para Godot", () => {
  it("cria só o que falta e acrescenta as regras no CLAUDE.md", () => {
    const p = convertPlan(["index.html", "CLAUDE.md", "GAME.md", "game.js"], "Jogo", "# regras\n");
    expect(p.create.map(([x]) => x)).toEqual(["MODELOS.md", "project.godot", "scenes/main.tscn", "scripts/main.gd", "export_presets.cfg"]);
    expect(p.appendClaude).toBe(true);
  });
  it("projeto Godot já existente (subpasta) não ganha outro; regras já presentes não repetem", () => {
    const p = convertPlan(["CLAUDE.md", "MODELOS.md", "project/project.godot"], "Jogo", "x\n## Godot pela linha de comando\n");
    expect(p.create.map(([x]) => x)).toEqual(["GAME.md"]);
    expect(p.appendClaude).toBe(false);
  });
  it("nada é sobrescrito, nem com maiúsculas diferentes (Windows)", () => {
    const p = convertPlan(["claude.md", "Project.godot"], "Jogo", undefined);
    expect(p.create.map(([x]) => x)).not.toContain("CLAUDE.md");
    expect(p.create.map(([x]) => x)).not.toContain("project.godot");
  });
});

// ── 3 pessoas (e os 3 Claudes) ao mesmo tempo ───────────────────────────────
// Simula o caminho da pasta do Claude/editor do app: cada um parte de uma base; grava se a versão da sala ainda é a
// base (transação), senão faz merge de 3 vias com a da sala e tenta de novo. Texto com marcador NUNCA é gravado.
interface Server {
  content: string;
  version: number;
}
interface Person {
  name: string;
  base: Server;
  local: string;
}
function push(server: Server, p: Person): "ok" | "conflict" {
  for (;;) {
    if (hasConflictMarkers(p.local)) return "conflict"; // folderMirror.push / session.save: não grava
    if (server.version === p.base.version) {
      server.content = p.local;
      server.version++;
      p.base = { ...server };
      return "ok";
    }
    const m = merge3(p.base.content, p.local, server.content, "outra pessoa");
    p.base = { ...server };
    p.local = m.text;
  }
}
const start = (name: string, s: Server, edit: (t: string) => string): Person => ({ name, base: { ...s }, local: edit(s.content) });

const SCENE = `[gd_scene format=3 uid="uid://b1x2y3"]

[ext_resource type="Script" uid="uid://c4d5e6" path="res://scripts/player.gd" id="1_pl4yr"]
[ext_resource type="Texture2D" uid="uid://d7e8f9" path="res://art/hero.png" id="2_h3ro0"]

[node name="Fase1" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]
position = Vector2(100, 200)
script = ExtResource("1_pl4yr")

[node name="Sprite" type="Sprite2D" parent="Player"]
texture = ExtResource("2_h3ro0")

[node name="Label" type="Label" parent="."]
offset_left = 40.0
offset_top = 40.0
text = "Fase 1"

[node name="Camera2D" type="Camera2D" parent="Player"]
zoom = Vector2(2, 2)
`;

const SCRIPT = `extends CharacterBody2D

const SPEED = 200.0


func _physics_process(delta: float) -> void:
	var dir := Input.get_axis("ui_left", "ui_right")
	velocity.x = dir * SPEED
	move_and_slide()


func pular() -> void:
	velocity.y = -400.0
`;

describe("3 pessoas na mesma cena e no mesmo script", () => {
  it(".tscn: partes diferentes = merge limpo, nada se perde", () => {
    const s: Server = { content: SCENE, version: 1 };
    const andre = start("André", s, (t) => t.replace('text = "Fase 1"', 'text = "Fase 1 - Outono"'));
    const kaue = start("Kauê", s, (t) => t.replace("position = Vector2(100, 200)", "position = Vector2(64, 180)"));
    const adri = start("Adriano", s, (t) => t + `\n[node name="Folhas" type="GPUParticles2D" parent="."]\namount = 40\n`);
    expect([push(s, andre), push(s, kaue), push(s, adri)]).toEqual(["ok", "ok", "ok"]);
    expect(s.version).toBe(4);
    expect(s.content).toContain('text = "Fase 1 - Outono"');
    expect(s.content).toContain("position = Vector2(64, 180)");
    expect(s.content).toContain('[node name="Folhas"');
    expect(hasConflictMarkers(s.content)).toBe(false);
    // ids e ordem das seções intactos
    expect(s.content.match(/id="1_pl4yr"/g)).toHaveLength(1);
    expect(s.content.indexOf('[node name="Player"')).toBeLessThan(s.content.indexOf('[node name="Label"'));
  });

  it(".gd: três funções/linhas diferentes = merge limpo", () => {
    const s: Server = { content: SCRIPT, version: 1 };
    const a = start("A", s, (t) => t.replace("const SPEED = 200.0", "const SPEED = 240.0"));
    const b = start("B", s, (t) => t.replace("velocity.y = -400.0", "velocity.y = -450.0"));
    const c = start("C", s, (t) => t + "\n\nfunc morrer() -> void:\n\tqueue_free()\n");
    expect([push(s, a), push(s, b), push(s, c)]).toEqual(["ok", "ok", "ok"]);
    expect(s.content).toContain("SPEED = 240.0");
    expect(s.content).toContain("-450.0");
    expect(s.content).toContain("func morrer()");
  });

  it("mesma linha da cena = conflito com marcador, que NUNCA chega à sala", () => {
    const s: Server = { content: SCENE, version: 1 };
    const a = start("A", s, (t) => t.replace('text = "Fase 1"', 'text = "Autumn"'));
    const b = start("B", s, (t) => t.replace('text = "Fase 1"', 'text = "Outono"'));
    const c = start("C", s, (t) => t.replace("zoom = Vector2(2, 2)", "zoom = Vector2(3, 3)"));
    expect(push(s, a)).toBe("ok");
    expect(push(s, b)).toBe("conflict");
    expect(push(s, c)).toBe("ok"); // quem mexeu em outra parte segue normal
    expect(hasConflictMarkers(b.local)).toBe(true); // só no disco de B (o aviso manda o Claude dele resolver)
    expect(hasConflictMarkers(s.content)).toBe(false);
    expect(s.content).toContain('text = "Autumn"');
    expect(s.content).toContain("zoom = Vector2(3, 3)");
    expect(conflictHint("scenes/fase1.tscn")).toContain("NÃO abre");
    expect(conflictHint("scripts/a.gd")).toBe("");
    // B resolve (fica com a dele) e apaga os marcadores: aí grava por cima da versão nova
    b.local = SCENE.replace('text = "Fase 1"', 'text = "Outono"').replace("zoom = Vector2(2, 2)", "zoom = Vector2(3, 3)");
    expect(push(s, b)).toBe("ok");
    expect(s.content).toContain('text = "Outono"');
  });

  it("load_steps no cabeçalho: duas pessoas acrescentando recurso e mexendo nele = conflito (por isso a regra no CLAUDE.md)", () => {
    const old = SCENE.replace("[gd_scene format=3", "[gd_scene load_steps=3 format=3");
    const s: Server = { content: old, version: 1 };
    const add = (id: string) => (t: string) =>
      t.replace("load_steps=3", "load_steps=4").replace("\n\n[node name=\"Fase1\"", `\n[ext_resource type="Texture2D" path="res://art/${id}.png" id="${id}"]\n\n[node name="Fase1"`);
    const a = start("A", s, add("3_aa111"));
    const b = start("B", s, add("3_bb222"));
    expect(push(s, a)).toBe("ok");
    expect(push(s, b)).toBe("conflict");
    // Mesmo sem load_steps, os dois acrescentando [ext_resource] no mesmo ponto (fim da lista) = conflito:
    // é o caso real de "duas pessoas na mesma cena", por isso a reserva por cena.
    const ext = (id: string) => (t: string) => t.replace('id="2_h3ro0"]', `id="2_h3ro0"]\n[ext_resource type="Texture2D" path="res://art/${id}.png" id="${id}"]`);
    const s2: Server = { content: SCENE, version: 1 };
    const a2 = start("A", s2, ext("3_aa111"));
    const b2 = start("B", s2, ext("3_bb222"));
    expect([push(s2, a2), push(s2, b2)]).toEqual(["ok", "conflict"]);
    // Um acrescenta recurso, o outro muda propriedade de um nó: limpo.
    const s3: Server = { content: SCENE, version: 1 };
    const a3 = start("A", s3, ext("3_aa111"));
    const b3 = start("B", s3, (t) => t.replace("zoom = Vector2(2, 2)", "zoom = Vector2(4, 4)"));
    expect([push(s3, a3), push(s3, b3)]).toEqual(["ok", "ok"]);
    expect(s3.content).toContain('id="3_aa111"');
    expect(s3.content).toContain("zoom = Vector2(4, 4)");
  });
});
