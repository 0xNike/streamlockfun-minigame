/**
 * Patch @streamlock/operator-sdk's compiled output for plain-node consumption.
 *
 * The SDK is compiled with `moduleResolution: "Bundler"`, which emits
 * extensionless ESM imports (e.g. `from "./tokens"`). That's valid for
 * bundlers but Node ESM requires explicit `.js` extensions and rejects
 * everything else with ERR_MODULE_NOT_FOUND.
 *
 * Until the SDK ships a build-tool fix upstream, this script:
 *   1. Walks the SDK's dist/ tree and appends `.js` to relative imports
 *      that lack a known extension.
 *   2. Adds `"type": "module"` to the SDK's package.json (defensive — Node
 *      20.19+ auto-detects ESM by syntax, but older runtimes don't).
 *
 * Idempotent: re-running on an already-patched tree is a no-op.
 *
 * Hooked via `postinstall` in the minigame's package.json, so it runs every
 * time deps are (re)installed — including inside the Fly Docker build.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SDK_ROOT = "node_modules/@streamlock/operator-sdk";
const DIST = `${SDK_ROOT}/dist`;

if (!existsSync(DIST)) {
  // SDK not installed yet; nothing to patch. npm runs postinstall after the
  // tree is built, but be defensive against odd setups.
  console.log(`patch-sdk: ${DIST} not found, skipping`);
  process.exit(0);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

const KNOWN_EXTS = /\.(?:js|mjs|cjs|json)$/;
const RE = /(from\s+["']|import\(["'])(\.\.?\/[^"')]+?)(["'])/g;

let filesPatched = 0;
let importsPatched = 0;
for (const f of walk(DIST)) {
  const src = readFileSync(f, "utf8");
  let count = 0;
  const next = src.replace(RE, (whole, pre, spec, post) => {
    if (KNOWN_EXTS.test(spec)) return whole;
    count++;
    return `${pre}${spec}.js${post}`;
  });
  if (count > 0) {
    writeFileSync(f, next);
    filesPatched++;
    importsPatched += count;
  }
}

const pkgPath = `${SDK_ROOT}/package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
let pkgChanged = false;
if (pkg.type !== "module") {
  pkg.type = "module";
  pkgChanged = true;
}
if (pkgChanged) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

console.log(
  `patch-sdk: rewrote ${importsPatched} import(s) across ${filesPatched} file(s)` +
    (pkgChanged ? `, set "type": "module" on ${pkg.name}` : ""),
);
