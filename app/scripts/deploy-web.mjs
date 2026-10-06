// Publica a tela do app no site (Firebase Hosting) em ~1 minuto, sem recompilar o Rust.
// O app de PC carrega https://gameforge-sync.web.app/app/ e avisa quando sai versão nova.
//   npm run deploy:web
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
const build = String(Date.now());
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

run("npx tsc --noEmit -p .");
run("npx vite build --base=/app/ --outDir ../hosting/app --emptyOutDir", { GFS_BUILD_ID: build });
writeFileSync(new URL("../../hosting/app/version.json", import.meta.url), JSON.stringify({ build, version }) + "\n");
run("npx -y firebase-tools@latest deploy --only hosting -P gameforge-sync", { NODE_NO_WARNINGS: "1" });
console.log(`\n✓ tela publicada: v${version} (build ${build}). Quem estiver com o app aberto recebe o aviso para recarregar.`);
