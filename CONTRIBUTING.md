# Contributing

This is the developer-facing companion to the [README](README.md). The README covers
*running and deploying* the operator; this file covers *changing the code*.

## Repo layout

Two npm packages, each with its own lockfile — install both:

```bash
npm install                       # operator (root): Fastify server, game engines, settlement
cd web && npm install && cd ..    # web client: React + Vite SPA
```

- **`src/`** — the operator. `src/server/` is the production service (Fastify + WSS,
  SQLite match registry, game engines, settlement state machine, crash reconciler).
  `src/main.ts` is the single-match demo orchestrator.
- **`web/`** — the React SPA (hub + per-game UIs). Talks to the operator over `/api/*` + WSS.
- **`scripts/`** — operational helpers. `patch-sdk.mjs` is a `postinstall` hook (see README §1);
  `e2e_demo.ts` is a runnable end-to-end demo. Don't commit throwaway probe/scratch scripts here.

The hard architectural rule: **this repo imports only `@streamlock/operator-sdk` and
`@solana/web3.js` — never the streamlockfun monorepo.** That boundary is the whole point of
the repo (see README). PRs that reach into Streamlock internals will be rejected.

## Before you open a PR

Both checks run in CI (`.github/workflows/ci.yml`) on every PR. Run them locally first:

```bash
# operator (root)
npm run typecheck
npm run build

# web
cd web && npm run typecheck && npm run build
```

`tsconfig` is `strict`; keep it green. Avoid `any` and `@ts-ignore` — the codebase has
effectively none, so a new one needs a comment justifying it.

For changes that touch on-chain settlement or wager math (`src/server/settlement.ts`,
`src/server/wager.ts`, the game engines), run a real devnet match end-to-end before opening
the PR — see README §5 (`npm run match`). There is no automated test suite yet, so the
devnet match *is* the integration test.

## Branches & commits

- Branch from `main`; never push directly to `main`.
- Name branches `<type>/<short-slug>` — e.g. `feat/reversi`, `fix/closeall-signature`,
  `chore/repo-hygiene`, `docs/readme-two-games`.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
  `chore:`, `docs:`, `refactor:`, with an optional scope (`fix(settlement): …`,
  `feat(games): …`). The commit log doubles as the changelog.
- Open a PR into `main` and merge once CI is green. Delete the branch after merge
  (locally and on the remote) so the branch list stays clean.

## Secrets

Never commit: `.env*` (except `.env.example`), operator keypairs (`operator.json`,
`*-operator.json`), the SQLite DB (`*.sqlite*`), or `.mcp.json`. All are gitignored, but
double-check `git status` before committing — these are real-money secrets.

## Adding a game

Games are self-contained modules around a shared shell (backend `GameEngine` seam in
`src/server/games/`, frontend `web/src/games/<id>/`). Full step-by-step in
[`src/server/games/README.md`](src/server/games/README.md), and the visual/design contract
is in README §Architecture.
