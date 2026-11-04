import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { claimAsset, claimKey, hhmm, releaseAsset, type Claim } from "../claims";
import {
  explain,
  godotCapture,
  godotExportWeb,
  godotImport,
  godotInfo,
  godotInstall,
  godotInstallCancel,
  godotTags,
  godotProjectDirs,
  godotRun,
  godotServe,
  godotStatus,
  godotStop,
  hasWebPreset,
  installOffer,
  installVersion,
  isOldApp,
  loadBin,
  loadProject,
  majorMinor,
  releaseOf,
  requiredVersion,
  saveBin,
  saveProject,
  versionAdvice,
  type GodotInfo,
  type GodotStatus,
  type InstallProgress,
} from "../godot";
import { updateRoomSettings } from "../rooms";
import { pickProject } from "../unreal";
import type { RoomSync } from "../sync/roomSync";
import type { Author, Room } from "../types";
import { Modal } from "./Modals";

const openUrl = (url: string) => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));

export function GodotPanel({
  room,
  sync,
  me,
  dir,
  readOnly,
  isOwner,
  claims,
  now,
  onStartMirror,
  onClose,
}: {
  room: Room;
  sync: RoomSync;
  me: Author;
  dir?: string;
  readOnly: boolean;
  isOwner: boolean;
  claims: Claim[];
  now: number;
  onStartMirror: () => Promise<void>;
  onClose: () => void;
}) {
  const files = sync.remoteFiles();
  const dirs = godotProjectDirs(files.map((f) => f.path));
  const [chosen, setChosen] = useState(() => loadProject(room.id));
  const project = pickProject(dirs, chosen); // "" = raiz; null = nenhum; undefined = vários sem escolha
  const pre = project ? `${project}/` : "";
  const text = (p: string) => files.find((f) => f.path.toLowerCase() === (pre + p).toLowerCase())?.content;
  const required = requiredVersion(room, text("project.godot"));

  const [bin, setBin] = useState(loadBin);
  const [info, setInfo] = useState<GodotInfo | null>(null);
  const [status, setStatus] = useState<GodotStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [old, setOld] = useState(false);
  const [frame, setFrame] = useState(false);
  const [stamp, setStamp] = useState(0);
  const [version, setVersion] = useState(room.godotVersion ?? "");
  const [scene, setScene] = useState("");
  const [hours, setHours] = useState(2);
  const [withTpl, setWithTpl] = useState(true);
  const [prog, setProg] = useState<InstallProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [tags, setTags] = useState<string[]>([]);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
    } catch (e) {
      if (isOldApp(e)) setOld(true);
      else setError(explain(e));
    } finally {
      setBusy(null);
      if (dir) godotStatus(dir).then(setStatus, () => {});
    }
  };

  const check = () => run("Verificando…", async () => setInfo(await godotInfo(required)));
  useEffect(() => {
    if (isTauri()) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!dir) return;
    const tick = () => godotStatus(dir).then(setStatus, (e) => isOldApp(e) && setOld(true));
    tick();
    const t = window.setInterval(tick, 3000);
    return () => window.clearInterval(t);
  }, [dir]);

  const offer = installOffer(info, required);
  useEffect(() => {
    if (offer === "engine" && !tags.length) void godotTags().then(setTags);
  }, [offer, tags.length]);
  const target = offer === "templates" ? releaseOf(info?.version) : installVersion(required, tags);
  const install = (engine: boolean) =>
    run(engine ? `Instalando a Godot ${target}…` : `Instalando os templates da ${target}…`, async () => {
      if (!target) return;
      setInstalling(true);
      setProg(null);
      try {
        const exe = await godotInstall(target, engine ? withTpl : true, engine, setProg);
        if (exe) setBin(exe);
      } finally {
        setInstalling(false);
        setProg(null);
      }
      setInfo(await godotInfo(required));
      return engine ? `Godot ${target} instalada${withTpl ? " com os templates do Preview Web" : ""}.` : `Templates da Godot ${target} instalados.`;
    });
  const mb = (b: number) => (b / 1048576).toFixed(0);
  const phase = { engine: "Baixando a Godot", templates: "Baixando os templates", extraindo: "Extraindo" };

  const proj = project ?? null;
  const advice = versionAdvice(info?.version ?? null, required);
  const zip = info?.web_templates.find((z) => z.startsWith("web_nothreads_release")) ?? info?.web_templates[0];
  const url = status?.port ? `http://127.0.0.1:${status.port}/` : null;
  const ready = !!dir && typeof project === "string" && !!info?.found;
  const active = claims.filter((c) => c.exp > now).sort((a, b) => a.path.localeCompare(b.path));
  const key = claimKey(scene);

  if (!isTauri()) {
    return (
      <Modal title="🎮 Godot" onClose={onClose}>
        <p className="muted">Rodar, exportar e capturar a Godot só funciona no app de PC.</p>
        <div className="actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="🎮 Godot" onClose={onClose}>
      {old && <div className="error-box">Esta versão do app ainda não conversa com a Godot. Feche e abra o GameForge para atualizar.</div>}

      <h4 style={{ margin: "0 0 6px" }}>Verificar Godot</h4>
      <div className="mirror-on" style={{ marginBottom: 6 }}>
        <span className="dot" style={{ background: info?.found && !advice ? "var(--ok)" : "#e5484d" }} />
        <div className="grow" style={{ minWidth: 0 }}>
          <b>{info ? (info.found ? `Godot ${majorMinor(info.version)} achada` : "Godot não encontrada neste PC") : "…"}</b>
          {info?.found && (
            <div className="muted small ellipsis" title={info.path ?? ""}>
              {info.version} · {info.path}
            </div>
          )}
        </div>
        <button disabled={!!busy} onClick={() => void check()}>
          Verificar
        </button>
      </div>
      <ul className="small" style={{ margin: "0 0 8px", paddingLeft: 18, lineHeight: 1.6 }}>
        <li>
          Versão que a sala usa: <b>{required}</b>
          {advice && <div className="error-box">{advice}</div>}
        </li>
        <li>
          Projeto (project.godot):{" "}
          {project === null ? (
            <b>não achei na sala</b>
          ) : project === undefined ? (
            <b>há {dirs.length}, escolha abaixo</b>
          ) : (
            <b>{project ? `${project}/` : "raiz da sala"}</b>
          )}
          {dirs.length > 1 && (
            <select
              value={project ?? ""}
              onChange={(e) => {
                saveProject(room.id, e.target.value);
                setChosen(e.target.value);
              }}
              style={{ marginLeft: 6 }}
            >
              {project === undefined && <option value="">escolha…</option>}
              {dirs.map((d) => (
                <option key={d} value={d}>
                  {d || "raiz"}
                </option>
              ))}
            </select>
          )}
        </li>
        <li>
          Preset “Web” no export_presets.cfg: <b>{hasWebPreset(text("export_presets.cfg")) ? "sim" : "não (o Preview Web não funciona sem ele)"}</b>
        </li>
        {info?.found && (
          <li>
            Export templates da Web: <b>{zip ? `instalados (${zip})` : "não instalados"}</b>
            {!zip && offer !== "templates" && offer !== "engine" && (
              <div className="muted">
                Na Godot: Editor → Gerenciar Modelos de Exportação → Baixar e instalar (centenas de MB). Ficam em <code>{info.templates_dir}</code>.
              </div>
            )}
          </li>
        )}
      </ul>
      {offer && target && (
        <div className="note-box small" style={{ marginBottom: 8 }}>
          {offer === "engine" ? (
            <>
              <div>
                {info?.found ? `Esta sala usa a Godot ${required}. ` : ""}O app baixa a Godot <b>{target}</b> do site oficial e instala só para você (sem pedir
                administrador, ~180 MB). As outras Godots do PC ficam como estão.
              </div>
              <label style={{ display: "block", margin: "4px 0" }}>
                <input type="checkbox" checked={withTpl} disabled={!!busy} onChange={(e) => setWithTpl(e.target.checked)} /> com os templates para o Preview Web (mais ~1,3 GB de
                download e de disco)
              </label>
            </>
          ) : (
            <div>
              Faltam os templates da Godot <b>{target}</b> (sem eles o Preview Web não funciona). O app baixa do site oficial (~1,3 GB) e instala onde a Godot procura.
            </div>
          )}
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <button className="primary" disabled={!!busy} onClick={() => void install(offer === "engine")}>
              {offer === "engine" ? `Instalar Godot ${target}` : "Instalar templates"}
            </button>
            {installing && <button onClick={() => void godotInstallCancel().catch(() => {})}>Cancelar</button>}
          </div>
          {installing && (
            <div style={{ marginTop: 4 }}>
              <progress style={{ width: "100%" }} value={prog?.total ? prog.done : undefined} max={prog?.total || undefined} />
              <div className="muted">
                {prog ? `${phase[prog.phase]}: ${mb(prog.done)}${prog.total ? ` de ${mb(prog.total)}` : ""} MB` : "Conectando ao GitHub…"} (não feche o app até terminar)
              </div>
            </div>
          )}
        </div>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          saveBin(bin);
          void check();
        }}
      >
        <input placeholder="Caminho do Godot_v4...exe (vazio = procurar sozinho)" value={bin} onChange={(e) => setBin(e.target.value)} />
        <button>Usar</button>
      </form>
      <div className="small muted">Fica só neste PC. Também vale a variável GODOT_BIN (feche e abra o app depois de criar).</div>
      {isOwner && (
        <form
          className="row"
          style={{ marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run("Salvando…", () => updateRoomSettings(room.id, { godotVersion: version.trim() }).then(() => "Versão da sala salva."));
          }}
        >
          <input placeholder={`Versão exigida pela sala (vazio = a do project.godot, senão ${required})`} value={version} onChange={(e) => setVersion(e.target.value)} />
          <button disabled={!!busy || (!!version.trim() && !/^\d+\.\d+$/.test(version.trim()))}>Salvar</button>
        </form>
      )}

      <h4 style={{ marginBottom: 6 }}>Rodar</h4>
      {!dir && (
        <p className="small">
          Ligue a pasta do Claude primeiro (a Godot roda nos arquivos dela).{" "}
          <button className="small" onClick={() => void onStartMirror().catch((e) => setError(String(e)))}>
            Ligar pasta
          </button>
        </p>
      )}
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <button disabled={!ready || !!busy} onClick={() => void run("Importando…", () => godotImport(dir!, proj).then(() => "Importação feita."))} title="godot --headless --import: depois de chegar imagem, som ou cena nova">
          Importar
        </button>
        {status?.running ? (
          <button disabled={!!busy} onClick={() => void run("Fechando…", () => godotStop(dir!))}>
            ■ Parar jogo
          </button>
        ) : (
          <button className="primary" disabled={!ready || !!busy} onClick={() => void run("Abrindo…", () => godotRun(dir!, proj).then(() => "Jogo aberto numa janela própria. Saída em .gfs/godot-run.log."))}>
            ▶ Rodar (janela)
          </button>
        )}
        <button
          disabled={!ready || !!busy}
          onClick={() =>
            void run("Exportando para Web…", async () => {
              const r = await godotExportWeb(dir!, proj);
              const port = await godotServe(dir!);
              const t = Date.now();
              setStamp(t); // o "Ver aqui" recarrega com o export novo
              const u = `http://127.0.0.1:${port}/?t=${t}`;
              openUrl(u);
              return `Exportado em ${(r.ms / 1000).toFixed(1)} s e aberto no navegador (${u}).${r.threads ? " Build com threads: só funciona no navegador, não no 'Ver aqui'." : ""}`;
            })
          }
          title="Exporta o preset Web para builds/godot-web e abre no navegador (127.0.0.1)"
        >
          🌐 Preview Web
        </button>
        {url && <button onClick={() => setFrame((v) => !v)}>{frame ? "Esconder" : "Ver aqui"}</button>}
        <button
          disabled={!ready || !!busy}
          onClick={() => void run("Capturando…", async () => `Tela salva em ${await godotCapture(dir!, proj)} (o Claude pode abrir com Read).`)}
          title="Roda o jogo 1 s e guarda o último quadro em .gfs/frames/"
        >
          📸 Capturar tela
        </button>
      </div>
      {busy && <p className="small muted">{busy} (pode levar um minuto na primeira vez)</p>}
      {msg && <div className="note-box small">{msg}</div>}
      {error && <div className="error-box">{error}</div>}
      {frame && url && (
        <iframe
          src={`${url}?t=${stamp}`}
          title="Preview Web da Godot"
          allow="autoplay; fullscreen; gamepad"
          style={{ width: "100%", height: 360, border: 0, marginTop: 8, background: "#000" }}
          onLoad={(e) => e.currentTarget.focus()}
        />
      )}
      {frame && <div className="small muted">Clique no jogo para o teclado e o som funcionarem. Não carregou? Use o navegador (botão Preview Web).</div>}

      <h4 style={{ marginBottom: 6 }}>Reservas de cenas</h4>
      <p className="small muted" style={{ marginTop: 0 }}>
        Uma pessoa por cena (.tscn/.tres): o merge é por linha e duas pessoas na mesma cena geram conflito. O Claude lê em <code>.gfs/CENAS.md</code>.
      </p>
      {active.length === 0 && <p className="muted small">Nenhuma cena reservada.</p>}
      {active.map((c) => {
        const mine = c.uid === me.uid;
        return (
          <div key={c.key} className="mirror-on" style={{ marginBottom: 6 }}>
            <span className="dot" style={{ background: mine ? "var(--ok)" : "#e5484d" }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <b className="ellipsis" style={{ display: "block" }}>
                res://{c.path}
              </b>
              <span className="muted small">
                {mine ? "você" : c.name} · até {hhmm(c.exp)}
                {c.note && ` · ${c.note}`}
              </span>
            </div>
            {(mine || isOwner) && !readOnly && (
              <button
                className="small"
                disabled={!!busy}
                onClick={() => {
                  if (mine || confirm(`Liberar à força a reserva de ${c.name} em ${c.path}?`)) void run("Liberando…", () => releaseAsset(room.id, c.key));
                }}
              >
                {mine ? "Liberar" : "Forçar liberar"}
              </button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (key) void run("Reservando…", () => claimAsset(room.id, me, scene.startsWith("res://") ? scene : `res://${scene}`, "", hours).then(() => setScene("")));
          }}
        >
          <input placeholder="res://scenes/fase1.tscn ou res://scenes/ (pasta)" value={scene} onChange={(e) => setScene(e.target.value)} />
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 2, 4, 8, 12].map((h) => (
              <option key={h} value={h}>
                {h} h
              </option>
            ))}
          </select>
          <button className="primary" disabled={!!busy || !key}>
            Reservar
          </button>
        </form>
      )}

      <div className="actions">
        <button onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}
