# streamlockfun-minigame

Reference mini-game built on [`@streamlock/operator-sdk`](https://github.com/0xNike/streamlockfun/tree/main/packages/operator-sdk).

This repo exists to be the receipt that the Streamlock Operator SDK is a real third-party integration boundary: it consumes only `@streamlock/operator-sdk` and `@solana/web3.js`. **Zero imports from the streamlockfun monorepo.** If you can build a game with this, you can build one without ever touching Streamlock's internals.

The current game is best-of-three Rock-Paper-Scissors, played off-chain in `src/game.ts`. Replace it with whatever your actual game is.

---

## Architecture

```
[matchmaker]  →  [src/main.ts]  →  [@streamlock/operator-sdk]  →  /v1/operator/*
                       ↓                                              ↓
                  [src/game.ts]                                 Solana mainnet
                  (off-chain RPS)                              (entitlement ledger)
```

`src/operator.ts` constructs the `StreamlockOperator` client from env vars.
`src/game.ts` is pure off-chain game logic — no Streamlock awareness.
`src/main.ts` orchestrates a single match end-to-end (discover → session → play → submit → finalize).

A production version would live behind an HTTP + WSS server, persist session state in its own DB, run matchmaking, and subscribe to `op.stream.on("stream.unlocked", ...)` for proactive settlement. None of that is here yet — this is the smallest thing that proves the boundary holds.

## Setup

### 1. Install

```bash
npm install
```

The SDK is currently consumed via `file:../streamlockfun/packages/operator-sdk`. Once `@streamlock/operator-sdk` is published to npm, swap that line in `package.json` for the registry version.

### 2. Get an operator API key

Email [streamlockfun@gmail.com](mailto:streamlockfun@gmail.com) or ping [@hao_ssh](https://t.me/hao_ssh) on Telegram. You'll receive an `sk_<base64url>` key. The same key works on devnet and mainnet — pick the cluster via `STREAMLOCK_CHAIN`.

### 3. Generate an operator Solana keypair

```bash
solana-keygen new -o ./operator.json --no-bip39-passphrase
SOLANA_KEYPAIR_B64=$(cat ./operator.json | python3 -c 'import json,sys,base64; print(base64.b64encode(bytes(json.load(sys.stdin))).decode())')
echo "OPERATOR_SECRET_KEY_B64=$SOLANA_KEYPAIR_B64"
```

Fund it with ~0.5 SOL working balance (per-match cost ~0.05 SOL, mostly refundable PDA rent).

> Keep `operator.json` outside this repo's tree, or `.gitignore` it explicitly. **Never commit a keypair.**

### 4. Configure env

```bash
cp .env.example .env
# fill in STREAMLOCK_OPERATOR_KEY, OPERATOR_SECRET_KEY_B64, GAME_TOKEN_MINT
```

For the first run, point `STREAMLOCK_CHAIN=soldev` and a devnet token mint that already has ≥2 streams.

### 5. Run a match

```bash
npm run match
```

You should see:
```
[match] operator: <pubkey>
[match] sdk config: {"apiKey":"sk_AbCdEfG…","chain":"soldev",…}
[match] paired <holder1>… vs <holder2>…
[match] creating session…
[match]   pda=<sessionPda>
[match]   sig=<txSig>
[match] off-chain: 3-round match → winner=p2
[match]   r vs p=p2  s vs r=p1  p vs r=p1  …
[match] submitting deltas (loser <…>… -1000, winner <…>… +1000)
[match] waiting 60s dispute window…
[match] finalizing + applying deltas…
[match]   finalize sigs: <sig>
[match]   apply sigs:    <sig>,<sig>
[match] ✅ done
```

Verify the bps shift: open `https://www.streamlock.fun/<chain>/<mint>` and confirm the holder rows for the loser's stream changed by ±1000 bps.

## Going to mainnet

Once a devnet match runs end-to-end:

1. Set `STREAMLOCK_CHAIN=mainnet` and `SOLANA_RPC_URL=<paid mainnet RPC>` in `.env`.
2. Set `GAME_TOKEN_MINT=<your mainnet token mint>`.
3. Top up the operator wallet to ~0.5 SOL on mainnet.
4. Run `npm run match` once with low stakes (start at `STAKE_BPS=100` not 1000) and verify on-chain.

## Reference

- **Operator + SDK guide:** [`docs/guides/OPERATOR_GUIDE.md`](https://github.com/0xNike/streamlockfun/blob/main/docs/guides/OPERATOR_GUIDE.md) in the streamlockfun repo (or [Gitbook](https://docs.streamlock.fun/developers/operator-guide) when synced).
- **OpenAPI 3.1 schema:** `https://www.streamlock.fun/v1/openapi.json`.
- **Reference operator (poker):** [`packages/operator-sdk/examples/poker-operator.ts`](https://github.com/0xNike/streamlockfun/blob/main/packages/operator-sdk/examples/poker-operator.ts).

## License

MIT
