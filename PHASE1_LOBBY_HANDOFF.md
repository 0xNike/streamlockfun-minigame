# Handoff: Phase 1 — emit Games Lobby listings from games.streamlock.fun

**Audience:** the agent/dev working in `streamlockfun-games`.
**Date:** 2026-06-17. **Author:** StreamlockFun side (lobby contract + backend owner).

## Why you're here

StreamlockFun is adding a **Games Lobby** to every token page: a per-token list of
joinable/open game sessions showing **player count/slots** and **wager (in token
amount)**, with **Join/View** buttons that just redirect to the game (no wallet
action). Viewing is open to everyone; sessions are created **only on
games.streamlock.fun** — that's the single ingress.

Everything *behind the SDK* is already built and merged on the StreamlockFun side:

- **SDK `op.lobby.*`** (operator-sdk **v0.1.7**) — `create`, `update`, `close`,
  `byToken`, `get`. Off-chain, API-key-authed, **no signer / no transaction**.
- **Operator API** `POST/GET /v1/operator/lobby`, `GET/PATCH /v1/operator/lobby/:id`
  (authed via your existing operator API key).
- **Persistence** in the Fly `mongodb-api` service (`game_lobby_listings`, TTL on
  `expiresAt`).
- **Token-page lobby UI** already reads the listings and renders rows + a
  "Play games with $TICKER" CTA.

**The only thing missing is you calling `op.lobby.*` over the match lifecycle.**
That's Phase 1.

---

## Hard prerequisite: bump the SDK 0.1.4 → 0.1.7  ✅ artifact provided

`op.lobby` **does not exist in 0.1.4**. The StreamlockFun side has **already built
0.1.7 and dropped it in this repo's `vendor/`**: `vendor/streamlock-operator-sdk-0.1.7.tgz`
(verified to contain `dist/lobby.js` and export `op.lobby`). It's NOT on npm — it's an
internal package, so use the vendored tgz.

To adopt it:
```jsonc
// package.json
"@streamlock/operator-sdk": "file:./vendor/streamlock-operator-sdk-0.1.7.tgz"
```
then reinstall. No config/auth change otherwise — `op.lobby.*` uses the **same
`STREAMLOCK_OPERATOR_KEY`** and `StreamlockOperator` instance in `src/operator.ts`.

---

## What to do — lifecycle integration

Use the **matchId as the `listingId`** (stable, idempotent across create→update).
Use the **matchUrl as `gameUrl`** (the Join/View redirect target).

| Match lifecycle event (current code) | Lobby call | Fields |
|---|---|---|
| **Create** — `createLiveMatch()` / `POST /api/matches` (state `partnered`, A seated) | `op.lobby.create({...})` | `listingId=matchId`, `tokenAddress=tokenMint`, **`gameId`/`gameName` from your game registry per match** (NOT hardcoded — see below), `gameUrl=matchUrl`, `playerSlots:2`, `playersJoined:1`, `wagerTokenAmount`, `wagerTokenDecimals`, `wagerTokenSymbol?`, `expiresAt` (see below) |
| **Join** — `joinAsB()` / `POST /api/matches/:id/join` (B seated) | `op.lobby.update(matchId, { playersJoined: 2 })` | bump seats |
| **On-chain session created** — after `op.sessions.create()` returns `gameSessionPda` in `runOnChainCreate`/`createSession` | `op.lobby.update(matchId, { status: "InProgress", gameSessionPda })` | link listing → on-chain session |
| **Settling/finalizing** (your submit→finalize flow) | `op.lobby.update(matchId, { status: "Settling" })` then `"Finalized"` | optional but nice for accurate rows |
| **Done / Finalized** | `op.lobby.close(matchId, "Finalized")` | terminal |
| **Cancel / fail / timeout** (`cancelled`, `failed` states) | `op.lobby.close(matchId, "Cancelled")` | terminal |

All calls are best-effort and **must not block or fail the match flow** — wrap in
try/catch and log. The lobby is a display mirror, not the source of truth for the game.

