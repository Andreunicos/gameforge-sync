# GameForge Sync — contexto do projeto

> Este arquivo resume tudo o que o André decidiu com o Claude (chat do claude.ai, out/2026) antes de começar a programar.
> Leia inteiro antes de qualquer tarefa. "GameForge Sync" é nome provisório.
> Plano completo (com diagramas): https://claude.ai/code/artifact/29cada44-fe16-4112-8969-e262ea355bef

## Estado atual (Fase 1 em andamento — 2026-10-05)

Estrutura do repo (`Andreunicos/gameforge-sync`, público):
- `app/` — Tauri 2 + React 19 + Vite + TS. `npm run dev` (navegador, login por popup) ou `npm run tauri dev` (app).
  - `src/sync/session.ts` — um `FileSession` por arquivo aberto: base+versão, grava após 2 s numa transação que só passa se a versão remota == base; versão nova de outro → merge de 3 vias (`sync/merge.ts`, linhas, marcadores estilo git).
  - `src/sync/roomSync.ts` — listener de `rooms/{id}/files`, sessões, criar/apagar/importar pasta, atividade (edição logada no máx. a cada 3 min por arquivo).
  - `src/sync/presence.ts` — presença/cursores no Realtime DB (`presence/{room}/{uid}`), cursores remotos via `sync/editorSetup.ts`.
  - `src/preview.ts` — monta o srcdoc: scripts/CSS da sala inline, módulos ES viram data: URLs, `<base href>` = `room.assetsBase`, localStorage em memória, console → postMessage.
  - Versão única em `app/package.json` (o `tauri.conf.json` aponta para ele).
