// Reserva automática (autoClaim do claims.ts do app) contra as regras de produção.
import assert from "node:assert/strict";
import { doc, getDoc, setDoc, Timestamp } from "firebase/firestore";
import { setup, room, USERS } from "./env.mjs";

const { env, dbs } = await setup("demo-gfs-auto");
await room(env, "r3", { u0: "owner", u1: "editor", u2: "editor", u3: "editor" });
globalThis.__dbs = dbs;
const mods = await Promise.all([0, 1, 2, 3].map((i) => import(`./.build/claims${i}.mjs?auto`)));
const me = (i) => ({ uid: USERS[i][0], name: `P${i}`, kind: "human" });
const M30 = 30 * 60_000;
const table = async () => {
  const c = (await getDoc(doc(dbs[0], "rooms/r3/claims/assets"))).data()?.c ?? {};
  return Object.fromEntries(Object.entries(c).map(([key, e]) => [key, { ...e, exp: e.exp.toMillis() }]));
};

// 1. ator externo (OFPA) modificado: reserva de 30 min com a nota auto
const actor = "/Game/__ExternalActors__/Maps/Arena/0/AB/9F3KQ2ZL1M8X7C6V5B4N3M2";
const key = mods[1].claimKey(actor).key;
assert.equal(key, "content/__externalactors__/maps/arena/0/ab/9f3kq2zl1m8x7c6v5b4n3m2");
assert.equal(await mods[1].autoClaim("r3", me(1), actor, "auto: BP_Player", M30), null);
let t = await table();
assert.equal(t[key].uid, "u1");
assert.equal(t[key].note, "auto: BP_Player");
assert.ok(Math.abs(t[key].exp - (Date.now() + M30)) < 15_000, "vence em ~30 min");
console.log("ok   auto: ator externo reservado por 30 min");

// 2. de novo logo em seguida: não grava (tem folga)
const exp1 = t[key].exp;
await mods[1].autoClaim("r3", me(1), actor, "auto: outra", M30);
assert.equal((await table())[key].exp, exp1);
console.log("ok   auto: não regrava com folga");

// 3. outra pessoa modifica o mesmo ator: devolve quem tem a reserva, nada muda
const o = await mods[2].autoClaim("r3", me(2), actor, "auto", M30);
assert.equal(o?.uid, "u1");
assert.equal((await table())[key].uid, "u1");
console.log("ok   auto: reservado por outra pessoa → devolve P1, não grava");

// 4. mapa reservado à mão cobre os atores externos dele (OFPA)
await mods[3].claimAsset("r3", me(3), "Content/Maps/Deserto.umap", "mapa", 2);
const o2 = await mods[2].autoClaim("r3", me(2), "/Game/__ExternalActors__/Maps/Deserto/1/C2/AAA", "auto", M30);
assert.equal(o2?.uid, "u3");
assert.ok(!(await table())["content/__externalactors__/maps/deserto/1/c2/aaa"]);
await assert.rejects(mods[2].claimAsset("r3", me(2), "/Game/__ExternalObjects__/Maps/Deserto/9/ZZ/B", "", 1), /está reservado/);
await mods[2].claimAsset("r3", me(2), "Content/Maps/Deserto/Texturas/T_Areia.uasset", "", 1); // pasta ao lado do mapa: livre
console.log("ok   auto: mapa reservado cobre __ExternalActors__/__ExternalObjects__ dele (e só eles)");

// 5. reserva manual longa (pasta) cobre: auto não encurta
await mods[3].claimAsset("r3", me(3), "Content/Cidade/", "mapa novo", 8);
const before = await table();
assert.equal(await mods[3].autoClaim("r3", me(3), "/Game/Cidade/Praca", "auto", M30), null);
assert.deepEqual(await table(), before);
console.log("ok   auto: reserva manual de pasta cobre, nada gravado");

// 6. manual minha vencendo em 5 min: auto renova para 30 min e mantém a nota
await env.withSecurityRulesDisabled(async (c) => {
  const cur = (await getDoc(doc(c.firestore(), "rooms/r3/claims/assets"))).data();
  cur.c["content/chars/bp_hero"] = { path: "Content/Chars/BP_Hero.uasset", uid: "u2", name: "P2", note: "rig novo", exp: Timestamp.fromMillis(Date.now() + 5 * 60_000) };
  await setDoc(doc(c.firestore(), "rooms/r3/claims/assets"), cur);
});
assert.equal(await mods[2].autoClaim("r3", me(2), "/Game/Chars/BP_Hero.BP_Hero", "auto", M30), null);
t = await table();
assert.equal(t["content/chars/bp_hero"].note, "rig novo");
assert.ok(t["content/chars/bp_hero"].exp > Date.now() + 25 * 60_000);
console.log("ok   auto: renova a própria que estava vencendo, mantém a nota");

// 7. corrida: 4 pessoas modificam o mesmo asset ao mesmo tempo → 1 dono, os outros recebem quem é
for (let r = 0; r < 5; r++) {
  const pkg = `/Game/Props/Box_${r}`;
  const res = await Promise.all(mods.map((m, i) => m.autoClaim("r3", me(i), pkg, "auto", M30)));
  const owner = (await table())[`content/props/box_${r}`].uid;
  assert.equal(res.filter((x) => x === null).length, 1, `rodada ${r}: ${JSON.stringify(res.map((x) => x?.uid ?? null))}`);
  assert.ok(res.every((x, i) => (x === null ? USERS[i][0] === owner : x.uid === owner)));
}
console.log("ok   auto: 5 rodadas de corrida com 4 pessoas, sempre 1 dono");
await env.cleanup();
