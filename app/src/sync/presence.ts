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
  private unsubConn: () => void;
  /**
   * Nó inteiro desta pessoa. Numa queda de rede o servidor roda o onDisconnect (apaga o nó) e os
   * update() seguintes, sem name/color, são recusados pelo .validate: a pessoa sumiria até recarregar.
   * Por isso, a cada reconexão, regrava tudo e arma o onDisconnect de novo.
   */
  private state: Omit<Presence, "at">;
  private left = false;

  constructor(
    roomId: string,
    me: Omit<Presence, "file" | "line" | "col" | "at">,
    onPeople: (people: Presence[]) => void,
  ) {
    const db = rtdb();
    this.myRef = ref(db, `presence/${roomId}/${me.uid}`);
    this.state = { ...me, file: null, line: 1, col: 0 };
    void onDisconnect(this.myRef).remove();
    void set(this.myRef, { ...this.state, at: serverTimestamp() });
    this.unsubConn = onValue(ref(db, ".info/connected"), (snap) => {
      if (snap.val() !== true || this.left) return;
      void onDisconnect(this.myRef)
        .remove()
        .then(() => {
          if (!this.left) return set(this.myRef, { ...this.state, at: serverTimestamp() });
        })
        .catch(() => {});
    });
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
    this.patch(this.pending, true);
    this.pending = null;
  }

  private patch(p: Partial<Presence>, stamp = false) {
    if (this.left) return;
    this.state = { ...this.state, ...p };
    void update(this.myRef, stamp ? { ...p, at: serverTimestamp() } : p).catch(() => {});
  }

  /** Liga/desliga o selo do Claude (pasta ligada) e o arquivo em que ele está mexendo. */
  setClaude(on: boolean, file: string | null = null) {
    this.patch({ claudeOn: on, claudeFile: file });
  }

  /** Sala Unreal: seleção no editor e servidor do Multi-User que esta pessoa hospeda (null apaga). */
  setUnreal(patch: Pick<Presence, "ue"> | Pick<Presence, "mue">) {
    this.patch(patch);
  }

  leave() {
    this.left = true;
    window.clearTimeout(this.timer);
    this.unsub();
    this.unsubConn();
    void remove(this.myRef);
  }
}
