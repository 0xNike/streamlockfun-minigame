import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_HTTP = process.env.VITE_API_BASE ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: SERVER_HTTP, changeOrigin: true },
      "/ws": { target: SERVER_HTTP.replace(/^http/, "ws"), ws: true, changeOrigin: true },
    },
  },
  // @worldcoin/idkit-core ships its WASM as a sibling file (`idkit_wasm_bg.wasm`).
  // Vite's dep-prebundle (esbuild) doesn't relocate the WASM alongside the
  // bundled JS, so the runtime URL resolves to index.html (SPA fallback) →
  // "expected magic word 00 61 73 6d" error. Excluding just the inner core
  // package lets the WASM load from node_modules. The outer @worldcoin/idkit
  // package needs to STAY in optimizeDeps so its CJS `qrcode` dep is
  // transformed to ESM (otherwise: "does not provide an export named 'default'").
  optimizeDeps: {
    exclude: ["@worldcoin/idkit-core"],
  },
  assetsInclude: ["**/*.wasm"],
  define: {
    // wallet-adapter packages reference these globals
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
    global: "globalThis",
  },
});
