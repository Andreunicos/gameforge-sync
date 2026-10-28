import { useState } from "react";
import { claimAsset, claimKey, hhmm, releaseAsset, type Claim } from "../claims";
import { mapName } from "../unreal";
import type { Author, Presence, Room } from "../types";
import { DiversionBox } from "./DiversionBox";
import { Modal } from "./Modals";

const HOURS = [1, 2, 4, 8, 12];

export function UnrealPanel({
  room,
  roomId,
  me,
  claims,
  now,
  readOnly,
  isOwner,
  dir,
  project,
  people,
  onClose,
}: {
  room: Room;
  roomId: string;
  me: Author;
  claims: Claim[];
  now: number;
  readOnly: boolean;
  isOwner: boolean;
  dir?: string;
  /** Pasta do projeto relativa à sala ("" = raiz; null/undefined = nenhum ainda / vários sem escolha). */
  project?: string | null;
  people: Presence[];
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [note, setNote] = useState("");
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = claims.filter((c) => c.exp > now).sort((a, b) => a.path.localeCompare(b.path));
  const key = claimKey(path);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="🔒 Unreal: reservas de assets" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.55 }}>
        .uasset/.umap não têm merge: <b>reserve antes de abrir para editar</b> um mapa, Blueprint ou material, e libere ao terminar. Todos
        veem aqui, e o Claude de cada um lê em <code>.gfs/ASSETS.md</code>. A reserva é um aviso: o Unreal não trava o arquivo. Com o editor
        conectado (🔌), o que você modifica é reservado sozinho por 30 min (<i>auto:</i>).
      </p>

      {people.some((p) => p.ue) && (
        <>
          <h4 style={{ margin: "0 0 6px" }}>Agora no editor</h4>
          {people
            .filter((p) => p.ue)
            .map((p) => (
              <div key={p.uid} className="small" style={{ marginBottom: 4 }}>
                <span className="dot" style={{ background: p.color, display: "inline-block", marginRight: 6 }} />
                <b>{p.uid === me.uid ? "você" : p.name}</b> · {mapName(p.ue!.map) || "?"}: {(p.ue!.sel ?? []).map((x) => x.l).join(", ") || "nada selecionado"}
              </div>
            ))}
          <h4 style={{ marginBottom: 6 }}>Reservas</h4>
        </>
      )}
      {active.length === 0 && <p className="muted">Nenhum asset reservado.</p>}
      {active.map((c) => {
        const mine = c.uid === me.uid;
        const soon = c.exp - now < 10 * 60_000;
        return (
          <div key={c.key} className="mirror-on" style={{ marginBottom: 6 }}>
            <span className="dot" style={{ background: mine ? "var(--ok)" : "#e5484d" }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <b className="ellipsis" style={{ display: "block" }} title={c.path}>
                {c.path}
              </b>
              <span className="muted small">
                {mine ? "você" : c.name} · até {hhmm(c.exp)}
                {soon && " (vence logo)"}
                {c.note && ` · ${c.note}`}
              </span>
            </div>
            {mine && !readOnly && (
              <button className="small" disabled={busy} onClick={() => void run(() => claimAsset(roomId, me, c.path, c.note, hours))} title={`Mais ${hours} h a partir de agora`}>
                Renovar
              </button>
            )}
            {(mine || isOwner) && !readOnly && (
              <button
                className="small"
                disabled={busy}
                onClick={() => {
                  if (mine || confirm(`Liberar à força a reserva de ${c.name} em ${c.path}? Combine com ${c.name} antes: o trabalho dele pode se perder.`))
                    void run(() => releaseAsset(roomId, c.key));
                }}
              >
                {mine ? "Liberar" : "Forçar liberar"}
              </button>
            )}
          </div>
        );
      })}

      {!readOnly && (
        <>
          <h4 style={{ marginBottom: 6 }}>Reservar</h4>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (key)
                void run(async () => {
                  await claimAsset(roomId, me, path, note, hours);
                  setPath("");
                  setNote("");
                });
            }}
          >
            <input placeholder="Content/Maps/Arena.umap, /Game/BP/BP_Player ou Content/Maps/ (pasta)" value={path} onChange={(e) => setPath(e.target.value)} />
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} title="Vence sozinha depois disso">
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} h
                </option>
              ))}
            </select>
            <button className="primary" disabled={busy || !key}>
              Reservar
            </button>
          </form>
          <input placeholder="O que vai fazer (opcional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6, width: "100%" }} />
          {path.trim() && <div className="small muted">{key ? `${key.path}${key.path.endsWith("/") ? " (pasta inteira)" : ""}` : "Caminho inválido"}</div>}
        </>
      )}
      {error && <div className="error-box">{error}</div>}

      <DiversionBox room={room} meUid={me.uid} isOwner={isOwner} project={project} />

      <h4 style={{ marginBottom: 6 }}>Como a sala Unreal funciona</h4>
      <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
        <li>
          O projeto Unreal 5.8.1 fica na pasta da sala{dir ? <> (<code>{dir}</code>)</> : ""} ou numa subpasta dela (ex.: a pasta que o Unreal cria com o
          nome do projeto): o app acha o <code>.uproject</code> sozinho, não precisa mover nada.
          {project ? <> Projeto desta sala: <code>{project}/</code>.</> : ""} Todos com a mesma versão da engine.
        </li>
        <li>Sincroniza sozinho (com merge): C++, .cs, .ini, .py, .usf/.ush, .uproject/.uplugin. Não sincroniza: Content/ (só Content/Python), Binaries, Intermediate, Saved, DerivedDataCache.</li>
        <li>Content/ chega a cada um por fora (Diversion, Perforce, Git LFS ou zip). Mudou .h ou .Build.cs de alguém: feche o editor e recompile.</li>
        <li>Editar o mesmo mapa ao vivo: Multi-User Editing da Epic (Beta, só rede local/VPN).</li>
      </ul>

      <div className="actions">
        <button onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}