- `firebase/firestore.rules`, `firebase/database.rules.json` — porteiro (membros, papéis, versão +1, convites). Deploy: `npx firebase-tools deploy --only firestore:rules,database` na raiz.
- `.github/workflows/release.yml` — tag `v*` → tauri-action (Windows/NSIS) → Release + `latest.json` assinado.
- Login no app de PC: abre https://gameforge-sync.web.app/login (hosting/login/index.html, Firebase Hosting) no navegador, que devolve o id_token para 127.0.0.1:<porta>/callback (google.rs). Sem cliente OAuth de desktop. Também aceita link no e-mail (Hotmail etc., provedor Email link do Firebase): a página manda `id_token=emaillink:{email,link}` pelo mesmo callback e quem usa o link é o app (`signInWithEmailLink`) ou o gfs (REST `accounts:signInWithEmailLink`). As regras aceitam `sign_in_provider` google.com ou password (o token do link no e-mail vem como password; não existe 'emailLink' no token), sempre com email_verified.
- Só 3 e-mails autorizados (regras + ALLOWED_EMAILS). Atualização é automática ao abrir (UpdateBanner).
- Chave de assinatura do updater: `C:\Users\BIGHOUSE\.tauri\gameforge.key` (sem senha). Precisa estar no secret `TAURI_SIGNING_PRIVATE_KEY` do repo e em backup.
- Convite = documento `invites/{código}`; entrar = update na sala validado pelas regras (`isJoining`).
- `gfs/` — CLI do Claude (Fase 2). REST puro do Firestore/Identity Toolkit (sem SDK), bundle único `dist/gfs.mjs` via `node build.mjs`. Login pela mesma página web.app; sessão em `~/.gfs/auth.json` (refresh token). Pasta clonada guarda `.gfs/state.json` + `.gfs/base/` (base do merge). Comandos: login, rooms, clone, status, pull, push. claim/say/checkpoint = Fase 3. `gfs/src/merge.ts` é cópia de `app/src/sync/merge.ts`. Toda sala ganha CLAUDE.md/GAME.md da sala (`gfs/src/templates.ts`) no primeiro clone.
- Pasta do Claude (v0.1.2): `app/src/sync/folderMirror.ts` espelha a sala em `~/<sala>` direto na pasta do usuário (desde v0.1.5; antes ~/GameForge/<sala>). Quem escolhe/cria a pasta e libera o escopo do plugin-fs em tempo de execução é o comando Rust `room_dir` (nome ocupado por outra coisa → `<sala>-<id6>`) (plugin-fs + watch), mesmo formato .gfs do CLI; botão "Ligar Claude" abre VS Code + `vscode://anthropic.claude-code/open` (`src-tauri/src/launch.rs`). Autor das mudanças da pasta = kind "claude".
- **Como publicar (desde v0.1.8):** a janela do app carrega a tela de https://gameforge-sync.web.app/app/ (Firebase Hosting). Mudança só de tela/TS → `cd app && npm run deploy:web` (~20 s; quem está fora de sala recarrega sozinho, quem está numa sala vê "Recarregar"). Mudança no Rust/tauri.conf/capabilities/plugins → subir versão + tag (build ~3-4 min com o cache da main, workflow rust-cache.yml). Comandos do app só funcionam se estiverem no AppManifest do build.rs E liberados em capabilities/default.json (allow-<comando>). Remote URL da capability = só o domínio `https://gameforge-sync.web.app` (no Windows o Tauri usa o cabeçalho Origin, sem caminho; `/app/*` não casa — erro "not allowed by ACL" da v0.1.8).
- **Histórico e backups (web v0.2.0):** `app/src/history.ts` + `app/src/diff.ts` (gfs tem cópia do diff). Toda gravação de arquivo (editor, pasta do Claude, criar/importar, gfs push) grava junto `rooms/{id}/history/{arquivo@versão}` com conteúdo, +/− e funções mexidas; apagar grava `@del-<ms>`. `rooms/{id}/checkpoints` = foto {arquivo: versão}: manual (📌), automática 1/dia (💾) e "backup inicial" (dono, salas antigas, marca `room.historySince`). Restaurar = gravar o conteúdo antigo como versão nova (nada se perde). UI: `components/HistoryPanel.tsx` (botão 🕘 Histórico).
- **Botão BUILD (v0.2.1):** `app/src/builds.ts` + `components/BuildPanel.tsx`. Web (.html único + pasta web/) é gerado no app (`buildPreview({standalone:true})`, gravado pelo comando Rust `write_build_file`). Android/Windows/Linux: o app grava o jogo num branch `build/<jogo>-<ms>` do repo PRIVADO `Andreunicos/gameforge-builds` (pasta `Desktop/Jogos/Projetos/GameForgeBuilds`: workflow `build.yml`, cascas `templates/desktop` (Tauri) e `templates/android` (Capacitor 8), `scripts/prepare.mjs`), dispara o workflow, acompanha os jobs, e baixa a release (tag `build-<jogo>-<ms>`) pelo comando Rust `download_asset` para `<sala>uilds<data>-v<versão>` (a pasta do Claude ignora `builds/`). Token = fine-grained só desse repo, em `secrets/github` no Firestore (lê: 3 contas; grava: só o André). Chave Android única dos jogos: `~/.gameforge/gameforge-games.jks` (senha no LEIA-ME ao lado), secrets ANDROID_KEYSTORE_B64/PASSWORD no repo de builds. Pacote Android = `com.bringmestudio.<nome-sem-traços>`. Histórico de builds em `rooms/{id}/builds`.
- Release: o workflow anexa `gfs.tgz` em toda release; instalar com `npm i -g https://github.com/Andreunicos/gameforge-sync/releases/latest/download/gfs.tgz`. Versão do gfs = versão do app (subir as duas juntas).
- Cuidado no Windows: arquivos que só diferem em maiúsculas (ex.: `main.tsx`/`Main.tsx`) são o MESMO arquivo.

## Quem e o quê

- **André** desenvolve jogos HTML5 (mobile e PC). Jogos têm em torno de 9–15 MB.
- Vai construir este app junto com um amigo, cada um com o próprio Claude.
- **Ideia:** um app que hospeda jogos HTML5 em desenvolvimento, onde várias pessoas **e o Claude de cada uma** editam os mesmos arquivos ao mesmo tempo, vendo o que o outro está mexendo. Tipo "Figma de jogos HTML5" com IA de cada dev coordenada.
- **Prioridades do André:** gastar pouco token, ficar no plano gratuito, app que se autoatualiza pelo GitHub.

