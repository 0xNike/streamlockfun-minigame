/**
 * End-to-end demo of the operator server.
 *
 * Drives the full lifecycle against a running `npm run server`:
 *   1. Discover two eligible streams via op.tokens.streams() — same flow
 *      `npm run match` uses, so we automatically pick up your devnet test
 *      streams (e.g. fJ9KSsCQ… / B1Ay87xx…).
 *   2. POST /api/matches as player A.
 *   3. POST /api/matches/:id/join as player B.
 *   4. Both connect over WSS.
 *   5. Each side sends a deterministic move per round (A:rock, B:scissors → A wins).
 *   6. Wait through dispute window + apply, capture `done` frame, print sigs.
 *
 * Prereqs in another terminal:
 *   - streamlockfun backend on :3000
 *   - npm run server (this repo) on :8787
 *   - .env.local populated
 *
 * Run:
 *   npx tsx scripts/e2e_demo.ts
 *
 * Wall-clock: ~3 minutes (round play + 120s dispute window + 30s buffer).
 */

import WebSocket from "ws";
import { op, GAME_TOKEN_MINT } from "../src/operator.js";

const SERVER = "http://127.0.0.1:8787";
const WS = "ws://127.0.0.1:8787";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = () =>
  new Date().toISOString().replace("T", " ").replace("Z", "").slice(11, 23);
const log = (tag: string, ...rest: unknown[]) =>
  console.log(`[${stamp()}] [${tag}]`, ...rest);

async function postJson<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${SERVER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
}

interface PlayerCtx {
  side: "a" | "b";
  ws: WebSocket;
  done: Promise<void>;
  resolveDone: () => void;
  failed: string | null;
  movePlan: Map<number, "rock" | "paper" | "scissors">;
}

function attachWs(matchId: string, side: "a" | "b", movePlan: Map<number, "rock" | "paper" | "scissors">): PlayerCtx {
  const ws = new WebSocket(`${WS}/ws/match/${matchId}?as=${side}`);
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const ctx: PlayerCtx = { side, ws, done, resolveDone, failed: null, movePlan };

  ws.on("open", () => log(`${side}.ws`, "open"));
  ws.on("error", (e: Error) => log(`${side}.ws`, "error", e.message));
  ws.on("close", (c: number) => log(`${side}.ws`, "close", c));

  ws.on("message", (raw: Buffer) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    switch (f.type) {
      case "hello":
        log(`${side}.frame`, "hello", "you=" + f.you, "state=" + f.snapshot.state);
        break;
      case "state":
        log(`${side}.frame`, "state", f.state, "(" + f.reason + ")");
        break;
      case "peer_status":
        log(`${side}.frame`, "peer_status", f.peer, f.connected ? "connected" : "disconnected");
        break;
      case "round_start": {
        const move = movePlan.get(f.round) ?? "rock";
        log(`${side}.frame`, "round_start", "round=" + f.round, "deadline=" + f.deadline, "→ playing " + move);
        ws.send(JSON.stringify({ type: "move", round: f.round, move }));
        break;
      }
      case "round_result":
        log(`${side}.frame`, "round_result", "round=" + f.round, "you=" + f.yourMove, "them=" + f.theirMove, "winner=" + f.winner);
        break;
      case "match_result":
        log(`${side}.frame`, "match_result", "winner=" + f.winner);
        break;
      case "tx":
        log(`${side}.frame`, "tx", f.kind, "attempt=" + f.attempt, f.status, f.sig?.slice(0, 12) ?? f.error?.slice(0, 80) ?? "");
        break;
      case "done":
        log(`${side}.frame`, "done", "winner=" + f.winner, "sigs=" + f.finalSignatures.length);
        for (const link of f.explorerLinks) log(`${side}.link`, link);
        resolveDone();
        break;
      case "cancelled":
        log(`${side}.frame`, "cancelled", "reason=" + f.reason);
        resolveDone();
        break;
      case "failed":
        ctx.failed = f.reason;
        log(`${side}.frame`, "failed", f.reason);
        resolveDone();
        break;
      case "error":
        log(`${side}.frame`, "error", f.code, f.message);
        if (f.fatal) {
          ctx.failed = `${f.code}: ${f.message}`;
          resolveDone();
        }
        break;
      default:
        log(`${side}.frame`, f.type, JSON.stringify(f).slice(0, 120));
    }
  });

  return ctx;
}

async function main() {
  log("init", "discovering eligible streams on", GAME_TOKEN_MINT.slice(0, 8) + "…");
  const { streams } = await op.tokens.streams(GAME_TOKEN_MINT);
  const eligible = (streams as Array<{ holder: string; streamId: string; settled?: boolean; closed?: boolean }>).filter(
    (s) => !s.settled && !s.closed,
  );
  if (eligible.length < 2) {
    console.error(`only ${eligible.length} eligible stream(s) — need 2`);
    process.exit(1);
  }
  const a = eligible[0];
  const b = eligible[1];
  log("init", `A: ${a.holder.slice(0, 8)}… stream ${a.streamId.slice(0, 8)}…`);
  log("init", `B: ${b.holder.slice(0, 8)}… stream ${b.streamId.slice(0, 8)}…`);

  // Plan: A plays rock every round, B plays scissors → A wins 2-0.
  const planA = new Map<number, "rock" | "paper" | "scissors">([
    [0, "rock"],
    [1, "rock"],
    [2, "rock"],
    [3, "rock"],
    [4, "rock"],
  ]);
  const planB = new Map<number, "rock" | "paper" | "scissors">([
    [0, "scissors"],
    [1, "scissors"],
    [2, "scissors"],
    [3, "scissors"],
    [4, "scissors"],
  ]);

  log("http", "POST /api/matches");
  const create = await postJson<{ matchId: string; matchUrl: string; wsUrl: string }>("/api/matches", {
    wallet: a.holder,
    streamId: a.streamId,
  });
  if (create.status !== 201) {
    console.error("create failed", create);
    process.exit(1);
  }
  log("http", "matchId=" + create.body.matchId);
  log("http", "URL=" + create.body.matchUrl);

  const ctxA = attachWs(create.body.matchId, "a", planA);
  await sleep(500);

  log("http", "POST /api/matches/:id/join (B)");
  const join = await postJson("/api/matches/" + create.body.matchId + "/join", {
    wallet: b.holder,
    streamId: b.streamId,
  });
  if (join.status !== 200) {
    console.error("join failed", join);
    process.exit(1);
  }
  log("http", "B joined");

  const ctxB = attachWs(create.body.matchId, "b", planB);

  await Promise.all([ctxA.done, ctxB.done]);
  ctxA.ws.close();
  ctxB.ws.close();

  if (ctxA.failed || ctxB.failed) {
    log("end", "FAILED", ctxA.failed ?? ctxB.failed);
    process.exit(1);
  }
  log("end", "✅ both clients reached terminal state cleanly");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
