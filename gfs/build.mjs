// Gera dist/gfs.mjs: um arquivo só, sem dependências, roda em qualquer Node 18+.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/gfs.mjs",
  banner: { js: "#!/usr/bin/env node" },
  define: { __GFS_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});
console.log(`gfs ${version} → dist/gfs.mjs`);
