import { useLayoutEffect, useRef } from "react";
import type { RoomSync, RoomSyncState } from "../sync/roomSync";
import type { SaveStatus } from "../sync/session";

const STATUS_LABEL: Record<SaveStatus, string> = {
  saved: "✓ salvo",
  dirty: "● editando",
  saving: "↑ gravando…",
  conflict: "⚠ conflito — resolva os marcadores",
  error: "✕ erro ao gravar (tentando de novo)",
  "too-big": "⚠ grande demais",
};

export function EditorPane({ sync, state }: { sync: RoomSync; state: RoomSyncState }) {
  const host = useRef<HTMLDivElement>(null);
  const active = state.active && state.files.some((f) => f.path === state.active) ? state.active : null;

  // Cada arquivo tem o seu EditorView (guarda desfazer, rolagem e seleção); aqui só trocamos qual aparece.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || !active) return;
    const view = sync.session(active).view;
    if (el.firstChild !== view.dom) el.replaceChildren(view.dom);
    view.requestMeasure();
    view.focus();
  }, [sync, active]);

  const file = state.files.find((f) => f.path === active);
  const status = active ? (state.statuses[active] ?? "saved") : null;

  return (
    <section className="editor-col">
      <div className="editor-tabbar">
        <span className="grow ellipsis">{active ?? ""}</span>
        {file && (
          <span className="muted small" title="Versão no Firebase e quem gravou por último">
            v{file.version} · {file.author.kind === "claude" ? `Claude de ${file.author.name}` : file.author.name}
          </span>
        )}
        {status && <span className={`status ${status}`}>{STATUS_LABEL[status]}</span>}
      </div>
      {active ? (
        <div className="editor-host" ref={host} />
      ) : (
        <div className="empty-editor">
          {state.files.length ? "Escolha um arquivo à esquerda." : "Crie ou importe arquivos para começar."}
        </div>
      )}
    </section>
  );
}
