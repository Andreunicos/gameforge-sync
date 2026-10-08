import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { buildPreview, findEntry } from "../preview";
import type { RoomSync } from "../sync/roomSync";
import type { Room } from "../types";

type Device = "free" | "phone" | "landscape";

/** Proporção de um celular moderno (altura ÷ largura em pé). */
const PHONE_RATIO = 19.5 / 9;
const FRAME_GAP = 28; // espaço em volta da moldura do celular

/** Maior tamanho de celular que cabe no palco, mantendo a proporção. */
function phoneSize(device: Device, w: number, h: number) {
  if (device === "free") return null;
  const ratio = device === "phone" ? 1 / PHONE_RATIO : PHONE_RATIO; // largura ÷ altura
  const aw = Math.max(0, w - FRAME_GAP * 2);
  const ah = Math.max(0, h - FRAME_GAP * 2);
  const width = Math.min(aw, ah * ratio);
  return { width: Math.floor(width), height: Math.floor(width / ratio) };
}
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
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [full, setFull] = useState(false);

  // Mede o palco sempre que ele muda de tamanho (janela, tela cheia, esconder console…).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen().catch(() => {});
  };
  const size = phoneSize(device, stage.w, stage.h);
  const st = useSyncExternalStore(
    (l) => sync.subscribe(l),
    () => sync.state,
  );
  // O preview roda o jogo inteiro como um site: começa na página inicial e segue os links do próprio jogo.
  const pages = st.files.map((f) => f.path).filter((p) => /[.]html?$/i.test(p)).sort();
  const startKey = `gfs-start-${room.id}`;
  const [start, setStart] = useState<string | null>(() => {
    try {
      return localStorage.getItem(startKey);
    } catch {
      return null;
    }
  });
  const home = start && pages.includes(start) ? start : findEntry(pages);
  const [current, setCurrent] = useState<string | null>(null);
  const entry = current && pages.includes(current) ? current : home;
  const storage = useRef<Record<string, string>>({}); // localStorage do jogo, igual em todas as páginas
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const chooseStart = (p: string) => {
    setStart(p);
    setCurrent(null);
    try {
      localStorage.setItem(startKey, p);
    } catch {
      /* sem storage: vale só nesta sessão */
    }
  };
  const timer = useRef<number | undefined>(undefined);
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const reload = useCallback(() => {
    const { html, warnings } = buildPreview({
      paths: sync.paths(),
      contentOf: (p) => sync.contentOf(p),
      assetsBase: room.assetsBase,
      entry,
      storage: storage.current,
    });
    setLogs(warnings.map((text) => ({ level: "warn", text })));
    if (frame.current) frame.current.srcdoc = html;
  }, [sync, room.assetsBase, entry]);

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
      const d = e.data;
      if (Array.isArray(d.store)) {
        const [k, v] = d.store as [string, string | null];
        if (v === null) delete storage.current[k];
        else storage.current[k] = v;
        return;
      }
      if (typeof d.nav === "string") {
        if (pagesRef.current.includes(d.nav)) setCurrent(d.nav);
        else setLogs((l) => [...l, { level: "warn", text: `O jogo tentou abrir ${d.nav}, mas essa página não existe na sala.` }]);
        return;
      }
      setLogs((l) => [...l.slice(-199), { level: String(e.data.level), text: String(e.data.text) }]);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);

  const errors = logs.filter((l) => l.level === "error").length;

  return (
    <section className="preview-col">
      <div className="preview-bar">
        <button
          className="ghost icon"
          onClick={() => {
            if (current && current !== home) setCurrent(null);
            else reload();
          }}
          title="Recomeçar o jogo da página inicial"
        >
          ⟳
        </button>
        <label className="row small muted" title="Recarregar sozinho quando alguém mexer no código">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto
        </label>
        <span className="grow" />
        {entry && entry !== home && <span className="small muted ellipsis" title="Página em que o jogo está agora">▸ {entry}</span>}
        {pages.length > 1 && (
          <select
            value={home ?? ""}
            onChange={(e) => chooseStart(e.target.value)}
            title="Página inicial do jogo (por onde o preview começa)"
            style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "3px 6px", maxWidth: 160 }}
          >
            {pages.map((p) => (
              <option key={p} value={p}>
                Início: {p}
              </option>
            ))}
          </select>
        )}
        <select
          value={device}
          onChange={(e) => setDevice(e.target.value as Device)}
          style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "3px 6px" }}
        >
          <option value="free">Tela livre</option>
          <option value="phone">Celular em pé</option>
          <option value="landscape">Celular deitado</option>
        </select>
        <button className="ghost icon" onClick={toggleFull} title="Tela cheia (Esc para sair)">
          ⛶
        </button>
      </div>
      <div
        className={`preview-stage ${device}${full ? " full" : ""}`}
        ref={stageRef}
        onDoubleClick={(e) => e.target === e.currentTarget && toggleFull()}
      >
        {full && (
          <button className="exit-full" onClick={toggleFull} title="Sair da tela cheia (Esc)">
            ✕ sair da tela cheia
          </button>
        )}
        <iframe
          ref={frame}
          style={size ? { width: size.width, height: size.height } : undefined}
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
