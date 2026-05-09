/**
 * Operator server entrypoint.
 *
 *   npm run server   (tsx watch src/server/index.ts)
 */

import { config } from "./config.js";
import { logger } from "./log.js";
import "./db.js"; // side-effect: open + migrate
import { runOnStartup } from "./reconciler.js";
import { buildHttp } from "./http.js";
import { registerWs } from "./ws.js";

async function main() {
  logger.info(
    {
      port: config.PORT,
      host: config.HOST,
      env: config.NODE_ENV,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      publicWsUrl: config.PUBLIC_WS_URL,
    },
    "server.boot",
  );

  runOnStartup();

  const app = await buildHttp();
  await registerWs(app);

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info("server.ready");

  const shutdown = async (signal: string) => {
    logger.warn({ signal }, "server.shutdown");
    try {
      await app.close();
      logger.info("server.closed");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "server.shutdown_failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "server.boot_failed");
  process.exit(1);
});
