/**
 * Pure off-chain Rock-Paper-Scissors logic.
 *
 * No Streamlock imports here on purpose — game rules and on-chain settlement
 * are kept separate. Replace this file with whatever your actual game is.
 */

export type Move = "rock" | "paper" | "scissors";
export type RoundResult = "p1" | "p2" | "tie";
export type MatchResult = { winner: "p1" | "p2" | "tie"; rounds: { p1: Move; p2: Move; result: RoundResult }[] };

const MOVES: Move[] = ["rock", "paper", "scissors"];

function randomMove(): Move {
  return MOVES[Math.floor(Math.random() * 3)];
}

function judgeRound(p1: Move, p2: Move): RoundResult {
  if (p1 === p2) return "tie";
  if (
    (p1 === "rock" && p2 === "scissors") ||
    (p1 === "paper" && p2 === "rock") ||
    (p1 === "scissors" && p2 === "paper")
  ) return "p1";
  return "p2";
}

/** Best-of-three RPS, deterministic interface, random implementation for the demo. */
export function playBestOfThree(): MatchResult {
  const rounds: MatchResult["rounds"] = [];
  let p1Wins = 0;
  let p2Wins = 0;

  while (p1Wins < 2 && p2Wins < 2 && rounds.length < 5) {
    const p1 = randomMove();
    const p2 = randomMove();
    const result = judgeRound(p1, p2);
    rounds.push({ p1, p2, result });
    if (result === "p1") p1Wins += 1;
    if (result === "p2") p2Wins += 1;
  }

  const winner: MatchResult["winner"] = p1Wins > p2Wins ? "p1" : p2Wins > p1Wins ? "p2" : "tie";
  return { winner, rounds };
}
