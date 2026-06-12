# Handoff: this repo now hosts `games.streamlock.fun` (hub + games)

_Brief from the `streamlockfun` (main app) side. Written 2026-06-10._

## What changed and why

`games.streamlock.fun` used to be served by the **main `streamlockfun` Next.js app** (via a subdomain rewrite in its `proxy.ts`). We decided that was the wrong home: games are a fun-first product, not part of the trading/portfolio app, and this repo already contains the live game. So **this repo is becoming the games platform** — it owns the whole `games.streamlock.fun` domain at root:

- `/` → **games hub** (explorer/landing) — new
- `/rps` → the existing Rock Paper Scissors game (was `/`)
- `/match/:id` → match view (unchanged)

The main app gets out of games hosting entirely; its only remaining tie is a sidebar link pointing at `https://games.streamlock.fun`.

Why one repo owns the domain (vs reverse-proxying `/rps` from the main app): it avoids the SPA-under-subpath tax (no absolute asset base, no `basename` juggling, no cross-repo proxy). Single project, root-mounted, normal routing.

## What was already done in this repo (by the main-app agent)

All in `web/`:

- **Tailwind v3 added** — `tailwind.config.js` (with `corePlugins.preflight: false` so Tailwind's global reset can't disturb the existing hand-written `styles.css` game UI), `postcss.config.js`, `src/tailwind.css` (the `@tailwind` directives), imported in `main.tsx` **before** `styles.css`.
- **`lucide-react` added** (icons for the hub).
- **`web/src/pages/Explore.tsx`** — the hub: games grid, per-game card with a "Verified" trust badge (`verified: true` = reviewed by Streamlock; third-party games default unverified), a "?" info modal, and a "Build a game" CTA. The `GAMES` array at the top is the single source of truth; only `status !== "coming-soon"` games with an `href` render. The RPS card links to the internal `/rps` route.
- **`web/src/pages/GamesInfoModal.tsx`** — the "?" explainer modal (plain-language, deliberately jargon-free copy — keep it that way).
- **`App.tsx`** — routes rewired (`/` Explore, `/rps` Home, `/match/:id` Match); header pill "Mini Game" → "Games", added an "Open app" link to `app.streamlock.fun`; footer genericized.

`web` typechecks and `npm run build` succeeds. `vercel.json`'s SPA fallback already covers `/rps` and `/match/*` — no change needed there.

## What you (this repo's agent) now own — remaining cutover

Do these **in order**; the domain move and the main-repo strip must not race or the live site 404s mid-flight.

1. **Deploy this repo** to its existing Vercel project. Verify `streamlockfun-minigame.vercel.app/` shows the hub and `/rps` plays a full match end-to-end.
2. **Operator + World ID origins** — set `PUBLIC_FRONTEND_ORIGIN=https://games.streamlock.fun` on the Fly operator (enables CORS + the `SameSite=None` World ID cookie for the new origin) and add that origin in the Worldcoin dev portal. **Verify the WSS origin** the client connects to (`web/src/pages/Match.tsx` ~line 127 connects to an explicit origin, not `location.origin`) points at the Fly operator, not a `*.vercel.app` URL.
3. **Move the domain in Vercel**: remove `games.streamlock.fun` from the *main* `streamlockfun` project, add it to *this* project. Cloudflare CNAME (`games` → `cname.vercel-dns.com`, DNS-only/grey cloud) stays as-is.
4. **Tell the main-app side** the domain has moved, so it can strip games (`src/app/games/*` + the games block in `proxy.ts`) and deploy. (That's the other agent's job — coordinate, don't do it here.)

## Conventions to keep

- **Adding a game** = add an entry to the `GAMES` array in `Explore.tsx`. Internal games use a route `href` (`/rps`); external ones use a full URL. `verified: true` only for games Streamlock has reviewed.
- **Copy style**: plain language, no crypto jargon ("claim rights", "entitlements", "zero-sum", "deltas"). The info-modal wording was iterated on deliberately.
- **Don't enable Tailwind preflight** — it will break the existing game CSS.
- Operator API key, keypair, and on-chain settlement details are in `README.md` / `RPC_GAMEPLAY.md`. The game settles via `@streamlock/operator-sdk` against the same on-chain entitlement ledger the main app uses; the main app exposes related state but the game does **not** import from the main monorepo (clean SDK boundary — keep it that way).

## Open question for the human

- **Operator credit** for RPS currently reads "by Streamlock Labs" in `Explore.tsx` — confirm or change.
- RPS card has **no thumbnail** (shows an "R" placeholder). Add a 16:9 image if wanted.
