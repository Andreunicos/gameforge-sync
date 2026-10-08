import { Annotation, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { addHistory } from "../history";
import { MAX_FILE_BYTES, SAVE_DEBOUNCE_MS } from "../config";
import { countWrite } from "../usage";
import type { Author, RemoteFile } from "../types";
import { editorExtensions, setRemoteCursors, type RemoteCursor } from "./editorSetup";
import { hasConflictMarkers, merge3 } from "./merge";

export type SaveStatus = "saved" | "dirty" | "saving" | "conflict" | "error" | "too-big";

/** Marca as mudanças que vieram do Firebase, para não serem tratadas como digitação. */
const fromRemote = Annotation.define<boolean>();

class StaleVersion extends Error {}

export interface SessionHooks {
  roomId: string;
  author: Author;
  onStatus(path: string, status: SaveStatus, detail?: string): void;
  onLocalEdit(path: string): void;
  onCursor(path: string, line: number, col: number): void;
  onSaved(path: string, created: boolean): void;
  onConflict(path: string, count: number, theirName: string): void;
}

export function fileDocId(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Um arquivo aberto no editor. Guarda a "base" (última versão do Firebase de onde
 * o texto local partiu), grava depois de uma pausa na digitação numa transação que só
 * passa se ninguém gravou antes, e quando chega versão nova de outra pessoa faz
 * merge de 3 vias com o que está sendo digitado.
 */
export class FileSession {
  readonly view: EditorView;
  status: SaveStatus = "saved";
  private base: { content: string; version: number };
  private inflight: { content: string; version: number } | null = null;
  private saving = false;
  private saveTimer: number | undefined;
  private destroyed = false;

  constructor(
    readonly path: string,
    remote: RemoteFile | null,
    readOnly: boolean,
    private hooks: SessionHooks,
  ) {
    this.base = remote ? { content: remote.content, version: remote.version } : { content: "", version: 0 };
    this.view = new EditorView({
      state: EditorState.create({
        doc: this.base.content,
        extensions: [
          editorExtensions(path, readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(fromRemote))) {
              this.setStatus("dirty");
              this.hooks.onLocalEdit(this.path);
              this.scheduleSave();
            }
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              this.hooks.onCursor(this.path, line.number, head - line.from);
            }
          }),
        ],
      }),
    });
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  get dirty(): boolean {
    return this.text !== this.base.content;
  }

  /** Chegou um snapshot do Firebase para este arquivo (null = apagado). */
  onRemote(remote: RemoteFile | null) {
    if (!remote) {
      // Apagado por alguém. Se tem texto local, a próxima gravação recria o arquivo.
      this.base = { content: "", version: 0 };
      if (this.text) this.scheduleSave();
      return;
    }
    if (remote.version <= this.base.version) return;

    // Eco da minha própria gravação.
    if (this.inflight && remote.version === this.inflight.version && remote.content === this.inflight.content) {
      this.base = { content: remote.content, version: remote.version };
      return;
    }

    const local = this.text;
    if (local === this.base.content) {
      this.replaceText(remote.content);
      this.base = { content: remote.content, version: remote.version };
      this.setStatus("saved");
      return;
    }

    // Os dois mexeram: merge de 3 vias.
    const m = merge3(this.base.content, local, remote.content, remote.author.name);
    this.replaceText(m.text);
    this.base = { content: remote.content, version: remote.version };
    if (m.conflicts > 0) {
      this.setStatus("conflict");
      this.hooks.onConflict(this.path, m.conflicts, remote.author.name);
    } else {
      this.scheduleSave(300);
    }
  }

  setRemoteCursors(cursors: RemoteCursor[]) {
    this.view.dispatch({ effects: setRemoteCursors.of(cursors) });
  }

  /** Grava agora (ao trocar de arquivo, sair da sala etc.). */
  async flush() {
    window.clearTimeout(this.saveTimer);
    await this.save();
  }

  destroy() {
    this.destroyed = true;
    window.clearTimeout(this.saveTimer);
    this.view.destroy();
  }

  private scheduleSave(delay = SAVE_DEBOUNCE_MS) {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), delay);
  }

  private setStatus(s: SaveStatus, detail?: string) {
    this.status = s;
    this.hooks.onStatus(this.path, s, detail);
  }

  /** Troca o texto do editor pela versão nova mexendo só no trecho que mudou (o cursor não pula). */
  private replaceText(next: string) {
    const cur = this.text;
    if (cur === next) return;
    let start = 0;
    const max = Math.min(cur.length, next.length);
    while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
    let endCur = cur.length;
    let endNext = next.length;
    while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
      endCur--;
      endNext--;
    }
    this.view.dispatch({
      changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
      annotations: [fromRemote.of(true)],
    });
  }

  private async save() {
    if (this.destroyed) return;
    if (this.saving) {
      this.scheduleSave(500);
      return;
    }
    const content = this.text;
    if (content === this.base.content && this.base.version > 0) {
      this.setStatus("saved");
      return;
    }
    if (hasConflictMarkers(content)) {
      this.setStatus("conflict");
      return;
    }
    if (new Blob([content]).size > MAX_FILE_BYTES) {
      this.setStatus("too-big", "Arquivo maior que 900 KB não cabe num documento do Firestore.");
      return;
    }

    const baseVersion = this.base.version;
    const version = baseVersion + 1;
    const ref = doc(db, "rooms", this.hooks.roomId, "files", fileDocId(this.path));
    this.saving = true;
    this.inflight = { content, version };
    this.setStatus("saving");
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists() ? (snap.data().version as number) : 0;
        if (current !== baseVersion) throw new StaleVersion();
        tx.set(ref, { path: this.path, content, version, author: this.hooks.author, updatedAt: serverTimestamp() });
        addHistory(tx, this.hooks.roomId, this.path, version, content, snap.exists() ? (snap.data().content as string) : null, this.hooks.author);
      });
      countWrite(2);
      if (this.base.version < version) this.base = { content, version };
      this.hooks.onSaved(this.path, baseVersion === 0);
      if (!this.destroyed) this.setStatus(this.dirty ? "dirty" : "saved");
    } catch (e) {
      if (e instanceof StaleVersion) {
        // Alguém gravou antes: o listener traz a versão nova, faz o merge e agenda outra gravação.
        this.setStatus("dirty");
      } else {
        console.error("Falha ao gravar", this.path, e);
        this.setStatus("error", e instanceof Error ? e.message : String(e));
        this.scheduleSave(5000);
      }
    } finally {
      this.saving = false;
      this.inflight = null;
      if (!this.destroyed && this.dirty && this.status !== "conflict" && this.status !== "error") this.scheduleSave();
    }
  }
}
