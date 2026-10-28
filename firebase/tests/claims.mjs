// Reservas de assets (rooms/{id}/claims/assets): os 22 casos das regras (cada gravação mexe numa chave só,
// ninguém toma reserva ativa de outro, limpeza de vencida em g, dono libera qualquer uma).
import { doc, setDoc, getDoc, deleteDoc, Timestamp } from "firebase/firestore";
import { setup, room, t } from "./env.mjs";

const { env, dbs } = await setup("demo-gfs-claims");
await room(env, "r1");
const [O, E1, E2, V] = ["u0", "u1", "u2", "u3"];
const ctx = { [O]: dbs[0], [E1]: dbs[1], [E2]: dbs[2], [V]: dbs[3] };
const H = 3600_000;
const e = (uid, path, ms = H) => ({ path, uid, name: uid, note: "", exp: Timestamp.fromMillis(Date.now() + ms) });
const ref = (db, id = "assets") => doc(db, "rooms/r1/claims", id);
const cur = async () => (await getDoc(ref(ctx[E1]))).data()?.c ?? {};

await t("E1 cria a", setDoc(ref(ctx[E1]), { c: { a: e(E1, "A") }, k: "a" }), true);
await t("E1 renova a", setDoc(ref(ctx[E1]), { c: { a: e(E1, "A", 2 * H) }, k: "a" }), true);
await t("E2 toma a ativa", setDoc(ref(ctx[E2]), { c: { a: e(E2, "A") }, k: "a" }), false);
await t("E2 adiciona b", setDoc(ref(ctx[E2]), { c: { ...(await cur()), b: e(E2, "B") }, k: "b" }), true);
const { a, ...noA } = await cur();
await t("E2 apaga a de E1", setDoc(ref(ctx[E2]), { c: noA, k: "a" }), false);
await t("E2 mente k (muda a, diz b)", setDoc(ref(ctx[E2]), { c: { ...(await cur()), a: e(E2, "A") }, k: "b" }), false);
await t("E1 mexe em duas chaves", setDoc(ref(ctx[E1]), { c: { ...(await cur()), c: e(E1, "C"), d: e(E1, "D") }, k: "c" }), false);
await t("E1 grava com uid de E2", setDoc(ref(ctx[E1]), { c: { ...(await cur()), c: e(E2, "C") }, k: "c" }), false);
await t("E1 exp 14h", setDoc(ref(ctx[E1]), { c: { ...(await cur()), c: e(E1, "C", 14 * H) }, k: "c" }), false);
await t("E1 exp no passado", setDoc(ref(ctx[E1]), { c: { ...(await cur()), c: e(E1, "C", -1000) }, k: "c" }), false);
await t("E1 campo extra", setDoc(ref(ctx[E1]), { c: { ...(await cur()), c: { ...e(E1, "C"), x: 1 } }, k: "c" }), false);
await t("viewer grava", setDoc(ref(ctx[V]), { c: { ...(await cur()), v: e(V, "V") }, k: "v" }), false);
await t("outro doc", setDoc(ref(ctx[E1], "foo"), { c: { z: e(E1, "Z") }, k: "z" }), false);
await t("dono força liberar a", setDoc(ref(ctx[O]), { c: noA, k: "a" }), true);
// reservas vencidas
await env.withSecurityRulesDisabled(async (c) => {
  const now = await cur();
  await setDoc(ref(c.firestore()), { c: { ...now, x: e(E2, "X", -2 * H), y: e(E2, "Y", -2 * H) }, k: "x" });
});
await t("E1 toma x vencida de E2", setDoc(ref(ctx[E1]), { c: { ...(await cur()), x: e(E1, "X") }, k: "x" }), true);
{
  const { y, ...noY } = await cur();
  await t("E1 cria c e limpa y vencida (g)", setDoc(ref(ctx[E1]), { c: { ...noY, c: e(E1, "C") }, k: "c", g: "y" }), true);
}
{
  const { b, ...noB } = await cur();
  await t("E1 limpa b ATIVA via g", setDoc(ref(ctx[E1]), { c: { ...noB, d: e(E1, "D") }, k: "d", g: "b" }), false);
}
await t("E1 g inexistente", setDoc(ref(ctx[E1]), { c: { ...(await cur()), d: e(E1, "D") }, k: "d", g: "nada" }), true);
{
  const { c: _, ...noC } = await cur();
  await t("E1 libera a própria c", setDoc(ref(ctx[E1]), { c: noC, k: "c" }), true);
}
await t("E2 apaga o doc", deleteDoc(ref(ctx[E2])), false);
await t("E1 lê", getDoc(ref(ctx[E1])), true);
await t("chaves com / e .", setDoc(ref(ctx[E1]), { c: { ...(await cur()), "content/maps/a.b/": e(E1, "Content/Maps/A.b/") }, k: "content/maps/a.b/" }), true);
await env.cleanup();
