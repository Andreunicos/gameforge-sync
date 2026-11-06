// Sons/imagens da sala Godot (rooms/{id}/assets + abin): regras (quem grava, campos, imutável) e o app/src/assets.ts de
// verdade (build.mjs) subindo, deduplicando e baixando com conferência de hash contra o emulador.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Bytes, deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { setup, room, t } from "./env.mjs";

const { env, dbs } = await setup("demo-gfs-assets");
await room(env, "r1");
const [O, E1, E2, V] = dbs;
const hex = (s) => createHash("sha256").update(s).digest("hex");
const SHA = hex("conteudo");
const man = (uid, path, extra = {}) => ({ path, sha256: SHA, size: 1000, parts: 1, uid, name: uid, ts: serverTimestamp(), ...extra });
const mref = (db, path) => doc(db, "rooms/r1/assets", hex(path.toLowerCase()));
const bref = (db, id) => doc(db, "rooms/r1/abin", id);
const bin = (n, i = 0) => ({ i, data: Bytes.fromUint8Array(new Uint8Array(n).fill(7)) });

// manifesto
await t("assets: editor cria", setDoc(mref(E1, "project/sfx/pulo.ogg"), man("u1", "project/sfx/pulo.ogg")), true);
await t("assets: outro editor atualiza (o último vence)", setDoc(mref(E2, "project/sfx/pulo.ogg"), man("u2", "project/sfx/pulo.ogg")), true);
await t("assets: dono atualiza", setDoc(mref(O, "project/sfx/pulo.ogg"), man("u0", "project/sfx/pulo.ogg")), true);
await t("assets: espectador cria", setDoc(mref(V, "project/a.png"), man("u3", "project/a.png")), false);
await t("assets: uid de outra pessoa", setDoc(mref(E1, "project/a.png"), man("u2", "project/a.png")), false);
await t("assets: id que não é o hash do caminho", setDoc(doc(E1, "rooms/r1/assets/qualquer"), man("u1", "project/a.png")), false);
await t("assets: id do caminho em minúsculas (Som.OGG)", setDoc(mref(E1, "project/Som.OGG"), man("u1", "project/Som.OGG")), true);
await t("assets: caminho com acento", setDoc(mref(E1, "project/música/ação.ogg"), man("u1", "project/música/ação.ogg")), true);
await t("assets: caminho com ..", setDoc(mref(E1, "project/../../x.ogg"), man("u1", "project/../../x.ogg")), false);
await t("assets: caminho absoluto", setDoc(mref(E1, "/etc/x.ogg"), man("u1", "/etc/x.ogg")), false);
await t("assets: caminho com unidade C:", setDoc(mref(E1, "C:/x.ogg"), man("u1", "C:/x.ogg")), false);
await t("assets: caminho com \\", setDoc(mref(E1, "a\\x.ogg"), man("u1", "a\\x.ogg")), false);
await t("assets: sha256 não hex", setDoc(mref(E1, "project/b.png"), man("u1", "project/b.png", { sha256: "XYZ" })), false);
await t("assets: size > 25 MB", setDoc(mref(E1, "project/b.png"), man("u1", "project/b.png", { size: 25_000_001, parts: 28 })), false);
await t("assets: 25 MB exatos, 28 pedaços", setDoc(mref(E1, "project/b.png"), man("u1", "project/b.png", { size: 25_000_000, parts: 28 })), true);
await t("assets: parts incoerente (poucos)", setDoc(mref(E1, "project/c.png"), man("u1", "project/c.png", { size: 900_001, parts: 1 })), false);
await t("assets: parts incoerente (muitos)", setDoc(mref(E1, "project/c.png"), man("u1", "project/c.png", { size: 900_000, parts: 2 })), false);
await t("assets: arquivo vazio, 0 pedaços", setDoc(mref(E1, "project/c.png"), man("u1", "project/c.png", { size: 0, parts: 0 })), true);
await t("assets: ts que não é do servidor", setDoc(mref(E1, "project/d.png"), man("u1", "project/d.png", { ts: new Date() })), false);
await t("assets: campo extra", setDoc(mref(E1, "project/d.png"), man("u1", "project/d.png", { del: true })), false);
await t("assets: editor apaga", deleteDoc(mref(E1, "project/sfx/pulo.ogg")), false);
await t("assets: espectador lê", getDoc(mref(V, "project/sfx/pulo.ogg")), true);
await t("assets: dono apaga", deleteDoc(mref(O, "project/sfx/pulo.ogg")), true);

