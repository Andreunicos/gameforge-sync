// Arquivos que toda sala recebe. Curtos de propósito: o Claude Code lê o CLAUDE.md
// em toda conversa, então cada linha aqui custa token em toda tarefa.

export const ROOM_CLAUDE_MD = `# Sala do GameForge Sync — regras para o Claude

Outras pessoas e os Claudes delas editam este jogo AO MESMO TEMPO, pelo app e pelo \`gfs\`.

## Toda tarefa
1. \`gfs status\` antes de começar. Se mostrar mudanças, \`gfs pull\`.
2. Mexa só no necessário. Ache o trecho com busca e leia só ele (não leia arquivos inteiros à toa).
3. Ao terminar: \`gfs push "o que você fez, em 1 linha"\`.
4. Conflito no push: resolva só o trecho mostrado (marcadores <<<<<<< ======= >>>>>>>) e rode \`gfs push\` de novo.

## Nunca
- Desfazer ou reescrever código de outra pessoa sem perguntar.
- Apagar arquivos (peça ao dono da sala).
- Mexer em arquivos fora do que foi pedido.

## Saber mais
- Visão do jogo e decisões: GAME.md (leia só quando a tarefa depender de design).
- Imagens e sons NÃO ficam na sala: estão no repositório do jogo no GitHub.
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
