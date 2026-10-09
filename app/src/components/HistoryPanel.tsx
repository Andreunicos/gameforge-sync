import { useEffect, useMemo, useState } from "react";
import { colorFor } from "../auth";
import {
  createCheckpoint,
  diffLines,
  getVersion,
  restoreCheckpoint,
  restoreFile,
  watchCheckpoints,
  watchHistory,
  type Checkpoint,
  type DiffLine,
  type HistoryEntry,
} from "../history";
import type { RoomSync } from "../sync/roomSync";
import type { Author, Presence, Room } from "../types";

type Item = { kind: "entry"; e: HistoryEntry; ms: number } | { kind: "cp"; cp: Checkpoint; ms: number };
type Who = "all" | "claude" | "human" | string;

const PAGE = 80;

const who = (a: Author) => (a.kind === "claude" ? `🤖 Claude de ${a.name}` : a.name);

const VERB: Record<HistoryEntry["kind"], string> = {
  edit: "editou",
  create: "criou",
  delete: "apagou",
  restore: "restaurou",
};

function when(ms: number) {
  if (!ms) return "agora";
  const d = new Date(ms);
  const s = (Date.now() - ms) / 1000;
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min · ${hm}`;
  if (new Date().toDateString() === d.toDateString()) return hm;
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

function dayLabel(ms: number) {
  if (!ms) return "Agora";
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === y.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" });
}

export function HistoryPanel({
  room,
  sync,
  me,
  readOnly,
  people,
  onClose,
}: {
  room: Room;
  sync: RoomSync;
  me: Author;
  readOnly: boolean;
  people: Presence[];
  onClose: () => void;
}) {
  const [max, setMax] = useState(PAGE);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [cps, setCps] = useState<Checkpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [whoF, setWhoF] = useState<Who>("all");
  const [fileF, setFileF] = useState("");
  const [sel, setSel] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => watchHistory(room.id, max, setEntries, (e) => setError(e.message)), [room.id, max]);
  useEffect(() => watchCheckpoints(room.id, setCps), [room.id]);

  const authors = useMemo(() => {
    const m = new Map<string, string>();
    entries?.forEach((e) => m.set(e.author.uid, e.author.name));
    return [...m];
  }, [entries]);
  const files = useMemo(() => [...new Set(entries?.map((e) => e.path))].sort(), [entries]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const e of entries ?? []) {
      if (whoF === "claude" && e.author.kind !== "claude") continue;
      if (whoF === "human" && e.author.kind !== "human") continue;
      if (whoF !== "all" && whoF !== "claude" && whoF !== "human" && e.author.uid !== whoF) continue;
      if (fileF && e.path !== fileF) continue;
      list.push({ kind: "entry", e, ms: e.ts?.toMillis() ?? Date.now() });
    }
    if (!fileF && (whoF === "all" || whoF === "human")) for (const cp of cps) list.push({ kind: "cp", cp, ms: cp.ts?.toMillis() ?? Date.now() });
    return list.sort((a, b) => b.ms - a.ms);
  }, [entries, cps, whoF, fileF]);

  const liveClaudes = people.filter((p) => p.claudeOn);

  const mark = async () => {
    const label = prompt("Nome desta versão (ex.: antes do boss novo):", "");
    if (!label?.trim()) return;
    setBusy(true);
    try {
      await createCheckpoint(room.id, sync.remoteFiles(), me, label.trim());
      setMsg(`📌 Versão “${label.trim()}” marcada.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  let lastDay = "";

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="history">
        <header className="history-head">
          <h3>🕘 Histórico e backups</h3>
          <span className="grow" />
          {liveClaudes.length > 0 && (
            <span className="small muted live-now">
              Agora:{" "}
              {liveClaudes.map((p) => (
                <b key={p.uid} style={{ color: p.color }}>
                  🤖 Claude de {p.name}
                  {p.claudeFile ? ` em ${p.claudeFile}` : " ligado"}{" "}
                </b>
              ))}
            </span>
          )}
          {!readOnly && (
            <button className="primary" disabled={busy} onClick={() => void mark()} title="Tira uma foto do jogo inteiro agora">
              📌 Marcar versão
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="history-body">
          <aside className="history-list">
            <div className="row history-filters">
              <select value={whoF} onChange={(e) => setWhoF(e.target.value)}>
                <option value="all">Todo mundo</option>
                <option value="claude">🤖 Só os Claudes</option>
                <option value="human">Só as pessoas</option>
                {authors.map(([uid, name]) => (
                  <option key={uid} value={uid}>
                    {name} (e o Claude dele)
                  </option>
                ))}
              </select>
              <select value={fileF} onChange={(e) => setFileF(e.target.value)}>
                <option value="">Todos os arquivos</option>
                {files.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            {entries === null && !error && <p className="muted small">Carregando…</p>}
            {entries?.length === 0 && (
              <p className="muted small" style={{ lineHeight: 1.5 }}>
                Ainda não há histórico. A partir de agora, toda gravação (sua, dos amigos e dos Claudes) aparece aqui.
              </p>
            )}
            {items.map((it) => {
              const day = dayLabel(it.ms);
              const head = day !== lastDay ? <div className="history-day">{(lastDay = day)}</div> : null;
              const active =
                sel && ((sel.kind === "entry" && it.kind === "entry" && sel.e.id === it.e.id) || (sel.kind === "cp" && it.kind === "cp" && sel.cp.id === it.cp.id));
              if (it.kind === "cp") {
                return (
                  <div key={"cp" + it.cp.id}>
                    {head}
                    <button className={`history-item cp ${active ? "active" : ""}`} onClick={() => setSel(it)}>
                      <span className="cp-pin">{it.cp.auto ? "💾" : "📌"}</span>
                      <span className="grow">
                        <b>{it.cp.label}</b>
                        <span className="small muted">
                          {" "}
                          · {Object.keys(it.cp.files).length} arquivos · {when(it.ms)}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              }
              const e = it.e;
              return (
                <div key={e.id}>
                  {head}
                  <button className={`history-item ${active ? "active" : ""}`} onClick={() => setSel(it)}>
                    <span className="dot" style={{ background: colorFor(e.author.uid) }} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="ellipsis" style={{ display: "block" }}>
                        <b>{who(e.author)}</b> {VERB[e.kind]} <code>{e.path}</code>
                      </span>
                      <span className="small muted ellipsis" style={{ display: "block" }}>
                        {e.added > 0 && <span className="plus">+{e.added}</span>} {e.removed > 0 && <span className="minus">−{e.removed}</span>}
                        {e.where?.length ? ` · em ${e.where.join(", ")}` : ""}
                        {e.note ? ` · ${e.note}` : ""} · {when(it.ms)}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
            {entries && entries.length >= max && (
              <button className="ghost small" style={{ margin: 8 }} onClick={() => setMax((m) => m + PAGE)}>
                Carregar mais antigos
              </button>
            )}
          </aside>

          <section className="history-detail">
            {msg && <div className="note-box small">{msg}</div>}
            {error && <div className="error-box">{error}</div>}
            {!sel && (
              <div className="muted history-empty">
                <p>Escolha uma mudança à esquerda para ver o que mudou, linha por linha.</p>
                <p className="small">
                  💾 = backup automático (1 por dia) · 📌 = versão marcada por alguém. Dá para voltar o jogo todo para qualquer uma
                  delas.
                </p>
              </div>
            )}
            {sel?.kind === "entry" && (
              <EntryDetail
                key={sel.e.id}
                room={room}
                e={sel.e}
                me={me}
                readOnly={readOnly}
                busy={busy}
                setBusy={setBusy}
                setMsg={setMsg}
                setError={setError}
              />
            )}
            {sel?.kind === "cp" && (
              <CheckpointDetail
                key={sel.cp.id}
                room={room}
                sync={sync}
                cp={sel.cp}
                me={me}
                readOnly={readOnly}
                busy={busy}
                setBusy={setBusy}
                setMsg={setMsg}
                setError={setError}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

interface DetailProps {
  room: Room;
  me: Author;
  readOnly: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setMsg: (m: string | null) => void;
  setError: (m: string | null) => void;
}

function EntryDetail({ room, e, me, readOnly, busy, setBusy, setMsg, setError }: DetailProps & { e: HistoryEntry }) {
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (e.big) {
        setNote("Arquivo grande (ex.: som ou imagem em texto): o histórico guarda quem mudou e quando, mas não o conteúdo dessa versão.");
        setLines([]);
        return;
      }
      if (e.kind === "delete") {
        setNote("Conteúdo do arquivo quando foi apagado:");
        setLines(e.content.split("\n").map((text, i) => ({ t: "del", text, old: i + 1 })));
        return;
      }
      const prev = await getVersion(room.id, e.path, e.version - 1);
      if (!alive) return;
      if (!prev || prev.big) {
        setNote(e.version === 1 ? "Arquivo novo:" : "Sem a versão anterior no histórico; mostrando o arquivo inteiro:");
        setLines(e.content.split("\n").map((text, i) => ({ t: e.version === 1 ? "add" : "same", text, neu: i + 1 })));
      } else {
        setNote(null);
        setLines(diffLines(prev.content, e.content));
      }
    })().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [room.id, e, setError]);

  const restore = async () => {
    const label = e.kind === "delete" ? `Recriar ${e.path} como estava quando foi apagado?` : `Voltar ${e.path} para a versão v${e.version}?`;
    if (!confirm(`${label}\n\nA versão atual continua guardada no histórico (dá para desfazer).`)) return;
    setBusy(true);
    setError(null);
    try {
      await restoreFile(room.id, e.path, e.content, me, `voltou para v${e.version}`);
      setMsg(`↩ ${e.path} voltou para a v${e.version}. Todo mundo já recebeu.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="history-detail-head">
        <div className="grow">
          <h4>
            {who(e.author)} {VERB[e.kind]} <code>{e.path}</code>
          </h4>
          <div className="small muted">
            v{e.version} · {when(e.ts?.toMillis() ?? 0)}
            {e.added > 0 && <span className="plus"> · +{e.added}</span>}
            {e.removed > 0 && <span className="minus"> −{e.removed}</span>}
            {e.where?.length ? ` · mexeu em ${e.where.join(", ")}` : ""}
            {e.note ? ` · ${e.note}` : ""}
          </div>
        </div>
        {!readOnly && !e.big && (
          <button className="primary" disabled={busy} onClick={() => void restore()}>
            ↩ {e.kind === "delete" ? "Recriar arquivo" : "Voltar para esta versão"}
          </button>
        )}
      </div>
      {note && <p className="small muted">{note}</p>}
      <pre className="diff">
        {lines === null && <span className="muted">Carregando…</span>}
        {lines?.slice(0, 3000).map((l, i) =>
          l.t === "gap" ? (
            <div key={i} className="gap">
              ⋯ {l.n} linhas iguais ⋯
            </div>
          ) : (
            <div key={i} className={l.t}>
              <span className="ln">{l.t === "del" ? l.old : l.neu}</span>
              <span className="sign">{l.t === "add" ? "+" : l.t === "del" ? "−" : " "}</span>
              {l.text}
            </div>
          ),
        )}
      </pre>
    </>
  );
}

function CheckpointDetail({ room, sync, cp, me, readOnly, busy, setBusy, setMsg, setError }: DetailProps & { cp: Checkpoint; sync: RoomSync }) {
  const now = sync.remoteFiles();
  const changed = now.filter((f) => f.path in cp.files && cp.files[f.path] !== f.version).map((f) => f.path);
  const gone = Object.keys(cp.files).filter((p) => !now.some((f) => f.path === p));
  const extra = now.filter((f) => !(f.path in cp.files)).map((f) => f.path);

  const restore = async () => {
    if (
      !confirm(
        `Voltar o JOGO TODO para “${cp.label}”?\n\n${changed.length + gone.length} arquivo(s) voltam como estavam. Antes disso o app tira uma foto do jogo atual, então dá para desfazer.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await restoreCheckpoint(room.id, cp, sync.remoteFiles(), me);
      setMsg(
        `⏪ Jogo voltou para “${cp.label}”: ${r.restored} arquivo(s) restaurado(s).` +
          (r.missing.length ? ` Sem backup: ${r.missing.join(", ")}.` : "") +
          (r.extra.length ? ` Arquivos criados depois continuam: ${r.extra.join(", ")}.` : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="history-detail-head">
        <div className="grow">
          <h4>
            {cp.auto ? "💾" : "📌"} {cp.label}
          </h4>
          <div className="small muted">
            {cp.auto ? "Backup automático" : `Marcada por ${who(cp.author)}`} · {when(cp.ts?.toMillis() ?? 0)} ·{" "}
            {Object.keys(cp.files).length} arquivos
          </div>
        </div>
        {!readOnly && (
          <button className="primary" disabled={busy || changed.length + gone.length === 0} onClick={() => void restore()}>
            ⏪ Voltar o jogo todo para cá
          </button>
        )}
      </div>
      {changed.length + gone.length + extra.length === 0 ? (
        <p className="muted">O jogo está exatamente igual a esta versão.</p>
      ) : (
        <div className="cp-diff">
          {changed.length > 0 && (
            <p>
              <b>Mudaram desde então ({changed.length}):</b> {changed.join(", ")}
            </p>
          )}
          {gone.length > 0 && (
            <p>
              <b>Foram apagados depois ({gone.length}):</b> {gone.join(", ")}
            </p>
          )}
          {extra.length > 0 && (
            <p className="muted">
              <b>Criados depois ({extra.length}):</b> {extra.join(", ")} (continuam se você voltar)
            </p>
          )}
        </div>
      )}
    </>
  );
}
