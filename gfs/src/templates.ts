// Arquivos que toda sala recebe. Curtos de propósito: o Claude Code lê o CLAUDE.md
// em toda conversa, então cada linha aqui custa token em toda tarefa.
// (Mantenha igual a app/src/sync/templates.ts.)

// Linha da regra de ideias/bugs sobre imagens (o app também a acrescenta em salas que já têm a regra sem ela).
export const IMG_RULE = "- Item com `🖼 .gfs/bugs/x.jpg`: veja a imagem (Read) como referência; ela some sozinha quando você apagar o item.\n";

export const ROOM_CLAUDE_MD = `# Sala do GameForge Sync — regras para o Claude

Esta pasta é uma sala compartilhada: outras pessoas e os Claudes delas editam este jogo AO MESMO TEMPO.
Com o app GameForge Sync aberto, a pasta sincroniza sozinha: o que você salva aparece para todos em segundos,
e o que os outros mudam aparece aqui. Não precisa rodar nenhum comando.

## Ideias e bugs (OBRIGATÓRIO)
- No começo de TODA tarefa, leia IDEIAS_E_BUGS.md (lista que os testadores mandam pelo app). Se tiver itens, trate-os junto com o pedido.
- Quando um item estiver feito e conferido, APAGUE a linha dele do arquivo (não marque, apague). O que não resolveu fica.
${IMG_RULE}
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
