import type { GameDefinition } from "../engine.js";
import { ReversiEngine } from "./engine.js";

export const reversiGame: GameDefinition = {
  id: "reversi",
  title: "Reversi",
  // slug defaults to id ("reversi") — already a kebab-case lobby slug.
  createEngine: (host) => new ReversiEngine(host),
};
