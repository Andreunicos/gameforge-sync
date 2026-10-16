// Imagens temporárias da lista de bugs. Ficam em rooms/{id}/bugimgs (JPEG em base64, ~100–400 KB)
// e viram arquivo em .gfs/bugs/<id>.jpg na pasta do Claude. Somem quando o item sai de IDEIAS_E_BUGS.md.
import { collection, deleteDoc, doc, getDocs, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import { countWrite } from "./usage";

export const BUGS_FILE = "IDEIAS_E_BUGS.md";
export const imgFile = (id: string) => `.gfs/bugs/${id}.jpg`;
const GRACE_MS = 10 * 60_000; // imagem recém-enviada ainda pode não estar no .md de quem limpa
const col = (roomId: string) => collection(db, "rooms", roomId, "bugimgs");

/** Reduz para JPEG que caiba num documento do Firestore (< 1 MB). Devolve o base64 puro. */
export async function compressImage(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  for (const [side, q] of [[1280, 0.72], [1000, 0.6], [720, 0.5]] as const) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff"; // PNG transparente não vira preto no JPEG
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const b64 = c.toDataURL("image/jpeg", q).split(",")[1];
    if (b64.length < 600_000) return b64;
  }
  throw new Error("Imagem grande demais para enviar.");
}

export async function addBugImage(roomId: string, b64: string): Promise<string> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await setDoc(doc(col(roomId), id), { data: b64, ts: Date.now() });
  countWrite();
  return id;
}

/** Lista viva das imagens da sala (para a pasta do Claude). */
export function watchBugImgs(roomId: string, cb: (imgs: { id: string; data: string }[]) => void): () => void {
  return onSnapshot(
    col(roomId),
    (s) => cb(s.docs.map((d) => ({ id: d.id, data: d.data().data as string }))),
    (e) => console.warn("imagens dos bugs:", e),
  );
}

/** Apaga as imagens que não aparecem mais no IDEIAS_E_BUGS.md (o Claude apagou o item = resolvido). */
export async function cleanBugImgs(roomId: string, md: string) {
  const s = await getDocs(col(roomId));
  const gone = s.docs.filter((d) => (d.data().ts as number) < Date.now() - GRACE_MS && !md.includes(d.id));
  await Promise.all(gone.map((d) => deleteDoc(d.ref)));
  countWrite(gone.length);
}
