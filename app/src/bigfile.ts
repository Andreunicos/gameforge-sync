// Arquivos grandes (ex.: música em base64): um documento do Firestore guarda no máximo ~1 MB,
// então acima de MAX_FILE_BYTES o conteúdo vai em pedaços para rooms/{id}/blobs/{arquivo~n}.
// O documento do arquivo fica com content "" + parts/size; cada pedaço leva a versão,
// e quem lê só aceita pedaços da mesma versão do arquivo.
//
// Mesmo arquivo em app/src/bigfile.ts e gfs/src/bigfile.ts (sem dependências).

/** Até aqui o arquivo cabe inteiro no documento. */
export const MAX_FILE_BYTES = 900_000;
/** Limite de um arquivo da sala (uma gravação do Firestore aceita ~10 MB no total). */
export const MAX_BIG_BYTES = 7_000_000;
const PART_BYTES = 900_000;

const enc = new TextEncoder();
export const utf8Bytes = (s: string) => enc.encode(s).length;

export const isBig = (content: string) => utf8Bytes(content) > MAX_FILE_BYTES;

export const blobDocId = (fileDocId: string, i: number) => `${fileDocId}~${i}`;

export const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString("pt-BR")} KB`;

/** Corta o texto em pedaços de até PART_BYTES (em UTF-8), sem partir caractere. */
export function splitParts(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + PART_BYTES);
    while (utf8Bytes(s.slice(i, end)) > PART_BYTES) end = i + Math.floor((end - i) * 0.9);
    const c = s.charCodeAt(end - 1);
    if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--; // não separa par surrogate
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}
