import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_MCP_PORT,
  enablePlugins,
  findEngines,
  isOldApp,
  loadSettings,
  mapName,
  openEditor,
  pickEngine,
  readUproject,
  saveSettings,
  startServer,
  stopServer,
  ueName,
  ueStatus,
  writeMcpJson,
  type Engine,
  type UeSettings,
  type UeSnap,
  type UeStatus,
  type Uproject,
} from "../unreal";
import { roomSlug } from "../sync/folderMirror";
import type { RoomSync } from "../sync/roomSync";
import type { Author, Presence, Room } from "../types";
import type { OpenTool } from "./ClaudePanel";
import { Modal } from "./Modals";

const MCP_WAIT_MS = 5 * 60_000; // o editor de um projeto grande leva minutos para abrir
const onlyName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);

export function UnrealConnectPanel({
  room,
  sync,
  me,
  dir,
  people,
  snap,
  onStartMirror,
  onOpen,
  onClose,
}: {
  room: Room;
  sync: RoomSync;
  me: Author;
  dir?: string;
  people: Presence[];
  snap: UeSnap | null;
  onStartMirror: () => Promise<void>;
  onOpen: (tool: OpenTool) => Promise<void>;
  onClose: () => void;
}) {
  const [s, setS] = useState<UeSettings>(() => loadSettings(room.id, roomSlug(room.name)));
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [other, setOther] = useState("");
  const [up, setUp] = useState<Uproject | null | undefined>(undefined);
  const [st, setSt] = useState<UeStatus | null>(null);
  const [oldApp, setOldApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waitUntil = useRef(0);

  const set = (patch: Partial<UeSettings>) =>
    setS((cur) => {
      const next = { ...cur, ...patch };
      saveSettings(room.id, next);
      return next;
    });

  const fail = (e: unknown) => {
    if (isOldApp(e)) setOldApp(true);
    else setError(e instanceof Error ? e.message : String(e));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const loadEngines = (extra: string) =>
    findEngines(extra).then((list) => {
      setEngines(list);
      return list;
    }, fail);

  const loadUproject = () => (dir ? readUproject(dir).then(setUp, fail) : Promise.resolve());

  useEffect(() => {
    void loadEngines(s.root);
    void loadUproject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  // Engine escolhida: a salva, a da versão do .uproject ou a mais nova.
  useEffect(() => {
    if (!engines?.length || up === undefined) return;
    const e = pickEngine(engines, s.root, up?.association ?? "");
    if (e && e.root !== s.root) set({ root: e.root });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engines, up]);

  // Estado do MCP e do servidor; esperando o editor abrir, abre o Claude quando o MCP responder.
  useEffect(() => {
    if (!dir || oldApp) return;
    let alive = true;
    const poll = async () => {
      try {
        const x = await ueStatus(dir, s.mcpPort);
        if (!alive) return;
        setSt(x);
        if (waitUntil.current && x.mcp) {
          waitUntil.current = 0;
          setMsg("O Unreal abriu com o MCP ligado. Abrindo o Claude Code na pasta do projeto…");
          await onOpen("vscode").catch(fail);
        } else if (waitUntil.current && Date.now() > waitUntil.current) {
          waitUntil.current = 0;
          setMsg(null);
          setError(
            `O MCP não respondeu na porta ${s.mcpPort} em 5 minutos. Confira no editor: plugins Unreal MCP e All Toolsets ligados (Edit > Plugins), e Editor Preferences > Model Context Protocol com a mesma porta. Depois abra o Claude pelo botão abaixo.`,
          );
        }
      } catch (e) {
        if (alive) fail(e);
      }
    };
    void poll();
    const t = window.setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, s.mcpPort, oldApp]);

  const engine = engines?.find((e) => e.root === s.root);
  const hosts = people.filter((p) => p.mue && p.uid !== me.uid);
  const initPy = sync.remoteFiles().find((f) => f.path.toLowerCase() === "content/python/init_unreal.py");
  const presenceOff = initPy && !initPy.content.includes("gameforge_presence");

  const connect = () =>
    run(async () => {
      if (!dir) throw new Error("Ligue a pasta da sala primeiro (botão acima).");
      const u = await readUproject(dir);
      setUp(u);
      if (!u) throw new Error("A pasta da sala ainda não tem o projeto: feche o Unreal e copie o .uproject, Source/, Config/ e Content/ para dentro dela.");
      if (u.missing.length) throw new Error(`Faltam plugins no ${u.file}: ${u.missing.join(", ")}. Clique em "Ligar plugins" abaixo.`);
      if (!engine) throw new Error("Unreal não encontrado neste PC. Indique a pasta da engine (ex.: C:\\Program Files\\Epic Games\\UE_5.8).");
      if (s.multi && (!s.server || !s.session)) throw new Error("Preencha o servidor e a sessão do Multi-User (ou desmarque a opção).");
      await writeMcpJson(dir, s.mcpPort);
      const now = await ueStatus(dir, s.mcpPort);
      if (
        now.mcp &&
        !confirm(`Algo já responde na porta ${s.mcpPort}: o Unreal deste projeto já está aberto? OK = abrir outro editor mesmo assim. Cancelar = só abrir o Claude.`)
      ) {
        await onOpen("vscode");
        setMsg(".mcp.json pronto e Claude Code aberto. Se a porta é de outro programa, mude a porta do MCP aqui e no Unreal.");
        return;
      }
      await openEditor(dir, s, me.name);
      waitUntil.current = Date.now() + MCP_WAIT_MS;
      setMsg(`Abrindo o Unreal ${engine.version}${s.multi ? ` e entrando na sessão ${s.session}` : ""}… O Claude Code abre sozinho quando o MCP responder.`);
    });

  const host = () =>
    run(async () => {
      if (!dir || !engine) throw new Error("Ligue a pasta da sala e escolha o Unreal primeiro.");
      await startServer(dir, s);
      sync.setUnreal({ mue: { server: s.server, session: s.session, addr: s.unicast.trim() } });
      setSt(await ueStatus(dir, s.mcpPort));
      setMsg("Servidor do Multi-User ligado neste PC. Os outros veem você como host aqui no painel. Ele fecha junto com o app.");
    });

  const unhost = () =>
    run(async () => {
      if (!dir) return;
      if (!confirm("Derrubar o servidor do Multi-User? Quem estiver na sessão cai. Antes, alguém deve salvar a sessão (Persist Session Changes no Unreal).")) return;
      await stopServer(dir);
      sync.setUnreal({ mue: null });
      setSt(await ueStatus(dir, s.mcpPort));
    });

  const dot = (on: boolean | undefined) => <span className="dot" style={{ background: on ? "var(--ok)" : "#888", display: "inline-block", marginRight: 6 }} />;

  return (
    <Modal title="🔌 Conectar Unreal" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.55 }}>
        Um clique: escreve o <code>.mcp.json</code>, abre o Unreal neste projeto com o <b>MCP oficial</b> ligado (e, se marcar, já entrando no{" "}
        <b>Multi-User Editing</b>) e, quando o editor responder, abre o <b>Claude Code</b> na pasta. Cada pessoa liga o seu: o MCP só aceita
        conexão deste PC.
      </p>

      {oldApp && <div className="error-box">Esta versão do app ainda não conecta o Unreal. Feche e abra o GameForge para atualizar.</div>}

      {!dir ? (
        <button className="primary" disabled={busy} onClick={() => void run(onStartMirror)}>
          Ligar a pasta da sala
        </button>
      ) : (
        <div className="small" style={{ lineHeight: 1.8 }}>
          <div>
            {dot(!!up)}
            {up === undefined ? "Procurando o projeto…" : up ? <>Projeto: <code>{up.file}</code> (engine {up.association || "?"})</> : "Sem .uproject na raiz da pasta da sala"}
          </div>
          <div>
            {dot(!!engine)}
            {engines === null ? "Procurando o Unreal…" : engine ? <>Unreal {engine.version}: <code>{engine.root}</code></> : "Unreal não encontrado"}
          </div>
          <div>
            {dot(st?.mcp)}MCP na porta {s.mcpPort}: {st?.mcp ? "respondendo" : "desligado (abre com o editor)"}
          </div>
          <div>
            {dot(!!snap)}Presença do editor: {snap ? `mapa ${mapName(snap.map) || "?"}, ${snap.sel.length} selecionado(s), ${snap.dirty.length + snap.more} modificado(s)` : "sem sinal (editor fechado?)"}
          </div>
        </div>
      )}

      {up && up.missing.length > 0 && (
        <div className="note-box small">
          Faltam no {up.file}: <b>{up.missing.join(", ")}</b>.{" "}
          <button
            className="small"
            disabled={busy}
            onClick={() => {
              if (confirm(`Ligar ${up.missing.join(", ")} no ${up.file}? O .uproject sincroniza: vale para todos da sala. Feche o Unreal antes.`))
                void run(async () => {
                  await enablePlugins(dir!, up.file);
                  await loadUproject();
                });
            }}
          >
            Ligar plugins
          </button>
        </div>
      )}
      {presenceOff && (
        <div className="note-box small">
          O <code>Content/Python/init_unreal.py</code> do projeto não liga a presença. Acrescente nele a linha <code>import gameforge_presence</code>.
        </div>
      )}
      {dir && engines !== null && !engine && (
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Pasta do Unreal (ex.: D:\Epic Games\UE_5.8)" value={other} onChange={(e) => setOther(e.target.value)} />
          <button
            disabled={busy || !other.trim()}
            onClick={() =>
              void run(async () => {
                const e = (await loadEngines(other.trim()))?.find((x) => x.root === other.trim());
                if (!e) throw new Error("Não achei o Unreal nessa pasta: indique a pasta que tem Engine\\Binaries\\Win64\\UnrealEditor.exe dentro.");
                set({ root: e.root });
              })
            }
          >
            Procurar
          </button>
        </div>
      )}
      {engines && engines.length > 1 && (
        <select value={s.root} onChange={(e) => set({ root: e.target.value })} style={{ marginTop: 8, width: "100%" }}>
          {engines.map((e) => (
            <option key={e.root} value={e.root}>
              Unreal {e.version} — {e.root}
            </option>
          ))}
        </select>
      )}

      <h4 style={{ marginBottom: 6 }}>Multi-User Editing (editar o mesmo mapa ao vivo)</h4>
      <label className="row small">
        <input type="checkbox" checked={s.multi} onChange={(e) => set({ multi: e.target.checked })} style={{ width: "auto" }} />
        Entrar na sessão ao abrir o Unreal (como <b>{ueName(me.name)}</b>)
      </label>
      {hosts.map((p) => (
        <div key={p.uid} className="row small" style={{ marginTop: 6 }}>
          <span className="grow">
            <b>{p.name}</b> hospeda: servidor {p.mue!.server}, sessão {p.mue!.session}
            {p.mue!.addr ? `, endereço ${p.mue!.addr}` : " (rede local)"}
          </span>
          <button className="small" onClick={() => set({ multi: true, server: p.mue!.server, session: p.mue!.session, addr: p.mue!.addr })}>
            Usar
          </button>
        </div>
      ))}
      {s.multi && (
        <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <input title="Nome do servidor (o mesmo do host)" placeholder="servidor" value={s.server} onChange={(e) => set({ server: onlyName(e.target.value) })} style={{ flex: "1 1 120px" }} />
          <input title="Nome da sessão (o mesmo do host)" placeholder="sessão" value={s.session} onChange={(e) => set({ session: onlyName(e.target.value) })} style={{ flex: "1 1 120px" }} />
          <input
            title="Só se o host estiver em outra rede (VPN): IP:porta do servidor. Vazio = rede local."
            placeholder="IP:porta do host (só VPN)"
            value={s.addr}
            onChange={(e) => set({ addr: e.target.value.trim() })}
            style={{ flex: "1 1 160px" }}
          />
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>
          Hospedar a sessão neste PC {st?.server ? "(servidor ligado)" : ""}
        </summary>
        <p className="small muted" style={{ lineHeight: 1.55 }}>
          Um PC da turma liga o servidor (não precisa do projeto, mas tem que ficar com o app aberto). Mesma rede: deixe o endereço vazio. Em VPN
          (Tailscale e parecidas): o IP deste PC na VPN e uma porta fixa entre 50000 e 60000, e os outros põem esse mesmo IP:porta.
        </p>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <input placeholder="IP:porta deste PC na VPN (vazio = rede local)" value={s.unicast} onChange={(e) => set({ unicast: e.target.value.trim() })} style={{ flex: "1 1 200px" }} />
          {st?.server ? (
            <button disabled={busy} onClick={() => void unhost()}>
              Derrubar servidor
            </button>
          ) : (
            <button disabled={busy || !dir || !engine || !s.server || !s.session} onClick={() => void host()}>
              Ligar servidor
            </button>
          )}
        </div>
        <div className="small muted">Log: .gfs/mue-server.log na pasta da sala.</div>
      </details>

      <h4 style={{ marginBottom: 6 }}>Porta do MCP</h4>
      <div className="row">
        <input
          type="number"
          min={1024}
          max={65535}
          value={s.mcpPort}
          onChange={(e) => set({ mcpPort: Number(e.target.value) || DEFAULT_MCP_PORT })}
          style={{ width: 110 }}
          title="A mesma de Editor Preferences > Model Context Protocol > Server Port Number (padrão 8000)"
        />
        <span className="small muted grow">Padrão 8000. Mude só se outro programa usa essa porta.</span>
      </div>

      {msg && <div className="note-box small">{msg}</div>}
      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <button className="primary" disabled={busy || !dir || oldApp} onClick={() => void connect()}>
          ▶ Conectar Unreal
        </button>
        <button disabled={busy || !dir} onClick={() => void run(() => onOpen("vscode"))}>
          Só abrir o Claude
        </button>
        <button disabled={busy || !dir} onClick={() => void run(() => onOpen("diversion"))} title="Abre o Content/ no app do Diversion (enviar e baixar os assets)">
          Abrir no Diversion
        </button>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>
          Passo a passo (primeira vez em cada PC)
        </summary>
        <ol className="steps small">
          <li>Unreal 5.8.1 instalado pelo Epic Games Launcher (todos com a mesma versão).</li>
          <li>
            Projeto na pasta da sala (o <code>.uproject</code> na raiz). Clique em <b>Ligar plugins</b> se aparecer (Python, Unreal MCP, All Toolsets,
            Multi-User). O <code>.uproject</code> sincroniza: basta uma pessoa.
          </li>
          <li>
            <b>Content/ pelo Diversion</b>: o repositório do Diversion é <b>só a pasta Content</b> (dv clone &lt;repo&gt; para dentro de{" "}
            <code>Content</code>), com <code>Python/</code> no <code>.dvignore</code> (essa pasta já vem pela sala). Nunca a pasta inteira: o Diversion
            traria código antigo por cima do que a sala sincroniza. Enviar e baixar: botão <b>Abrir no Diversion</b>.
          </li>
          <li>
            <b>▶ Conectar Unreal</b>. Na primeira vez o Claude Code pergunta se pode usar o servidor <code>unreal-mcp</code> do <code>.mcp.json</code>: aceite.
          </li>
          <li>
            Multi-User: uma pessoa liga o servidor (Hospedar), as outras clicam em <b>Usar</b> e conectam. Mesma rede local, ou VPN com IP:porta. Ao terminar,
            alguém salva a sessão no Unreal (Persist Session Changes) antes de derrubar o servidor.
          </li>
          <li>
            O que cada pessoa seleciona e modifica no editor aparece no 🔒 Unreal e no <code>.gfs/ASSETS.md</code> do Claude; o modificado é reservado
            sozinho por 30 min (só com o app e o editor abertos).
          </li>
        </ol>
      </details>

      <div className="actions">
        <button onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}
