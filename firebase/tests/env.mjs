// Ambiente comum: emulador do Firestore (porta do firebase.json desta pasta) com as regras de produção.
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";

export const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const tok = (email) => ({ email, email_verified: true, firebase: { sign_in_provider: "google.com" } });

// As 4 contas da lista das regras: u0 = dono, u1/u2 = editores, u3 = espectador (salvo quando o teste diz outra coisa).
export const USERS = [
  ["u0", "andreluizvillanova123@gmail.com"],
  ["u1", "kaue.bimok@gmail.com"],
  ["u2", "jonatas3dmodel@gmail.com"],
  ["u3", "adriwolf@hotmail.com"],
];

export async function setup(projectId, rules = RULES) {
  const env = await initializeTestEnvironment({ projectId, firestore: { rules, host: "127.0.0.1", port: 18089 } });
  const dbs = USERS.map(([u, e]) => env.authenticatedContext(u, tok(e)).firestore());
  return { env, dbs };
}

/** Sala `id` com papéis (padrão: u0 dono, u1/u2 editores, u3 espectador). */
export async function room(env, id, roles = { u0: "owner", u1: "editor", u2: "editor", u3: "viewer" }) {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), `rooms/${id}`), { ownerId: "u0", memberIds: Object.keys(roles), roles, name: "x" });
  });
}

let fails = 0;
export const failures = () => fails;
/** Caso de teste: `ok` = a regra deve aceitar. */
export async function t(name, p, ok) {
  try {
    await (ok ? assertSucceeds(p) : assertFails(p));
    console.log("ok  ", name);
  } catch (err) {
    fails++;
    console.log("FAIL", name, err.message);
  }
}
