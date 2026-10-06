import { diff3Merge } from "node-diff3";

export interface Merge3Result {
  text: string;
  conflicts: number;
}

/**
 * Merge de 3 vias por linha: `base` é a versão de onde os dois partiram,
 * `mine` é a minha, `theirs` a que chegou do Firebase.
 * Trechos que os dois mudaram de jeitos diferentes viram marcadores de conflito
 * no estilo do git, com o nome de quem fez a outra mudança.
 */
export function merge3(base: string, mine: string, theirs: string, theirName: string): Merge3Result {
  if (mine === theirs) return { text: mine, conflicts: 0 };
  if (base === mine) return { text: theirs, conflicts: 0 };
  if (base === theirs) return { text: mine, conflicts: 0 };

  const regions = diff3Merge(mine.split("\n"), base.split("\n"), theirs.split("\n"));
  const out: string[] = [];
  let conflicts = 0;
  for (const r of regions) {
    if (r.ok) out.push(...r.ok);
    else if (r.conflict) {
      conflicts++;
      out.push("<<<<<<< sua versão", ...r.conflict.a, "=======", ...r.conflict.b, `>>>>>>> versão de ${theirName}`);
    }
  }
  return { text: out.join("\n"), conflicts };
}

const CONFLICT_RE = /^<{7} .*$[\s\S]*?^={7}$[\s\S]*?^>{7} .*$/m;

export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_RE.test(text);
}
