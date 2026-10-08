import { useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  TARGETS,
  appIdFor,
  buildState,
  downloadOld,
  nextVersion,
  onBuild,
  revealBuild,
  runBuild,
  saveBuildToken,
  watchBuilds,
  type BuildRecord,
  type JobState,
  type Target,
} from "../builds";
import { findEntry } from "../preview";
import type { RoomSync } from "../sync/roomSync";
import type { Author, Room } from "../types";

const JOB_LABEL: Record<JobState, string> = {
  fila: "⏳ na fila",
  compilando: "⚙️ compilando…",
  pronto: "✅ pronto",
  erro: "❌ deu erro",
  pulado: "— pulado",
};

const PLAT_LABEL = { web: "Web", android: "Android", windows: "Windows", linux: "Linux" } as const;

function size(n: number) {
  if (!n) return "";
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`;
}

function elapsed(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function BuildPanel({
  room,
  sync,
  me,
  isAdmin,
  onClose,
}: {
  room: Room;
  sync: RoomSync;
  me: Author;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [tokenInput, setTokenInput] = useState("");
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const st = useSyncExternalStore(onBuild, () => buildState(room.id));
  const [history, setHistory] = useState<BuildRecord[]>([]);
  const [targets, setTargets] = useState<Set<Target>>(() => new Set<Target>(["web", "android-apk"]));
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => watchBuilds(room.id, setHistory), [room.id]);
  useEffect(() => {
    if (!version && history.length) setVersion(nextVersion(history[0].version));
  }, [history, version]);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const running = st.phase === "enviando" || st.phase === "compilando" || st.phase === "baixando";
  const desktop = isTauri();

  const toggle = (t: Target) =>
    setTargets((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  const start = () => {
    setError(null);
    const files = sync.remoteFiles();
    if (!files.length) return setError("A sala está vazia.");
    const v = version.trim() || "1.0.0";
    if (!/^\d+\.\d+\.\d+$/.test(v)) return setError("Versão no formato 1.0.0");
    let entry: string | null = null;
    try {
      entry = localStorage.getItem(`gfs-start-${room.id}`);
    } catch {
      /* ignora */
    }
    entry = entry && files.some((f) => f.path === entry) ? entry : findEntry(files.map((f) => f.path));
    if (!entry) return setError("O jogo precisa de uma página .html (index.html).");
    void runBuild({ room, files, targets: TARGETS.map((t) => t.id).filter((t) => targets.has(t)), version: v, entry, by: me });
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal build-modal">
        <h3>🔨 Build de “{room.name}”</h3>

        {!running && (
          <>
            <div className="build-targets">
              {TARGETS.map((t) => {
                const off = !desktop && t.id !== "web";
                return (
                  <label key={t.id} className={`build-target ${targets.has(t.id) ? "on" : ""} ${off ? "off" : ""}`}>
                    <input type="checkbox" disabled={off} checked={targets.has(t.id) && !off} onChange={() => toggle(t.id)} />
                    <span className="grow">
                      <b>{t.label}</b>
                      <span className="small muted"> · {t.hint}</span>
                    </span>
                    <span className="small muted">{t.minutes}</span>
                  </label>
                );
              })}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <label className="small muted" style={{ whiteSpace: "nowrap" }}>
                Versão
              </label>
              <input value={version} placeholder="1.0.0" onChange={(e) => setVersion(e.target.value)} style={{ width: 110 }} />
              <span className="small muted grow ellipsis" title="Nome do pacote no Android (não muda depois de publicar)">
                {targets.has("android-apk") || targets.has("android-aab") ? `Android: ${appIdFor(room)}` : ""}
              </span>
            </div>
            {!desktop && <p className="small muted">No navegador só dá para gerar o Web. Android, Windows e Linux pelo app do PC.</p>}
            <button className="primary build-go" disabled={!targets.size} onClick={start}>
              🔨 BUILD
            </button>
          </>
        )}

        {st.phase !== "idle" && (
          <div className="build-progress">
            <div className="row">
              <b className="grow">
                {st.phase === "enviando" && "Enviando o jogo para a fábrica…"}
                {st.phase === "compilando" && "Compilando na nuvem…"}
                {st.phase === "baixando" && "Baixando os arquivos…"}
                {st.phase === "pronto" && "✅ Build pronto!"}
                {st.phase === "erro" && "❌ O build falhou"}
              </b>
              {running && <span className="small muted">{elapsed(st.startedAt)}</span>}
            </div>
            <div className="build-jobs">
              {(Object.keys(st.jobs) as (keyof typeof st.jobs)[]).map((k) => (
                <div key={k} className={`build-job ${st.jobs[k]}`}>
                  <span className="grow">{PLAT_LABEL[k]}</span>
                  <span>{JOB_LABEL[st.jobs[k]!]}</span>
                </div>
              ))}
            </div>
            {st.error && <div className="error-box">{st.error}</div>}
            {st.files.length > 0 && (
              <div className="build-files">
                {st.files.map((f) => (
                  <div key={f.name} className="small">
                    📦 {f.name} <span className="muted">{size(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
              {st.dir && (
                <button className="primary" onClick={() => void revealBuild(st.dir!).catch((e) => setError(String(e)))}>
                  📂 Abrir pasta do build
                </button>
              )}
              {st.dir && <span className="small muted ellipsis grow" title={st.dir}>{st.dir}</span>}
              {st.runUrl && running && (
                <a className="small muted" href={st.runUrl} target="_blank" rel="noreferrer">
                  ver na nuvem
                </a>
              )}
            </div>
            {running && <p className="small muted">Pode fechar esta janela: o build continua e os arquivos chegam sozinhos.</p>}
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        {history.length > 0 && (
          <details className="build-history" open={!running && st.phase === "idle"}>
            <summary className="small muted">Builds anteriores da sala</summary>
            {history.map((b) => (
              <div key={b.id} className="row small build-old">
                <span className="grow ellipsis">
                  {b.status === "success" ? "✅" : b.status === "partial" ? "⚠️" : b.status === "running" ? "⏳" : "❌"} v{b.version} ·{" "}
                  {b.targets.map((t) => TARGETS.find((x) => x.id === t)?.label.split(" ")[0]).join(", ")} · {b.by.name} ·{" "}
                  {b.ts ? b.ts.toDate().toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
                {desktop && b.tag && b.status !== "running" && b.status !== "failure" && (
                  <button className="ghost small" onClick={() => void downloadOld(room, b).catch((e) => setError(e instanceof Error ? e.message : String(e)))}>
                    baixar
                  </button>
                )}
              </div>
            ))}
          </details>
        )}

        {isAdmin && (
          <details className="build-history">
            <summary className="small muted">⚙ Token da fábrica de builds (só você vê)</summary>
            <p className="small muted" style={{ lineHeight: 1.5 }}>
              Token “fine-grained” do GitHub com acesso só ao repositório <code>gameforge-builds</code> (Contents e Actions: leitura e
              escrita). Fica guardado no Firebase e só as 3 contas autorizadas conseguem usar.
            </p>
            <div className="row">
              <input type="password" placeholder="github_pat_…" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
              <button
                className="primary"
                disabled={!tokenInput.trim().startsWith("github_pat_")}
                onClick={() =>
                  void saveBuildToken(tokenInput, me)
                    .then(() => {
                      setTokenInput("");
                      setTokenMsg("✓ Token salvo. Todo mundo da sala já pode buildar.");
                    })
                    .catch((e) => setTokenMsg(e instanceof Error ? e.message : String(e)))
                }
              >
                Salvar
              </button>
            </div>
            {tokenMsg && <p className="small">{tokenMsg}</p>}
          </details>
        )}

        <div className="actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
