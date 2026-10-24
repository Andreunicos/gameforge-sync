// Arquivos que toda sala recebe. Curtos de propósito: o Claude Code lê o CLAUDE.md
// em toda conversa, então cada linha aqui custa token em toda tarefa.
// (Mantenha igual a app/src/sync/templates.ts.)

// Linha da regra de ideias/bugs sobre imagens (o app também a acrescenta em salas que já têm a regra sem ela).
export const IMG_RULE = "- Item com `🖼 .gfs/bugs/x.jpg`: veja a imagem (Read) como referência; ela some sozinha quando você apagar o item.\n";

// Bloco do CLAUDE.md que manda ler o MODELOS.md primeiro (o app também o acrescenta em salas que ainda não têm).
export const MODELOS_RULE = "## Primeiro passo (OBRIGATÓRIO)\n- Antes de QUALQUER tarefa, leia MODELOS.md e siga: ele diz se você faz sozinho (Sonnet) ou delega a Opus/Haiku. É assim que a sala economiza token.\n";

export const ROOM_MODELOS_MD = `# MODELOS.md — qual modelo usa em cada tarefa

> Leia ANTES de toda tarefa neste projeto. Objetivo: gastar menos token sem perder qualidade.

Você não troca o modelo da sessão sozinho, mas troca DELEGANDO: use a ferramenta Agent com o campo \`model\`
("opus" ou "haiku") e passe o pedido completo (arquivos, o que quer, regras do CLAUDE.md). Peça de volta só um resumo curto.

## Classifique a tarefa e escolha
- **Normal → Sonnet (padrão).** Faça você mesmo. Bug comum, feature pequena ou média, ajuste de tela, refatoração local, lógica de jogo em geral.
- **Complexa e difícil → Opus.** Delegue com \`model: "opus"\`. Só quando for MESMO pesada: arquitetura nova, bug que resiste a tentativas,
  mexe em vários sistemas ao mesmo tempo, algoritmo ou balanceamento difícil, redesign grande. Opus não economiza token: ele entra pela qualidade.
- **Boba → Haiku.** Delegue com \`model: "haiku"\` só para troca simples e sem lógica: renomear, trocar texto, cor ou número, corrigir typo,
  ou mudança mecânica repetida em vários arquivos. Nunca use Haiku para lógica, nem para algo que exija entender o jogo.

## Regras
- Em dúvida: Sonnet. Suba para Opus se o Sonnet já falhou 2 vezes na mesma coisa.
- Delegar tem custo de partida (o subagente começa sem contexto). Se você já leu o arquivo e a troca é uma edição só, faça você mesmo, mesmo sendo boba.
- Se a sessão já roda no modelo certo (ex.: já está em Opus), não delegue. Se o usuário pediu um modelo, siga o pedido dele.
- Diga ao usuário em UMA linha o que escolheu, ex.: "Modelo: Sonnet (tarefa normal)".
`;

// Seção de ideias/bugs (igual nos CLAUDE.md de todos os tipos de sala; o BugsPanel também a usa).
export const BUGS_SECTION = `## Ideias e bugs (OBRIGATÓRIO)
- No começo de TODA tarefa, leia IDEIAS_E_BUGS.md (lista que os testadores mandam pelo app). Se tiver itens, trate-os junto com o pedido.
- Quando um item estiver feito e conferido, APAGUE a linha dele do arquivo (não marque, apague). O que não resolveu fica.
${IMG_RULE}`;

export const ROOM_CLAUDE_MD = `# Sala do GameForge Sync — regras para o Claude

Esta pasta é uma sala compartilhada: outras pessoas e os Claudes delas editam este jogo AO MESMO TEMPO.
Com o app GameForge Sync aberto, a pasta sincroniza sozinha: o que você salva aparece para todos em segundos,
e o que os outros mudam aparece aqui. Não precisa rodar nenhum comando.

${MODELOS_RULE}
${BUGS_SECTION}
## Como trabalhar
- Mexa só no necessário. Ache o trecho com busca e leia só ele (não leia arquivos inteiros à toa).
- Antes de abrir um arquivo, consulte .gfs/MAPA.md (funções com nome@linha): ache o nome e leia só aquelas linhas.
- Se uma edição falhar porque o arquivo mudou, leia de novo só aquele trecho: foi alguém da sala.
- Achou marcadores <<<<<<< ======= >>>>>>> num arquivo: é conflito. Junte as duas versões e apague os marcadores.

## Nunca
- Desfazer ou reescrever código de outra pessoa sem perguntar.
- Apagar arquivos (peça ao dono da sala).
- Mexer em arquivos fora do que foi pedido.

## Saber mais
- Visão do jogo e decisões: GAME.md (leia só quando a tarefa depender de design).
- Imagens e sons NÃO ficam na sala: estão no repositório do jogo no GitHub.
- App fechado? Use \`gfs pull\` antes e \`gfs push "o que fez"\` depois.
`;

