/**
 * Game registry: the single place that knows which games exist.
 *
 * Add a game = implement GameEngine/GameDefinition under games/<id>/ and add it
 * here. Matches carry a `gameId` (default `rps`); the shell looks the definition
 * up to build the right engine. `gameId` is in-memory only today — persisting it
 * for crash recovery is a follow-up once a second game exists.
 */

import { chessGame } from "./chess/index.js";
import type { GameDefinition } from "./engine.js";
import { reversiGame } from "./reversi/index.js";
import { rpsGame } from "./rps/index.js";

export const DEFAULT_GAME_ID = "rps";

export const GAMES: Record<string, GameDefinition> = {
  [rpsGame.id]: rpsGame,
  [reversiGame.id]: reversiGame,
  [chessGame.id]: chessGame,
};

export function getGame(id: string): GameDefinition {
  const game = GAMES[id];
  if (!game) throw new Error(`unknown game: ${id}`);
  return game;
}