## Decisões já tomadas

1. **O app é um "banco de armazenamento" + editor.** Não há servidor próprio. App e CLI falam direto com o Firebase; as regras de segurança do Firebase fazem o papel de porteiro.
2. **Firebase no plano Spark (grátis, sem cartão):**
   - **Firestore:** código do jogo (um documento por arquivo, com versão), feed de atividade, reservas, chat. Limites grátis: 1 GiB, 50 mil leituras e 20 mil gravações por dia. Limite de 1 MB por documento: arquivo acima de 900 KB vai em pedaços para `rooms/{id}/blobs/{arquivo~n}` (o doc do arquivo fica com `content: ""` + `parts`/`size`; cada pedaço leva a `version`). Limite de 7 MB por arquivo. Toda gravação passa por `putFile` (`app/src/sync/fileStore.ts`); o gfs faz o mesmo em `writeRemote`. Histórico de arquivo grande guarda só quem/quando (`big: true`, sem conteúdo, sem restaurar). Lógica comum em `bigfile.ts` (cópia igual em app/src e gfs/src).
   - **Realtime Database:** presença e cursores (cobra por volume, não por gravação). 1 GB grátis.
   - **Firebase Auth:** login com conta Google.
   - **NÃO usar Cloud Storage no início:** desde fev/2026 exige plano Blaze (cartão). O Firebase grátis NÃO tem 50 GB.
3. **GitHub para o que é pesado e para versões:**
   - Repositório do **jogo**: sprites, sons, histórico; jogo publicado no **GitHub Pages**. O Firestore guarda só o caminho dos assets.
   - Repositório do **app** (público): Releases + `latest.json` assinado para a autoatualização.
4. **Método de conexão do Claude (economia de token):** o Claude NÃO edita arquivo a arquivo por servidor/MCP. Ele trabalha no **Claude Code**, numa **pasta local** que espelha a sala, com as ferramentas normais (busca, lê só o trecho necessário, edita, roda o jogo) e no fim manda **só o que mudou** com `gfs push`.
5. **Sincronização "em segundos", não letra por letra.** Troca consciente para caber no grátis e economizar token. Se um dia precisar, colocar Yjs só no editor humano.
6. **Autoatualização** desde a v0.1.0 (Fase 1).
7. **Tudo em TypeScript**, do app ao gfs.

## Stack

| Camada | Escolha |
| --- | --- |
| App no PC | Tauri 2 (React + Vite por dentro) |
| App no Android | Tauri 2 Android, APK fora da loja no começo |
| App na web (opcional) | Mesmo front no GitHub Pages |
| Editor de código | CodeMirror 6 |
| Preview do jogo | iframe em sandbox (isolado) |
| Banco em tempo real | Firestore + Realtime Database (Spark) |
| Login | Firebase Auth (Google) |
| Assets / jogo publicado | Repo do jogo no GitHub + GitHub Pages |
| Ponte do Claude | `gfs` — CLI em Node.js + TypeScript, publicado no npm (`npx gfs@latest`) |
| Builds e releases | GitHub Actions + tauri-action |

## Arquitetura (resumo)

```
 Você / Amigo (app: editor + preview)  <── tempo real ──>  ┌──────────── Firebase (Spark) ────────────┐
                                                            │ Realtime DB: presença, cursores          │
 Seu Claude / Claude do amigo                                │ Firestore: código + versão, feed,        │
 (Claude Code + pasta local + gfs)   ── push só do que mudou ─>│            reservas, chat                │
                                                            └──────────────────────┬───────────────────┘
                                                                                   │ checkpoint de versão
 GitHub · repo do app (releases + latest.json)                GitHub · repo do jogo (assets, Pages)
   ^-- o app confere ao abrir e se atualiza
```

## O gfs (CLI que o Claude usa)

Regra de ouro: **nenhum comando devolve arquivo inteiro, só resumos curtos.** O Claude abre o arquivo local quando precisa.

