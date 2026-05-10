# ─── build stage ─────────────────────────────────────────────────────────────
# Compile TS → dist/ and install all deps (including the native better-sqlite3).
FROM node:20-bullseye AS build

# better-sqlite3 ships C++ source; needs python3 + g++ to compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer cache: deps before source. The vendored SDK tarball must be present
# at install time alongside package.json. The postinstall hook also needs
# scripts/patch-sdk.mjs in place — must be copied BEFORE `npm ci` runs.
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
COPY scripts/ ./scripts/
RUN npm ci --no-audit --no-fund

# Compile TypeScript.
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── runtime stage ───────────────────────────────────────────────────────────
# Slim image with only what's needed to run. node_modules carries the already-
# compiled better-sqlite3 .node binary; bullseye → bullseye-slim share glibc,
# so the native module loads without re-build.
FROM node:20-bullseye-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

EXPOSE 8787
CMD ["node", "dist/server/index.js"]
