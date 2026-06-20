# Streamlock Games

The games platform behind [`games.streamlock.fun`](https://games.streamlock.fun) — a games hub plus the games themselves, built on [`@streamlock/operator-sdk`](https://github.com/0xNike/streamlockfun/tree/main/packages/operator-sdk).

This repo is also the receipt that the Streamlock Operator SDK is a real third-party integration boundary: it consumes only `@streamlock/operator-sdk` and `@solana/web3.js`. **Zero imports from the streamlockfun monorepo.** If you can build a game with this, you can build one without ever touching Streamlock's internals.

The first game is best-of-three Rock-Paper-Scissors with commit-reveal, World ID sybil gating, and amount-based wagering. Live at [games.streamlock.fun](https://games.streamlock.fun) — the hub at `/`, RPS at `/rps` — talking to [streamlockfun-minigame.fly.dev](https://streamlockfun-minigame.fly.dev) (operator).

---

## Gameplay

**Stakes are real but bounded.** Each player wagers an amount of the game token (`$TICKET` in the live deployment). The token is *streamed*, not held — it lives in a Streamlock entitlement ledger, which means winning shifts the loser's stream by some bps (basis points) toward the winner. No transfers, no approvals, no token accounts to set up; it's a single on-chain settlement at the end of the match.

**A match flow:**

1. **Create.** Player A connects their wallet, picks one of their streams on the token, sets a wager amount and (optionally) toggles "Verified humans only" to require World ID. A shareable match URL is generated.
2. **Join.** Player B visits the URL, connects a wallet, picks their stream. If verified-only is on, they're routed through World ID first (staging = simulator app; production = real World App orb-or-phone verification). A shared match snapshot is locked in: `min(lockedA, lockedB)` × stakeBps caps the prize so neither side can over-promise.
3. **Play.** Best-of-three RPS over a WebSocket. Each round has two phases (defaults; configurable in `src/server/config.ts`):
   - **Commit (45s):** each browser hashes `sha256(move:nonce)` and sends the hash. Neither the operator nor your opponent learns your move.
   - **Reveal (15s):** once both commits are in, the operator broadcasts `commits_locked` and both clients auto-reveal `(move, nonce)`. The operator verifies each reveal matches its prior commit before judging.
   
   A missing/late commit forfeits that round to the other side. A reveal whose hash doesn't match the earlier commit is treated as a forfeit (and logged as a cheat attempt — the commit hash is in the DB). A green/red flash gives the winner/loser of each round quick feedback.
4. **Settle.** After three rounds, the operator computes the winner, picks the bps-shift for the actual outcome (the wager snapshot stores per-outcome bps so settlement never re-derives from drifted live data), and runs the on-chain sequence: `submit deltas → wait dispute window → finalize → apply`. The dispute window defaults to 30s on Fly (`fly.toml`). Players see each transaction with a live "pending → confirmed" tag and a Solscan link.

**Anti-grief and anti-cheat properties this gets you for free:**

- *Move secrecy.* Commit-reveal means the operator can't peek at your move and tell your opponent (or front-run a settlement). It's verifiable client-side: the commit hash is broadcast to both players before either reveals.
- *No double-spend.* Stakes are bounded by `min(lockedA, lockedB)` and locked into a session PDA at match start; the only outcomes are "loser's bps → winner" or "cancel and walk away" (on ties or operator-side failures).
- *Sybil resistance.* `verifiedOnly` matches reject the same World ID nullifier on both sides, so one human can't farm both seats.
- *Crash recovery.* The operator state machine is in-process, but every transition writes a SQLite row. On restart, the reconciler marks abandoned mid-flight matches `failed` so neither party is left holding an active PDA forever.
- *Dispute window.* Every settlement has a (configurable, default 30s mainnet) window where deltas are *submitted* but not yet *applied* — gives an out-of-band dispute path if the chain ever needs one. The operator only calls `apply` after the window elapses.

## Architecture

```
                   ┌──────────────────────────┐
   Browser ──WSS── │  src/server/  (Fastify)  │ ──── @streamlock/operator-sdk ───▶ /v1/operator/*
   (web/, React)   │  - matches.ts  state mc  │                                          │
                   │  - rps.ts      commit-rev│                                          ▼
                   │  - settlement  retry/log │                                  Solana mainnet
                   │  - reconciler  crash rec │                                  (entitlement ledger)
                   │  - SQLite (better-sqlite3)│
                   └──────────────────────────┘
```

**Two entry points:**

- `src/main.ts` (`npm run match`) — single-match demo orchestrator. Discovers two streams, runs RPS in `src/game.ts`, settles. Useful as a smoke test and as a 200-line proof of the SDK boundary.
- `src/server/` (`npm run server` / `npm start`) — production operator: Fastify HTTP + WSS, SQLite-backed match registry, commit-reveal RPS, settlement state machine with retries, crash reconciler, World ID gate. This is what runs on Fly.

**Web frontend** lives in `web/` (React + Vite, Privy wallet, World ID IDKit). On Vercel it ships as a static SPA at `games.streamlock.fun`: the **games hub** at `/`, RPS at `/rps`, and match views at `/match/:id`. `/api/*` rewrites to the Fly operator (see `vercel.json`).

**Adding a game.** Games are self-contained modules around a shared shell: the backend exposes a `GameEngine` seam (`src/server/games/`) and the frontend a `games/<id>/` folder, with the hub driven by the `GAMES` array in `web/src/hub/Explore.tsx`. Full step-by-step in [`src/server/games/README.md`](src/server/games/README.md).

**In-house game design contract.** Every in-house game page must read as one continuous product with the hub, so the shell never shifts between routes:

- *Shell.* Render inside the shared `App` header + 760px `.app` column. Don't ship a per-game header — there is one universal bar.
- *Surface & accent.* Black background, `zinc-900` panels (`--panel`) with `zinc-700` borders (`--border`), and **orange** (`--accent`, `#F97316`) as the only interactive accent — matching the header's "Games" pill and the hub's CTAs. Orange is the Games identity, deliberately distinct from the parent app's green. Primary buttons are orange with **dark** text (`#1a0d02`), never white.
- *Semantics.* Win = `--green`, loss = `--red`, tie/settling = `--info` (cool blue — the calm "wait/neutral" lane). `--amber` is reserved for urgency only (low-time countdown, anti-cheat hold, cancel). Reuse these tokens instead of introducing new hues.

The palette lives in `web/src/styles.css` `:root`. A new game that styles with these tokens (or the hub's Tailwind `zinc`/`orange` utilities) inherits the look for free — keep them as the single source of truth rather than hard-coding colors per game.

## Setup

### 1. Install

```bash
npm install        # operator (root)
cd web && npm install && cd ..   # web client
```

`@streamlock/operator-sdk` is consumed via the bundled tarball at `vendor/streamlock-operator-sdk-0.1.4.tgz`. A `postinstall` script (`scripts/patch-sdk.mjs`) applies in-tree patches — no manual step required.

### 2. Get an operator API key

Email [streamlockfun@gmail.com](mailto:streamlockfun@gmail.com) or ping [@hao_ssh](https://t.me/hao_ssh) on Telegram. You'll receive an `sk_<base64url>` key. The same key works on devnet and mainnet — pick the cluster via `STREAMLOCK_CHAIN`.

### 3. Generate an operator Solana keypair

```bash
solana-keygen new -o ./operator.json --no-bip39-passphrase
SOLANA_KEYPAIR_B64=$(cat ./operator.json | python3 -c 'import json,sys,base64; print(base64.b64encode(bytes(json.load(sys.stdin))).decode())')
echo "OPERATOR_SECRET_KEY_B64=$SOLANA_KEYPAIR_B64"
```

Fund it with ~0.5 SOL working balance. Per-match rent is ~0.05 SOL across two PDAs (session + results); rent is reclaimed when `finalizeAndApply` or `cancel` closes them, so steady-state cost is dominated by transaction fees. Lamports are *float* during a match's dispute window — size the balance for your peak concurrent matches, not your lifetime volume.

> Keep `operator.json` outside this repo's tree, or `.gitignore` it explicitly. **Never commit a keypair.**

### 4. Configure env

```bash
cp .env.example .env.local
# fill in STREAMLOCK_OPERATOR_KEY, OPERATOR_SECRET_KEY_B64, GAME_TOKEN_MINT,
# SOLANA_RPC_URL, WORLD_* (optional, only if running verified-only matches)
```

`STREAMLOCK_CHAIN` accepts `soldev` (devnet) or `sol` (mainnet). For the first run, point at devnet with a token mint that already has ≥2 streams.

> **Broadcast RPC must be at tip.** `SOLANA_RPC_URL` is the operator's *broadcast* endpoint — the SDK's `signAndSend` signs and sends every settlement tx through it, with **no failover**. If that node falls behind the cluster tip (a stale/desynced endpoint), preflight rejects *every* tx with `Transaction simulation failed: Blockhash not found` — even a healthy finalized blockhash references slots the lagging node hasn't reached yet. Use a dedicated node (Chainstack, a fresh Helius endpoint, or your own) — **not** a flaky/free endpoint that can lose sync. To diagnose, compare slots:
>
> ```bash
> # both should be within a few slots of each other
> curl -s "$SOLANA_RPC_URL" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}' -H content-type:application/json
> curl -s https://api.devnet.solana.com -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}' -H content-type:application/json
> ```
>
> A gap of thousands of slots means your endpoint is stale — rotate `SOLANA_RPC_URL` to a healthy node and restart the operator. (This is separate from the *build-side* RPC, which lives on the Streamlock API and is already failover-wrapped.)

### 5. Run the single-match demo

```bash
npm run match
```

Picks the first two streams on `GAME_TOKEN_MINT`, plays one off-chain best-of-three, and settles on-chain. Verify on `https://www.streamlock.fun/<chain>/<mint>` — the loser's stream rows should shift by ±1000 bps.

### 6. Run the full operator + web app locally

```bash
# terminal 1 — operator (Fastify on :8787)
npm run server

# terminal 2 — web client (Vite on :5173, proxies /api to :8787)
cd web && npm run dev
```

Open http://localhost:5173. Wallet-connect, create a match, share the URL with a second wallet to join. The match plays in-browser via WSS to the operator.

## Going to mainnet

After a devnet match runs end-to-end:

1. Set `STREAMLOCK_CHAIN=sol` and `SOLANA_RPC_URL=<paid mainnet RPC>` in your env.
2. Set `GAME_TOKEN_MINT=<your mainnet token mint>`.
3. Top up the operator wallet to **at least 0.5 SOL** on mainnet. The wallet pays rent for every concurrent in-flight match; under-funding it surfaces as `Transaction simulation failed: Attempt to debit an account but found no record of a prior credit` (cold wallet) or `insufficient lamports` (running low).
4. Run a single low-stakes match first and confirm the on-chain ledger shift before opening it up.

## Deployment

- **Operator → Fly.io.** `fly.toml` configures a single always-on machine in `iad` with a persistent volume for the SQLite DB. Match registry and settlement timers are in-process — **do not scale horizontally** without first moving state to Redis/Postgres. Set runtime secrets with `fly secrets set STREAMLOCK_OPERATOR_KEY=… OPERATOR_SECRET_KEY_B64=… …`.
- **Web → Vercel.** `vercel.json` builds `web/`, serves the SPA at `games.streamlock.fun`, and rewrites `/api/*` to the Fly operator. Set `PUBLIC_FRONTEND_ORIGIN=https://games.streamlock.fun` on the Fly side so the operator emits the right CORS headers and `SameSite=None` World ID cookies.

## World ID (optional)

When `verifiedOnly: true` is passed at match-create, joiners must present a valid `wid_session` cookie matching their wallet. Provision the World ID app via the `worldcoin-developer-portal` MCP — it returns the signing key once; store it as `WORLD_SIGNING_KEY`. Set `WORLD_ENVIRONMENT=staging` for the simulator, `production` for the real World App.

## Reference

- **Operator + SDK guide:** [`docs/guides/OPERATOR_GUIDE.md`](https://github.com/0xNike/streamlockfun/blob/main/docs/guides/OPERATOR_GUIDE.md) in the streamlockfun repo (or [Gitbook](https://docs.streamlock.fun/developers/operator-guide) when synced).
- **OpenAPI 3.1 schema:** `https://www.streamlock.fun/v1/openapi.json`.
- **Reference operator (poker):** [`packages/operator-sdk/examples/poker-operator.ts`](https://github.com/0xNike/streamlockfun/blob/main/packages/operator-sdk/examples/poker-operator.ts).

## License

MIT
