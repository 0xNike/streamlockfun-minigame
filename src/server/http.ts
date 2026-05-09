/**
 * Fastify app: /healthz + match routes.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { logger } from "./log.js";
import { registerMatchRoutes } from "./routes.matches.js";

export async function buildHttp(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    logger,
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  }) as unknown as FastifyInstance;

  app.get("/healthz", async () => ({
    ok: true,
    svc: "minigame-operator",
    uptime_sec: Math.floor(process.uptime()),
    ts: Math.floor(Date.now() / 1000),
  }));

  registerMatchRoutes(app);

  return app;
}
