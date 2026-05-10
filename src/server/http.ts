/**
 * Fastify app: /healthz + match routes.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { config } from "./config.js";
import { logger } from "./log.js";
import { registerMatchRoutes } from "./routes.matches.js";
import { registerWorldIdRoutes } from "./routes.worldid.js";

export async function buildHttp(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    logger,
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  }) as unknown as FastifyInstance;

  // CORS: only registered when PUBLIC_FRONTEND_ORIGIN is set (cross-origin
  // frontend). Same-origin (Vite dev proxy) doesn't need it. credentials:true
  // is required for the wid_session cookie to round-trip on /api/worldid/*.
  if (config.PUBLIC_FRONTEND_ORIGIN) {
    await app.register(fastifyCors, {
      origin: config.PUBLIC_FRONTEND_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "OPTIONS"],
    });
  }

  // Cookie plugin must be registered before any route that reads/sets cookies
  // (i.e. the World ID + match-gating routes below).
  await app.register(fastifyCookie);

  app.get("/healthz", async () => ({
    ok: true,
    svc: "minigame-operator",
    uptime_sec: Math.floor(process.uptime()),
    ts: Math.floor(Date.now() / 1000),
  }));

  registerMatchRoutes(app);
  registerWorldIdRoutes(app);

  return app;
}
