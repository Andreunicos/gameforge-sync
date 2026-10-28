import { useEffect, useState, useSyncExternalStore } from "react";
import { getGhToken, looksLikeGhToken, onGhToken, setGhToken, validLogin, type GhMemberStatus } from "../gitContent";
import { createGitRepo, gitDo, gitState, onGitState, syncGitAccess } from "../gitContentSync";
import { updateRoomSettings } from "../rooms";
import type { Author, Room } from "../types";

const STATE: Record<GhMemberStatus["state"], string> = {
  owner: "dono do repositório",
  viewer: "espectador: não é convidado (num repositório pessoal do GitHub todo convidado pode enviar)",
  nologin: "sem usuário do GitHub: escreva ao lado",
  ok: "✓ tem acesso",
  pending: "convite enviado: a pessoa aceita em github.com (e-mail ou notificações)",
  sent: "convidado, sem resposta (recusou ou o convite venceu em 7 dias)",
  todo: "a convidar",
};

const OP: Record<string, string> = { status: "Lendo…", init: "Ligando…", fetch: "Conferindo o GitHub…", pull: "Baixando…", push: "Enviando…" };

/** Seção do 🔒 Unreal: o Content/ do projeto pelo Git (GitHub + LFS). Token e convites só para o dono. */
export function GitContentBox({ room, me, isOwner, readOnly, dir, project }: { room: Room; me: Author; isOwner: boolean; readOnly: boolean; dir?: string; project?: string | null }) {
  const g = room.git;
  const token = useSyncExternalStore(onGhToken, getGhToken);
  const st = useSyncExternalStore(onGitState, () => gitState(room.id));
  const [draft, setDraft] = useState("");
  const [logins, setLogins] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ctx = dir && typeof project === "string" ? { room, dir, project, me } : null;
  const l = st.local;

  // Painel aberto: lê o Content/ deste PC; o dono confere os convites (pega quem aceitou).
  useEffect(() => {
    if (ctx && g?.repo) void gitDo(ctx, "status"); // só leitura local; erro aparece no painel
    if (isOwner && token && g?.repo) void syncGitAccess(room);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g?.repo, !!ctx, isOwner, token]);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    fn()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const saveLogin = (uid: string) => {
    const v = (logins[uid] ?? "").trim();
    if (v && !validLogin(v)) return setError(`"${v}" não é um usuário do GitHub válido.`);
    const users = { ...g?.users };
    if (v) users[uid] = v;
    else delete users[uid];
    run(async () => {
      const next = { ...room, git: { ...g, users } };
      await updateRoomSettings(room.id, { git: next.git });
      await syncGitAccess(next);
    });
  };

  const summary = !l
    ? "Lendo o Content/ deste PC…"
    : !l.repo
      ? "Este PC ainda não está ligado ao repositório."
      : l.ahead > 0 && l.behind > 0
        ? "Divergiu: este PC e o GitHub têm envios diferentes (veja o aviso abaixo)."
        : [
            l.changedTotal > 0 ? `${l.changedTotal} arquivo(s) mudado(s) para enviar` : "",
            l.ahead > 0 ? `${l.ahead} envio(s) feitos aqui ainda não subiram` : "",
            l.behind > 0 ? `${l.behind} envio(s) para baixar` : "",
          ]
            .filter(Boolean)
            .join(" · ") || (l.remote ? "✓ Em dia com o GitHub." : "Repositório vazio: o dono (ou quem tem os assets) envia primeiro.");

  return (
    <>
      <h4 style={{ marginBottom: 6 }}>Git (Content/ pelo GitHub)</h4>
      {g?.repo ? (
        <div className="small" style={{ lineHeight: 1.55 }}>
          Repositório privado desta sala:{" "}
          <a href={`https://github.com/${g.repo}`} target="_blank" rel="noreferrer">
            {g.repo}
          </a>
          . O Content/ do projeto chega por ele: o app confere a cada 10 min e <b>baixa sozinho</b> quando nada mudou aqui e o Unreal está fechado. Enviar é sempre
          pelo botão.
          {st.oldApp ? (
            <p className="error-box">Este app é de uma versão anterior ao Git do Content/: atualize (reabra o app para a atualização automática).</p>
          ) : !dir ? (
            <p className="muted">Ligue a pasta do Claude (botão na barra da sala) para o app achar o projeto neste PC.</p>
          ) : project === null ? (
            <p className="muted">A sala ainda não tem projeto Unreal (.uproject).</p>
          ) : project === undefined ? (
            <p className="muted">A sala tem mais de um projeto: escolha qual no 🔌 Conectar Unreal.</p>
          ) : (
            <>
              <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
                <span className="grow">{st.op ? OP[st.op] : summary}</span>
                {l && !l.repo && (
                  <button className="primary small" disabled={!!st.op} onClick={() => ctx && void gitDo(ctx, "init")}>
                    Ligar este PC
                  </button>
                )}
                {l?.repo && (
                  <>
                    <button className="small" disabled={!!st.op} onClick={() => ctx && void gitDo(ctx, "fetch")}>
                      Conferir
                    </button>
                    <button className="small" disabled={!!st.op || l.behind === 0} onClick={() => ctx && void gitDo(ctx, "pull")} title="Feche o Unreal antes">
                      Baixar
                    </button>
                    {!readOnly && (
                      <button className="small" disabled={!!st.op || (l.changedTotal === 0 && l.ahead === 0)} onClick={() => ctx && void gitDo(ctx, "push")}>
                        Enviar
                      </button>
                    )}
                  </>
                )}
              </div>
              {l && !l.lfs && <div className="error-box">O Git LFS não está instalado neste PC: instale pelo git-lfs.com (ou reinstale o Git para Windows marcando Git LFS) e reabra o app.</div>}
              {l && l.changedTotal > 0 && (
                <div className="muted ellipsis" title={l.changed.join("\n")}>
                  Mudados aqui: {l.changed.slice(0, 5).join(", ")}
                  {l.changedTotal > 5 ? "…" : ""}
                </div>
              )}
              {st.msg && <div className="muted">{st.msg}</div>}
              {st.error && <div className="error-box">{st.error}</div>}
            </>
          )}
          {!isOwner &&
            (g.users?.[me.uid] ? (
              <p className="muted" style={{ margin: "6px 0" }}>
                Seu usuário do GitHub na sala: <b>{g.users[me.uid]}</b>.{" "}
                {room.roles[me.uid] === "editor" ? (
                  <>
                    Aceite o convite em{" "}
                    <a href={`https://github.com/${g.repo}/invitations`} target="_blank" rel="noreferrer">
                      github.com/{g.repo}/invitations
                    </a>{" "}
                    e clique em <b>Ligar este PC</b>: na 1ª vez o Git abre o navegador para você entrar no GitHub.
                  </>
                ) : (
                  "Espectador não recebe o Content/ pelo Git."
                )}
              </p>
            ) : (
              <p className="muted" style={{ margin: "6px 0" }}>
                Passe seu usuário do GitHub para o dono da sala: ele põe aqui e o app convida você.
              </p>
            ))}
        </div>
      ) : (
        !isOwner && <p className="small muted">Esta sala não usa Git para o Content/.</p>
      )}

      {isOwner && (
        <div className="small" style={{ lineHeight: 1.55 }}>
          {token ? (
            <div className="row" style={{ marginTop: 6 }}>
              <span className="grow muted">Token do GitHub salvo só neste PC.</span>
              <button className="small" onClick={() => confirm("Apagar o token do GitHub deste PC? Criar repositório e convidar param até colar outro.") && setGhToken("")}>
                Apagar token
              </button>
            </div>
          ) : (
            <>
              <p className="muted" style={{ margin: "6px 0" }}>
                Cole um token do GitHub (github.com → Settings → Developer settings → Personal access tokens) para o app criar o repositório privado da sala e
                convidar os editores. Fica só neste PC: não vai para a sala nem para os outros.
              </p>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!looksLikeGhToken(draft)) return setError("O token do GitHub começa com ghp_ ou github_pat_.");
                  run(async () => {
                    setGhToken(draft);
                    setDraft("");
                  });
                }}
              >
                <input type="password" autoComplete="off" placeholder="ghp_… ou github_pat_…" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <button className="primary" disabled={!draft.trim()}>
                  Salvar
                </button>
              </form>
            </>
          )}

          {token && !g?.repo && (
            <button className="primary small" style={{ marginTop: 6 }} disabled={busy} onClick={() => run(() => createGitRepo(room))}>
              Criar repositório Git desta sala
            </button>
          )}

          {token && g?.repo && (
            <>
              {room.memberIds
                .filter((uid) => uid !== room.ownerId)
                .map((uid) => {
                  const m = st.access?.find((x) => x.uid === uid);
                  return (
                    <div key={uid} style={{ marginTop: 6 }}>
                      <div className="row">
                        <b className="grow">{room.names[uid] ?? uid}</b>
                        <input
                          style={{ width: 160 }}
                          placeholder="usuário do GitHub"
                          value={logins[uid] ?? g.users?.[uid] ?? ""}
                          onChange={(e) => setLogins({ ...logins, [uid]: e.target.value })}
                        />
                        <button className="small" disabled={busy || st.accessBusy || (logins[uid] ?? g.users?.[uid] ?? "") === (g.users?.[uid] ?? "")} onClick={() => saveLogin(uid)}>
                          Salvar
                        </button>
                        {(m?.state === "sent" || m?.error) && (
                          <button className="small" disabled={st.accessBusy} onClick={() => void syncGitAccess(room, [uid])}>
                            Convidar de novo
                          </button>
                        )}
                      </div>
                      <span className={m?.error ? "" : "muted"} style={m?.error ? { color: "#e5484d" } : undefined}>
                        {m ? (m.error ?? STATE[m.state]) : ""}
                      </span>
                    </div>
                  );
                })}
              <div className="row" style={{ marginTop: 6 }}>
                <span className="grow muted">{st.accessBusy ? "Conferindo o GitHub…" : ""}</span>
                <button className="small" disabled={st.accessBusy} onClick={() => void syncGitAccess(room)}>
                  Conferir convites
                </button>
              </div>
              {st.accessError && <div className="error-box">{st.accessError}</div>}
            </>
          )}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      {(g?.repo || isOwner) && (
        <ul className="small muted" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.55 }}>
          <li>
            Passo a passo: o dono cria o repositório e põe o usuário do GitHub de cada editor; quem tem os assets clica <b>Ligar este PC</b> e <b>Enviar</b>; os outros
            aceitam o convite e clicam <b>Ligar este PC</b> (precisa do Git para Windows, que já traz o Git LFS).
          </li>
          <li>
            <b>Dois .uasset/.umap editados ao mesmo tempo NÃO se juntam</b>: o app para e avisa, nunca sobrescreve. Reserve aqui em cima antes de mexer.
          </li>
          <li>
            Cota grátis do Git LFS (GitHub Free): 10 GiB guardados e 10 GiB de download por mês, somados na conta do dono (o download dos amigos conta nela; cada
            versão de um binário fica guardada). Estourou: o LFS para até o mês seguinte. Arquivo até 2 GB.
          </li>
        </ul>
      )}
    </>
  );
}
