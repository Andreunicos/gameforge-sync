import { useRef, useState } from "react";
import type { RoomSync, RoomSyncState } from "../sync/roomSync";

const TEXT_EXT = /\.(html?|js|mjs|cjs|ts|css|json|txt|md|csv|xml|svg|glsl|frag|vert)$/i;
const IGNORE = /(^|\/)(node_modules|\.git|dist|android|ios)(\/|$)/;

function extClass(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs", "ts"].includes(ext)) return ["js", "JS"];
  if (["html", "htm"].includes(ext)) return ["html", "<>"];
  if (ext === "css") return ["css", "CSS"];
  if (ext === "json") return ["json", "{}"];
  return ["other", ext.slice(0, 3).toUpperCase() || "·"];
}

export function FileList({
  sync,
  state,
  readOnly,
  meUid,
}: {
  sync: RoomSync;
  state: RoomSyncState;
  readOnly: boolean;
  meUid: string;
}) {
  const folderInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const toast = (text: string, kind: "info" | "warn" | "error" = "error") => sync.onToast({ kind, text });

  const newFile = async () => {
    const path = prompt("Nome do arquivo novo (ex.: index.html ou js/player.js):", state.files.length ? "" : "index.html");
    if (!path) return;
    if (/^[a-z]:[\\/]/i.test(path.trim()) || path.trim().startsWith("\\\\") || path.includes("\\")) {
      toast("Isso é um caminho do seu PC, não um nome de arquivo. Para trazer um jogo que você já tem, use o botão “Importar pasta”.", "warn");
      return;
    }
    if (!/\.[a-z0-9]+$/i.test(path.trim())) {
      toast("Coloque a extensão no nome (ex.: player.js, index.html, style.css).", "warn");
      return;
    }
    try {
      await sync.createFile(path, path.endsWith(".html") && state.files.length === 0 ? STARTER_HTML : "");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const del = async (path: string) => {
    if (!confirm(`Apagar ${path} para todo mundo da sala?`)) return;
    try {
      await sync.deleteFile(path);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const importFolder = async (list: HTMLInputElement["files"]) => {
    if (!list?.length) return;
    const files = Array.from(list).filter((f) => {
      const rel = f.webkitRelativePath.split("/").slice(1).join("/");
      return TEXT_EXT.test(rel) && !IGNORE.test(rel);
    });
    if (!files.length) {
      toast("Nenhum arquivo de código (html, js, css, json…) nessa pasta.", "warn");
      return;
    }
    if (!confirm(`Importar ${files.length} arquivo(s) de código? Os que já existem na sala serão substituídos.\n\nImagens e sons não vão: eles ficam no repositório do jogo no GitHub.`))
      return;
    setImporting(`0/${files.length}`);
    try {
      const data = await Promise.all(
        files.map(async (f) => ({
          path: f.webkitRelativePath.split("/").slice(1).join("/"),
          content: (await f.text()).replace(/\r\n/g, "\n"),
        })),
      );
      const skipped = await sync.importFiles(data, (n) => setImporting(`${n}/${files.length}`));
      if (skipped.length) toast(`Ficaram de fora (maiores que 900 KB): ${skipped.join(", ")}`, "warn");
      else toast(`${data.length} arquivo(s) importados.`, "info");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
      if (folderInput.current) folderInput.current.value = "";
    }
  };

  const peopleIn = (path: string) => state.people.filter((p) => p.file === path && p.uid !== meUid);

  return (
    <>
      <div className="side-head">
        <span className="title">Arquivos</span>
        {!readOnly && (
          <>
            <button className="ghost small" title="Criar um arquivo novo" onClick={() => void newFile()}>
              ＋ Arquivo
            </button>
            <button className="ghost small" title="Trazer o código de um jogo que já existe no seu PC" onClick={() => folderInput.current?.click()}>
              📁 Importar
            </button>
            <input
              ref={folderInput}
              type="file"
              hidden
              // @ts-expect-error atributo não-padrão, mas suportado pelo Chromium/WebView2
              webkitdirectory=""
              multiple
              onChange={(e) => void importFolder(e.target.files)}
            />
          </>
        )}
      </div>
      {importing && <div className="small muted" style={{ padding: "0 14px 6px" }}>Importando {importing}…</div>}
      <div className="files">
        {!state.loaded && <div className="small muted" style={{ padding: 8 }}>Carregando…</div>}
        {state.loaded && state.files.length === 0 && (
          <div className="empty-files">
            <p>Sala vazia. Como quer começar?</p>
            {!readOnly && (
              <>
                <button className="primary" onClick={() => folderInput.current?.click()}>
                  📁 Importar pasta de um jogo
                </button>
                <span className="small muted">Escolha a pasta do jogo no PC. Vai só o código (html, js, css, json).</span>
                <button onClick={() => void sync.createFile("index.html", STARTER_HTML).catch((e: Error) => toast(e.message))}>
                  ✨ Começar do zero
                </button>
              </>
            )}
          </div>
        )}
        {state.files.map((f) => {
          const [cls, label] = extClass(f.path);
          const i = f.path.lastIndexOf("/");
          const status = state.statuses[f.path];
          return (
            <div
              key={f.path}
              className={`file ${state.active === f.path ? "active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => sync.open(f.path)}
              onKeyDown={(e) => e.key === "Enter" && sync.open(f.path)}
              title={`${f.path} · v${f.version} · por ${f.author.name}${f.author.kind === "claude" ? " (Claude)" : ""}`}
            >
              <span className={`ext ${cls}`}>{label}</span>
              <span className="grow ellipsis">
                {i >= 0 && <span className="dir">{f.path.slice(0, i + 1)}</span>}
                {f.path.slice(i + 1)}
              </span>
              {(status === "dirty" || status === "saving") && <span className="dot" style={{ background: "var(--muted)" }} title="não gravado" />}
              {status === "conflict" && <span title="conflito">⚠</span>}
              {peopleIn(f.path).map((p) => (
                <span key={p.uid} className="dot" style={{ background: p.color }} title={`${p.name} está aqui`} />
              ))}
              {!readOnly && (
                <button
                  className="ghost del"
                  title="Apagar"
                  onClick={(e) => {
                    e.stopPropagation();
                    void del(f.path);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

const STARTER_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meu jogo</title>
  <style>
    html, body { margin: 0; height: 100%; background: #1b1625; }
    canvas { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
  </style>
</head>
<body>
  <canvas id="game"></canvas>
  <script>
    const c = document.getElementById("game");
    const ctx = c.getContext("2d");
    let t = 0;
    function frame() {
      c.width = innerWidth; c.height = innerHeight;
      ctx.fillStyle = "#ff9d4d";
      const x = c.width / 2 + Math.cos(t) * 80, y = c.height / 2 + Math.sin(t) * 80;
      ctx.fillRect(x - 12, y - 12, 24, 24);
      t += 0.03;
      requestAnimationFrame(frame);
    }
    frame();
  </script>
</body>
</html>
`;
