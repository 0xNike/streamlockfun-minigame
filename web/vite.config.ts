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
  define: {
    // wallet-adapter packages reference these globals
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
    global: "globalThis",
  },
});
