// Mapa da sala: um índice curto de cada arquivo (tamanho, funções e linhas), gerado do código, sem IA.
// O Claude lê o mapa em vez de abrir arquivo inteiro: acha o trecho e lê só aquelas linhas.
// Vai para .gfs/MAPA.md (não sincroniza: cada máquina gera o seu, é de graça).
// Função pura, sem dependências. Mantenha igual a gfs/src/mapa.ts.

const MAX_SYMBOLS = 60; // shortcut: arquivo com mais símbolos que isso mostra só os primeiros; subir se faltar
const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return"]);

// Aceita até 2 espaços de recuo: os jogos usam (() => { ... })() e o código fica nesse nível.
const JS = [
  /^ {0,2}(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, // function nome(
  /^ {0,2}(?:export\s+)?class\s+([\w$]+)/, // class Nome
  /^ {0,2}(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\(|function|[\w$]+\s*=>|\{|\[)/, // const x = (..)=> / { / [ (ignora const N = 600)
];

// Luau: function Nome( / local function nome( / function Mod.nome( / function Mod:nome(
// Python: def / async def / class (métodos recuados até 4 espaços); PowerShell: function Nome
const PY = /^ {0,4}(?:async\s+def|def|class)\s+(\w+)/;
const PS = /^ {0,2}function\s+([\w-]+)/i;
const LUAU = /^\s{0,2}(?:local\s+)?function\s+([\w.:]+)/;

function symbols(path: string, text: string): string[] {
  const out: string[] = [];
  const keep = (name: string, n: number) => out.length < MAX_SYMBOLS && !NOT_NAMES.has(name) && out.push(`${name}@${n}`);
  const isJs = /\.(m?js|cjs|jsx|m?ts|cts|tsx)$/i.test(path);
  const isPy = /\.pyw?$/i.test(path);
  const isPs = /\.psm?1$/i.test(path);
  const isLuau = /\.luau?$/i.test(path);
  const isMd = /\.md$/i.test(path);
  const isHtml = /\.html?$/i.test(path);
  text.split("\n").forEach((l, i) => {
    if (isJs) for (const re of JS) { const m = re.exec(l); if (m) { keep(m[1], i + 1); break; } }
    else if (isPy) { const m = PY.exec(l); if (m) keep(m[1], i + 1); }
    else if (isPs) { const m = PS.exec(l); if (m) keep(m[1], i + 1); }
    else if (isLuau) { const m = LUAU.exec(l); if (m) keep(m[1], i + 1); }
    else if (isMd) { const m = /^#{1,3}\s+(.+)/.exec(l); if (m) keep(m[1].trim().slice(0, 50), i + 1); }
    else if (isHtml) { const m = /<script[^>]*\ssrc="([^"]+)"/.exec(l); if (m) keep(m[1], i + 1); }
  });
  return out;
}

export function buildMap(files: [path: string, text: string][], roomName: string): string {
  let bytes = 0;
  const rows = [...files]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, t]) => {
      bytes += t.length;
      const size = t.length > 50_000 ? `, ${Math.round(t.length / 1000)}KB` : "";
      const lines = t.split("\n");
      // Linha gigante = dado em texto (música/imagem em base64): uma busca nele devolve MBs. Avisa o Claude.
      if (lines.some((l) => l.length > 100_000)) return `${p} (${lines.length}L${size}) ⚠ DADOS em texto, não busque nem abra`;
      return `${p} (${lines.length}L${size}) ${symbols(p, t).join(" ")}`.trimEnd();
    });
  const head = `# MAPA da sala "${roomName}"
Índice gerado do código (nome@linha). Use assim: ache o nome aqui, depois leia só as linhas dele (Read com offset/limit). Não abra arquivo inteiro.
Gerado em ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${rows.length} arquivos, ${Math.round(bytes / 1000)} KB de código. Desatualizou? Rode: gfs map

`;
  return head + rows.join("\n") + "\n";
}
