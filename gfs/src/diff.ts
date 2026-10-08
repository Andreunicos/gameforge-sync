// Cópia de app/src/diff.ts.
// Diferença entre duas versões de um arquivo: estatística (+/−, em que funções) e linhas para mostrar.
import { diffComm } from "node-diff3";

export type DiffLine = { t: "same" | "add" | "del"; text: string; old?: number; neu?: number } | { t: "gap"; n: number };

const FN_RE =
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)|^\s*([\w$]+)\s*:\s*(?:async\s*)?function\b|^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b)([\w$]+)\s*\([^)]*\)\s*\{|^\s*class\s+([\w$]+)|^\s*([^{}@/]{1,60}?)\s*\{\s*$/;

/** Nome da função (ou seletor CSS) que contém a linha `i` do texto novo. */
function enclosing(lines: string[], i: number): string | null {
  for (let k = Math.min(i, lines.length - 1); k >= 0 && k > i - 300; k--) {
    const m = FN_RE.exec(lines[k]);
    if (m) {
      const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? "").trim();
      if (name) return /^[\w$]+$/.test(name) ? `${name}()` : name;
    }
  }
  return null;
}

export function diffStats(prev: string | null, next: string) {
  if (prev === null) return { added: next ? next.split("\n").length : 0, removed: 0, where: [] as string[] };
  const a = prev.split("\n");
  const b = next.split("\n");
  let added = 0;
  let removed = 0;
  let bi = 0;
  const where = new Set<string>();
  for (const part of diffComm(a, b)) {
    if (part.common) {
      bi += part.common.length;
      continue;
    }
    added += part.buffer2.length;
    removed += part.buffer1.length;
    const name = enclosing(b, bi);
    if (name && where.size < 6) where.add(name);
    bi += part.buffer2.length;
  }
  return { added, removed, where: [...where] };
}

/** Linhas para mostrar na tela, com trechos iguais longos recolhidos. */
export function diffLines(prev: string, next: string, context = 3): DiffLine[] {
  const out: DiffLine[] = [];
  let oi = 0;
  let ni = 0;
  const parts = diffComm(prev.split("\n"), next.split("\n"));
  parts.forEach((part, idx) => {
    if (part.common) {
      const lines = part.common;
      const first = idx === 0;
      const last = idx === parts.length - 1;
      const keepHead = first ? 0 : context;
      const keepTail = last ? 0 : context;
      if (lines.length > keepHead + keepTail + 1) {
        lines.slice(0, keepHead).forEach((text, k) => out.push({ t: "same", text, old: oi + k + 1, neu: ni + k + 1 }));
        out.push({ t: "gap", n: lines.length - keepHead - keepTail });
        const start = lines.length - keepTail;
        lines.slice(start).forEach((text, k) => out.push({ t: "same", text, old: oi + start + k + 1, neu: ni + start + k + 1 }));
      } else {
        lines.forEach((text, k) => out.push({ t: "same", text, old: oi + k + 1, neu: ni + k + 1 }));
      }
      oi += lines.length;
      ni += lines.length;
    } else {
      part.buffer1.forEach((text, k) => out.push({ t: "del", text, old: oi + k + 1 }));
      part.buffer2.forEach((text, k) => out.push({ t: "add", text, neu: ni + k + 1 }));
      oi += part.buffer1.length;
      ni += part.buffer2.length;
    }
  });
  return out;
}
