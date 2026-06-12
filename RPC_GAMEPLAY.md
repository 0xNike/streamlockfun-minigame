# Gameplay Rules & Edge Cases

Rock-Paper-Scissors over Streamlock streams. This doc covers the rules players see, the timing knobs operators tune, and every edge case the server handles by design.

> Filename note: the file is named `RPC_GAMEPLAY.md` per request. The game itself is **RPS** (rock-paper-scissors). RPC here is just the filename, not the protocol acronym.

---

## 1. The match, in one paragraph

Two players each commit a stake of the **same absolute token amount** (snapshotted from the smaller side's stream at agreement time). They play **best-of-three rock-paper-scissors** in a commit-reveal flow. Ties extend up to round 5 with a hard cap. The loser's stream is reweighted on-chain — the loser's holder share drops by the agreed amount, the winner's grows by the same. **No tokens move; only the entitlement split changes inside the loser's stream.** A match-level tie cancels the on-chain session and refunds rent.

---

## 2. Match lifecycle

```
queued → partnered → creating → active → complete → submitting → dispute_wait
                                                                  → finalizing → applying → done
                                              → cancelling → cancelled         (tie or abandon)
                                                          → failed             (any error)
```

| State | Meaning | Reachable for |
|---|---|---|
| `queued` | Reserved; not used in current build. | — |
| `partnered` | Match created by A, waiting for B to join. | Either side opens via the share URL. |
| `creating` | B has joined; on-chain session create in flight. | Both sides see "Creating session…" |
| `active` | Round play in progress. | Each round is commit phase → reveal phase. |
| `complete` | Best-of-three decided; settlement queued. | Brief — milliseconds. |
| `submitting` | Operator submits the deltas tx to Streamlock. | UI shows "Locking in result". |
| `dispute_wait` | On-chain anti-cheat window. Big countdown timer in UI. | Settlement is paused server-side. |
| `finalizing` / `applying` | Operator finalizes + applies deltas. | UI shows "Sending payout". |
| `done` | Entitlements applied, payout settled. | **Terminal.** |
| `cancelling` / `cancelled` | Tie or abandon; no entitlements move. | **Terminal.** Rent refunded. |
| `failed` | Operational error (RPC outage, missing config, etc.). | **Terminal.** Possibly recoverable via support. |

---

## 3. Round play (commit-reveal)

Each round has two phases. The protocol prevents either player from seeing the other's move before committing to their own.

### Commit phase

1. Both clients pick a move locally (rock / paper / scissors), generate a random 16-byte nonce, and send the operator only the SHA-256 hash of `${move}:${nonce}` as a `commit` frame.
2. Phase deadline: **`ROUND_DEADLINE_SEC` (default 45s)**.
3. When both commits land, the operator broadcasts `commits_locked` with both hashes.

### Reveal phase

1. On `commits_locked`, each client auto-sends a `reveal` frame with `(move, nonce)`.
2. Operator recomputes `sha256(move:nonce)` and checks it equals the committed hash. Mismatch → that side is added to `failedReveals` and treated as a forfeit.
3. Phase deadline: **`REVEAL_DEADLINE_SEC` (default 15s)**.

### Round resolution

| Both reveal | Side A in running | Side B in running | Result |
|---|---|---|---|
| ✓ valid | — | — | `judgeRound(a, b)` — normal RPS |
| One side reveals | ✓ | ✗ | A wins by walkover; B's move recorded as `null`, `forfeitedBy: "b"` |
| Other reveals | ✗ | ✓ | Symmetric |
| Neither reveals | ✗ | ✗ | Tie, `forfeitedBy: "both"`, both moves `null` |

"In running" means **committed AND not failed-reveal AND not explicitly forfeited.**

### Best-of-three resolution

`decideMatch()` (in `src/server/rps.ts`):
- ≥2 round wins for either side → match winner.
- After 5 rounds: more wins → match winner. Equal wins → match-level tie.
- Otherwise → continue.

So a match goes 3, 4, or 5 rounds — never more.

---

## 4. Wager mechanics

### Amount-based betting (post-2026-05-09)

Wagers are agreed in **absolute token amount**, not percentage. Both players risk the *same number of base units*. The on-chain bps that achieves that is computed per-side and snapshotted at the moment B joins.

```
wagerAmountRaw = min(P1.locked, P2.locked) × stakeBps / 10000      // server default
```

The creator can override with a smaller `wagerAmountRaw` at create time; the server then clamps to `min(locked)` at B-join. The agreed amount becomes the *contract* — settlement reads it from the snapshot, not from live data, so timing drift can't change what was agreed.

Per-side bps precomputed at B-join:

```
bpsIfALoses = ceil(wagerAmountRaw × 10000 / lockedAtMatchTime.a)
bpsIfBLoses = ceil(wagerAmountRaw × 10000 / lockedAtMatchTime.b)
```

Round-up ensures the winner is never under-credited. Loser eats at most 1 base unit of rounding noise. Zero-sum holds.

### Cohort tolerance band

`COHORT_MAX_RATIO` (default 5×) rejects pairings where `max(locked) / min(locked) > ratio`. This prevents whales from grinding minnows for negligible-to-them risk. Enforced at B-join via HTTP 422 with code `COHORT_MISMATCH`.

### Wager floor and cap

| Constraint | Why | Server check |
|---|---|---|
| `amount ≥ ceil(max(lockedA, lockedB) / 10000)` | Below this, at least one side's `bps` rounds to 0 → silent on-chain no-op for that outcome. | `AMOUNT_BELOW_FLOOR` |
| `amount ≤ min(lockedA, lockedB)` | Bps must fit in [1, 10000]; can't risk more than the smaller side's whole position. | `AMOUNT_ABOVE_CAP` |

### Settlement (winner determined → on-chain delta)

Two delta entries inside the **loser's** stream:

```
{ player: loser,  streamId: loser.streamId, deltaBps: -loserBps }
{ player: winner, streamId: loser.streamId, deltaBps: +loserBps }
```

`loserBps` is `wager.bpsIfALoses` or `wager.bpsIfBLoses` from the snapshot, depending on which side lost. **No tokens move** — only the holder share within the loser's stream is reweighted.

### Legacy fallback

If a stream pre-dates `lockedTokenAmount` instrumentation (~2026-04-29), the snapshot can't be materialised and the operator falls back to the symmetric `bpsAtStake` path — both deltas use the same fixed bps, accepting the EV asymmetry. UI shows percent-only copy in that mode.

---

## 5. Edge cases

### A creates a match and the joiner never shows up

- Tab stays open: indefinite. No global "match expires in N minutes" timer.
- Tab closes (or A navigates away): WS disconnect → `RECONNECT_GRACE_SEC` (default 30s) grace → `handleAbandon` fires in `partnered`/`creating` → match marked `failed`.
- Operator redeploy in the meantime: the in-memory registry is wiped, the reconciler at startup marks any non-terminal `partnered`/`creating` row as `failed`.
- Edge: A creates via curl/script and never opens a WS — no abandon trigger fires, the match lives until the next deploy.

### Both players ghost the round

Both miss the commit phase deadline. Round resolves as a tie with `forfeitedBy: "both"`; no move is fabricated. Match continues. If both ghost every round, after 5 rounds `decideMatch` returns a match-level tie → `runSettlement` calls `cancelSession` → no entitlements move, rent refunded. Worst-case duration: `5 × 45s ≈ 3:45`.

### One player ghosts the round

Other side wins the round by walkover. Their move is preserved in the round record (if they revealed); the ghoster's move is `null`. This counts toward best-of-three.

### Player commits but never reveals

After `REVEAL_DEADLINE_SEC` (15s), the missing reveal is timed out. If their counterpart revealed, the counterpart wins by walkover. If both committed but neither revealed, the round is a tie with `forfeitedBy: "both"`.

### Player commits, reveals with a wrong move/nonce

`verifyCommit` fails (hash mismatch). That side is added to `failedReveals` and treated identically to a forfeit. No second-chance reveal — one valid reveal per commit.

### Player closes the tab mid-match

WS disconnect → grace timer (`RECONNECT_GRACE_SEC`, default 30s). If they reconnect within the grace, play resumes from where they left off. If they don't, in `active` state `handleAbandon` declares the *other* side the match winner and runs settlement — they lose the entire wager, not just the current round.

### Operator (Fly machine) redeploys during a match

- Pre-settlement (`partnered`/`creating`/`active`/`complete`) — reconciler marks the row `failed` at next boot. The session PDA on chain is orphaned but inert (no deltas ever submitted). Cleanup script can `cancelSession` to recover rent.
- Settlement-stage (`submitting`/`dispute_wait`/`finalizing`/`applying`) — left in DB for a Phase-3 chain reconciliation pass that doesn't yet exist; manual recovery via `scripts/cleanup.ts` for now.

### Tie game (best-of-three or match-level)

A tie round counts toward the round count but doesn't move the score. After round 5 with equal wins, `decideMatch` returns `winner: "tie"`. `runSettlement` calls `cancelSession`. No entitlements move. UI hero shows "It's a tie. No funds moved. Your match is being cancelled and any setup costs refunded."

### Cohort mismatch at join

If `max(P1.locked, P2.locked) / min(...) > COHORT_MAX_RATIO`, `/api/matches/:id/join` returns HTTP 422 with `code: "COHORT_MISMATCH"` and a message like *"stream sizes differ by 23.4× (max 5×)"*. The FE's `PredictedWager` mirrors this client-side so the joiner sees the rejection *before* clicking Confirm.

### Wager floor / cap violations

`AMOUNT_BELOW_FLOOR` or `AMOUNT_ABOVE_CAP` from `/api/matches/:id/join`. Surfaced in the FE as a join error.

### Stream becomes unwagerable mid-creation

The on-chain `createSession` call may revert if the stream has been settled/closed since the matchmaker check. `runOnChainCreate` calls `this.fail(...)` with code `create_failed`. UI shows the failure state.

### RPC outage during settlement

Each settlement step (`submitDeltas`, `finalizeAndApply`, `cancelSession`) has its own retry budget at the SDK layer. If retries exhaust, the match transitions to `failed` with a reason like `submit_failed: ...`. Stuck matches in settlement-stage are flagged for manual recovery via `scripts/cleanup.ts`.

### World ID gate enabled but server not configured

If a creator opts into "Verified players only" but `WORLD_*` secrets are missing on the operator, the `/api/matches` create returns 503 with `WORLDID_NOT_CONFIGURED`. The FE hides the toggle when `/api/config.worldId.enabled === false`, so this should not be reachable in normal use.

---

## 6. Timing knobs

All defaults are in `src/server/config.ts`. Production values are pinned in `fly.toml [env]`.

| Env var | Default | Purpose |
|---|---|---|
| `ROUND_DEADLINE_SEC` | 45 | Commit-phase window per round. |
| `REVEAL_DEADLINE_SEC` | 15 | Reveal-phase window per round (after both commits land). |
| `RECONNECT_GRACE_SEC` | 30 | WS-disconnect grace before forfeit/abandon. |
| `STAKE_BPS` | 1000 (10%) | Default percentage stake when creator doesn't supply an absolute amount. |
| `COHORT_MAX_RATIO` | 5 | Reject pairings where larger / smaller stream exceeds this ratio. |
| `DISPUTE_WINDOW_SEC` | 120 | On-chain anti-cheat window. Lower = faster settlement; chain enforces a minimum. Production value: 30. |
| `FINALIZE_BUFFER_SEC` | 30 | Local clock-skew buffer between dispute-window-elapsed and the `finalize` call. Production value: 10. |
| `ENDTS_BUFFER_SEC` | 30 | `endTs` set at session-create as `now + this`. Padding so retries after slow confirmation don't reuse a stale, now-past timestamp. |

Changing any of the above requires `fly deploy` (env vars in `fly.toml [env]` only take effect on full redeploy).

---

## 7. What players never see / what's never fabricated

- **No move is ever defaulted to "paper"** (or any other value). A missing move is `null`, treated as a forfeit.
- **No tokens move.** Settlement only changes the entitlement split inside the loser's stream. Confused players sometimes ask "where did my X tokens go?" — the answer is they're still in the same stream, just with a different holder share.
- **The on-chain dispute window cannot be skipped.** Even if both players agree "we're done, payout now", the chain rejects `finalize` before `disputeEndTs`. Lower `DISPUTE_WINDOW_SEC` if you want faster settlement, but you can't bypass it per-match.
- **Wager amount is frozen at B-join.** Any drift in `lockedTokenAmount` between agreement and settlement is irrelevant — the snapshot is the contract.

---

## 8. Files of record

| Concern | File |
|---|---|
| Match state machine, round flow, commit-reveal | `src/server/matches.ts` |
| Round / match judging | `src/server/rps.ts` |
| Wager logic (snapshot, validation, ceiling rounding) | `src/server/wager.ts` |
| Timing / config knobs | `src/server/config.ts` |
| Settlement orchestration (submit / finalize / apply / cancel) | `src/server/settlement.ts` |
| Crash recovery on operator restart | `src/server/reconciler.ts` |
| HTTP routes (`/api/matches/*`, `/api/config`) | `src/server/routes.matches.ts` |
| WebSocket bridge | `src/server/ws.ts` |
| Persistence (SQLite schema + DAOs) | `src/server/db.ts` |
| FE round play (commit-reveal driver) | `web/src/pages/Match.tsx` |
| FE settlement progress + dispute hold UI | `web/src/components/SettlementProgress.tsx` |
| FE wager input + cohort preview | `web/src/components/WagerInput.tsx`, `PredictedWager.tsx` |