---

## Field mapping notes (read these — they have gotchas)

- **`wagerTokenAmount`** — u64 **base units, decimal string**. Your amount-based path
  has this as `WagerSnapshot.amountRaw`, but that's only **finalized at B-join**
  (server derives `bpsAtStake × min(locked)` if `wagerAmountRaw` wasn't passed at
  create). The lobby needs an amount at **create** time (WaitingForPlayers row).
  Two options — pick one and tell us:
  1. **Require `wagerAmountRaw` at create** for any match that should appear in the
     lobby (cleanest — the row shows the real wager).
  2. Show an **indicative** amount at create (e.g. `bpsAtStake × A's locked`) and
     `op.lobby.update` the exact `wagerTokenAmount`… *(not currently supported by the
     PATCH contract — it only updates status/playersJoined/gameSessionPda/expiresAt.
     If you need to mutate the wager amount post-create, ping us to extend the
     contract.)*
  Recommendation: **option 1**.
- **`wagerTokenDecimals`** — required so the lobby (open to non-holders) can format
  without a metadata lookup. Not in your config today. Fetch the mint's decimals once
  (RPC `getMint`) or hardcode per `GAME_TOKEN_MINT` (devnet $LOCK = 6). Provide it.
- **`wagerTokenMint`** — defaults to `tokenAddress` server-side; only send if the
  wager token differs from the page token (it doesn't, for now).
- **`expiresAt`** — unix seconds. This drives the **TTL that auto-drops stale open
  matches** from the lobby. Set it to when an unfilled match offer should disappear
  (suggest **now + 15 min**, or your match-offer expiry). Server defaults to +1h if
  omitted — set it explicitly.
- **`status`** values: `WaitingForPlayers | InProgress | Settling | Finalized | Cancelled | Expired`.

---

## The "$ticker" CTA contract

The token page links to **`https://games.streamlock.fun/?token=<mint>`**. Make the
games site **read `?token=<mint>`** and prefill / scope the create-match flow to that
token. This is the assumed contract — if you use a different param or path, tell us so
we fix the CTA on the StreamlockFun side.

⚠️ **Constraint:** the games server today runs on a single `GAME_TOKEN_MINT` env. For
the lobby to be genuinely per-token (and for `?token=` to mean anything), the create
flow needs to accept an arbitrary mint, validate it has live streams
(`op.tokens.streams(mint)`), and pass it through as `tokenMint`. Flag if this is a
bigger lift than expected — it may warrant its own sub-phase.

---

## Out of scope (do NOT do these here)

- **Settlement / entitlement** — unchanged. You already settle via `op.sessions.*`
  (submit/finalize/applyDelta). The lobby never touches on-chain state.
- **Trust boundary** for external game results — explicitly deferred by product.
- **Per-game approval / allowlist** (Phase 4) — handled on the StreamlockFun side; the
  current gate is the operator whitelist (your API key).

## Cross-repo hygiene

Keep this repo a clean **SDK consumer** — no internal StreamlockFun imports (that's the
whole point of the integration boundary). Lobby concerns = listing lifecycle only. If
you need the Operator API or SDK contract changed (e.g. to mutate `wagerTokenAmount`
post-create), raise it with the StreamlockFun side rather than working around it.

## Decisions (locked 2026-06-17)

1. **Wager: require `wagerAmountRaw` at create.** Lobby-eligible matches must specify
   the wager up front so the row shows the real, fixed amount. No backend/PATCH change
   — the current contract (status/playersJoined/gameSessionPda/expiresAt) is enough.
   If `wagerAmountRaw` is absent, either don't list the match or default it before
   calling `op.lobby.create`.
2. **Single-token for v1.** Ship Phase 1 against the existing `GAME_TOKEN_MINT`. The
   `?token=` CTA can still deep-link, but the create flow targets the one configured
   mint for now; arbitrary-mint create is a later sub-phase. Provide
   `wagerTokenDecimals` for that mint (devnet $LOCK = 6).
3. **`?token=` param** is the assumed CTA shape; confirm/adjust when wiring the create page.
4. **`gameId`/`gameName` are registry-driven, not hardcoded** (resolves your two-games
   point). Each listing carries the actual game of that match, sourced from your game
   registry — so Gomoku auto-lists the moment PR #2 merges, with no StreamlockFun-side
   change (the lobby UI renders `gameName` generically; `gameUrl=/match/:id` is already
   game-agnostic via the dispatcher). Use stable kebab-case slugs (`rock-paper-scissors`,
   `gomoku`) — `gameId` is the key the later per-game approval gate (Phase 4) will use.
   In practice v1 = RPS-only until Gomoku merges; that's correct and self-resolving.
5. **Approved to proceed (option 2):** implement Phase 1 in this repo as an isolated,
   best-effort `src/server/lobby.ts` wrapper called from the lifecycle points. **Branch
   Phase 1 off `main`, independent of PR #2** — the hook points (createLiveMatch,
   joinAsB, runOnChainCreate, runSettlement) already exist on `main`, and registry-driven
   `gameId` means you don't need Gomoku merged first. Keep the two merges decoupled so
   Phase 1 isn't blocked on Gomoku's outstanding devnet smoke test.