export const ROOM_GAME_MD = `# GAME.md — visão do jogo

> Árbitro das decisões de design: em dúvida, siga o que está aqui. Mantenha curto.

## O jogo
- Gênero:
- Plataforma: (celular em pé / PC / os dois)
- Ideia em 1 frase:

## Estilo de código
- Arquivos: index.html + JS separado por assunto (player.js, enemies.js, ui.js…)

## Decisões já tomadas
-
`;

// ── Salas de Roblox (Rojo) ───────────────────────────────────────────────────
// A sala é o JOGO; cada mapa/local (Lobby, Arena…) é uma pasta com o próprio default.project.json e o próprio `rojo serve` (uma porta cada).

export const ROOM_CLAUDE_MD_ROBLOX = `# Sala do GameForge Sync (Roblox) — regras para o Claude

Esta pasta é uma sala compartilhada de um jogo de Roblox: outras pessoas e os Claudes delas editam AO MESMO TEMPO.
Com o app GameForge Sync aberto, a pasta sincroniza sozinha e cada local (mapa) tem um servidor do Rojo ligado pelo app,
que manda para o Roblox Studio tudo o que você salva. Não precisa rodar nenhum comando.

${MODELOS_RULE}
${BUGS_SECTION}
## Como trabalhar (Roblox / Luau)
- Cada LOCAL (mapa/place do Roblox) é uma pasta na raiz, ex.: Lobby/, Arena/. Dentro dela: default.project.json (Rojo) e src/.
- src/server (ServerScriptService), src/client (StarterPlayerScripts), src/shared (ReplicatedStorage). Escolha o local certo antes de criar arquivo.
- Nome do arquivo define o tipo: *.server.luau = Script, *.client.luau = LocalScript, *.luau = ModuleScript; init.luau na pasta = a pasta vira o script.
- Só mexa no default.project.json para criar um mapeamento novo. Local novo: peça à pessoa para criar pelo botão 🧩 Rojo do app.
- Mapa, workspace e objetos criados no Studio NÃO ficam aqui: só o código. Não invente instâncias que o Studio não tem.
- Servidor decide, cliente só mostra: nunca confie em dados vindos do cliente (RemoteEvent/RemoteFunction validam tudo no servidor).
- Você não roda o jogo: o teste é no Studio (Play). Peça à pessoa o erro do Output em vez de adivinhar.
- Mexa só no necessário. Ache o trecho com busca e leia só ele. Antes de abrir um arquivo, consulte .gfs/MAPA.md (nome@linha).
- Se uma edição falhar porque o arquivo mudou, leia de novo só aquele trecho: foi alguém da sala.
- Achou marcadores <<<<<<< ======= >>>>>>> num arquivo: é conflito. Junte as duas versões e apague os marcadores.

## Nunca
- Desfazer ou reescrever código de outra pessoa sem perguntar.
- Apagar arquivos (peça ao dono da sala).
- Mexer em arquivos fora do que foi pedido.

## Saber mais
- Visão do jogo e decisões: GAME.md (leia só quando a tarefa depender de design).
`;

export const ROOM_GAME_MD_ROBLOX = `# GAME.md — visão do jogo (Roblox)

> Árbitro das decisões de design: em dúvida, siga o que está aqui. Mantenha curto.

## O jogo
- Gênero:
- Ideia em 1 frase:
- Monetização (gamepasses, produtos):

## Locais (mapas / places)
- (um por pasta: o que cada um é e como o jogador vai de um ao outro)

## Decisões já tomadas
-
`;

// ── Salas de Unreal Engine ───────────────────────────────────────────────────
// A pasta da sala É a raiz do projeto: o código (texto) sincroniza com merge; Content/ (binário) vem por fora
// e é protegido por reservas (rooms/{id}/claims/assets), que o app escreve em .gfs/ASSETS.md.

