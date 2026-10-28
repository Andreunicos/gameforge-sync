// Quais arquivos entram numa sala (importar pasta e pasta do Claude): qualquer texto de código/script,
// em qualquer linguagem. Fica de fora o que é binário, gerado ou segredo.
// app/src/sync/fileKinds.ts e gfs/src/fileKinds.ts são o MESMO arquivo (o teste do app compara): mude os dois.

const EXT = new Set(
  (
    // web e app
    "html htm css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte astro mdx " +
    // scripts e backend
    "py pyw pyi ps1 psm1 psd1 sh bash zsh bat cmd php rb pl pm lua luau r jl " +
    // compiladas
    "java kt kts groovy gradle scala c h cc cpp cxx hpp hh cs go rs swift m mm dart zig " +
    // dados e config
    "json jsonc json5 yaml yml toml ini cfg conf properties xml csv tsv sql graphql gql proto cmake plist " +
    // texto, shaders, jogos
    "md rst txt svg glsl frag vert wgsl hlsl usf ush gd tscn tres uproject uplugin"
  ).split(" "),
);

// Arquivos conhecidos sem extensão (os que começam com ponto a pasta do Claude não varre, então ficam fora).
const NAMES = new Set(["dockerfile", "makefile", "procfile", "gemfile", "rakefile", "license", "readme"]);

/** Parece segredo (senha, chave, token): nunca entra na sala, que é compartilhada. */
export const SECRET_PATH =
  /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|id_rsa[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore)|\.npmrc|\.pypirc|[^/]*(secret|credential|serviceaccount)[^/]*\.(json|ya?ml|toml|ini|txt))$/i;

/** Gerado ou enorme e inútil para o Claude: travas de pacote, minificados, source maps. */
const NOISE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/i;

/** Pastas que não sobem: gerenciadas por ferramentas, saídas de build, ou da própria sala. */
export const IGNORE_PATH =
  /(^|\/)(\.gfs|\.git|\.claude|\.vscode|\.idea|node_modules|dist|android|ios|builds|Packages|ServerPackages|__pycache__|\.venv|venv|\.next|\.nuxt|\.cache|\.gradle|\.pytest_cache|\.mypy_cache|\.tox)(\/|$)|^(target|build|out|obj|coverage|Pods|DerivedData)\//;

/** Só em sala Unreal (outros tipos podem ter Build/ ou Content/ de verdade, ex.: Unity WebGL): pastas geradas ou binárias
 * em qualquer nível (Plugins/X/Binaries também). Content/ é .uasset/.umap, menos Content/Python (scripts do editor). */
export const UNREAL_IGNORE_PATH = /(^|\/)(Binaries|Intermediate|Saved|DerivedDataCache|\.vs|Build)(\/|$)|(^|\/)Content\/(?!Python(\/|$))/i;

/** Pastas onde o projeto Unreal (.uproject) nunca está: a busca (raiz e subpastas até 2 níveis) não entra nelas nem nas que
 * começam com ponto. Igual ao SKIP de app/src-tauri/src/unreal.rs. */
export const UE_PROJECT_SKIP = /^(node_modules|intermediate|saved|deriveddatacache|binaries|builds|content|build)$/i;

/** O arquivo é texto de código/script que a sala aceita? (`rel` = caminho relativo à pasta do projeto) */
export function isCodePath(rel: string): boolean {
  if (SECRET_PATH.test(rel) || NOISE.test(rel)) return false;
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  if (NAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && EXT.has(base.slice(dot + 1));
}
