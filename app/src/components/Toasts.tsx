import type { Toast } from "../sync/roomSync";

export function Toasts({ toasts, onClose }: { toasts: (Toast & { id: number })[]; onClose: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button className="ghost icon" onClick={() => onClose(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
