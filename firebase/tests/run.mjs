// Roda tudo dentro do emulador (npm test = firebase emulators:exec ... "node run.mjs").
import { failures } from "./env.mjs";

await import("./build.mjs");
console.log("── reservas (regras)");
await import("./claims.mjs");
console.log("── arquivos e histórico (regras)");
await import("./files.mjs");
console.log("── corrida com o claims.ts do app");
await import("./race.mjs");
console.log("── reserva automática");
await import("./auto.mjs");
console.log("── sala (tipo e versão da Godot)");
await import("./rooms.mjs");
console.log("── sons e imagens (assets/abin + app/src/assets.ts)");
await import("./assets.mjs");
const n = failures();
console.log(n ? `${n} FALHA(S)` : "TUDO OK");
process.exit(n ? 1 : 0);
