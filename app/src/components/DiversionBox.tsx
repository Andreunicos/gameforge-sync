import { useEffect, useState, useSyncExternalStore } from "react";
import { DV_APP, dvApi, getDvToken, onDvToken, setDvToken, type DvMemberStatus } from "../diversion";
import { dvState, onDvState, syncDiversion } from "../diversionSync";
import { updateRoomSettings } from "../rooms";
import type { Room } from "../types";
import { Cmd } from "./Modals";

const STATE: Record<DvMemberStatus["state"], string> = {
  ok: "✓ tem acesso",
  pending: "convite enviado, esperando aceitar",
  sent: "convidado, sem resposta (convite vencido ou aceito com outro e-mail?)",
  todo: "a convidar",
  skip: "",
};

/** Seção do 🔒 Unreal: o repositório do Diversion da sala. O token e os convites só aparecem para o dono. */
export function DiversionBox({ room, meUid, isOwner, project }: { room: Room; meUid: string; isOwner: boolean; project?: string | null }) {
  const d = room.diversion;
  // Content/ do projeto (na raiz da sala ou numa subpasta), relativo à pasta da sala.
  const content = typeof project === "string" ? (project ? `${project}/Content` : "Content") : "<pasta do projeto>/Content";
  const arg = /\s/.test(content) ? `"${content}"` : content;
  const token = useSyncExternalStore(onDvToken, getDvToken);
  const st = useSyncExternalStore(onDvState, () => dvState(room.id));
  const [draft, setDraft] = useState("");
  const [repos, setRepos] = useState<{ repo_id: string; repo_name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = d?.invited?.[meUid];

  // Painel aberto pelo dono: confere de novo (pega quem aceitou o convite).
  useEffect(() => {
    if (isOwner && token && d) void syncDiversion(room, { refresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, token, !!d]);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      <h4 style={{ marginBottom: 6 }}>Diversion (Content/ do projeto)</h4>
      {d?.repoId ? (
        <div className="small" style={{ lineHeight: 1.55 }}>
          Repositório desta sala: <b>{d.name}</b> (
          <a href={DV_APP} target="_blank" rel="noreferrer">
            abrir o Diversion
          </a>
          ). Na pasta da sala, sem a pasta <code>{content}</code> (se já tiver, renomeie para <code>Content_old</code> antes):
          <Cmd text={`dv clone ${d.repoId} ${arg}`} />
          Quem tem os assets copia de volta para <code>{content}</code> e envia pelo Diversion. Ponha <code>Python/</code> no <code>.dvignore</code> do Content.{" "}
          {!isOwner &&
            (mine ? (
              <>
                Seu e-mail <b>{mine.email}</b> foi convidado ({mine.mode === "WRITE" ? "pode enviar" : "só baixar"}): aceite o convite que o Diversion mandou
                por e-mail (crie a conta com esse e-mail, se ainda não tiver).
              </>
            ) : (
              "O dono ainda não convidou você: o app dele faz isso sozinho quando estiver aberto."
            ))}
        </div>
      ) : d ? (
        <p className="small muted">O repositório é criado quando o app do dono da sala estiver aberto.</p>
      ) : (
        !isOwner && <p className="small muted">Esta sala não tem repositório do Diversion pelo GameForge.</p>
      )}

      {isOwner && (
        <div className="small" style={{ lineHeight: 1.55 }}>
          {token ? (
            <div className="row" style={{ marginTop: 6 }}>
              <span className="grow muted">Token do Diversion salvo só neste PC.</span>
              <button className="small" onClick={() => confirm("Apagar o token do Diversion deste PC? Os convites param até colar outro.") && setDvToken("")}>
                Apagar token
              </button>
            </div>
          ) : (
            <>
              <p className="muted" style={{ margin: "6px 0" }}>
                Cole o token do Diversion (diversion.dev → Settings → Integrations, começa com <code>dvk_</code>) para o app criar o repositório de cada sala Unreal
                e convidar o e-mail de quem entra. Fica só neste PC: não vai para a sala nem para os outros.
              </p>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!draft.trim().startsWith("dvk_")) return setError("O token do Diversion começa com dvk_.");
                  run(async () => {
                    setDvToken(draft);
                    setDraft("");
                  });
                }}
              >
                <input type="password" autoComplete="off" placeholder="dvk_…" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <button className="primary" disabled={!draft.trim()}>
                  Salvar
                </button>
              </form>
            </>
          )}

          {token && !d && (
            <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
              <button className="primary small" onClick={() => run(() => updateRoomSettings(room.id, { diversion: {} }))}>
                Criar repositório desta sala
              </button>
              {repos === null ? (
                <button className="small" onClick={() => run(async () => setRepos(await dvApi(token).listOwned()))}>
                  Usar um que já tenho…
                </button>
              ) : (
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const r = repos.find((x) => x.repo_id === e.target.value);
                    if (r && confirm(`Ligar a sala ao repositório ${r.repo_name}? Os membros da sala serão convidados para ele.`))
                      run(() => updateRoomSettings(room.id, { diversion: { repoId: r.repo_id, name: r.repo_name } }));
                  }}
                >
                  <option value="" disabled>
                    {repos.length ? "Escolha o repositório" : "Nenhum repositório seu"}
                  </option>
                  {repos.map((r) => (
                    <option key={r.repo_id} value={r.repo_id}>
                      {r.repo_name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {token && d && (
            <>
              {st.members?.map((m) => (
                <div key={m.uid} className="row" style={{ marginTop: 4 }}>
                  <span className="grow">
                    <b>{m.name}</b> <span className="muted">{m.email}</span>
                    {m.mode && <span className="muted"> · {m.mode === "WRITE" ? "envia e baixa" : "só baixa"}</span>}
                    <br />
                    <span className={m.error ? "" : "muted"} style={m.error ? { color: "#e5484d" } : undefined}>
                      {m.error ?? (!m.mode ? "dono: já é OWNER do repositório" : !m.email ? "sem e-mail no perfil: não dá para convidar" : STATE[m.state])}
                    </span>
                  </span>
                  {(m.state === "sent" || m.error) && m.mode && (
                    <button className="small" disabled={st.busy} onClick={() => void syncDiversion(room, { force: [m.uid] })}>
                      Convidar de novo
                    </button>
                  )}
                </div>
              ))}
              <div className="row" style={{ marginTop: 6 }}>
                <span className="grow muted">{st.busy ? "Conferindo o Diversion…" : st.at ? `Conferido às ${new Date(st.at).toLocaleTimeString("pt-BR").slice(0, 5)}` : ""}</span>
                <button className="small" disabled={st.busy} onClick={() => void syncDiversion(room, { refresh: true })}>
                  Tentar de novo
                </button>
              </div>
            </>
          )}
          {st.error && <div className="error-box">{st.error}</div>}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
    </>
  );
}
