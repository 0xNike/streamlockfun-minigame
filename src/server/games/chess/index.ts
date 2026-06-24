import type { GameDefinition } from "../engine.js";
import { ChessEngine } from "./engine.js";

export const chessGame: GameDefinition = {
  id: "chess",
  title: "Chess",
  createEngine: (host) => new ChessEngine(host),
};