// pedaços
const id0 = `${SHA}~0`;
await t("abin: editor cria pedaço de 900.000 bytes", setDoc(bref(E1, id0), bin(900_000)), true);
await t("abin: regravar (imutável)", setDoc(bref(E2, id0), bin(10)), false);
await t("abin: update", updateDoc(bref(E1, id0), { i: 0 }), false);
await t("abin: 900.001 bytes", setDoc(bref(E1, `${SHA}~1`), bin(900_001, 1)), false);
await t("abin: vazio", setDoc(bref(E1, `${SHA}~1`), bin(0, 1)), false);
await t("abin: i não bate com o id", setDoc(bref(E1, `${SHA}~1`), bin(10, 2)), false);
await t("abin: id sem sha", setDoc(bref(E1, "abc~0"), bin(10)), false);
await t("abin: data em string (base64)", setDoc(bref(E1, `${SHA}~1`), { i: 1, data: "AAAA" }), false);
await t("abin: campo extra", setDoc(bref(E1, `${SHA}~1`), { ...bin(10, 1), path: "x" }), false);
await t("abin: espectador cria", setDoc(bref(V, `${SHA}~1`), bin(10, 1)), false);
await t("abin: espectador lê", getDoc(bref(V, id0)), true);
await t("abin: editor apaga", deleteDoc(bref(E1, id0)), false);
await t("abin: dono apaga", deleteDoc(bref(O, id0)), true);

// o assets.ts do app contra as regras
globalThis.__dbs = dbs;
const [A0, A1, A2] = await Promise.all([0, 1, 2].map((i) => import(`./.build/assets${i}.mjs?assets`)));
const me = (i) => ({ uid: `u${i}`, name: `P${i}`, kind: "claude" });
const som = new Uint8Array(2_000_123).map((_, i) => (i * 31 + 7) & 255); // 3 pedaços
const up1 = await A1.uploadAsset("r1", me(1), "project/sfx/musica.ogg", som);
assert.equal(up1.sent, som.length);
assert.equal(up1.writes, 4);
assert.equal(up1.conflict, undefined);
console.log("ok   app: sobe 2 MB em 3 pedaços + manifesto");
const again = await A2.uploadAsset("r1", me(2), "project/copia/musica.ogg", som);
assert.equal(again.sent, 0, "dedupe: nenhum byte de novo");
assert.equal(again.writes, 1, "dedupe: só o manifesto");
console.log("ok   app: mesmo conteúdo noutro caminho não sobe os bytes de novo (dedupe)");
const m = (await getDoc(mref(E2, "project/sfx/musica.ogg"))).data();
const got = await A2.downloadAsset("r1", { ...m, ts: 0 });
assert.deepEqual(Buffer.from(got), Buffer.from(som));
console.log("ok   app: baixa, junta e confere o sha256");
await assert.rejects(A2.downloadAsset("r1", { ...m, sha256: hex("outro"), ts: 0 }), /faltam pedaços|hash/);
await assert.rejects(A2.downloadAsset("r1", { ...m, size: m.size - 1, ts: 0 }), /hash não bate/);
console.log("ok   app: hash/tamanho diferente = recusa (nada gravado)");
// pedaço corrompido de propósito (sem regras): o download recusa
await env.withSecurityRulesDisabled(async (c) => {
  const s = hex("x");
  await setDoc(doc(c.firestore(), `rooms/r1/abin/${s}~0`), { i: 0, data: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])) });
  await assert.rejects(A2.downloadAsset("r1", { path: "project/x.png", sha256: s, size: 3, parts: 1, uid: "u1", name: "P1", ts: 0 }), /hash não bate/);
});
console.log("ok   app: pedaço adulterado na sala = recusa");
// conflito: E2 muda a partir de uma base velha → grava (o último vence) e avisa quem era
const som2 = som.slice(0, 1000);
const up2 = await A2.uploadAsset("r1", me(2), "project/sfx/musica.ogg", som2, "0".repeat(64));
assert.equal(up2.conflict?.uid, "u1");
const up3 = await A1.uploadAsset("r1", me(1), "project/sfx/musica.ogg", som2, up2.sha);
assert.equal(up3.writes, 0, "mesmo sha que já está na sala: nada");
console.log("ok   app: conflito avisa e o último vence; sha igual não grava");
// voltar à versão antiga: bytes já existem
const back = await A1.uploadAsset("r1", me(1), "project/sfx/musica.ogg", som, up2.sha);
assert.equal(back.sent, 0);
console.log("ok   app: voltar a uma versão antiga não sobe bytes");
// espectador
const AV = await import(`./.build/assets3.mjs?assets`);
await assert.rejects(AV.uploadAsset("r1", me(3), "project/v.png", new Uint8Array([1, 2])));
console.log("ok   app: espectador não sobe");
// corrida: dois PCs sobem o mesmo arquivo novo ao mesmo tempo
const novo = new Uint8Array(1_000_000).map((_, i) => (i * 7) & 255);
const r = await Promise.allSettled([A1.uploadAsset("r1", me(1), "project/n.png", novo), A2.uploadAsset("r1", me(2), "project/n.png", novo)]);
assert.ok(r.every((x) => x.status === "fulfilled"), r.map((x) => x.reason?.message).join(" | "));
const nm = (await getDoc(mref(E1, "project/n.png"))).data();
assert.deepEqual(Buffer.from(await A0.downloadAsset("r1", { ...nm, ts: 0 })), Buffer.from(novo));
console.log("ok   app: dois sobem o mesmo arquivo juntos sem erro");
await env.cleanup();
