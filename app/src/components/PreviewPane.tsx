import { useCallback, useEffect, useRef, useState } from "react";
import { buildPreview } from "../preview";
import type { RoomSync } from "../sync/roomSync";
import type { Room } from "../types";

type Device = "free" | "phone" | "landscape";
interface LogLine {
  level: string;
  text: string;
}

// Junta várias mudanças seguidas num reload só, para o jogo não piscar a cada tecla.
const RELOAD_DEBOUNCE_MS = 1500;

export function PreviewPane({ sync, room }: { sync: RoomSync; room: Room }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [auto, setAuto] = useState(true);
  const [device, setDevice] = useState<Device>("free");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const reload = useCallback(() => {
    const { html, warnings } = buildPreview({
      paths: sync.paths(),
      contentOf: (p) => sync.contentOf(p),
      assetsBase: room.assetsBase,
    });
    setLogs(warnings.map((text) => ({ level: "warn", text })));
    if (frame.current) frame.current.srcdoc = html;
  }, [sync, room.assetsBase]);

  useEffect(() => {
    reload();
    const off = sync.onContentChange(() => {
      if (!autoRef.current) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(reload, RELOAD_DEBOUNCE_MS);
    });
    return () => {
      off();
      window.clearTimeout(timer.current);
    };
  }, [sync, reload]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data?.__gfs) return;
      setLogs((l) => [...l.slice(-199), { level: String(e.data.level), text: String(e.data.text) }]);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);

  const errors = logs.filter((l) => l.level === "error").length;

  return (
    <section className="preview-col">
      <div className="preview-bar">
        <button className="ghost icon" onClick={reload} title="Recarregar o jogo">
          ⟳
        </button>
        <label className="row small muted" title="Recarregar sozinho quando alguém mexer no código">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto
        </label>
        <span className="grow" />
        <select
          value={device}
          onChange={(e) => setDevice(e.target.value as Device)}
          style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "3px 6px" }}
        >
          <option value="free">Tela livre</option>
          <option value="phone">Celular em pé</option>
          <option value="landscape">Celular deitado</option>
        </select>
      </div>
      <div className={`preview-stage ${device}`}>
        <iframe
          ref={frame}
          title="Preview do jogo"
          sandbox="allow-scripts allow-pointer-lock allow-popups allow-forms allow-modals"
          allow="autoplay; fullscreen; gamepad"
        />
      </div>
      {logs.length > 0 && (
        <div className="console">
          <div className="console-head">
            <span>
              Console {errors > 0 && <b style={{ color: "#ff9aa5" }}>· {errors} erro{errors > 1 ? "s" : ""}</b>}
            </span>
            <button className="ghost small" onClick={() => setLogs([])}>
              limpar
            </button>
          </div>
          {logs.map((l, i) => (
            <div key={i} className={l.level}>
              {l.text}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
