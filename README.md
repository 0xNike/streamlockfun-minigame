# streamlockfun-minigame

Reference mini-game built on [`@streamlock/operator-sdk`](https://github.com/0xNike/streamlockfun/tree/main/packages/operator-sdk).

This repo is the receipt that the Streamlock Operator SDK is a real third-party integration boundary: it consumes only `@streamlock/operator-sdk` and `@solana/web3.js`. **Zero imports from the streamlockfun monorepo.** If you can build a game with this, you can build one without ever touching Streamlock's internals.

The game is best-of-three Rock-Paper-Scissors with commit-reveal, World ID sybil gating, and amount-based wagering. Live at [streamlockfun-minigame.vercel.app](https://streamlockfun-minigame.vercel.app) (frontend) talking to [streamlockfun-minigame.fly.dev](https://streamlockfun-minigame.fly.dev) (operator).

---

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

**Web frontend** lives in `web/` (React + Vite, Solana wallet adapter, World ID IDKit). On Vercel it ships as a static SPA; `/api/*` rewrites to the Fly operator (see `vercel.json`).

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
# WORLD_* (optional, only if running verified-only matches)
```

`STREAMLOCK_CHAIN` accepts `soldev` (devnet) or `sol` (mainnet). For the first run, point at devnet with a token mint that already has ≥2 streams.

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
- **Web → Vercel.** `vercel.json` builds `web/`, serves the SPA, and rewrites `/api/*` to the Fly operator. Set `PUBLIC_FRONTEND_ORIGIN=<vercel-url>` on the Fly side so the operator emits the right CORS headers and `SameSite=None` World ID cookies.

## World ID (optional)

When `verifiedOnly: true` is passed at match-create, joiners must present a valid `wid_session` cookie matching their wallet. Provision the World ID app via the `worldcoin-developer-portal` MCP — it returns the signing key once; store it as `WORLD_SIGNING_KEY`. Set `WORLD_ENVIRONMENT=staging` for the simulator, `production` for the real World App.

## Reference

- **Operator + SDK guide:** [`docs/guides/OPERATOR_GUIDE.md`](https://github.com/0xNike/streamlockfun/blob/main/docs/guides/OPERATOR_GUIDE.md) in the streamlockfun repo (or [Gitbook](https://docs.streamlock.fun/developers/operator-guide) when synced).
- **OpenAPI 3.1 schema:** `https://www.streamlock.fun/v1/openapi.json`.
- **Reference operator (poker):** [`packages/operator-sdk/examples/poker-operator.ts`](https://github.com/0xNike/streamlockfun/blob/main/packages/operator-sdk/examples/poker-operator.ts).

## License

MIT
