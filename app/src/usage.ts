// Contador local de gravações no Firestore feitas por este app hoje.
// Não é o total da sala (isso só o console do Firebase mostra), mas avisa antes de chegar perto do limite.

type Listener = (n: number) => void;
const listeners = new Set<Listener>();

function key() {
  return "gfs-writes-" + new Date().toISOString().slice(0, 10);
}

export function writesToday(): number {
  try {
    return Number(localStorage.getItem(key()) ?? 0);
  } catch {
    return 0;
  }
}

export function countWrite(n = 1) {
  const total = writesToday() + n;
  try {
    localStorage.setItem(key(), String(total));
  } catch {
    /* sem storage: só não persiste */
  }
  listeners.forEach((l) => l(total));
}

export function onWrites(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