---

## Games-repo reply (2026-06-19) — Phase 1 built

All four answers landed; thanks. Built and PR'd as **PR #3 (`feat/lobby-listings`, off `main`)**.

- **SDK 0.1.7** — flipped `package.json` to `file:./vendor/streamlock-operator-sdk-0.1.7.tgz`, reinstalled, confirmed `op.lobby` present. The `postinstall` patch is version-agnostic, no issue.
- **Wrapper, as approved (option 2)** — `src/server/lobby.ts`: `createListing` / `updateListing` / `closeListing`, each `try/catch` + fire-and-forget. Never awaited on the match path, never throws into it. Lobby stays a pure display mirror.
- **Lifecycle wiring** (all gated on `lobbyEligible` = wager fixed at create):
  create → `WaitingForPlayers` (`playersJoined:1`); B-join → `playersJoined:2`; on-chain session → `InProgress` + `gameSessionPda`; settling → `Settling`; done → close `Finalized`; tie / fail / abandon → close `Cancelled`.
- **Registry-driven `gameId`/`gameName`** — added `GameDefinition.slug`; RPS → `rock-paper-scissors`, listing name from the definition `title`. Gomoku (`id` already `gomoku`) auto-lists on PR #2 merge, zero changes. `gameUrl = PUBLIC_BASE_URL/match/:id` (same as the create response's `matchUrl`).
- **Decisions honored** — (1) require `wagerAmountRaw` at create; absent → match runs but isn't listed (no fail). (2) single-token v1 vs `GAME_TOKEN_MINT`; `wagerTokenDecimals` from token meta, fallback **6**. 15-min TTL on unfilled listings.
- **Status** — `tsc --noEmit` + `tsc -p .` green. **Not runtime-verified** against the live `/v1/operator/lobby` (needs operator key + the endpoint); best-effort design means a lobby outage degrades to "no row," not a broken match. A devnet run (create → join → fill → finalize, watching rows transition) is the remaining check.

**Not in this PR:** `?token=<mint>` create-page prefill (decision 3) — frontend follow-up; for single-token v1 the create already targets the configured mint. Arbitrary-mint create stays deferred.

**Related, separate track:** wrote `THIRDPARTY_DEVNET_OPERATOR_PROPOSAL.md` into the `streamlockfun` repo — clean third-party devnet onboarding (dedicated `api-devnet` host, per-chain `HOSTED_BASES`, cluster-scoped keys, faucet, npm-published SDK). Awaiting the platform-side reply there. Also noted your standing offer: if decision #1 ever drops and we need PATCH to mutate `wagerTokenAmount`, I'll raise it.
