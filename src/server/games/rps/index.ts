import type { GameDefinition } from "../engine.js";
import { RpsEngine } from "./engine.js";

export const rpsGame: GameDefinition = {
  id: "rps",
  title: "Rock Paper Scissors",
  createEngine: (host) => new RpsEngine(host),
};