| Comando | O que faz | O que devolve |
| --- | --- | --- |
| `gfs login` | Entra com a conta Google | "logado como André" |
| `gfs clone <sala>` | Baixa a sala para a pasta | Lista curta de arquivos |
| `gfs status` | Atividade desde o último sync | Poucas linhas: quem mexeu, onde, reservas ativas |
| `gfs pull` | Traz o que mudou | Nomes dos arquivos atualizados |
| `gfs claim player.js:jump "intenção"` | Reserva uma função por 10 min | OK, ou quem já está lá |
| `gfs push "mensagem"` | Envia só os alterados, com merge automático | OK + versão, ou só o trecho em conflito |
| `gfs release` | Libera reservas | OK |
| `gfs say "texto"` | Mensagem no chat da sala | OK |
| `gfs checkpoint "rótulo"` | Salva versão no repo do jogo no GitHub | Link do commit |

Ciclo do Claude: `gfs status` → `gfs claim` → edita e testa local → `gfs push` → `gfs release`.

### Como o push funciona
1. O gfs guarda a **versão base** de cada arquivo baixado.
2. No push, cada arquivo alterado vai numa **transação** do Firestore: se a versão remota ainda é a base, grava e incrementa a versão.
3. Se mudou, baixa a nova e faz **merge de 3 vias** (base, local, remota). Sem choque: grava. Com choque: devolve ao Claude só o trecho em conflito.

## Modelo de dados (Firestore)

| Coleção | Documento | Campos principais |
| --- | --- | --- |
| `rooms` | Uma sala | nome, dono, membros e papéis, versão mínima do app |
| `rooms/{id}/files` | Um arquivo de código | caminho, conteúdo, versão, autor, data |
| `rooms/{id}/activity` | Um evento | autor (humano ou Claude), arquivo, função, resumo de 1 linha |
| `rooms/{id}/claims` | Uma reserva | arquivo, área, intenção, dono, expira em |
| `rooms/{id}/chat` | Uma mensagem | autor, texto, destinatário opcional |

## Desafios e soluções

- **Conflitos:** (1) reservas por função, vencem em 10 min, destacadas no app; (2) push com versão + merge de 3 vias; (3) editor humano grava ao pausar ~2 s, mesmo merge, cursores visíveis. Rede de segurança: histórico de versões por arquivo + `gfs checkpoint` no GitHub.
- **Latência:** listeners do Firestore empurram mudanças; edição local otimista; presença no Realtime DB; reload do preview agrupado; Claude trabalha em lotes e o feed mostra "Claude do André está mexendo em player.js".
- **Permissões** (garantidas pelas regras do Firebase):

  | Papel | Editar código | Apagar arquivo | Publicar | Convidar |
  | --- | --- | --- | --- | --- |
  | Dono | Sim | Sim | Sim | Sim |
  | Editor | Sim | Sim | Não | Não |
  | Claude de um editor | Sim | Pede aprovação | Não | Não |
  | Espectador | Não | Não | Não | Não |

  O Claude nunca tem mais poder que o dono dele. Pastas podem ser travadas (ex.: `assets/final/`).
- **Custo:** zero de token para o app (cada um usa o próprio plano do Claude). O limite que mais aperta são as 20 mil gravações/dia: gravar ao pausar, cursores no Realtime DB, contador de uso no app.
- **Claudes discordando:** um Claude não reverte mudança de outro autor sem perguntar no chat; limite de pushes por minuto por agente; `GAME.md` da sala é o árbitro de design.

## Arquivos que toda sala recebe (template)

- `CLAUDE.md` **da sala** (não confundir com este): regras para o Claude que edita o jogo — rodar `gfs status` antes de começar, reservar antes de mexer, `gfs push` ao fim de cada tarefa, nunca reverter trabalho alheio sem perguntar.
- `GAME.md`: visão do jogo, estilo de código, decisões já tomadas.

## Autoatualização pelo GitHub

