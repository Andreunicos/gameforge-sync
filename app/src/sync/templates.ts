// Arquivos que toda sala recebe. Curtos de propósito: o Claude Code lê o CLAUDE.md
// em toda conversa, então cada linha aqui custa token em toda tarefa.
// (Mantenha igual a gfs/src/templates.ts.)

export const ROOM_CLAUDE_MD = `# Sala do GameForge Sync — regras para o Claude

Esta pasta é uma sala compartilhada: outras pessoas e os Claudes delas editam este jogo AO MESMO TEMPO.
Com o app GameForge Sync aberto, a pasta sincroniza sozinha: o que você salva aparece para todos em segundos,
e o que os outros mudam aparece aqui. Não precisa rodar nenhum comando.

## Como trabalhar
- Mexa só no necessário. Ache o trecho com busca e leia só ele (não leia arquivos inteiros à toa).
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
