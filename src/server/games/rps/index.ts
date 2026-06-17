import type { GameDefinition } from "../engine.js";
import { RpsEngine } from "./engine.js";

export const rpsGame: GameDefinition = {
  id: "rps",
  title: "Rock Paper Scissors",
  slug: "rock-paper-scissors", // lobby gameId differs from the internal "rps"
  createEngine: (host) => new RpsEngine(host),
};