1. Subir a versão no código (ex.: 1.3.0) e criar a tag `v1.3.0`.
2. GitHub Actions + tauri-action compila PC e Android e publica uma Release com instaladores e `latest.json` assinado.
3. Ao abrir, o app lê `https://github.com/SEU_USUARIO/gameforge/releases/latest/download/latest.json`, compara versões e avisa.
4. PC: `tauri-plugin-updater` baixa, verifica assinatura e instala. Android: o updater do Tauri não suporta; usar `tauri-plugin-android-update` (baixa o APK e o Android pede confirmação).

```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "SUA_CHAVE_PUBLICA",
      "endpoints": [
        "https://github.com/SEU_USUARIO/gameforge/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Cuidados:
- Chave privada de assinatura como segredo do GitHub **e** em backup. Perder a chave impede atualizar quem já instalou.
- Repositório do app público (o link direto do `latest.json` não funciona em repo privado sem servidor intermediário).
- Versão mínima por sala: se o formato dos dados mudar, o app obriga a atualizar antes de entrar.
- O gfs se atualiza rodando com `npx gfs@latest`.

## Roadmap (cada fase termina num teste)

1. **Sala básica no Firebase** — app Tauri com login Google, salas, editor e preview; código no Firestore; autoatualização desde a v0.1.0. Ainda sem IA.
   *Teste:* dois navegadores/apps editam juntos sem perder nada.
2. **Primeiro Claude** — gfs com `login`, `clone`, `status`, `push` e merge de 3 vias; Claude Code edita na pasta local e manda só o que mudou.
   *Teste:* o push do Claude entra enquanto o André digita, sem perder nada.
3. **Vários Claudes** — reservas, chat entre Claudes, CLAUDE.md/GAME.md da sala, papéis; checkpoints no GitHub e voltar versão.
   *Teste:* dois Claudes no mesmo arquivo sem entrar em loop.
4. **Produto** — publicar jogo no GitHub Pages, convites por link, APK Android; opcional: conector MCP para usar a IA pelo celular.
   *Teste:* primeiro jogo feito em dupla publicado.

## Riscos

- Loop entre agentes (regras acima).
- Limite diário do Firestore (20 mil gravações).
- Chave de assinatura perdida.
- IA pelo celular depende de um Claude Code rodando em algum lugar (PC ou nuvem); pelo celular o app serve para acompanhar e editar à mão.
- Código malicioso no preview: sempre iframe isolado.
- Escopo: começar só com arquivos de texto (HTML, JS, CSS, JSON); editor visual de cenas fica para depois.

## Mercado (referências)

Ninguém junta as três coisas (jogos HTML5 + edição simultânea + cada dev com o próprio agente). Referências:
- **PlayCanvas** — editor web de jogos com colaboração ao vivo e servidor MCP. A mais próxima; estudar.
- **Replit Multiplayer** — cada colaborador roda tarefas do Agent em cópias isoladas, com merge automático.
- **Rosebud AI** — cria e hospeda jogos web por prompt; sem construção ao vivo em conjunto.
- **Superconductor** — workspace onde cada pessoa dirige o próprio Claude/Codex (software geral).
- **Liveblocks** — infraestrutura de salas/presença com agentes.

## Próximos passos (onde começar)

- [ ] Escolher o nome definitivo do app
- [ ] Criar o projeto no Firebase (Spark) e ativar login Google, Firestore e Realtime Database
- [ ] Criar o repositório do app no GitHub com o esqueleto Tauri 2 + React
- [ ] Gerar a chave de assinatura, configurar GitHub Actions com tauri-action, publicar a v0.1.0 e testar a autoatualização lançando a v0.1.1
- [ ] Editor + preview lendo e gravando arquivos no Firestore, com o André e o amigo na mesma sala
- [ ] Primeira versão do gfs (`login`, `clone`, `status`, `push`) e o template de CLAUDE.md/GAME.md da sala

## Pendente de confirmação

- Cada dev usa o próprio plano do Claude (o app não paga API). Assumido, ainda não confirmado pelo André.
- Nome do app e nome do usuário/organização no GitHub.
