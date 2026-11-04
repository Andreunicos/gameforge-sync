// Área de Preview da sala Godot: o jogo rodando (embutido na janela do app, numa janela solta ou exportado para Web)
// e reiniciado sozinho quando os arquivos do jogo mudam (de qualquer pessoa ou Claude), como o preview do HTML5.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  COVER_SELECTOR,
  GODOT_MODES,
  explain,
  godotEmbedRect,
  godotEmbedStart,
  godotEmbedStop,
  godotExportWeb,
  godotImport,
  godotProjectDirs,
  godotRun,
  godotServe,
  godotStatus,
  godotStop,
  isOldApp,
  liveChange,
  liveQueue,
  loadMode,
  loadProject,
  rectsOverlap,
  saveMode,
  toPhysical,
  type GodotMode,
} from "../godot";
import { pickProject } from "../unreal";
import type { RoomSync } from "../sync/roomSync";
import type { Room } from "../types";

type Phase = "parado" | "abrindo" | "reiniciando" | "rodando" | "fechou";
const LABEL: Record<Phase, string> = { parado: "parado", abrindo: "abrindo…", reiniciando: "reiniciando…", rodando: "rodando", fechou: "o jogo fechou" };
const RESTART_DEBOUNCE_MS = 1500;
const openUrl = (url: string) => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));

