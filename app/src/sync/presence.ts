import { onDisconnect, onValue, ref, remove, serverTimestamp, set, update } from "firebase/database";
import { rtdb } from "../firebase";
import type { Presence } from "../types";

/**
 * Presença e cursores no Realtime Database (cobra por volume, não por gravação,
 * então pode atualizar com frequência sem gastar a cota do Firestore).
 */
export class PresenceChannel {
  private myRef;
  private lastSent = 0;
  private pending: Partial<Presence> | null = null;
  private timer: number | undefined;
  private unsub: () => void;

  constructor(
    roomId: string,
    me: Omit<Presence, "file" | "line" | "col" | "at">,
    onPeople: (people: Presence[]) => void,
  ) {
    const db = rtdb();
    this.myRef = ref(db, `presence/${roomId}/${me.uid}`);
    void onDisconnect(this.myRef).remove();
    void set(this.myRef, { ...me, file: null, line: 1, col: 0, at: serverTimestamp() });
    this.unsub = onValue(ref(db, `presence/${roomId}`), (snap) => {
      const val = (snap.val() ?? {}) as Record<string, Presence>;
      onPeople(Object.entries(val).map(([uid, p]) => ({ ...p, uid })));
    });
  }

  /** Atualiza arquivo/cursor no máximo ~3x por segundo. */
  move(file: string | null, line: number, col: number) {
    this.pending = { file, line, col };
    const wait = 300 - (Date.now() - this.lastSent);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.send(), Math.max(0, wait));
  }

  private send() {
    if (!this.pending) return;
    this.lastSent = Date.now();
    void update(this.myRef, { ...this.pending, at: serverTimestamp() });
    this.pending = null;
  }

  leave() {
    window.clearTimeout(this.timer);
    this.unsub();
    void remove(this.myRef);
  }
}
