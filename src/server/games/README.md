# Adding a game

This repo is a games platform: a shared **shell** plus per-game **modules**. The
shell owns everything game-agnostic — matchmaking, the on-chain session,
settlement, sockets, World ID, the wager math, snapshots, crash recovery. A game
module owns only *play*: the bit between "the session is active" and "we have a
winner".

Adding a game touches four places and nothing in the shell.

## 1. Backend engine — `src/server/games/<id>/`

Implement [`GameEngine`](./engine.ts). The shell drives it; it talks back only
through the `GameHost` it's handed at construction.

```
src/server/games/<id>/
  engine.ts    # class <Id>Engine implements GameEngine
  rules.ts     # pure, deterministic game logic (optional, but keep it pure)
  index.ts     # export const <id>Game: GameDefinition = { id, title, createEngine }
```

The contract (see [`engine.ts`](./engine.ts) for the full signatures):

| Shell → engine | when |
| --- | --- |
| `start()` | once, after the on-chain session is created and state is `active` |
| `handleFrame(side, frame)` | each gameplay client frame (the shell already handled `pong`/`leave`/`request_resync`) |
| `resync(side)` | a socket (re)connected — re-push any phase state it may have missed |
| `destroy()` | match torn down — clear all timers (must be idempotent) |
| `progress()` | the shell needs `{ roundIndex, rounds }` for a snapshot |

| Engine → shell (`GameHost`) | use |
| --- | --- |
| `broadcast` / `sendTo` / `sendError` | wire frames out (these already guard socket readiness) |
| `now()` / `isActive()` | the shell's clock; `isActive()` is true only while playable |
| `onComplete(winner, rounds)` | **call once** when play resolves — the shell broadcasts `match_result` and runs settlement |
| `log`, `matchId`, `socketFor(side)` | logging, persistence keys, direct socket access |

Rules of the road:

- **Never settle or transition match state from the engine.** Produce a winner,
  call `onComplete`, done. Settlement, ties, cancels and the on-chain sequence
  are the shell's job.
- **Own your timers.** Arm them in play, clear them all in `destroy()`. The shell
  calls `destroy()` on cleanup; guard every timer callback with `isActive()`.
- **Keep `rules.ts` pure and deterministic** (no clock, no I/O) so it's trivially
  testable and auditable — see [`rps/rules.ts`](./rps/rules.ts).
- The wire contract lives in [`../types.ts`](../types.ts): `ServerFrame`,
  `ClientFrame`, `ErrorCode`. A new game with frames RPS doesn't have (different
  moves, a board, real-time ticks) adds them there. Today that union is
  RPS-shaped; namespace per-game frames when it starts to crowd.

[`rps/`](./rps/) is the reference implementation: a commit-reveal best-of-three
round loop in ~330 lines.

## 2. Register it — `src/server/games/registry.ts`

```ts
import { myGame } from "./my-game/index.js";

export const GAMES: Record<string, GameDefinition> = {
  [rpsGame.id]: rpsGame,
  [myGame.id]: myGame,
};
```

A match carries a `gameId` (defaults to `rps`); `createLiveMatch({ gameId })`
looks the definition up and builds the engine. `gameId` is **in-memory only**
today — persist it (a DB column) once there's a second game, so crash recovery
can rebuild the right engine.

## 3. Frontend module — `web/src/games/<id>/`

```
web/src/games/<id>/
  <Page>.tsx          # the game's screen(s)
  components/         # game-specific UI
```

Pull shared platform code from `web/src/shared/` (wallet, World ID, api, ws,
crypto, types, format). Reusable staking/settlement UI currently lives under
`web/src/games/rps/components/` (StreamPicker, Wager, WagerInput, StakeMath,
PredictedWager, SettlementProgress) — promote what you need into a
`web/src/shared/components/` rather than copying it.

Add the route in [`web/src/App.tsx`](../../../web/src/App.tsx):

```tsx
<Route path="/my-game" element={<div className="game-view"><MyGame /></div>} />
```

Follow the **in-house game design contract** in the top-level
[`README.md`](../../../README.md) so the page reads as one product with the hub
(shared shell + header, the emerald accent, the win/loss/tie tokens).

## 4. List it in the hub — `web/src/hub/Explore.tsx`

Add one entry to the `GAMES` array (the single source of truth for the grid):

```ts
{
  slug: "my-game",
  name: "My Game",
  tagline: "One line that sells it",
  description: "A sentence or two, plain language — no crypto jargon.",
  operator: "Streamlock Labs",   // or the third-party operator's name
  href: "/my-game",              // internal route, or a full URL for external games
  tags: ["1v1", "Quick"],
  status: "live",                // "live" | "beta" | "coming-soon"
  verified: true,                // true ONLY for games Streamlock has reviewed
}
```

Only `status !== "coming-soon"` games with an `href` render as playable.

---

That's it. If you find yourself editing `matches.ts`, `settlement.ts`, `ws.ts`,
or `wager.ts` to add a game, stop — that logic belongs behind the `GameHost`
seam, not in the shell.
