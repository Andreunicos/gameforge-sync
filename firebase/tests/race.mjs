// Corrida real: 4 pessoas reservando caminhos que se sobrepõem ao mesmo tempo, com o claims.ts do app (build.mjs).
import assert from "node:assert/strict";
import { doc, getDoc } from "firebase/firestore";
import { setup, room, USERS } from "./env.mjs";

const { env, dbs } = await setup("demo-gfs-race");
await room(env, "r2", { u0: "owner", u1: "editor", u2: "editor", u3: "editor" });
globalThis.__dbs = dbs;
const mods = await Promise.all([0, 1, 2, 3].map((i) => import(`./.build/claims${i}.mjs?race`)));
const { overlaps, assetsMd } = mods[0];
const me = (i) => ({ uid: USERS[i][0], name: `P${i}`, kind: "human" });

const table = async () => {
  const c = (await getDoc(doc(dbs[0], "rooms/r2/claims/assets"))).data()?.c ?? {};
  return Object.entries(c).map(([key, e]) => ({ key, ...e, exp: e.exp.toMillis() }));
};
const noOverlap = async () => {
  const act = (await table()).filter((c) => c.exp > Date.now());
  for (const a of act) for (const b of act) if (a.uid !== b.uid) assert.ok(!overlaps(a.key, b.key), `sobreposição ${a.key} × ${b.key}`);
  return act;
};

const inputs = ["Content/Maps/", "Content/Maps/Arena.umap", "/Game/Maps/Arena.Arena", "World'/Game/Maps/Arena.Arena'"];
for (let r = 0; r < 8; r++) {
  const res = await Promise.allSettled(mods.map((m, i) => m.claimAsset("r2", me(i), inputs[(i + r) % 4], "", 1)));
  const won = res.filter((x) => x.status === "fulfilled").length;
  const why = res.filter((x) => x.status === "rejected").map((x) => x.reason.message);
  assert.equal(won, 1, `rodada ${r}: ${won} venceram (${why.join(" | ")})`);
  assert.ok(why.every((m) => m.includes("está reservado")), why.join(" | "));
  const act = await noOverlap();
  const w = res.findIndex((x) => x.status === "fulfilled");
  await mods[w].releaseAsset("r2", act[0].key);
  assert.equal((await noOverlap()).length, 0);
}
console.log("ok   8 rodadas de corrida: sempre 1 vencedor, sem sobreposição");

// Mapa × ator externo (One File Per Actor) ao mesmo tempo: só um fica.
for (let r = 0; r < 4; r++) {
  const map = `Content/Maps/Lvl${r}.umap`;
  const actor = `/Game/__ExternalActors__/Maps/Lvl${r}/0/AB/X${r}`;
  const res = await Promise.allSettled(mods.map((m, i) => m.claimAsset("r2", me(i), i % 2 ? actor : map, "", 1)));
  assert.equal(res.filter((x) => x.status === "fulfilled").length, 1, `mapa × ator, rodada ${r}`);
  const act = await noOverlap();
  await mods[res.findIndex((x) => x.status === "fulfilled")].releaseAsset("r2", act[0].key);
}
console.log("ok   4 rodadas mapa × ator externo: sempre 1 vencedor");

// sem sobreposição: todos ganham ao mesmo tempo
await Promise.all(mods.map((m, i) => m.claimAsset("r2", me(i), `Content/Chars/BP_${i}.uasset`, "nota", 2)));
assert.equal((await noOverlap()).length, 4);
console.log("ok   4 reservas diferentes ao mesmo tempo");
// renovar a própria, liberar a de outro (editor não pode; dono pode)
await mods[1].claimAsset("r2", me(1), "Content/Chars/BP_1.uasset", "nota", 3);
await assert.rejects(mods[2].releaseAsset("r2", "content/chars/bp_1"));
await mods[0].releaseAsset("r2", "content/chars/bp_1");
assert.equal((await noOverlap()).length, 3);
// pasta por cima de arquivo de outro: recusa; dentro da própria pasta: aceita
await assert.rejects(mods[1].claimAsset("r2", me(1), "Content/Chars/", "", 1), /está reservado/);
await mods[1].claimAsset("r2", me(1), "Content/Props/", "", 1);
await mods[1].claimAsset("r2", me(1), "Content/Props/Box.uasset", "", 1);
await assert.rejects(mods[2].claimAsset("r2", me(2), "/Game/Props/Box", "", 1), /está reservado/);
const md = assetsMd(await table(), "u1", Date.now());
assert.ok(md.includes("Content/Props/ — VOCÊ"), md);
assert.ok(md.includes("Content/Chars/BP_2.uasset — P2 (NÃO mexa)"), md);
console.log("ok   renovar, liberar, pasta × arquivo, ASSETS.md");
await env.cleanup();