export function GodotPreview({ room, sync, dir }: { room: Room; sync: RoomSync; dir?: string }) {
  const st = useSyncExternalStore(
    (l) => sync.subscribe(l),
    () => sync.state,
  );
  const project = pickProject(godotProjectDirs(st.files.map((f) => f.path)), loadProject(room.id));
  const proj = typeof project === "string" ? project : null;
  const ready = isTauri() && !!dir && proj !== null;

  const [mode, setMode] = useState<GodotMode>(loadMode);
  const [auto, setAuto] = useState(true);
  const [wanted, setWanted] = useState(() => loadMode() === "embed"); // janela/Web só abrem quando a pessoa pede
  const [phase, setPhase] = useState<Phase>("parado");
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState<string | null>(null);
  const [old, setOld] = useState(false);
  const [covered, setCovered] = useState(false);
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const live = useRef({ mode, dir, proj, auto, wanted, phase });
  live.current = { mode, dir, proj, auto, wanted, phase };
  const setP = (p: Phase) => {
    live.current.phase = p;
    setPhase(p);
  };

  /** Onde está a área (pixels físicos) e se o jogo pode aparecer (nada por cima, app visível). */
  const geom = () => {
    const b = stageRef.current?.getBoundingClientRect();
    if (!b) return { rect: { x: 0, y: 0, w: 0, h: 0 }, visible: false, cover: false };
    const cover = [...document.querySelectorAll(COVER_SELECTOR)].some((c) => rectsOverlap(c.getBoundingClientRect(), b));
    return { rect: toPhysical(b, window.devicePixelRatio || 1), visible: !cover && document.visibilityState === "visible", cover };
  };

  // Uma ação por vez (abrir, reiniciar, parar), na ordem em que foram pedidas.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (fn: () => Promise<void>) => {
    chain.current = chain.current.then(fn, fn);
  };
  const restart = (doImport: boolean, again: boolean) =>
    enqueue(async () => {
      const { mode: m, dir: d, proj: p } = live.current;
      if (!d || p === null) return;
      setP(again ? "reiniciando" : "abrindo");
      setError(null);
      setTail(null);
      try {
        if (doImport) await godotImport(d, p);
        if (m === "embed") {
          const g = geom();
          await godotEmbedStart(d, p, g.rect, g.visible);
        } else if (m === "window") {
          await godotStop(d);
          await godotRun(d, p);
        } else {
          await godotExportWeb(d, p);
          setWebUrl(`http://127.0.0.1:${await godotServe(d)}/?t=${Date.now()}`);
        }
        setP("rodando");
      } catch (e) {
        if (isOldApp(e)) setOld(true);
        else setError(explain(e));
        setP("parado");
      }
    });
  const stopMode = (m: GodotMode, d: string | undefined) =>
    enqueue(async () => {
      setP("parado");
      if (m === "embed") await godotEmbedStop().catch(() => {});
      else if (m === "window" && d) await godotStop(d).catch(() => {});
      else setWebUrl(null);
    });

  // Abre quando dá (e reabre ao trocar de modo/projeto); fecha ao sair da sala, esconder o Preview ou ⏸.
  useEffect(() => {
    if (!ready || !wanted || old) return;
    restart(false, false);
    return () => stopMode(mode, dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, wanted, old, mode, dir, proj]);

  // Arquivos do jogo mudaram (de qualquer pessoa/Claude): 1,5 s de silêncio e reinicia (importando se precisar).
  useEffect(() => {
    if (!ready) return;
    const queue = liveQueue(RESTART_DEBOUNCE_MS, (imp) => {
      if (live.current.auto && live.current.wanted) restart(imp, true);
    });
    let off: (() => void) | undefined;
    let alive = true;
    void sync.whenLoaded().then(() => {
      if (!alive) return;
      const seen = new Map(sync.remoteFiles().map((f) => [f.path, f.content]));
      off = sync.onRemoteFile((path, f) => {
        const kind = liveChange(path, seen.get(path), f?.content, live.current.proj ?? "");
        if (f) seen.set(path, f.content);
        else seen.delete(path);
        if (kind !== "none") queue.push(kind);
      });
    });
    return () => {
      alive = false;
      off?.();
      queue.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sync]);

  // Embutido: manda a posição da área ao mudar e a cada 1 s (sinal de vida), esconde se um painel/aviso cobrir.
  useEffect(() => {
    if (!ready || mode !== "embed" || !dir) return;
    let last = "";
    let lastAt = 0;
    let wasCover = false;
    const tick = () => {
      const g = geom();
      if (g.cover !== wasCover) setCovered((wasCover = g.cover));
      const key = JSON.stringify(g);
      if (key === last && Date.now() - lastAt < 1000) return;
      last = key;
      lastAt = Date.now();
      godotEmbedRect(dir, g.rect, g.visible).then(
        (s) => {
          if (live.current.phase === "rodando" && !s.running && s.code !== null) {
            setP("fechou");
            setTail(`Código ${s.code}.\n${s.tail ?? ""}`.trim());
          }
        },
        (e) => isOldApp(e) && setOld(true),
      );
    };
    const t = window.setInterval(tick, 250);
    const mo = new MutationObserver(tick); // modal/aviso abriu: esconde já, sem esperar o próximo tique
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      mo.disconnect();
      window.removeEventListener("resize", tick);
      document.removeEventListener("visibilitychange", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode, dir]);

  // Janela solta: percebe quando a pessoa fecha a janela ou o jogo cai.
  useEffect(() => {
    if (!ready || mode !== "window" || !dir) return;
    const t = window.setInterval(() => {
      if (live.current.phase === "rodando")
        godotStatus(dir).then(
          (s) => !s.running && live.current.phase === "rodando" && setP("fechou"),
          () => {},
        );
    }, 2000);
    return () => window.clearInterval(t);
  }, [ready, mode, dir]);

  const chooseMode = (m: GodotMode) => {
    saveMode(m);
    setMode(m);
    setOld(false);
    setError(null);
  };
  const busy = phase === "abrindo" || phase === "reiniciando";
  const on = wanted && phase !== "parado";

  let note: string | null = null;
  if (!isTauri()) note = "O jogo da Godot roda só no app de PC.";
  else if (!dir) note = "Ligue a pasta do Claude (botão 🤖 Claude) para o jogo rodar aqui.";
  else if (project === null) note = "Não achei o project.godot na sala.";
  else if (project === undefined) note = "A sala tem mais de um projeto Godot: escolha qual no 🎮 Godot.";
  else if (old)
    note =
      mode === "embed"
        ? "Esta versão do app ainda não embute a Godot. Feche e abra o GameForge para atualizar; enquanto isso use “Janela solta” ou “Web”."
        : "Esta versão do app ainda não roda a Godot. Feche e abra o GameForge para atualizar.";
  else if (!wanted) note = "Jogo parado. Clique em ▶ para rodar.";
  else if (mode === "embed") note = covered ? "Jogo escondido enquanto um painel ou aviso está por cima." : phase === "rodando" ? "Carregando o jogo…" : LABEL[phase];
  else if (mode === "window") note = phase === "rodando" ? "O jogo está numa janela própria (reinicia sozinha quando os arquivos mudam)." : LABEL[phase];
  else if (!webUrl) note = phase === "parado" ? "Clique em ▶ para exportar para Web." : "Exportando para Web… (a primeira vez demora)";

  return (
    <section className="preview-col">
      <div className="preview-bar">
        <button className="ghost icon" disabled={!ready || busy || old} onClick={() => (wanted ? restart(true, true) : setWanted(true))} title="Reiniciar o jogo agora (importa antes)">
          ⟳
        </button>
        <button className="ghost icon" disabled={!ready || old} onClick={() => (on ? setWanted(false) : wanted ? restart(false, false) : setWanted(true))} title={on ? "Parar o jogo" : "Rodar o jogo"}>
          {on ? "⏸" : "▶"}
        </button>
        <label className="row small muted" title="Reiniciar sozinho quando alguém mexer nos arquivos do jogo">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto
        </label>
        <span className="grow" />
        <span className="small muted">{LABEL[phase]}</span>
        {mode === "web" && webUrl && (
          <button className="ghost icon" onClick={() => openUrl(webUrl)} title="Abrir no navegador (se não carregar aqui)">
            🌐
          </button>
        )}
        <select
          value={mode}
          onChange={(e) => chooseMode(e.target.value as GodotMode)}
          style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "3px 6px" }}
          title="Como o jogo aparece"
        >
          {GODOT_MODES.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="preview-stage" ref={stageRef}>
        {mode === "web" && webUrl && !old ? (
          <iframe src={webUrl} title="Preview Web da Godot" allow="autoplay; fullscreen; gamepad" onLoad={(e) => e.currentTarget.focus()} />
        ) : (
          note && <p className="muted small" style={{ padding: 16, textAlign: "center" }}>{note}</p>
        )}
      </div>
      {(error || tail || (mode === "embed" && phase === "rodando")) && (
        <div className="console">
          {error && <div className="error">{error}</div>}
          {tail && (
            <div className="error" style={{ whiteSpace: "pre-wrap" }}>
              O jogo fechou. Últimas linhas de .gfs/godot-run.log:{"\n"}
              {tail}
            </div>
          )}
          {mode === "embed" && phase === "rodando" && (
            <div className="muted">Clique no jogo para jogar (o teclado vai para a Godot). Clique em qualquer outro lugar do app para o teclado voltar ao GameForge.</div>
          )}
        </div>
      )}
    </section>
  );
}
