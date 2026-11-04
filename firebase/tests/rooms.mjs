// Sala: o dono troca o tipo (Converter para Godot) e a versão exigida sem regra nova; editor/espectador não.
import { doc, updateDoc } from "firebase/firestore";
import { setup, room, t } from "./env.mjs";

const { env, dbs } = await setup("demo-gfs-rooms");
await room(env, "r1");
const [O, E1, , V] = dbs;
const r = (db) => doc(db, "rooms/r1");

await t("sala: dono converte para godot", updateDoc(r(O), { kind: "godot" }), true);
await t("sala: dono grava godotVersion", updateDoc(r(O), { godotVersion: "4.7" }), true);
await t("sala: editor troca o tipo", updateDoc(r(E1), { kind: "html5" }), false);
await t("sala: espectador troca o tipo", updateDoc(r(V), { kind: "html5" }), false);
await env.cleanup();
