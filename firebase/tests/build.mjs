// Empacota app/src/claims.ts 4 vezes, cada uma com o `db` de uma pessoa diferente (troca o ./firebase do app por um
// shim), para a corrida usar o código de verdade do app contra as regras de verdade. Idem app/src/assets.ts (assets.mjs).
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("./.build/", import.meta.url));
const claims = fileURLToPath(new URL("../../app/src/claims.ts", import.meta.url));
const assets = fileURLToPath(new URL("../../app/src/assets.ts", import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}usage.mjs`, "export const countWrite = () => {};\n");
writeFileSync(`${out}react.mjs`, "export const useState = () => [];\nexport const useEffect = () => {};\n");
writeFileSync(
  `${out}tauri.mjs`,
  "export const join = async (...a) => a.join('/');\nexport const writeTextFile = async () => {};\n" +
    "const no = async () => { throw new Error('sem disco no teste'); };\nexport const mkdir = no, readDir = no, readFile = no, readTextFile = no, remove = no, rename = no, stat = no, writeFile = no;\n",
);
for (const u of [0, 1, 2, 3]) {
  writeFileSync(`${out}fb${u}.mjs`, `export const db = globalThis.__dbs[${u}];\n`);
  for (const [src, name] of [[claims, "claims"], [assets, "assets"]]) await build({
    entryPoints: [src],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: `${out}${name}${u}.mjs`,
    external: ["firebase/*"],
    logLevel: "warning",
    plugins: [
      {
        name: "shim",
        setup(b) {
          b.onResolve({ filter: /^\.\/firebase$/ }, () => ({ path: `${out}fb${u}.mjs` }));
          b.onResolve({ filter: /^\.\/usage$/ }, () => ({ path: `${out}usage.mjs` }));
          b.onResolve({ filter: /^react$/ }, () => ({ path: `${out}react.mjs` }));
          b.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: `${out}tauri.mjs` }));
        },
      },
    ],
  });
}