export const ROOM_CLAUDE_MD_UNREAL = `# Sala do GameForge Sync (Unreal Engine 5.8.1) — regras para o Claude

Esta pasta é a raiz de um projeto Unreal 5.8.1 compartilhado: outras pessoas e os Claudes delas mexem AO MESMO TEMPO.
Com o app GameForge Sync aberto, o CÓDIGO sincroniza sozinho em segundos: Source/, Config/, *.uproject, Plugins/*/Source,
Content/Python, shaders .usf/.ush. NÃO sincronizam por aqui: Content/ (.uasset/.umap), Binaries/, Intermediate/, Saved/, DerivedDataCache/.

${MODELOS_RULE}
${BUGS_SECTION}
## Assets (.uasset/.umap): reserva OBRIGATÓRIA
- Binário não tem merge: duas pessoas no mesmo asset = alguém perde trabalho.
- Antes de criar, salvar, mover, renomear ou apagar QUALQUER coisa de Content/ (pelo editor, por ferramenta MCP, por script Python), leia .gfs/ASSETS.md.
- Só mexa no que está reservado para VOCÊ. Reservado por outra pessoa: não toque, avise. Sem reserva: peça à pessoa para reservar no botão 🔒 Unreal do app.
- .gfs/ASSETS.md só vale com o app aberto. App fechado = não mexa em asset.
- Nunca abra nem "conserte" .uasset/.umap como texto.

## Como trabalhar (C++ / Python / INI)
- Código em texto tem merge automático: não precisa reservar. Mexa só no necessário; consulte .gfs/MAPA.md (nome@linha) e leia só aquelas linhas.
- Mudou .h (UCLASS/UPROPERTY/UFUNCTION), .Build.cs, .Target.cs ou criou arquivo C++: precisa recompilar com o editor fechado (Live Coding não pega). Avise a pessoa.
- Config/*.ini: mude só a chave necessária, na seção certa. Default*.ini vale para todos.
- Você não roda o editor nem o jogo: peça à pessoa o erro do Output Log ou da compilação em vez de adivinhar.
- Se uma edição falhar porque o arquivo mudou, leia de novo só aquele trecho: foi alguém da sala.
- Achou marcadores <<<<<<< ======= >>>>>>> num arquivo: é conflito. Junte as duas versões e apague os marcadores.

## Nunca
- Nada destrutivo: apagar ou limpar pastas (Content, Binaries, Intermediate, Saved, DerivedDataCache), git clean/reset, Fix Up Redirectors, resave, migrar ou renomear assets em lote.
- Compilar, empacotar ou rodar scripts que mexem no projeto inteiro sem a pessoa pedir.
- Desfazer ou reescrever código de outra pessoa sem perguntar.
- Apagar arquivos (peça ao dono da sala).
- Mexer em arquivos fora do que foi pedido.

## Saber mais
- Visão do jogo e decisões: GAME.md (leia só quando a tarefa depender de design).
`;

export const ROOM_GAME_MD_UNREAL = `# GAME.md — visão do jogo (Unreal Engine 5.8.1)

> Árbitro das decisões de design: em dúvida, siga o que está aqui. Mantenha curto.

## O jogo
- Gênero:
- Plataforma: (PC / console / celular)
- Ideia em 1 frase:

## Projeto
- Módulo principal (Source/<Nome>):
- O que é C++ e o que é Blueprint:
- Mapas (Content/Maps) e quem cuida de cada um:
- Como o Content/ (binários) chega a cada pessoa: (Diversion / Perforce / Git LFS / zip)

## Decisões já tomadas
-
`;

/** Nome de pasta seguro para um local: sem acento, espaço ou símbolo (vira o nome do projeto Rojo). */
export function placeFolder(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "") || "Local";
}

const robloxProject = (name: string) =>
  JSON.stringify(
    {
      name,
      tree: {
        $className: "DataModel",
        ReplicatedStorage: { $path: "src/shared", $ignoreUnknownInstances: true },
        ServerScriptService: { $path: "src/server", $ignoreUnknownInstances: true },
        StarterPlayer: { StarterPlayerScripts: { $path: "src/client", $ignoreUnknownInstances: true } },
      },
    },
    null,
    2,
  ) + "\n";

/** Arquivos de um local novo (um projeto Rojo na pasta `<folder>/`). */
export function placeTemplates(folder: string): [path: string, text: string][] {
  const hi = (side: string) => `print(${JSON.stringify(`[${folder}] ${side} pronto`)})\n`;
  return [
    [`${folder}/default.project.json`, robloxProject(folder)],
    [`${folder}/src/server/Main.server.luau`, hi("servidor")],
    [`${folder}/src/client/Main.client.luau`, hi("cliente")],
    [`${folder}/src/shared/Config.luau`, "return {}\n"],
  ];
}

/** Arquivos que a sala nova ganha, conforme o tipo (undefined = HTML5, as salas antigas). */
export function roomTemplates(kind: string | undefined, roomName: string): [path: string, text: string][] {
  if (kind === "roblox") {
    return [
      ["CLAUDE.md", ROOM_CLAUDE_MD_ROBLOX],
      ["GAME.md", ROOM_GAME_MD_ROBLOX],
      ["MODELOS.md", ROOM_MODELOS_MD],
      ...placeTemplates(placeFolder(roomName)),
    ];
  }
  if (kind === "unreal") {
    return [
      ["CLAUDE.md", ROOM_CLAUDE_MD_UNREAL],
      ["GAME.md", ROOM_GAME_MD_UNREAL],
      ["MODELOS.md", ROOM_MODELOS_MD],
    ];
  }
  return [
    ["CLAUDE.md", ROOM_CLAUDE_MD],
    ["GAME.md", ROOM_GAME_MD],
    ["MODELOS.md", ROOM_MODELOS_MD],
  ];
}
