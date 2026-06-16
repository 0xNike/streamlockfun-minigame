import type { GameDefinition } from "../engine.js";
import { GomokuEngine } from "./engine.js";

export const gomokuGame: GameDefinition = {
  id: "gomoku",
  title: "Gomoku",
  createEngine: (host) => new GomokuEngine(host),
};
