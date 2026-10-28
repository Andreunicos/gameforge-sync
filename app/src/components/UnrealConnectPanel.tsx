import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_MCP_PORT,
  editorAlive,
  enablePlugins,
  findEngines,
  isOldApp,
  loadSettings,
  mapName,
  openEditor,
  pickEngine,
  pickProject,
  projectDirs,
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
import { exists, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { roomSlug } from "../sync/folderMirror";
import { ueScripts } from "../sync/templates";
import type { RoomSync } from "../sync/roomSync";
import type { Author, Presence, Room } from "../types";
import type { OpenTool } from "./ClaudePanel";
import { Modal } from "./Modals";
import { VPN_LABEL, checkHostAddr, hostAddr, joinTarget, netAddrs, pickVpn, saveHosted, type NetAddr } from "../vpn";

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
  onOpen: (tool: OpenTool, project?: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [s, setS] = useState<UeSettings>(() => loadSettings(room.id, roomSlug(room.name)));
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [other, setOther] = useState("");
  const [dirs, setDirs] = useState<string[] | null>(null); // pastas da sala com .uproject ("" = raiz)
  const [up, setUp] = useState<Uproject | null | undefined>(undefined);
  const [st, setSt] = useState<UeStatus | null>(null);
  const [oldApp, setOldApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waitUntil = useRef(0);
  // Placas de rede deste PC (Radmin...): null = lendo; "old" = app sem o comando vpn_addrs (só o modo manual).
  const [nets, setNets] = useState<NetAddr[] | "old" | null>(null);

  const set = (patch: Partial<UeSettings>) =>
    setS((cur) => {
      const next = { ...cur, ...patch };
      saveSettings(room.id, next);
      return next;
    });

  // Projeto: "" = raiz da sala, "TesteUnreal" = subpasta; null = nenhum; undefined = vários (a pessoa escolhe) ou procurando.
  const proj = dirs && pickProject(dirs, s.project);

  const fail = (e: unknown) => {
    // App de antes da busca em subpastas: o Rust só olha a raiz e responde SEM_UPROJECT.
    if (isOldApp(e) || (proj && String(e).includes("SEM_UPROJECT"))) setOldApp(true);
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

  /** Relê as placas de rede (a pessoa pode ligar o Radmin com o painel aberto). Erro nunca trava o painel: cai no manual. */
  const refreshNets = () =>
    netAddrs().then(
      (list) => {
        setNets(list);
        return list;
      },
      (e) => {
        if (!isOldApp(e)) console.warn("vpn_addrs:", e);
        const v = isOldApp(e) ? "old" : [];
        setNets(v);
        return v;
      },
    );

  useEffect(() => {
    void refreshNets();
    const t = window.setInterval(() => void refreshNets(), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Acha o projeto pelos arquivos da sala (raiz ou subpasta até 2 níveis) e lê o .uproject dele no disco. */
  const findProject = async () => {
    const list = projectDirs(sync.remoteFiles().map((f) => f.path));
    setDirs(list);
    const p = pickProject(list, s.project);
    const u = dir && typeof p === "string" ? await readUproject(dir, p) : null;
    setUp(u);
    return { p, u };
  };
  const loadUproject = () => findProject().catch(fail);

  useEffect(() => {
    void loadEngines(s.root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  useEffect(() => {
    if (dir) void loadUproject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, s.project]);

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
          setMsg("O Unreal abriu com o MCP ligado. Abrindo o Claude Code na pasta da sala…");
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
  const vpn = Array.isArray(nets) ? pickVpn(nets) : undefined;
  const target = joinTarget(s, people, me.uid);
  const hostTarget = joinTarget({ ...s, addr: "" }, people, me.uid); // o que o automático usaria
  const pre = proj ? `${proj}/` : "";
  const initPy = sync.remoteFiles().find((f) => f.path.toLowerCase() === `${pre}content/python/init_unreal.py`.toLowerCase());
  const presenceOff = initPy && !initPy.content.includes("gameforge_presence");
  // A pasta da sala cria os scripts sozinha quando há um projeto só; com vários, cria no que a pessoa escolher aqui.
  const presenceMissing = !!up && !initPy;

  const createScripts = () =>
    run(async () => {
      if (!dir || typeof proj !== "string") return;
      for (const [p, text] of ueScripts(proj)) {
        const parts = p.split("/");
        const f = await join(dir, ...parts);
        if (await exists(f)) continue; // nunca por cima do que já existe
        await mkdir(await join(dir, ...parts.slice(0, -1)), { recursive: true });
        await writeTextFile(f, text);
      }
      setMsg(`Scripts criados em ${pre}Content/Python. A pasta da sala manda para todos em segundos. Reabra o Unreal para ele carregar.`);
    });

  const connect = () =>
    run(async () => {
      if (!dir) throw new Error("Ligue a pasta da sala primeiro (botão acima).");
      const { p, u } = await findProject();
      if (p === undefined) throw new Error("Há mais de um projeto (.uproject) na pasta da sala: escolha qual na lista acima.");
      if (typeof p !== "string" || !u)
        throw new Error(
          "Não achei o projeto: o .uproject tem que estar na pasta da sala ou numa subpasta dela (até 2 níveis), como a pasta que o Unreal cria com o nome do projeto. Não precisa mover nada; se acabou de criar, espere uns segundos a pasta da sala enviar e tente de novo.",
        );
      if (u.missing.length) throw new Error(`Faltam plugins no ${u.file}: ${u.missing.join(", ")}. Clique em "Ligar plugins" abaixo.`);
      if (!engine) throw new Error("Unreal não encontrado neste PC. Indique a pasta da engine (ex.: C:\\Program Files\\Epic Games\\UE_5.8).");
      if (s.multi && (!s.server || !s.session)) throw new Error("Preencha o servidor e a sessão do Multi-User (ou desmarque a opção).");
      // Multi-User automático: campo IP:porta preenchido ganha; senão servidor, sessão e endereço do host da sala (presença).
      const t = joinTarget(s, people, me.uid);
      if (s.multi && t.from === "none") {
        const ok = confirm(
          "Ninguém está hospedando o Multi-User nesta sala agora: peça para o host abrir o 🔌 Conectar Unreal e clicar em Hospedar.\n\nOK = abrir o Unreal mesmo assim (ele fica procurando o servidor). Cancelar = esperar o host.",
        );
        if (!ok) return;
      }
      if (s.multi && t.addr) {
        const list = await refreshNets();
        const c = Array.isArray(list) ? checkHostAddr(t.addr, list) : null;
        if (c?.level === "error") throw new Error(c.text);
        if (c && !confirm(`${c.text}\n\nConectar mesmo assim?`)) return;
      }
      await writeMcpJson(dir, s.mcpPort);
      const now = await ueStatus(dir, s.mcpPort);
      // O script de presença deu sinal há menos de 30 s: o editor deste projeto já está aberto, não abre outro.
      if (await editorAlive(dir)) {
        if (!now.mcp) {
          throw new Error(
            `O Unreal deste projeto já está aberto, mas o MCP não responde na porta ${s.mcpPort}. Feche o Unreal e clique em Conectar de novo (ele abre já nessa porta), ou confira Edit > Plugins (Unreal MCP e All Toolsets).`,
          );
        }
        await onOpen("vscode");
        setMsg(`O Unreal deste projeto já estava aberto (MCP na porta ${s.mcpPort}): abri só o Claude Code.`);
        return;
      }
      if (
        now.mcp &&
        !confirm(`Algo já responde na porta ${s.mcpPort}: o Unreal deste projeto já está aberto? OK = abrir outro editor mesmo assim. Cancelar = só abrir o Claude.`)
      ) {
        await onOpen("vscode");
        setMsg(".mcp.json pronto e Claude Code aberto. Se a porta é de outro programa, mude a porta do MCP aqui e no Unreal.");
        return;
      }
      await openEditor(dir, { ...s, server: t.server, session: t.session, addr: t.addr }, me.name, p);
      waitUntil.current = Date.now() + MCP_WAIT_MS;
      const where = t.hostName ? ` de ${t.hostName}` : t.from === "self" ? " deste PC" : "";
      setMsg(
        `Abrindo o Unreal ${engine.version}${s.multi ? ` e entrando na sessão ${t.session}${where}${t.addr ? ` (${t.addr})` : " (rede local)"}` : ""}… O Claude Code abre sozinho quando o MCP responder.`,
      );
    });

  const host = () =>
    run(async () => {
      if (!dir || !engine) throw new Error("Ligue a pasta da sala e escolha o Unreal primeiro.");
      const { p, u } = await findProject();
      if (typeof p !== "string" || !u) throw new Error("O servidor usa o nome do .uproject: ache o projeto primeiro (veja a linha Projeto acima).");
      // Automático: campo vazio + rede virtual ligada = IP da VPN + porta fixa da sala (ocupada: tenta as 9 seguintes).
      const list = await refreshNets();
      const v = Array.isArray(list) ? pickVpn(list) : undefined;
      let addr = hostAddr(s.unicast, v, room.id);
      for (let i = 1; ; i++) {
        try {
          await startServer(dir, { ...s, unicast: addr }, p);
          break;
        } catch (e) {
          if (s.unicast.trim() || !v || i > 9 || !/porta UDP \d+ já está em uso/.test(String(e))) throw e;
          addr = hostAddr("", v, room.id, i);
        }
      }
      sync.setUnreal({ mue: { server: s.server, session: s.session, addr } });
      saveHosted(room.id, addr);
      setSt(await ueStatus(dir, s.mcpPort));
      setMsg(
        addr
          ? `Servidor do Multi-User ligado em ${addr}${v && !s.unicast.trim() ? ` (${VPN_LABEL[v.kind as keyof typeof VPN_LABEL]})` : ""}. Os outros só clicam em Conectar: o endereço vai sozinho. Fecha junto com o app e, se a VPN cair por mais de 10 s, fecha sozinho.`
          : "Servidor do Multi-User ligado para a REDE LOCAL (nenhuma rede virtual ligada neste PC). Em casas diferentes: abra o Radmin VPN, derrube e hospede de novo.",
      );
    });

  const unhost = () =>
    run(async () => {
      if (!dir) return;
      if (!confirm("Derrubar o servidor do Multi-User? Quem estiver na sessão cai. Antes, alguém deve salvar a sessão (Persist Session Changes no Unreal).")) return;
      sync.setUnreal({ mue: null }); // antes de parar: o vigia da sala (useMueWatch) não confunde com queda
      saveHosted(room.id, null);
      await stopServer(dir);
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

      {oldApp && (
        <div className="error-box">
          Esta versão do app ainda não conecta o Unreal{proj ? " com o projeto numa subpasta" : ""}. Feche e abra o GameForge para atualizar.
        </div>
      )}

      {!dir ? (
        <button className="primary" disabled={busy} onClick={() => void run(onStartMirror)}>
          Ligar a pasta da sala
        </button>
      ) : (
        <div className="small" style={{ lineHeight: 1.8 }}>
          <div>
            {dot(!!up)}
            {up === undefined ? (
              "Procurando o projeto…"
            ) : up ? (
              <>
                Projeto: <code>{up.path}</code> (engine {up.association || "?"})
              </>
            ) : proj === undefined ? (
              "Há mais de um projeto (.uproject) na pasta da sala: escolha qual abaixo"
            ) : (
              "Nenhum .uproject na pasta da sala nem nas subpastas (até 2 níveis)"
            )}
          </div>
          {dirs && dirs.length > 1 && (
            <select value={proj ?? "?"} onChange={(e) => set({ project: e.target.value })} style={{ width: "100%" }} title="Projetos achados na pasta da sala (escolha vale só neste PC)">
              {proj === undefined && (
                <option value="?" disabled>
                  Escolha o projeto…
                </option>
              )}
              {dirs.map((d) => (
                <option key={d} value={d}>
                  {d ? `${d}/` : "Raiz da pasta da sala"}
                </option>
              ))}
            </select>
          )}
          <div>
            {dot(!!engine)}
            {engines === null ? "Procurando o Unreal…" : engine ? <>Unreal {engine.version}: <code>{engine.root}</code></> : "Unreal não encontrado"}
          </div>
          <div>
            {dot(st?.mcp)}MCP na porta {s.mcpPort}: {st?.mcp ? "respondendo" : "desligado (abre com o editor)"}
          </div>
          <div>
            {dot(!!snap)}Presença do editor: {snap ? `mapa ${mapName(snap.map) || "?"}, ${snap.sel.length} selecionado(s), ${snap.dirty.length + snap.more} modificado(s)${snap.mu ? " · na sessão do Multi-User" : ""}` : "sem sinal (editor fechado?)"}
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
                  await enablePlugins(dir!, up.path);
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
          O <code>{pre}Content/Python/init_unreal.py</code> do projeto não liga a presença. Acrescente nele a linha <code>import gameforge_presence</code>.
        </div>
      )}
      {presenceMissing && (
        <div className="note-box small">
          O projeto ainda não tem os scripts de presença do GameForge em <code>{pre}Content/Python</code> (sem eles o app não vê o que você seleciona e
          modifica no editor).{" "}
          <button className="small" disabled={busy} onClick={() => void createScripts()}>
            Criar
          </button>
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
      <div className="small" style={{ marginTop: 4 }}>
        {dot(!!vpn)}
        {nets === null
          ? "Procurando rede virtual…"
          : nets === "old"
            ? "Esta versão do app não acha o Radmin VPN sozinha: feche e abra o GameForge para atualizar (até lá, IP:porta à mão)."
            : vpn
              ? <>Rede virtual: <b>{VPN_LABEL[vpn.kind as keyof typeof VPN_LABEL]}</b> {vpn.ip}</>
              : "Nenhuma rede virtual ligada: em casas diferentes, abra o Radmin VPN e entre na rede da turma (mesmo Wi-Fi não precisa)."}
      </div>
      {s.multi && (
        <div className="small muted" style={{ marginTop: 2 }}>
          Conectar vai em:{" "}
          {target.from === "manual"
            ? `${target.addr} (digitado à mão)`
            : target.from === "host"
              ? `servidor de ${target.hostName}${target.addr ? ` em ${target.addr}` : " (rede local)"} (automático)`
              : target.from === "self"
                ? `o servidor deste PC${target.addr ? ` (${target.addr})` : ""}`
                : "ninguém está hospedando: peça para o host clicar em Hospedar."}
        </div>
      )}
      {s.multi && target.from === "manual" && hostTarget.from === "host" && hostTarget.addr !== target.addr && (
        <div className="note-box small">
          O endereço digitado ({target.addr}) é diferente do que {hostTarget.hostName} publicou ({hostTarget.addr || "rede local"}). Apague o campo para seguir o host sozinho.
        </div>
      )}
      {s.multi && snap && !snap.mu && (
        <details className="note-box small" style={{ marginTop: 6 }}>
          <summary style={{ cursor: "pointer" }}>O Unreal está aberto, mas o app ainda não o viu entrar na sessão. Não achou o servidor?</summary>
          <ol className="steps">
            <li>Os dois com o Radmin VPN ligado e na MESMA rede (o IP dos dois começa com 26.).</li>
            <li>O host clicou em Hospedar e aparece aqui como host (o servidor dele fecha se o Radmin dele cair).</li>
            <li>
              Firewall do Windows: a rede do Radmin costuma ser <b>Pública</b>. Em Segurança do Windows &gt; Firewall e proteção de rede &gt; Permitir um
              aplicativo pelo firewall, marque <b>Pública</b> para <code>UnrealMultiUserServer</code> (no PC do host) e <code>UnrealEditor</code> (nos dois); se não estiverem
              na lista, "Permitir outro aplicativo" e escolha em <code>Engine\Binaries\Win64</code> da engine. Se o Windows perguntar ao abrir, marque redes
              públicas também.
            </li>
            <li>Ainda não: feche o Unreal e clique em Conectar de novo (o script de presença antigo também não mostra a sessão: ignore se você já está nela).</li>
          </ol>
        </details>
      )}
      {hosts.map((p) => (
        <div key={p.uid} className="row small" style={{ marginTop: 6 }}>
          <span className="grow">
            <b>{p.name}</b> hospeda: servidor {p.mue!.server}, sessão {p.mue!.session}
            {p.mue!.addr ? `, endereço ${p.mue!.addr}` : " (rede local)"}
          </span>
          <button
            className="small"
            title="Usa o servidor e a sessão desse host; o endereço segue o host sozinho"
            onClick={() => set({ multi: true, server: p.mue!.server, session: p.mue!.session, addr: "" })}
          >
            Usar
          </button>
        </div>
      ))}
      {s.multi && (
        <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <input title="Nome do servidor (o mesmo do host)" placeholder="servidor" value={s.server} onChange={(e) => set({ server: onlyName(e.target.value) })} style={{ flex: "1 1 120px" }} />
          <input title="Nome da sessão (o mesmo do host)" placeholder="sessão" value={s.session} onChange={(e) => set({ session: onlyName(e.target.value) })} style={{ flex: "1 1 120px" }} />
          <input
            title="Vazio = automático (o endereço que o host publicou, ou rede local). Preenchido = usa este IP:porta."
            placeholder="IP:porta do host (vazio = automático)"
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
          Um PC da turma liga o servidor (tem que ficar com o app aberto). Deixe o endereço vazio: com o Radmin VPN (ou ZeroTier/Tailscale) ligado, o
          app usa o IP deste PC na VPN e uma porta fixa da sala ({hostAddr("", vpn, room.id) || "sem VPN: rede local"}) e os outros recebem sozinhos.
          Se a VPN deste PC cair por mais de 10 s, o servidor fecha sozinho (a sessão para para todos; o Unreal de cada um continua aberto).
        </p>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <input placeholder="IP:porta deste PC (vazio = automático)" value={s.unicast} onChange={(e) => set({ unicast: e.target.value.trim() })} style={{ flex: "1 1 200px" }} />
          {st?.server ? (
            <button disabled={busy} onClick={() => void unhost()}>
              Derrubar servidor
            </button>
          ) : (
            <button disabled={busy || !dir || !engine || !s.server || !s.session} onClick={() => void host()}>
              Hospedar
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
        <span className="small muted grow">
          Cada sala Unreal tem a sua neste PC (a primeira é 8000), para dois projetos abertos não se confundirem. Mude só se outro programa usa
          essa porta.
        </span>
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
        <button
          disabled={busy || !dir}
          onClick={() => void run(() => onOpen("diversion", typeof proj === "string" ? proj : null))}
          title="Abre o Content/ do projeto no app do Diversion (enviar e baixar os assets)"
        >
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
            Projeto dentro da pasta da sala: o <code>.uproject</code> na raiz dela ou numa subpasta (ex.: a pasta que o Unreal cria com o nome do
            projeto). O app acha sozinho, não precisa mover nada. Clique em <b>Ligar plugins</b> se aparecer (Python, Unreal MCP, All Toolsets,
            Multi-User). O <code>.uproject</code> sincroniza: basta uma pessoa.
          </li>
          <li>
            <b>Content/ pelo Diversion</b>: o repositório do Diversion é <b>só a pasta Content do projeto</b> (dv clone &lt;repo&gt; para dentro de{" "}
            <code>{pre}Content</code>), com <code>Python/</code> no <code>.dvignore</code> (essa pasta já vem pela sala). Com o token do Diversion no app do
            dono, a sala ganha um repositório próprio e cada membro é convidado por e-mail: o comando de clone está no 🔒 Unreal. Nunca a pasta inteira: o Diversion
            traria código antigo por cima do que a sala sincroniza. Enviar e baixar: botão <b>Abrir no Diversion</b>.
          </li>
          <li>
            <b>▶ Conectar Unreal</b>. Na primeira vez o Claude Code pergunta se pode usar o servidor <code>unreal-mcp</code> do <code>.mcp.json</code>: aceite.
          </li>
          <li>
            Multi-User em casas diferentes: todos com o <b>Radmin VPN</b> ligado na mesma rede. Uma pessoa abre "Hospedar a sessão neste PC" e clica em{" "}
            <b>Hospedar</b>; as outras marcam a caixa do Multi-User e clicam em <b>▶ Conectar Unreal</b> (o endereço vai sozinho, sem digitar). Fechar o Radmin
            do host (ou o app) desliga o servidor. Não achou o servidor: veja a dica do firewall que aparece acima. Ao terminar, alguém salva a sessão no
            Unreal (Persist Session Changes) antes de derrubar o servidor.
          </li>
          <li>
            O que cada pessoa seleciona e modifica no editor aparece no 🔒 Unreal e no <code>.gfs/ASSETS.md</code> do Claude; o modificado é reservado
            sozinho por 30 min (só com o app e o editor abertos; dentro de uma sessão do Multi-User o app só avisa, porque o que os outros mudam
            também aparece como modificado).
          </li>
        </ol>
      </details>

      <div className="actions">
        <button onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}
