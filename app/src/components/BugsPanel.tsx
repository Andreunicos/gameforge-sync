import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { RoomSync } from "../sync/roomSync";
import { IMG_RULE, ROOM_CLAUDE_MD } from "../sync/templates";
import { BUGS_FILE, addBugImage, compressImage, imgFile } from "../bugimgs";
import { logActivity } from "../rooms";
import type { Author } from "../types";
import { Modal } from "./Modals";

const HEADER = `# Ideias e Bugs

> Lista dos testadores (enviada pelo app). Claude: leia no começo de TODA tarefa.
> Item feito e conferido = APAGUE a linha. O que não resolveu, deixe.
> 🖼 .gfs/bugs/x.jpg = imagem de referência do item (veja com Read; some sozinha quando o item for apagado).

`;

// Salas antigas já têm um CLAUDE.md sem a regra: ela entra uma vez, no primeiro envio.
const RULE = ROOM_CLAUDE_MD.slice(ROOM_CLAUDE_MD.indexOf("## Ideias e bugs"), ROOM_CLAUDE_MD.indexOf("## Como trabalhar"));

const MAX_IMGS = 3;

interface Item {
  kind: "🐞" | "💡";
  text: string;
  imgs: string[]; // base64 de JPEG já reduzido
}

const src = (b64: string) => `data:image/jpeg;base64,${b64}`;

export function BugsPanel({ roomId, sync, me, onClose }: { roomId: string; sync: RoomSync; me: Author; onClose: () => void }) {
  const [kind, setKind] = useState<Item["kind"]>("🐞");
  const [text, setText] = useState("");
  const [imgs, setImgs] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const attach = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/")).slice(0, MAX_IMGS - imgs.length);
    if (!pics.length) return;
    setMsg(null);
    try {
      const done = await Promise.all(pics.map(compressImage));
      setImgs((v) => [...v, ...done].slice(0, MAX_IMGS));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void attach(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void attach([...e.dataTransfer.files]);
  };

  const draft = (): Item | null =>
    text.trim() || imgs.length ? { kind, text: text.replace(/\s*\n\s*/g, " ").trim() || "ver imagem", imgs } : null;

  const add = () => {
    const d = draft();
    if (!d) return;
    setItems((v) => [...v, d]);
    setText("");
    setImgs([]);
  };

  const all = [...items, ...(draft() ? [draft()!] : [])];

  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const day = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      let withImg = false;
      let out = "";
      for (const it of all) {
        const ids = await Promise.all(it.imgs.map((b) => addBugImage(roomId, b))); // imagens antes do texto
        withImg ||= ids.length > 0;
        out += `- [ ] ${it.kind} ${it.text} — ${me.name}, ${day}${ids.length ? ` · 🖼 ${ids.map(imgFile).join(" ")}` : ""}\n`;
      }
      await sync.appendToFile(BUGS_FILE, out, HEADER);
      const rules = sync.remoteFiles().find((f) => f.path === "CLAUDE.md");
      if (rules && !rules.content.includes(BUGS_FILE)) await sync.appendToFile("CLAUDE.md", `\n${RULE}`);
      else if (rules && withImg && !rules.content.includes("🖼")) await sync.appendToFile("CLAUDE.md", IMG_RULE);
      await logActivity(roomId, me, { kind: "edit", file: BUGS_FILE, summary: `mandou ${all.length} ${all.length === 1 ? "item" : "itens"} para ${BUGS_FILE}` });
      setItems([]);
      setText("");
      setImgs([]);
      setMsg({ ok: true, text: `Enviado! ${all.length} ${all.length === 1 ? "item entrou" : "itens entraram"} em ${BUGS_FILE}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const thumbs = (list: string[], remove?: (i: number) => void) => (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {list.map((b, i) => (
        <span key={i} style={{ position: "relative" }}>
          <img src={src(b)} alt="" style={{ height: 48, borderRadius: 4, display: "block" }} />
          {remove && (
            <button className="ghost" style={{ position: "absolute", top: -6, right: -6, padding: "0 5px" }} onClick={() => remove(i)}>
              ✕
            </button>
          )}
        </span>
      ))}
    </span>
  );

  return (
    <Modal title="🐞 Lista de bugs e ideias" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.55 }}>
        Escreva o que achou testando e, se ajudar, cole (Ctrl+V), arraste ou anexe uma imagem. Ao enviar, vai para{" "}
        <code>{BUGS_FILE}</code>; o Claude lê em toda tarefa e apaga o que resolveu. As imagens são temporárias: somem junto.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className={kind === "🐞" ? "primary" : ""} onClick={() => setKind("🐞")}>
          🐞 Bug
        </button>
        <button className={kind === "💡" ? "primary" : ""} onClick={() => setKind("💡")}>
          💡 Ideia
        </button>
      </div>
      <textarea
        autoFocus
        rows={4}
        style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }}
        placeholder="o botão de comprar gema não responde na loja"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      />
      <div className="row" style={{ margin: "8px 0", alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={pick}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void attach([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button disabled={imgs.length >= MAX_IMGS} onClick={() => pick.current?.click()}>
          🖼 Imagem ({imgs.length}/{MAX_IMGS})
        </button>
        {thumbs(imgs, (i) => setImgs((v) => v.filter((_, j) => j !== i)))}
        <span className="grow" />
        <button disabled={!draft()} onClick={add}>
          ＋ Adicionar outro
        </button>
      </div>

      {items.length > 0 && (
        <ul style={{ paddingLeft: 18, margin: "8px 0" }}>
          {items.map((it, i) => (
            <li key={i} className="small" style={{ marginBottom: 4 }}>
              {it.kind} {it.text} {thumbs(it.imgs)}{" "}
              <button className="ghost" onClick={() => setItems((v) => v.filter((_, j) => j !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {msg && <div className={msg.ok ? "note-box small" : "error-box"}>{msg.text}</div>}
      <div className="actions">
        <button onClick={onClose}>Fechar</button>
        <button className="primary" disabled={busy || all.length === 0} onClick={() => void send()}>
          {busy ? "Enviando…" : `Enviar${all.length ? ` (${all.length})` : ""}`}
        </button>
      </div>
    </Modal>
  );
}
