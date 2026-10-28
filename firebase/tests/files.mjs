// Arquivos (versão +1) e histórico (quem grava, quem apaga; o que a compactação do dono e a recriação de arquivo precisam).
import { doc, setDoc, deleteDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { RULES, setup, room, t } from "./env.mjs";

const author = (uid, kind = "human") => ({ uid, name: uid, kind });
const file = (uid, path, version, content = "x") => ({ path, content, version, author: author(uid), updatedAt: serverTimestamp() });
const hist = (uid, path, version, kind = "edit", content = "x") => ({ path, version, content, author: author(uid), kind, added: 1, removed: 0, where: [], ts: serverTimestamp() });

const { env, dbs } = await setup("demo-gfs-files");
await room(env, "r1");
const [O, E1, E2, V] = dbs;
const f = (db) => doc(db, "rooms/r1/files/a.js");
const h = (db, id) => doc(db, "rooms/r1/history", id);

await t("arquivo: editor cria v1", setDoc(f(E1), file("u1", "a.js", 1)), true);
await t("arquivo: cria já na v2", setDoc(doc(E1, "rooms/r1/files/b.js"), file("u1", "b.js", 2)), false);
await t("arquivo: editor grava v2", setDoc(f(E2), file("u2", "a.js", 2)), true);
await t("arquivo: grava v2 de novo (partiu de versão velha)", setDoc(f(E1), file("u1", "a.js", 2)), false);
await t("arquivo: pula para v5", setDoc(f(E1), file("u1", "a.js", 5)), false);
await t("arquivo: espectador grava v3", setDoc(f(V), file("u3", "a.js", 3)), false);
await t("arquivo: autor com uid de outro", setDoc(f(E1), file("u2", "a.js", 3)), false);
await t("arquivo: campo extra", setDoc(f(E1), { ...file("u1", "a.js", 3), x: 1 }), false);

await t("histórico: editor cria a.js@1", setDoc(h(E1, "a.js@1"), hist("u1", "a.js", 1, "create")), true);
await t("histórico: Claude do editor cria a.js@2", setDoc(h(E2, "a.js@2"), { ...hist("u2", "a.js", 2), author: author("u2", "claude") }), true);
await t("histórico: espectador cria", setDoc(h(V, "a.js@3"), hist("u3", "a.js", 3)), false);
await t("histórico: autor com uid de outro", setDoc(h(E1, "a.js@3"), hist("u2", "a.js", 3)), false);
await t("histórico: kind inválido", setDoc(h(E1, "a.js@3"), hist("u1", "a.js", 3, "hack")), false);
// Arquivo apagado e criado de novo: a versão recomeça do 1 e o app/gfs regravam a.js@1 (que já existe).
// Por isso o histórico ainda aceita update; "só create" quebraria salvar arquivo recriado (ver relatório).
await t("histórico: regrava a.js@1 (arquivo recriado)", setDoc(h(E2, "a.js@1"), hist("u2", "a.js", 1, "create", "novo")), true);
await t("histórico: editor apaga", deleteDoc(h(E1, "a.js@1")), false);
{
  // Compactar (dono): apaga em lote por id, inclusive id que nem existe.
  const b = writeBatch(O);
  b.delete(h(O, "a.js@1"));
  b.delete(h(O, "a.js@99"));
  await t("histórico: dono compacta em lote", b.commit(), true);
}
{
  const b = writeBatch(E1);
  b.delete(h(E1, "a.js@2"));
  await t("histórico: editor tenta compactar", b.commit(), false);
}
await env.cleanup();

// A mesma recriação com a regra "histórico só create": o lote do putFile (arquivo v1 + histórico @1) seria recusado.
{
  const createOnly = RULES.replace(
    /match \/history\/\{entryId\} \{\s*allow read: if isMember\(roomId\);\s*allow create, update:/,
    (m) => m.replace("allow create, update:", "allow create:"),
  );
  if (createOnly === RULES) throw new Error("não achei a regra do histórico para o teste só-create");
  const x = await setup("demo-gfs-create-only", createOnly);
  await room(x.env, "r1");
  const E = x.dbs[1];
  await t("(só create) cria a.js v1 + histórico", (async () => {
    const b = writeBatch(E);
    b.set(doc(E, "rooms/r1/files/a.js"), file("u1", "a.js", 1));
    b.set(doc(E, "rooms/r1/history/a.js@1"), hist("u1", "a.js", 1, "create"));
    await b.commit();
  })(), true);
  await deleteDoc(doc(E, "rooms/r1/files/a.js"));
  await t("(só create) recriar a.js: lote v1 + histórico @1 é RECUSADO", (async () => {
    const b = writeBatch(E);
    b.set(doc(E, "rooms/r1/files/a.js"), file("u1", "a.js", 1, "de novo"));
    b.set(doc(E, "rooms/r1/history/a.js@1"), hist("u1", "a.js", 1, "create", "de novo"));
    await b.commit();
  })(), false);
  await x.env.cleanup();
}
